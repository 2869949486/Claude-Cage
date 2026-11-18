package workbench

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/sylvinus/agent-vm/internal/desktop"
	"github.com/sylvinus/agent-vm/internal/hostbridge"
)

const (
	hostApprovalWait       = 2 * time.Minute
	hostApprovalCommandMax = 4000
)

// hostApprovals asks the user before each command Claude runs on this
// computer. An answer for the session covers one project until the tools
// stop; nothing is remembered across starts.
type hostApprovals struct {
	ask func(ctx context.Context, title, msg string) (desktop.Scope, bool)
	// dialog keeps one question on screen at a time.
	dialog  sync.Mutex
	mu      sync.Mutex
	allowed map[string]bool
}

func newHostApprovals() *hostApprovals {
	return &hostApprovals{ask: desktop.AskScope, allowed: map[string]bool{}}
}

func (a *hostApprovals) approve(ctx context.Context, request hostbridge.CommandRequest) error {
	return a.decide(ctx, request.Project, request.Command+request.Dir, len(request.Command),
		"允许 Claude 在这台电脑上运行命令？", hostApprovalMessage(request))
}

// approveTool asks about one call to a plugin's tool. An answer for the
// session covers that plugin.
func (a *hostApprovals) approveTool(ctx context.Context, request hostbridge.ToolRequest) error {
	return a.decide(ctx, "plugin:"+request.Plugin, request.Arguments, len(request.Arguments),
		"允许 Claude 使用这台电脑上的插件？",
		"插件「"+request.Plugin+"」\n工具　"+request.Tool+"\n\n"+request.Arguments+
			"\n\n插件以你的用户权限运行。「本次会话都允许」对该插件生效，直到环境停止。")
}

// decide asks unless key was already allowed for the session. shown is the
// text the user must be able to read in full to judge the request.
func (a *hostApprovals) decide(ctx context.Context, key, shown string, length int, title, message string) error {
	// A request the dialog cannot show faithfully is one the user cannot
	// judge: control and invisible format characters can hide part of it.
	if strings.ContainsFunc(shown, func(r rune) bool {
		return (unicode.IsControl(r) && r != '\n' && r != '\t') || unicode.Is(unicode.Cf, r)
	}) {
		return errors.New("the request contains control or invisible characters and was not run")
	}
	if length > hostApprovalCommandMax {
		return errors.New("the request is too long to show for approval and was not run; put long content in a file")
	}
	if a.sessionAllowed(key) {
		return nil
	}
	a.dialog.Lock()
	defer a.dialog.Unlock()
	// Another call may have been answered for the session while this one waited.
	if a.sessionAllowed(key) {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, hostApprovalWait)
	defer cancel()
	scope, answered := a.ask(ctx, title, message)
	switch {
	case !answered:
		return errors.New("no approval dialog could be shown on the user's computer, so nothing was run")
	case scope == desktop.Session:
		a.mu.Lock()
		a.allowed[key] = true
		a.mu.Unlock()
	case scope != desktop.Once:
		return errors.New("the user did not approve this request, so nothing was run")
	}
	return nil
}

func (a *hostApprovals) sessionAllowed(key string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.allowed[key]
}

func hostApprovalMessage(request hostbridge.CommandRequest) string {
	return "项目「" + filepath.Base(request.Project) + "」\n目录　" + request.Dir + "\n\n" + request.Command +
		"\n\n命令以你的用户权限运行，可以访问这台电脑上的任何内容。「本次会话都允许」对该项目生效，直到环境停止。"
}
