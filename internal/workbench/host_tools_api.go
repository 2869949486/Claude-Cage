package workbench

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sylvinus/agent-vm/internal/containerenv"
	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/hostbridge"
	"github.com/sylvinus/agent-vm/internal/hostproxy"
)

// hostPluginView is one plugin as the plugin page shows it.
type hostPluginView struct {
	Name        string                `json:"name"`
	Version     string                `json:"version,omitempty"`
	Description string                `json:"description,omitempty"`
	Permissions []string              `json:"permissions"`
	BuiltIn     bool                  `json:"built_in,omitempty"`
	Supported   bool                  `json:"supported"`
	Loaded      bool                  `json:"loaded"`
	Tools       []hostbridge.ToolInfo `json:"tools,omitempty"`
	// Problem is why the plugin's folder cannot be used.
	Problem string `json:"problem,omitempty"`
}

type hostToolsView struct {
	// Available is false where the tools cannot run at all.
	Available bool `json:"available"`
	Enabled   bool `json:"enabled"`
	Running   bool `json:"running"`
	// Directory is where the user puts plugin folders.
	Directory string           `json:"directory"`
	Folders   []string         `json:"folders"`
	Plugins   []hostPluginView `json:"plugins"`
	Problems  []string         `json:"problems,omitempty"`
	// Catalog lists the plugins that come with the application.
	Catalog []hostCatalogView `json:"catalog"`
}

type hostCatalogView struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description,omitempty"`
	Permissions []string `json:"permissions"`
	Supported   bool     `json:"supported"`
	Installed   bool     `json:"installed"`
}

func (s *Server) hostPluginDir() string { return filepath.Join(s.profile, "plugins") }

func (s *Server) hostToolsView() hostToolsView {
	s.mu.Lock()
	enabled, tools := s.preferences.HostTools, s.hostTools
	s.mu.Unlock()
	view := hostToolsView{Available: !containerenv.Configured(s.profile), Enabled: enabled, Running: tools != nil,
		Directory: s.hostPluginDir(), Folders: s.hostToolDirs()}
	if view.Folders == nil {
		view.Folders = []string{}
	}
	loaded := map[string][]hostbridge.ToolInfo{}
	if tools != nil {
		view.Problems = tools.problems
		for _, plugin := range tools.plugins {
			loaded[plugin.Manifest.Name] = plugin.ToolList()
		}
	}
	view.Plugins = []hostPluginView{{Name: "commands", BuiltIn: true, Supported: true, Loaded: tools != nil, Permissions: []string{"commands"},
		Tools: []hostbridge.ToolInfo{{Name: "run_command"}, {Name: "command_job"}}}}
	entries, _ := os.ReadDir(view.Directory)
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		manifest, err := hostbridge.LoadManifest(filepath.Join(view.Directory, entry.Name()))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			view.Plugins = append(view.Plugins, hostPluginView{Name: entry.Name(), Permissions: []string{}, Problem: err.Error()})
			continue
		}
		plugin := hostPluginView{Name: manifest.Name, Version: manifest.Version, Description: manifest.Description,
			Permissions: manifest.Permissions, Supported: manifest.Supported()}
		if manifest.Name != entry.Name() {
			plugin.Problem = "文件夹名称须与插件名称 " + manifest.Name + " 一致"
			plugin.Name = entry.Name()
		} else if list, ok := loaded[manifest.Name]; ok {
			plugin.Loaded, plugin.Tools = true, list
		}
		view.Plugins = append(view.Plugins, plugin)
	}
	view.Catalog = []hostCatalogView{}
	for _, manifest := range hostbridge.Catalog() {
		_, err := os.Lstat(filepath.Join(view.Directory, manifest.Name))
		view.Catalog = append(view.Catalog, hostCatalogView{Name: manifest.Name, Version: manifest.Version, Description: manifest.Description,
			Permissions: manifest.Permissions, Supported: manifest.Supported(), Installed: err == nil})
	}
	return view
}

