package workbench

import (
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"

	"github.com/sylvinus/agent-vm/internal/guestos"
)

func TestGuestInstallCommandBootResult(t *testing.T) {
	if os.Getenv("CAGE_TEST_ISO_BOOT_HELPER") == "1" {
		for _, chunk := range strings.Split(os.Getenv("CAGE_TEST_ISO_BOOT_STDOUT"), "|") {
			_, _ = io.WriteString(os.Stdout, chunk)
		}
		_, _ = io.WriteString(os.Stderr, os.Getenv("CAGE_TEST_ISO_BOOT_STDERR"))
		if os.Getenv("CAGE_TEST_ISO_BOOT_EXIT") == "1" {
			os.Exit(1)
		}
		os.Exit(0)
	}

	const failed = "CAGE_WINDOWS_ISO_BOOT failed"
	const unconfirmed = "CAGE_WINDOWS_ISO_BOOT unconfirmed"
	const unknown = "客户机安装未完成"
	var jobs jobManager
	var op sync.Mutex
	for _, tc := range []struct {
		name, system, stdout, stderr, exit, want string
	}{
		{"confirmed", guestos.Windows11, "CAGE_WINDOWS_ISO_|BOOT failed\r\n", "host detail\n", "1", "18603"},
		{"unconfirmed", guestos.Windows11, unconfirmed, "", "1", "尚无法确认"},
		{"unknown", guestos.Windows11, "trace " + failed + "\n" + failed + " extra\n", "", "1", unknown},
		{"stderr", guestos.Windows11, "", failed + "\n", "1", unknown},
		{"macOS", guestos.MacOS, failed + "\n", "", "1", unknown},
		{"success", guestos.Windows11, failed + "\n", "", "0", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestGuestInstallCommandBootResult$")
			cmd.Env = append(os.Environ(), "CAGE_TEST_ISO_BOOT_HELPER=1", "CAGE_TEST_ISO_BOOT_STDOUT="+tc.stdout, "CAGE_TEST_ISO_BOOT_STDERR="+tc.stderr, "CAGE_TEST_ISO_BOOT_EXIT="+tc.exit)
			if _, err := jobs.submit(&op, "guest-install", 0, nil, nil, func() error {
				return runGuestInstallCommand(cmd, tc.system, jobs.execution())
			}); err != nil {
				t.Fatal(err)
			}
			job := awaitJobIdle(t, &jobs)
			if tc.want == "" && job.Error != "" || tc.want != "" && !strings.Contains(job.Error, tc.want) {
				t.Fatalf("unexpected job error: %q", job.Error)
			}
			if tc.want != "18603" && strings.Contains(job.Error, "18603") {
				t.Fatalf("reported an unobserved Hyper-V event: %s", job.Error)
			}
			for _, line := range []string{tc.stdout, tc.stderr} {
				for _, part := range strings.FieldsFunc(strings.ReplaceAll(line, "|", ""), func(r rune) bool { return r == '\r' || r == '\n' }) {
					if !strings.Contains(job.Log, part) {
						t.Fatalf("missing %q in operation log: %q", part, job.Log)
					}
				}
			}
		})
	}
}
