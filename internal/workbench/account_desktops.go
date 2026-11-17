package workbench

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"al.essio.dev/pkg/shellescape"
	"github.com/sylvinus/agent-vm/internal/containerenv"
)

//go:embed linux-account-desktop.sh
var linuxAccountDesktop string

type desktopEntry struct {
	ID        string `json:"id"`
	Number    uint32 `json:"number"`
	Label     string `json:"label"`
	Running   bool   `json:"running"`
	Dedicated bool   `json:"dedicated"`
}

func (s *Server) accountDesktopsSupported() bool {
	return s.macosGuest == nil && s.windowsGuest == nil && !containerenv.Configured(s.profile)
}

func (s *Server) accountDesktopList(w http.ResponseWriter, r *http.Request) {
	s.claudeAccounts.mu.Lock()
	list, err := s.loadClaudeAccounts()
	s.claudeAccounts.mu.Unlock()
	if err != nil {
		requestError(w, err)
		return
	}
	supported := s.accountDesktopsSupported()
	units := map[string]bool{}
	if supported && len(list.Accounts) > 0 && s.vmRunning() {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		output, err := s.guest(ctx, "set -o pipefail; systemctl list-units --state=active --type=service --no-pager --no-legend --plain 'desktop-*.service' | awk '{print $1}'")
		if err != nil {
			http.Error(w, "无法读取 Desktop 运行状态", 502)
			return
		}
		for _, unit := range strings.Fields(string(output)) {
			units[unit] = true
		}
	}
	entries := make([]desktopEntry, 0, len(list.Accounts))
	for _, a := range list.Accounts {
		entries = append(entries, desktopEntry{a.ID, a.Number, a.Label, units["desktop-"+a.ID+".service"], a.DesktopDedicatedNetwork || a.ProxyNodeID != ""})
	}
	jsonReply(w, map[string]any{"supported": supported, "accounts": entries})
}

func (s *Server) accountDesktop(w http.ResponseWriter, r *http.Request) {
	id, action := r.PathValue("id"), r.PathValue("action")
	if !validClaudeID(id) || !(r.Method == "GET" && (action == "vnc" || action == "vnc-credentials") || r.Method == "POST" && (action == "start" || action == "stop")) {
		http.NotFound(w, r)
		return
	}
	if r.Method == "POST" {
		var input struct{}
		if !readJSON(w, r, &input) {
			return
		}
	}
	if !s.accountDesktopsSupported() {
		http.Error(w, "此环境尚未支持独立 Desktop", http.StatusNotImplemented)
		return
	}
	if !s.vmRunning() {
		http.Error(w, "请先启动环境", 409)
		return
	}
	s.claudeAccounts.mu.Lock()
	list, err := s.loadClaudeAccounts()
	s.claudeAccounts.mu.Unlock()
	if err != nil {
		requestError(w, err)
		return
	}
	account := list.find(id)
	if account == nil {
		http.NotFound(w, r)
		return
	}
	run := "/run/desktop-" + id
	switch action {
	case "vnc":
		s.streamDesktopSocket(w, r, run+"/vnc.sock")
		return
	case "vnc-credentials":
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		b, err := s.guest(ctx, "systemctl is-active --quiet desktop-"+id+".service && cat "+run+"/password")
		if err != nil || len(b) != 8 {
			http.Error(w, "此 Desktop 尚未启动", 409)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		jsonReply(w, map[string]string{"password": string(b)})
		return
	}
	s.launch(w, "desktop-instance-"+action, func() error {
		// Reload inside the job's operation lock. A draft can be removed or
		// its dedicated-network selection can change between admission and execution.
		s.claudeAccounts.mu.Lock()
		current, err := s.loadClaudeAccounts()
		s.claudeAccounts.mu.Unlock()
		if err != nil {
			return err
		}
		selected := current.find(id)
		if selected == nil {
			return errors.New("账号已移除，请刷新 Desktop 列表")
		}
		return s.changeAccountDesktop(s.operationContext(), *selected, action)
	})
}

func (s *Server) changeAccountDesktop(parent context.Context, account claudeAccount, action string) error {
	var err error
	scope := "stop"
	var key []byte
	if action == "start" {
		scope = "shared"
		if account.DesktopDedicatedNetwork {
			scope = "dedicated"
		}
		if account.ProxyNodeID != "" {
			if err = s.ensureAccountNetwork(parent, account.ID, account.ProxyNodeID); err != nil {
				return err
			}
			scope = "node"
		}
		key, err = s.account.desktopKey()
		if err != nil {
			return err
		}
		defer clear(key)
	}
	ctx, cancel := context.WithTimeout(parent, 100*time.Second)
	defer cancel()
	command := fmt.Sprintf("exec /bin/bash -c %s -- %s %s %s", shellescape.Quote(linuxAccountDesktop), account.ID, account.guestID(), scope)
	cmd := s.sshCommand(ctx, "-T", s.sshTarget(), "--", command)
	cmd.Stdin = bytes.NewReader(key)
	output, err := cmd.CombinedOutput()
	if err != nil {
		msg := "Desktop 操作失败，请确认已安装 Claude Desktop 并检查客机服务"
		if bytes.Contains(output, []byte("专属网络尚未就绪")) {
			msg = "此账号的专属网络尚未就绪"
		}
		return errors.New(msg)
	}
	return nil
}
