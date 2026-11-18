package workbench

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/sylvinus/agent-vm/internal/desktop"
	"github.com/sylvinus/agent-vm/internal/hostbridge"
)

func approvalsAnswering(scope desktop.Scope, answered bool, asked *atomic.Int32, shown *string) *hostApprovals {
	approvals := newHostApprovals()
	approvals.ask = func(_ context.Context, _, msg string) (desktop.Scope, bool) {
		asked.Add(1)
		if shown != nil {
			*shown = msg
		}
		return scope, answered
	}
	return approvals
}

func TestHostApprovalOnceIsAskedEveryTime(t *testing.T) {
	var asked atomic.Int32
	var shown string
	approvals := approvalsAnswering(desktop.Once, true, &asked, &shown)
	request := hostbridge.CommandRequest{Command: "make test", Dir: "/p/app/sub", Project: "/p/app"}
	for range 2 {
		if err := approvals.approve(context.Background(), request); err != nil {
			t.Fatal(err)
		}
	}
	if asked.Load() != 2 {
		t.Fatalf("asked %d times", asked.Load())
	}
	for _, want := range []string{"make test", "/p/app/sub", "「app」"} {
		if !strings.Contains(shown, want) {
			t.Fatalf("the dialog does not show %q: %s", want, shown)
		}
	}
}

func TestHostApprovalForTheSessionCoversOnlyThatProject(t *testing.T) {
	var asked atomic.Int32
	approvals := approvalsAnswering(desktop.Session, true, &asked, nil)
	first := hostbridge.CommandRequest{Command: "ls", Dir: "/p/a", Project: "/p/a"}
	for range 3 {
		if err := approvals.approve(context.Background(), first); err != nil {
			t.Fatal(err)
		}
	}
	if asked.Load() != 1 {
		t.Fatalf("asked %d times for one project", asked.Load())
	}
	if err := approvals.approve(context.Background(), hostbridge.CommandRequest{Command: "ls", Dir: "/p/b", Project: "/p/b"}); err != nil {
		t.Fatal(err)
	}
	if asked.Load() != 2 {
		t.Fatalf("another project was not asked about: %d", asked.Load())
	}
	if newHostApprovals().sessionAllowed("/p/a") {
		t.Fatal("an approval outlived its session")
	}
}

func TestHostApprovalRefusals(t *testing.T) {
	request := hostbridge.CommandRequest{Command: "ls", Dir: "/p/a", Project: "/p/a"}
	var asked atomic.Int32
	if err := approvalsAnswering(desktop.Deny, true, &asked, nil).approve(context.Background(), request); err == nil {
		t.Fatal("a denied command was approved")
	}
	if err := approvalsAnswering(desktop.Deny, false, &asked, nil).approve(context.Background(), request); err == nil || !strings.Contains(err.Error(), "no approval dialog") {
		t.Fatalf("without a dialog: %v", err)
	}
	asked.Store(0)
	approvals := approvalsAnswering(desktop.Session, true, &asked, nil)
	for _, command := range []string{"echo a\x1b[2Kb", "echo a‮b", "echo ​hidden", strings.Repeat("x", hostApprovalCommandMax+1)} {
		if err := approvals.approve(context.Background(), hostbridge.CommandRequest{Command: command, Dir: "/p/a", Project: "/p/a"}); err == nil {
			t.Fatalf("%q was approved", command)
		}
	}
	if asked.Load() != 0 {
		t.Fatal("the user was asked about a command that cannot be shown")
	}
	if err := approvals.approve(context.Background(), hostbridge.CommandRequest{Command: "printf 'a\\n'\n\tls", Dir: "/p/a", Project: "/p/a"}); err != nil {
		t.Fatalf("an ordinary multi-line command was refused: %v", err)
	}
}

func TestHostApprovalShowsOneDialogAtATime(t *testing.T) {
	approvals := newHostApprovals()
	var open, most, asked atomic.Int32
	release := make(chan struct{})
	approvals.ask = func(context.Context, string, string) (desktop.Scope, bool) {
		asked.Add(1)
		if now := open.Add(1); now > most.Load() {
			most.Store(now)
		}
		<-release
		open.Add(-1)
		return desktop.Session, true
	}
	var wait sync.WaitGroup
	for range 5 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_ = approvals.approve(context.Background(), hostbridge.CommandRequest{Command: "ls", Dir: "/p/a", Project: "/p/a"})
		}()
	}
	close(release)
	wait.Wait()
	if most.Load() != 1 || asked.Load() != 1 {
		t.Fatalf("%d dialogs at once, %d in all", most.Load(), asked.Load())
	}
}
