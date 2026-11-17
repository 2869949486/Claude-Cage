package workbench

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func claudeAuthorizationURL(raw string) bool {
	if len(raw) > 8192 || strings.ContainsAny(raw, "\r\n\t \\") {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery == "" {
		return false
	}
	path := strings.TrimSuffix(u.EscapedPath(), "/")
	if path != "/oauth/authorize" && path != "/cai/oauth/authorize" {
		return false
	}
	switch strings.ToLower(u.Host) {
	case "claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com", "platform.anthropic.com":
		return true
	}
	return false
}

func (s *Server) terminalLoginLink(w http.ResponseWriter, r *http.Request) {
	var input struct {
		URL  string `json:"url"`
		Open bool   `json:"open,omitempty"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if !claudeAuthorizationURL(input.URL) {
		http.Error(w, "请选择 Claude 官方授权链接", 400)
		return
	}
	terminal := s.terminals.get(r.PathValue("id"))
	if terminal == nil {
		http.NotFound(w, r)
		return
	}
	terminal.loginLinkMu.Lock()
	defer terminal.loginLinkMu.Unlock()
	if !terminal.ownsConversation() {
		http.Error(w, "登录终端已关闭，请重新发起登录", 409)
		return
	}
	s.mu.Lock()
	ready, token := s.ready, s.credentials.Token
	s.mu.Unlock()
	if !ready {
		http.Error(w, "请先启动工作环境", 409)
		return
	}

	a, err := s.accountForRoute(terminal.claudeAccountID)
	if err != nil {
		requestError(w, err)
		return
	}
	if a.ProxyNodeID != "" {
		if input.Open {
			ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
			defer cancel()
			cmd := s.sshCommand(ctx, "-T", s.sshTarget(), "--", "/usr/local/lib/account-routes/"+a.ID+"/open --stdin")
			cmd.Stdin = strings.NewReader(input.URL)
			if err := cmd.Run(); err != nil {
				http.Error(w, "账号授权浏览器未能打开，请重新打开该账号的 Desktop", 502)
				return
			}
		}
		jsonReply(w, map[string]any{"desktop": desktopEntry{ID: a.ID, Number: a.Number, Label: a.Label, Dedicated: true}})
		return
	}
	if input.Open {
		http.Error(w, "账号出口已更改，请重新打开授权链接", 409)
		return
	}
	login := terminal.id
	if terminal.loginGuestID != "" {
		// Match the official CLI helper's private browser and cleanup key.
		login = terminal.loginGuestID
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	payload, _ := json.Marshal(map[string]string{"login": login, "url": input.URL})
	data, err := s.guestAPI(ctx, token, "POST", "/login-open", payload)
	if terminal.loginGuestID == "" {
		terminal.loginLinkCleanup.Do(func() {
			go func() {
				lifetime := s.lifetimeContext()
				select {
				case <-lifetime.Done():
					return
				case <-terminal.done:
				}
				terminal.loginLinkMu.Lock()
				defer terminal.loginLinkMu.Unlock()
				ctx, cancel := context.WithTimeout(lifetime, 8*time.Second)
				defer cancel()
				body, _ := json.Marshal(map[string]string{"login": login})
				_, _ = s.guestAPI(ctx, token, "POST", "/login-finish", body)
			}()
		})
	}
	var tab struct {
		ID string `json:"id"`
	}
	if err != nil || json.Unmarshal(data, &tab) != nil || tab.ID == "" {
		http.Error(w, "Cage 浏览器未能打开授权页，请检查浏览器连接并重试", 502)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonReply(w, tab)
}
