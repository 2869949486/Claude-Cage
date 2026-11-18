package workbench

import (
	"context"
	"errors"
	"net"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/sylvinus/agent-vm/internal/cage"
	"github.com/sylvinus/agent-vm/internal/managedproxy"
)

func interfaceMonitorServer(t *testing.T) (*Server, *cage.EgressGate) {
	t.Helper()
	s := testServer(t)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	cfg, _ := loadConfig(s.configPath)
	p, _ := managedproxy.Load(s.profile)
	p.Port = listener.Addr().(*net.TCPAddr).Port
	if err = p.Save(s.profile); err != nil {
		t.Fatal(err)
	}
	cfg.ProxyURL = p.Endpoint()
	if err := writePrivate(s.configPath, cfg); err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := os.MkdirAll(filepath.Join(s.profile, "proxy"), 0700); err != nil {
		t.Fatal(err)
	}
	data := []byte("interface-name: en0\nmixed-port: " + strconv.Itoa(port) + "\n")
	if err := os.WriteFile(filepath.Join(s.profile, "proxy", "config.yaml"), data, 0600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(s.profile, "state", "lima", cage.InstanceName(s.profile, s.environmentDir()))
	if err := writePrivate(filepath.Join(dir, "cage-running.json"), map[string]int{"pid": os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	gate, err := cage.NewEgressGate(cfg)
	if err != nil {
		t.Fatal(err)
	}
	stop, err := cage.StartGateControl(s.configPath, dir, gate)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(stop)
	if err := gate.BeginCheck(); err != nil {
		t.Fatal(err)
	}
	return s, gate
}

func TestInterfaceRecoveryRevokesGateAndPreservesManualPause(t *testing.T) {
	previous := physicalProxyInterface
	t.Cleanup(func() { physicalProxyInterface = previous })
	for _, tc := range []struct {
		name, next   string
		paused, lost bool
	}{
		{"Wi-Fi to Ethernet", "en7", false, false},
		{"Ethernet while paused", "en7", true, false},
		{"same interface after outage", "en0", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, gate := interfaceMonitorServer(t)
			s.networkPaused, s.proxyNetworkLost = tc.paused, tc.lost
			physicalProxyInterface = func(context.Context) (string, error) { return tc.next, nil }
			observed := s.observeProxyInterface(context.Background())
			// Keep the recovery queued: assert the synchronous revocation before
			// any core can restart, then cancel through the normal stop path.
			s.op.Lock()
			s.applyProxyInterfaceObservation(observed)
			s.mu.Lock()
			queued, paused := s.jobs.snapshot().Kind == "proxy-network" && s.jobs.snapshot().Running, s.networkPaused
			s.mu.Unlock()
			closed := gate.Status().Mode == cage.GateClosed
			finished := make(chan struct{})
			s.launch(httptest.NewRecorder(), "stop", func() error { close(finished); return nil })
			s.op.Unlock()
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("stop could not cancel network recovery")
			}
			s.op.Lock()
			s.op.Unlock()
			if !queued || !closed || paused != tc.paused {
				t.Fatalf("queued=%v closed=%v paused=%v; wanted pause=%v", queued, closed, paused, tc.paused)
			}
		})
	}
}

func TestMissingPhysicalInterfaceClosesGateWithoutUnboundFallback(t *testing.T) {
	s, gate := interfaceMonitorServer(t)
	grantTestGate(t, gate)
	before := gate.Status()
	destination := netip.MustParseAddrPort("8.8.8.8:443")
	if before.Mode != cage.GateOpen || !gate.Allows("tcp", destination) {
		t.Fatal("fixture did not grant public egress before the network failure")
	}
	previous := physicalProxyInterface
	t.Cleanup(func() { physicalProxyInterface = previous })
	const disconnected = "physical network unavailable"
	physicalProxyInterface = func(context.Context) (string, error) { return "", errors.New(disconnected) }
	observed := s.observeProxyInterface(context.Background())
	s.op.Lock()
	s.applyProxyInterfaceObservation(observed)
	s.op.Unlock()
	after := gate.Status()
	if after.Mode != cage.GateClosed || after.Reason != disconnected || after.Epoch <= before.Epoch ||
		gate.Allows("tcp", destination) || s.networkPaused || !s.proxyNetworkLost || s.jobs.snapshot().Running {
		t.Fatalf("physical network failure did not revoke public egress: %+v", after)
	}
	data, _ := os.ReadFile(filepath.Join(s.profile, "proxy", "config.yaml"))
	if !strings.Contains(string(data), "interface-name: en0") {
		t.Fatal("missing uplink removed the existing binding")
	}
}

func TestPhysicalInterfaceObservationIsDiscardedAfterNetworkChange(t *testing.T) {
	previous := physicalProxyInterface
	physicalProxyInterface = func(context.Context) (string, error) { return "", errors.New("old physical network unavailable") }
	t.Cleanup(func() { physicalProxyInterface = previous })
	for _, changed := range []string{"configuration", "job"} {
		t.Run(changed, func(t *testing.T) {
			s, gate := interfaceMonitorServer(t)
			grantTestGate(t, gate)
			observed := s.observeProxyInterface(context.Background())
			if changed == "configuration" {
				cfg, err := loadConfig(s.configPath)
				if err != nil {
					t.Fatal(err)
				}
				cfg.Timezone = "Etc/GMT+1"
				if err := writePrivate(s.configPath, cfg); err != nil {
					t.Fatal(err)
				}
			} else {
				s.setJobForTest(Job{ID: "completed-during-probe"})
			}
			s.op.Lock()
			s.applyProxyInterfaceObservation(observed)
			s.op.Unlock()
			if gate.Status().Mode != cage.GateOpen || s.proxyNetworkLost || s.safety.monitorError != "" {
				t.Fatal("a stale interface result revoked the current network state")
			}
		})
	}
}