// removeHostPlugin sets the plugin's folder aside under plugins-removed, so
// nothing the user put there is lost.
func (s *Server) removeHostPlugin(name string) error {
	_, err := s.setAsideHostPlugin(name)
	return err
}

// setAsideHostPlugin moves the plugin's folder away and says where to.
func (s *Server) setAsideHostPlugin(name string) (string, error) {
	if name == "" || name != filepath.Base(name) || strings.HasPrefix(name, ".") {
		return "", errors.New("插件名称无效")
	}
	source := filepath.Join(s.hostPluginDir(), name)
	if info, err := os.Lstat(source); err != nil || !info.IsDir() {
		return "", errors.New("没有找到这个插件")
	}
	aside := filepath.Join(s.profile, "plugins-removed")
	if err := os.MkdirAll(aside, 0o700); err != nil {
		return "", err
	}
	target := filepath.Join(aside, name+"-"+time.Now().Format("20060102-150405"))
	return target, os.Rename(source, target)
}

func (s *Server) getHostTools(w http.ResponseWriter, r *http.Request) {
	jsonReply(w, s.hostToolsView())
}

// setHostTools turns the tools on or off, installs or removes a plugin, or
// loads the plugin folders again.
// Only this computer's own window may: the tools act on this computer.
func (s *Server) setHostTools(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled *bool  `json:"enabled"`
		Reload  bool   `json:"reload"`
		Install string `json:"install"`
		Remove  string `json:"remove"`
		// Source is "market" to install from the community list; Replace
		// then sets an installed version aside first.
		Source  string `json:"source"`
		Replace bool   `json:"replace"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !s.hasTrustedView(r) {
		http.Error(w, "请在本机 Cage 窗口更改主机工具", http.StatusForbidden)
		return
	}
	if containerenv.Configured(s.profile) {
		http.Error(w, "此环境不支持主机工具", http.StatusConflict)
		return
	}
	if !s.op.TryLock() {
		http.Error(w, "环境正在执行其他操作，请稍后再试", http.StatusConflict)
		return
	}
	defer s.op.Unlock()
	s.mu.Lock()
	previous, ready, closing := s.preferences, s.ready, s.closing
	s.mu.Unlock()
	if closing {
		http.Error(w, "服务正在关闭", http.StatusServiceUnavailable)
		return
	}
	if body.Enabled != nil && *body.Enabled != previous.HostTools {
		next := previous
		next.HostTools = *body.Enabled
		if err := writePrivate(filepath.Join(s.profile, "workbench.json"), next); err != nil {
			requestError(w, err)
			return
		}
		s.mu.Lock()
		s.preferences.HostTools = next.HostTools
		s.mu.Unlock()
	}
	if body.Install != "" {
		var err error
		if body.Source == "market" {
			err = s.installFromMarket(r.Context(), body.Install, body.Replace)
		} else {
			err = hostbridge.InstallFromCatalog(body.Install, s.hostPluginDir())
		}
		if err != nil {
			requestError(w, errors.New("插件安装失败："+err.Error()))
			return
		}
	}
	if body.Remove != "" {
		// Stop the plugin's program before its folder moves.
		s.closeHostTools()
		if err := s.removeHostPlugin(body.Remove); err != nil {
			requestError(w, err)
			return
		}
	}
	if body.Reload || body.Install != "" {
		s.closeHostTools()
	}
	if ready || !s.hostToolsView().Enabled {
		s.ensureHostTools()
	}
	jsonReply(w, s.hostToolsView())
}

// hostMarketCache keeps the community list between requests.
type hostMarketCache struct {
	mu      sync.Mutex
	entries []hostbridge.MarketEntry
	fetched time.Time
	err     error
}

const hostMarketMaxAge = 5 * time.Minute

// hostMarketClient reaches the list the way the user's own browser would.
func hostMarketClient() *http.Client {
	return &http.Client{Transport: hostproxy.NewTransport(), Timeout: 2 * time.Minute}
}

// hostMarketEntries reads the community list, at most once per max age
// unless refresh is set. A failed read keeps the last good list.
func (s *Server) hostMarketEntries(ctx context.Context, refresh bool) ([]hostbridge.MarketEntry, time.Time, error) {
	cache := &s.hostMarket
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if !refresh && !cache.fetched.IsZero() && time.Since(cache.fetched) < hostMarketMaxAge {
		return cache.entries, cache.fetched, cache.err
	}
	fetch, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	entries, err := hostbridge.CommunityMarket.Fetch(fetch, hostMarketClient())
	cache.err = err
	if err == nil {
		cache.entries, cache.fetched = entries, time.Now()
	} else if cache.fetched.IsZero() {
		// Do not ask again on every poll while the list cannot be reached.
		return nil, time.Time{}, err
	}
	return cache.entries, cache.fetched, cache.err
}

type hostMarketEntryView struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description,omitempty"`
	Permissions []string `json:"permissions"`
	Supported   bool     `json:"supported"`
	Bytes       int64    `json:"bytes"`
	// InstalledVersion is empty when the plugin is not installed.
	InstalledVersion string `json:"installed_version"`
	Update           bool   `json:"update"`
}

