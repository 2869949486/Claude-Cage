package hostbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ManifestFile is the file that makes a directory a plugin.
const ManifestFile = "plugin.json"

// Manifest describes a plugin that runs as its own program and speaks MCP
// on its standard input and output.
type Manifest struct {
	// Name identifies the plugin: lowercase letters, digits and hyphens.
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
	// Platforms lists the systems the plugin runs on, as darwin, linux or
	// windows. Empty means all.
	Platforms []string `json:"platforms,omitempty"`
	// Permissions declares what the plugin does on the computer, for the
	// user to read before enabling it. See KnownPermissions.
	Permissions []string `json:"permissions"`
	// Command is the program and its arguments. A relative program path is
	// taken from the plugin's directory.
	Command []string `json:"command"`
}

// KnownPermissions are the values a manifest may declare.
var KnownPermissions = []string{"files", "commands", "screen", "input", "network"}

var pluginName = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// LoadManifest reads and checks the manifest of the plugin in dir.
func LoadManifest(dir string) (Manifest, error) {
	data, err := os.ReadFile(filepath.Join(dir, ManifestFile))
	if err != nil {
		return Manifest{}, err
	}
	var m Manifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&m); err != nil {
		return Manifest{}, fmt.Errorf("%s: %w", ManifestFile, err)
	}
	switch {
	case !pluginName.MatchString(m.Name) || len(m.Name) > 40:
		return Manifest{}, fmt.Errorf("%s: name must be lowercase letters, digits and hyphens", ManifestFile)
	case m.Version == "":
		return Manifest{}, fmt.Errorf("%s: version is missing", ManifestFile)
	case len(m.Command) == 0 || m.Command[0] == "":
		return Manifest{}, fmt.Errorf("%s: command is missing", ManifestFile)
	case m.Permissions == nil:
		return Manifest{}, fmt.Errorf("%s: permissions must be declared, as an empty list if there are none", ManifestFile)
	}
	for _, permission := range m.Permissions {
		if !slices.Contains(KnownPermissions, permission) {
			return Manifest{}, fmt.Errorf("%s: unknown permission %q", ManifestFile, permission)
		}
	}
	for _, platform := range m.Platforms {
		if !slices.Contains([]string{"darwin", "linux", "windows"}, platform) {
			return Manifest{}, fmt.Errorf("%s: unknown platform %q", ManifestFile, platform)
		}
	}
	return m, nil
}

// Supported reports whether the plugin runs on this system.
func (m Manifest) Supported() bool {
	return len(m.Platforms) == 0 || slices.Contains(m.Platforms, runtime.GOOS)
}

// ToolRequest is one call to a plugin's tool awaiting approval.
type ToolRequest struct {
	Plugin    string
	Tool      string
	Arguments string
}

// External is a plugin run as a child program. Its tools are offered under
// their own names once they pass CheckWording; every call first goes
// through Approve, if set.
type External struct {
	Manifest Manifest
	Dir      string
	Approve  func(context.Context, ToolRequest) error

	mu      sync.Mutex
	session *mcp.ClientSession
	tools   []*mcp.Tool
}

// Start runs the program and reads its tools. It fails, leaving nothing
// running, if a tool's wording is not acceptable.
func (e *External) Start(ctx context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.startLocked(ctx)
}

func (e *External) startLocked(ctx context.Context) error {
	if !e.Manifest.Supported() {
		return fmt.Errorf("plugin %s does not support %s", e.Manifest.Name, runtime.GOOS)
	}
	program := e.Manifest.Command[0]
	if !filepath.IsAbs(program) && (filepath.Base(program) != program || fileExists(filepath.Join(e.Dir, program))) {
		program = filepath.Join(e.Dir, program)
	}
	// The program outlives the call that starts it.
	cmd := exec.Command(program, e.Manifest.Command[1:]...)
	cmd.Dir = e.Dir
	client := mcp.NewClient(&mcp.Implementation{Name: "computer", Version: "1"}, nil)
	connect, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	session, err := client.Connect(connect, &mcp.CommandTransport{Command: cmd, TerminateDuration: 2 * time.Second}, nil)
	if err != nil {
		return fmt.Errorf("plugin %s: %w", e.Manifest.Name, err)
	}
	listed, err := session.ListTools(connect, nil)
	if err != nil {
		_ = session.Close()
		return fmt.Errorf("plugin %s: %w", e.Manifest.Name, err)
	}
	for _, tool := range listed.Tools {
		if word, found := CheckWording(tool); found {
			_ = session.Close()
			return fmt.Errorf("plugin %s: tool %s mentions %q; tools describe only what they do", e.Manifest.Name, tool.Name, word)
		}
	}
	e.session, e.tools = session, listed.Tools
	return nil
}

