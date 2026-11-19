package workbench

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/sylvinus/agent-vm/internal/hostbridge"
	"github.com/sylvinus/agent-vm/internal/version"
)

// Plugin pages are shown in a frame that may run scripts but is no origin of
// this workbench: it carries no cookie, so its files cannot be served behind
// the session. They are served under a path only the workbench is told.
const hostViewPrefix = "/plugin-views/"

// hostViewCallWait is how long a page's tool call may take.
const hostViewCallWait = 60 * time.Second

// hostViewKey is the path segment that stands for the plugin's pages while
// this application runs.
func (s *Server) hostViewKey(plugin string) string {
	mac := hmac.New(sha256.New, []byte(s.token))
	mac.Write([]byte("plugin-view\x00" + plugin))
	return hex.EncodeToString(mac.Sum(nil))[:32]
}

func (s *Server) hostViewURL(plugin, view string) string {
	return hostViewPrefix + plugin + "/" + s.hostViewKey(plugin) + "/" + view + "/"
}

// hostViewManifest is the manifest of an installed plugin that is turned on
// and that this application can run.
func (s *Server) hostViewManifest(plugin string) (hostbridge.Manifest, bool) {
	if plugin == "" || plugin != filepath.Base(plugin) || strings.HasPrefix(plugin, ".") {
		return hostbridge.Manifest{}, false
	}
	manifest, err := hostbridge.LoadManifest(filepath.Join(s.hostPluginDir(), plugin))
	s.mu.Lock()
	off := hostPluginsOff(s.preferences)
	s.mu.Unlock()
	if err != nil || manifest.Name != plugin || !manifest.Supported() || manifest.Unavailable(version.Version, true) != "" || slices.Contains(off, plugin) {
		return hostbridge.Manifest{}, false
	}
	return manifest, true
}

func hostView(manifest hostbridge.Manifest, id string) (hostbridge.View, bool) {
	if manifest.Contributes == nil {
		return hostbridge.View{}, false
	}
	for _, view := range manifest.Contributes.Views {
		if view.ID == id {
			return view, true
		}
	}
	return hostbridge.View{}, false
}

// servePluginView serves a file of a plugin's page: the entry for the page's
// own address, and beside it the files in the entry's folder.
func (s *Server) servePluginView(w http.ResponseWriter, r *http.Request) {
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, hostViewPrefix), "/", 4)
	if (r.Method != http.MethodGet && r.Method != http.MethodHead) || len(parts) != 4 {
		http.NotFound(w, r)
		return
	}
	plugin, key, id, rest := parts[0], parts[1], parts[2], parts[3]
	manifest, usable := s.hostViewManifest(plugin)
	view, found := hostView(manifest, id)
	if !usable || !found || !hmac.Equal([]byte(key), []byte(s.hostViewKey(plugin))) {
		http.NotFound(w, r)
		return
	}
	root := filepath.Join(s.hostPluginDir(), plugin)
	// Inside the folder of the page's entry, and no part of the way there a
	// link out of it.
	if rest != "" && (rest != path.Clean(rest) || rest == ".." || strings.HasPrefix(rest, "../") || path.IsAbs(rest) || strings.Contains(rest, "\\")) {
		http.NotFound(w, r)
		return
	}
	name := path.Join(path.Dir(view.Entry), rest)
	if rest == "" {
		name = view.Entry
	}
	file := root
	for _, part := range strings.Split(name, "/") {
		file = filepath.Join(file, part)
		if info, err := os.Lstat(file); err != nil || info.Mode()&os.ModeSymlink != 0 {
			http.NotFound(w, r)
			return
		}
	}
	info, err := os.Stat(file)
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	data, err := os.ReadFile(file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	kind := mime.TypeByExtension(strings.ToLower(path.Ext(name)))
	if kind == "" {
		kind = "application/octet-stream"
	}
	own := s.origin + hostViewPrefix + plugin + "/"
	header := w.Header()
	header.Del("X-Frame-Options")
	header.Set("Content-Security-Policy", "default-src 'none'; script-src "+own+"; style-src "+own+" 'unsafe-inline'; img-src "+own+
		" data:; font-src "+own+"; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors "+s.origin)
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Cache-Control", "no-store")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("Content-Type", kind)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(data)
}

// The reasons a page's call fails, as the page is told them.
const (
	hostCallRefused     = -32001
	hostCallNotAllowed  = -32002
	hostCallUnavailable = -32003
	hostCallTimedOut    = -32004
	hostCallFailed      = -32005
)

func hostCallError(w http.ResponseWriter, status, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "message": message})
}

// callHostTool lists or calls the tools of the MCP server a plugin's page is
// bound to, for that page.
func (s *Server) callHostTool(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Plugin    string          `json:"plugin"`
		View      string          `json:"view"`
		Method    string          `json:"method"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if !readJSON(w, r, &body, 1<<20) {
		return
	}
	manifest, usable := s.hostViewManifest(body.Plugin)
	view, found := hostView(manifest, body.View)
	if !usable || !found {
		hostCallError(w, http.StatusForbidden, hostCallNotAllowed, "这个页面不属于已启用的插件")
		return
	}
	// A plugin on this computer acts on it; only this computer's window may
	// drive one. A plugin inside the environment acts where any signed-in
	// workbench already does.
	if manifest.Kind != hostbridge.KindGuest && !s.hasTrustedView(r) {
		hostCallError(w, http.StatusForbidden, hostCallNotAllowed, "请在本机 Cage 窗口使用这个插件页面")
		return
	}
	s.mu.Lock()
	tools := s.hostTools
	s.mu.Unlock()
	var plugin *hostbridge.External
	if tools != nil {
		for _, loaded := range tools.plugins {
			if loaded.Manifest.Name == body.Plugin {
				plugin = loaded
			}
		}
	}
	if view.Server == "" || plugin == nil {
		hostCallError(w, http.StatusConflict, hostCallUnavailable, "插件没有在运行，或这个页面没有可调用的服务")
		return
	}
	switch body.Method {
	case "tools/list":
		list := []map[string]any{}
		for _, tool := range plugin.ToolSpecs() {
			list = append(list, map[string]any{"name": tool.Name, "description": tool.Description, "inputSchema": tool.InputSchema})
		}
		jsonReply(w, map[string]any{"tools": list})
	case "tools/call":
		if len(body.Arguments) > 0 && !json.Valid(body.Arguments) {
			hostCallError(w, http.StatusBadRequest, -32602, "参数无效")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), hostViewCallWait)
		defer cancel()
		result, err := plugin.CallFromView(ctx, body.Name, body.Arguments)
		var refused *hostbridge.RefusedError
		switch {
		case err == nil:
			jsonReply(w, result)
		case errors.As(err, &refused):
			hostCallError(w, http.StatusForbidden, hostCallRefused, "没有获得允许："+refused.Error())
		case ctx.Err() != nil:
			hostCallError(w, http.StatusGatewayTimeout, hostCallTimedOut, "工具在 60 秒内没有返回结果")
		default:
			hostCallError(w, http.StatusBadGateway, hostCallFailed, "工具执行出错："+err.Error())
		}
	default:
		hostCallError(w, http.StatusBadRequest, -32601, "没有这个方法")
	}
}