func (s *Server) getHostMarket(w http.ResponseWriter, r *http.Request) {
	entries, fetched, err := s.hostMarketEntries(r.Context(), r.URL.Query().Get("refresh") == "1")
	view := struct {
		Source  string                `json:"source"`
		Fetched string                `json:"fetched"`
		Error   string                `json:"error,omitempty"`
		Entries []hostMarketEntryView `json:"entries"`
	}{Source: "https://github.com/Lee-xeo/cage-plugins", Entries: []hostMarketEntryView{}}
	if !fetched.IsZero() {
		view.Fetched = fetched.UTC().Format(time.RFC3339)
	}
	if err != nil {
		diagnostics.Log("warn", "host-tools", fmt.Sprintf("market error=%v", err))
		view.Error = "暂时无法读取插件市场，请检查主机网络或代理后重试"
	}
	for _, entry := range entries {
		item := hostMarketEntryView{Name: entry.Name, Version: entry.Version, Description: entry.Description,
			Permissions: entry.Permissions, Supported: entry.Supported(), Bytes: entry.Bytes}
		if manifest, err := hostbridge.LoadManifest(filepath.Join(s.hostPluginDir(), entry.Name)); err == nil {
			item.InstalledVersion = manifest.Version
			item.Update = manifest.Version != entry.Version
		} else if _, statErr := os.Lstat(filepath.Join(s.hostPluginDir(), entry.Name)); statErr == nil {
			// A folder of that name that is not a usable plugin.
			item.InstalledVersion, item.Update = "?", true
		}
		view.Entries = append(view.Entries, item)
	}
	jsonReply(w, view)
}

// installFromMarket installs the named plugin from the community list. With
// replace, a version already installed is set aside first and put back if the
// new one cannot be installed.
func (s *Server) installFromMarket(ctx context.Context, name string, replace bool) error {
	entries, _, err := s.hostMarketEntries(ctx, false)
	if err != nil && len(entries) == 0 {
		return err
	}
	index := slices.IndexFunc(entries, func(entry hostbridge.MarketEntry) bool { return entry.Name == name })
	if index < 0 {
		return errors.New("插件市场里没有这个插件")
	}
	if !entries[index].Supported() {
		return errors.New("这个插件不支持此系统")
	}
	aside := ""
	if _, statErr := os.Lstat(filepath.Join(s.hostPluginDir(), name)); statErr == nil {
		if !replace {
			return errors.New("这个插件已经安装")
		}
		// Stop the plugin's program before its folder moves.
		s.closeHostTools()
		if aside, err = s.setAsideHostPlugin(name); err != nil {
			return err
		}
	}
	if err = hostbridge.CommunityMarket.Install(ctx, hostMarketClient(), entries[index], s.hostPluginDir()); err != nil && aside != "" {
		if restore := os.Rename(aside, filepath.Join(s.hostPluginDir(), name)); restore != nil {
			return errors.Join(err, restore)
		}
	}
	return err
}
