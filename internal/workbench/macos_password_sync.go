package workbench

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"al.essio.dev/pkg/shellescape"
	"github.com/sylvinus/agent-vm/internal/guestos"
	"github.com/sylvinus/agent-vm/internal/host"
)

func (s *Server) syncMacGuestPassword(ctx context.Context) error {
	if s.macosGuest == nil || s.account == nil {
		return nil
	}
	install, err := guestos.LoadInstallation(s.profile)
	if err != nil {
		return err
	}
	if install == nil {
		return nil
	}
	return s.account.syncMacPassword(ctx, install.ID, s.macosGuest.User, func(ctx context.Context, oldPassword, newPassword string) error {
		return s.applyMacGuestPassword(ctx, install.ID, oldPassword, newPassword)
	})
}

func (s *Server) applyMacGuestPassword(ctx context.Context, id uuid.UUID, oldPassword, newPassword string) error {
	return s.applyMacGuestAccount(ctx, id, "password", oldPassword+"\n"+newPassword+"\n")
}

// Only the first-setup route calls this, after checking its closed egress gate.
func (s *Server) prepareMacGuestAccount(ctx context.Context) error {
	s.macSetupAccountMu.Lock()
	defer s.macSetupAccountMu.Unlock()
	if s.macSetupAccountPrepared {
		return nil
	}
	install, err := guestos.LoadInstallation(s.profile)
	if err != nil || install == nil || s.macosGuest == nil || install.ID.String() != s.macosGuest.SetupID || !s.macSetupPending() {
		return errors.New("首次设置身份已改变")
	}
	password, err := s.account.savedMacGuestPassword(ctx, install.ID)
	if err != nil || password == "" {
		return errors.New("客机凭据不可用，请核对安装记录与保险箱")
	}
	if err = s.applyMacGuestAccount(ctx, install.ID, "prepare", password+"\n"); err != nil {
		return err
	}
	s.macSetupAccountPrepared = true
	return nil
}

func (s *Server) applyMacGuestAccount(ctx context.Context, id uuid.UUID, operation, input string) error {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	provision, err := guestos.MacOSProvisionUser(s.profile)
	if err != nil {
		return err
	}
	if provision != "cageprovision" {
		return errors.New("客机置备身份不匹配")
	}
	args, err := guestos.MacOSSSHArgs(s.profile, provision)
	if err != nil {
		return err
	}
	command := func(ctx context.Context, script string) *exec.Cmd {
		cmd := exec.CommandContext(ctx, sshExecutable(), append(append([]string{}, args...), "-T", "cage-macos", "--", "exec /bin/sh -ec "+shellescape.Quote(script))...)
		cmd.Env = sshEnvironment()
		host.HideCommandWindow(cmd)
		return cmd
	}
	// Use this build's helper so older managed guests can adopt the shared
	// credential without reinstalling their applications or personal disk.
	helper, err := os.ReadFile(filepath.Join(filepath.Dir(s.exe), "guest-os", "cage-finish-initial-setup"))
	if err != nil {
		return err
	}
	out, err := command(ctx, `umask 077; mktemp -d /private/var/tmp/cage-account.XXXXXXXX`).Output()
	stage := strings.TrimSpace(string(out))
	if err != nil || !regexp.MustCompile(`^/private/var/tmp/cage-account\.[A-Za-z0-9]{8}$`).MatchString(stage) {
		return errors.New("无法准备客机账户组件")
	}
	admin := " < /Users/" + provision + "/password"
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = command(cleanup, `sudo -S -p '' /bin/rm -rf `+stage+admin).Run()
	}()
	upload := command(ctx, `umask 077; cat > `+stage+`/helper`)
	upload.Stdin = bytes.NewReader(helper)
	if err = upload.Run(); err != nil {
		return err
	}
	script := `chown -R root:wheel ` + stage + `; chmod 700 ` + stage + ` ` + stage + `/helper; chmod 600 ` + stage + `/input; ` + stage + `/helper ` + operation + ` ` + id.String() + ` ` + s.macosGuest.User + ` < ` + stage + `/input`
	if operation == "prepare" {
		// Finish must use this helper too: older builds only revoke the former
		// separate administrator, leaving the user's new membership behind.
		script += `; /usr/bin/install -m 755 ` + stage + `/helper /usr/local/libexec/.cage-setup-account; /bin/mv -f /usr/local/libexec/.cage-setup-account /usr/local/libexec/cage-finish-initial-setup`
	}
	apply := command(ctx, `umask 077; cat > `+stage+`/input; sudo -S -p '' /bin/sh -ec `+shellescape.Quote(script)+admin)
	apply.Stdin = strings.NewReader(input)
	if out, err := apply.CombinedOutput(); err != nil {
		return fmt.Errorf("guest account %s: %w: %.2048s", operation, err, out)
	}
	return nil
}
