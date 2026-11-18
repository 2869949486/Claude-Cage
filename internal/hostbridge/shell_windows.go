//go:build windows

package hostbridge

import (
	"os/exec"
	"strconv"
	"syscall"
)

func shellCommand(command string) *exec.Cmd {
	cmd := exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd
}

func killTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	kill := exec.Command("taskkill.exe", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if kill.Run() != nil {
		_ = cmd.Process.Kill()
	}
}
