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
	// A command the dialog cannot show faithfully is one the user cannot
	// judge: control and invisible format characters can hide part of it.
	if strings.ContainsFunc(request.Command+request.Dir, func(r rune) bool {
		return (unicode.IsControl(r) && r != '\n' && r != '\t') || unicode.Is(unicode.Cf, r)
	}) {
		return errors.New("the command contains control or invisible characters and was not run")
	}
	if len(request.Command) > hostApprovalCommandMax {
		return errors.New("the command is too long to show for approval and was not run; put it in a script file")
	}
	if a.sessionAllowed(request.Project) {
		return nil
	}
	a.dialog.Lock()
	defer a.dialog.Unlock()
	// Another call may have been answered for the session while this one waited.
	if a.sessionAllowed(request.Project) {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, hostApprovalWait)
	defer cancel()
	scope, answered := a.ask(ctx, "允许 Claude 在这台电脑上运行命令？", hostApprovalMessage(request))
	switch {
	case !answered:
		return errors.New("no approval dialog could be shown on the user's computer, so the command was not run")
	case scope == desktop.Session:
		a.mu.Lock()
		a.allowed[request.Project] = true
		a.mu.Unlock()
	case scope != desktop.Once:
		return errors.New("the user did not approve this command, so it was not run")
	}
	return nil
}

func (a *hostApprovals) sessionAllowed(project string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.allowed[project]
}

func hostApprovalMessage(request hostbridge.CommandRequest) string {
	return "项目「" + filepath.Base(request.Project) + "」\n目录　" + request.Dir + "\n\n" + request.Command +
		"\n\n命令以你的用户权限运行，可以访问这台电脑上的任何内容。「本次会话都允许」对该项目生效，直到环境停止。"
}