// Tools are the names of the plugin's tools, once started.
func (e *External) Tools() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	names := make([]string, len(e.tools))
	for i, tool := range e.tools {
		names[i] = tool.Name
	}
	return names
}

// ToolInfo is a tool's name and what it says it does.
type ToolInfo struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// ToolList describes the plugin's tools, once started.
func (e *External) ToolList() []ToolInfo {
	e.mu.Lock()
	defer e.mu.Unlock()
	list := make([]ToolInfo, len(e.tools))
	for i, tool := range e.tools {
		list[i] = ToolInfo{Name: tool.Name, Description: tool.Description}
	}
	return list
}

// Register offers the plugin's tools on server.
func (e *External) Register(server *mcp.Server) {
	e.mu.Lock()
	tools := slices.Clone(e.tools)
	e.mu.Unlock()
	for _, tool := range tools {
		server.AddTool(tool, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			result, err := e.call(ctx, tool.Name, request.Params.Arguments)
			if err != nil {
				refused := &mcp.CallToolResult{}
				refused.SetError(err)
				return refused, nil
			}
			return result, nil
		})
	}
}

func (e *External) call(ctx context.Context, name string, arguments json.RawMessage) (*mcp.CallToolResult, error) {
	if e.Approve != nil {
		if err := e.Approve(ctx, ToolRequest{Plugin: e.Manifest.Name, Tool: name, Arguments: string(arguments)}); err != nil {
			return nil, err
		}
	}
	params := &mcp.CallToolParams{Name: name}
	if len(arguments) > 0 {
		params.Arguments = arguments
	}
	e.mu.Lock()
	session := e.session
	e.mu.Unlock()
	if session == nil {
		return nil, fmt.Errorf("plugin %s is not running", e.Manifest.Name)
	}
	result, err := session.CallTool(ctx, params)
	if err == nil || ctx.Err() != nil {
		return result, err
	}
	// The program may have exited; run it again once. Its tools must be the
	// ones already offered, or the call is not what was approved.
	e.mu.Lock()
	if e.session == session {
		_ = session.Close()
		e.session = nil
		offered := e.tools
		if restart := e.startLocked(ctx); restart != nil {
			e.mu.Unlock()
			return nil, errors.Join(err, restart)
		}
		if !sameTools(offered, e.tools) {
			_ = e.session.Close()
			e.session, e.tools = nil, offered
			e.mu.Unlock()
			return nil, fmt.Errorf("plugin %s changed its tools while running", e.Manifest.Name)
		}
	}
	session = e.session
	e.mu.Unlock()
	if session == nil {
		return nil, err
	}
	return session.CallTool(ctx, params)
}

// Close stops the program.
func (e *External) Close() {
	e.mu.Lock()
	session := e.session
	e.session = nil
	e.mu.Unlock()
	if session != nil {
		_ = session.Close()
	}
}

func sameTools(a, b []*mcp.Tool) bool {
	return slices.EqualFunc(a, b, func(x, y *mcp.Tool) bool {
		return x.Name == y.Name && x.Description == y.Description
	})
}

// LoadPlugins starts every plugin found in the subdirectories of dir that
// supports this system. A plugin that fails to load, or offers a tool name
// already taken (taken lists those of the built-in plugins), is left out and
// reported; the others still load.
func LoadPlugins(ctx context.Context, dir string, taken []string, approve func(context.Context, ToolRequest) error) ([]*External, []error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, []error{err}
	}
	var loaded []*External
	var failures []error
	names := slices.Clone(taken)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		manifest, err := LoadManifest(path)
		if err != nil {
			if !os.IsNotExist(err) {
				failures = append(failures, fmt.Errorf("%s: %w", entry.Name(), err))
			}
			continue
		}
		if manifest.Name != entry.Name() {
			failures = append(failures, fmt.Errorf("%s: the directory must be named after the plugin, %s", entry.Name(), manifest.Name))
			continue
		}
		if !manifest.Supported() {
			continue
		}
		plugin := &External{Manifest: manifest, Dir: path, Approve: approve}
		if err := plugin.Start(ctx); err != nil {
			failures = append(failures, err)
			continue
		}
		clash := ""
		for _, tool := range plugin.Tools() {
			if slices.Contains(names, tool) {
				clash = tool
				break
			}
		}
		if clash != "" {
			plugin.Close()
			failures = append(failures, fmt.Errorf("plugin %s: tool name %s is already in use", manifest.Name, clash))
			continue
		}
		names = append(names, plugin.Tools()...)
		loaded = append(loaded, plugin)
	}
	return loaded, failures
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
