package workbench

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sylvinus/agent-vm/internal/containerenv"
	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/hostbridge"
	"github.com/sylvinus/agent-vm/internal/paths"
)

// hostToolsPort is where the environment reaches the tools, on its own
// loopback. It and the token stay the same across restarts so the entry in
// Claude's configuration is written once and then left alone: Claude rewrites
// that file itself, and a second writer would race with it.
const hostToolsPort = 18962

//go:embed host_tools_config.py
var hostToolsConfigScript string

// hostToolsRelayScript lets the desktop app, which can only start a server as
// a local program, reach the same tools.
//
//go:embed host_tools_relay.py
var hostToolsRelayScript string

// hostTools is the running tool server and the SSH process that forwards the
// environment's port to it.
type hostTools struct {
	bridge *hostbridge.Bridge
	cancel context.CancelFunc
	done   chan struct{}
	// configured is when the environment's clients were last given the entry.
	configured time.Time
}

// hostToolsConfigInterval is how often a running environment is checked for
// Claude profiles created since the entry was written.
const hostToolsConfigInterval = time.Minute

func (h *hostTools) close() {
	h.cancel()
	<-h.done
	_ = h.bridge.Close()
}

// ensureHostTools starts the tools when the preference is on and they are not
// already running, and stops them when it is off. Called under the lifecycle
// lock whenever the environment is known to be reachable, so a forward that
// dropped is replaced on the next check.
func (s *Server) ensureHostTools() {
	if s.windowsGuest != nil || s.macosGuest != nil || containerenv.Configured(s.profile) {
		return
	}
	s.mu.Lock()
	enabled, closing, current := s.preferences.HostTools, s.closing, s.hostTools
	s.mu.Unlock()
	if !enabled || closing {
		s.closeHostTools()
		if !closing {
			s.removeHostToolsConfig()
		}
		return
	}
	if current != nil {
		select {
		case <-current.done:
			s.closeHostTools()
		default:
			s.refreshHostToolsConfig(current)
			return
		}
	}
	if err := s.startHostTools(); err != nil {
		diagnostics.Log("warn", "host-tools", fmt.Sprintf("start error=%v", err))
	}
}

func (s *Server) startHostTools() error {
	token, err := s.hostToolsToken()
	if err != nil {
		return err
	}
	bridge, err := hostbridge.Start(token, hostbridge.Command{Dirs: s.hostToolDirs, MapDir: paths.FromGitBash, Approve: newHostApprovals().approve})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(s.lifetimeContext())
	tools := &hostTools{bridge: bridge, cancel: cancel, done: make(chan struct{})}
	forward := fmt.Sprintf("127.0.0.1:%d:%s", hostToolsPort, bridge.Addr())
	cmd := s.sshCommandWithForwarding(ctx, "-o", "ExitOnForwardFailure=yes", "-N", "-T", "-R", forward, s.sshTarget())
	if err = cmd.Start(); err != nil {
		cancel()
		_ = bridge.Close()
		return err
	}
	go func() {
		defer close(tools.done)
		_ = cmd.Wait()
	}()
	configure, finish := context.WithTimeout(ctx, 15*time.Second)
	defer finish()
	if err = s.writeHostToolsConfig(configure, token, "add"); err != nil {
		tools.close()
		return err
	}
	tools.configured = time.Now()
	s.mu.Lock()
	s.hostTools = tools
	s.hostToolsRemoved = false
	s.mu.Unlock()
	return nil
}

// refreshHostToolsConfig gives the entry to profiles created while the
// environment runs. Unchanged files are not rewritten.
func (s *Server) refreshHostToolsConfig(tools *hostTools) {
	if time.Since(tools.configured) < hostToolsConfigInterval {
		return
	}
	tools.configured = time.Now()
	token, err := s.hostToolsToken()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(s.lifetimeContext(), 15*time.Second)
	defer cancel()
	if err = s.writeHostToolsConfig(ctx, token, "add"); err != nil {
		diagnostics.Log("warn", "host-tools", fmt.Sprintf("refresh error=%v", err))
	}
}

// removeHostToolsConfig takes the entry back out of the environment once
// after the preference is turned off, so clients do not keep a server that
// no longer answers.
func (s *Server) removeHostToolsConfig() {
	s.mu.Lock()
	removed, ready := s.hostToolsRemoved, s.ready
	s.mu.Unlock()
	if removed || !ready {
		return
	}
	ctx, cancel := context.WithTimeout(s.lifetimeContext(), 15*time.Second)
	defer cancel()
	if err := s.writeHostToolsConfig(ctx, "", "remove"); err != nil {
		diagnostics.Log("warn", "host-tools", fmt.Sprintf("remove error=%v", err))
		return
	}
	s.mu.Lock()
	s.hostToolsRemoved = true
	s.mu.Unlock()
}

func (s *Server) closeHostTools() {
	s.mu.Lock()
	tools := s.hostTools
	s.hostTools = nil
	s.mu.Unlock()
	if tools != nil {
		tools.close()
	}
}

// hostToolDirs are the folders the user opened as projects, the current one
// first: the same folders the environment already reads and writes.
func (s *Server) hostToolDirs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var dirs []string
	for path := range s.projectShares {
		if path != s.preferences.Workspace {
			dirs = append(dirs, path)
		}
	}
	sort.Strings(dirs)
	if _, shared := s.projectShares[s.preferences.Workspace]; shared {
		dirs = append([]string{s.preferences.Workspace}, dirs...)
	}
	return dirs
}

// hostToolsToken is this profile's token, created on first use.
func (s *Server) hostToolsToken() (string, error) {
	path := filepath.Join(s.profile, "host-tools.token")
	if data, err := os.ReadFile(path); err == nil {
		if token := strings.TrimSpace(string(data)); len(token) >= 32 {
			return token, nil
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	token, err := hostbridge.NewToken()
	if err != nil {
		return "", err
	}
	return token, os.WriteFile(path, []byte(token+"\n"), 0o600)
}

// hostToolsEntry is the server entry written into Claude's configuration.
func hostToolsEntry(token string) map[string]any {
	return map[string]any{
		"type":    "http",
		"url":     fmt.Sprintf("http://127.0.0.1:%d/", hostToolsPort),
		"headers": map[string]string{"Authorization": "Bearer " + token},
	}
}

// writeHostToolsConfig adds the entry to, or removes it from, each Claude
// Code profile and the desktop app in the environment. The token travels on SSH stdin, never argv.
func (s *Server) writeHostToolsConfig(ctx context.Context, token, action string) error {
	entry, err := json.Marshal(hostToolsEntry(token))
	if err != nil {
		return err
	}
	cmd := s.sshCommand(ctx, "-T", s.sshTarget(), "--", "exec python3 - computer "+action)
	cmd.Stdin = strings.NewReader(hostToolsConfigInput(entry))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && stderr.Len() > 0 {
			return fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
		}
		return err
	}
	return nil
}

// hostToolsConfigInput is the script preceded by the values it reads back
// from its own source, so the entry is never part of a command line.
func hostToolsConfigInput(entry []byte) string {
	// A JSON string of ASCII is also a Python string literal.
	literal, _ := json.Marshal(string(entry))
	relay, _ := json.Marshal(hostToolsRelayScript)
	return "ENTRY = " + string(literal) + "\nRELAY = " + string(relay) + "\n" + hostToolsConfigScript
}
