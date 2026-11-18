//go:build !windows

package hostbridge

import (
	"os"
	"os/exec"
	"syscall"
)

// shellCommand runs the command in the user's own shell, so it sees the same
// PATH and tools as their terminal.
func shellCommand(command string) *exec.Cmd {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell, "-c", command)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd
}

func killTree(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
