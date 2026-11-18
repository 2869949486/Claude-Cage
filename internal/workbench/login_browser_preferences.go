package workbench

import (
	"context"
	"errors"
)

// A missing file means private. Only the root-controlled opt-out marker is
// shared between the browser user and the account desktop's private HOME.
func linuxLoginPreferences(reuse bool) string {
	if reuse {
		return "if ! test -f /etc/claude-cage/login-browser-mode; then sudo install -m 0644 /dev/null /etc/claude-cage/login-browser-mode || exit 1; fi"
	}
	return "if test -f /etc/claude-cage/login-browser-mode; then sudo unlink /etc/claude-cage/login-browser-mode || exit 1; fi"
}
func macLoginPreferences(reuse bool) string {
	if reuse {
		return `umask 077; d="$HOME/Library/Application Support/Cage"; mkdir -p "$d" && touch "$d/reuse-claude-login"`
	}
	return `f="$HOME/Library/Application Support/Cage/reuse-claude-login"; if test -f "$f"; then unlink "$f"; fi`
}

func (s *Server) syncLoginPreferences(ctx context.Context, reuse bool) error {
	// The Windows controller receives the mode with each workbench login request.
	if s.windowsGuest != nil {
		return nil
	}
	script := linuxLoginPreferences(reuse)
	if s.macosGuest != nil {
		script = macLoginPreferences(reuse)
	}
	if _, err := s.guest(ctx, script); err != nil {
		return errors.New("未能将登录浏览器设置同步到环境，请重新连接后重试")
	}
	return nil
}
