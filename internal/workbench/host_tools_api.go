package workbench

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"

	"github.com/sylvinus/agent-vm/internal/containerenv"
	"github.com/sylvinus/agent-vm/internal/hostbridge"
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
		if !entry.IsDir() {
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
	return view
}

func (s *Server) getHostTools(w http.ResponseWriter, r *http.Request) {
	jsonReply(w, s.hostToolsView())
}

// setHostTools turns the tools on or off, or loads the plugin folders again.
// Only this computer's own window may: the tools act on this computer.
func (s *Server) setHostTools(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled *bool `json:"enabled"`
		Reload  bool  `json:"reload"`
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
	if body.Reload {
		s.closeHostTools()
	}
	if ready || !s.hostToolsView().Enabled {
		s.ensureHostTools()
	}
	jsonReply(w, s.hostToolsView())
}
