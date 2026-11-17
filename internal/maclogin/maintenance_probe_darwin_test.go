//go:build darwin && (amd64 || (arm64 && cgo && !no_vz))

package maclogin

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

func TestMaintenanceProbeDistinguishesComponentFailuresFromTransportFailures(t *testing.T) {
	for _, test := range []struct {
		name, script, code, recovery string
	}{
		{"invalid helper", "exit 72", "component_update_required", "environment-update"},
		{"missing helper", "exit 127", "component_update_required", "environment-update"},
		{"logged out", "exit 73", "requires_gui_login", "guest-login"},
		{"ssh disconnected", "exit 255", "maintenance_probe_unavailable", ""},
		{"invalid response", "printf 'not-json'", "maintenance_probe_unavailable", ""},
		{"guest error", `printf '{"error":"maintenance_window_obscured"}'`, "maintenance_window_obscured", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			window, err := runMaintenanceProbe(ctx, exec.CommandContext(ctx, "/bin/sh", "-c", test.script))
			if err == nil || window.Error != test.code {
				t.Fatalf("failure misclassified: %q, %v", window.Error, err)
			}
			result := maintenanceFailure(window, err, false)
			if result.Recovery != test.recovery {
				t.Fatalf("incorrect recovery action: %q", result.Recovery)
			}
		})
	}
}

func TestMaintenanceProbeTimeoutDoesNotRequestAnUpdate(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	window, err := runMaintenanceProbe(ctx, exec.CommandContext(ctx, "/bin/sleep", "5"))
	if err == nil || window.Error != "maintenance_probe_unavailable" || ctx.Err() == nil {
		t.Fatalf("timeout misclassified: %q, %v", window.Error, err)
	}
}

func TestMaintenanceProbeAcceptsSuccessfulResponse(t *testing.T) {
	window, err := runMaintenanceProbe(context.Background(), exec.Command("/bin/sh", "-c", `printf '{"version":1,"session":"ready"}'`))
	if err != nil || window.Version != 1 || window.Session != "ready" {
		t.Fatalf("valid response rejected: %#v, %v", window, err)
	}
}
