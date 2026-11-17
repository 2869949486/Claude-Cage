package workbench

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"github.com/sylvinus/agent-vm/internal/diagnostics"
	"github.com/sylvinus/agent-vm/internal/managedproxy"
	"github.com/sylvinus/agent-vm/internal/usererror"
)

var physicalProxyInterface = managedproxy.PhysicalInterface

// The lifecycle lock is held by monitorNetwork. Schedule a regular job so a
// user stop can cancel recovery and pause can still revoke the gate immediately.
func (s *Server) monitorProxyInterface() {
	if s.busy() {
		return
	}
	cfg, err := loadConfig(s.configPath)
	if err != nil || cfg.RequireManagedProxy(s.profile) != nil {
		return
	}
	name, err := physicalProxyInterface(s.lifetimeContext())
	if err != nil {
		_ = s.closeProxyGate(err.Error())
		s.mu.Lock()
		s.safety.monitorError = err.Error()
		s.proxyNetworkLost = true
		s.mu.Unlock()
		return
	}
	s.mu.Lock()
	lost := s.proxyNetworkLost
	retry := s.proxyNetworkRetry
	s.mu.Unlock()
	bound, err := managedproxy.BoundInterface(filepath.Join(managedproxy.Dir(s.profile), "config.yaml"))
	if err != nil || (bound == name && !lost) {
		return
	}
	if lost && time.Now().Before(retry) {
		return
	}
	if !s.vmRunning() {
		return
	}
	// Revoke the previous report before the asynchronous recovery can start.
	if err := s.closeProxyGate("物理网卡已变化，正在重新绑定代理并检查出口"); err != nil {
		return
	}
	s.mu.Lock()
	s.proxyNetworkLost = true
	s.proxyNetworkRetry = time.Now().Add(15 * time.Second)
	s.mu.Unlock()
	_, _ = s.submitJob("proxy-network", s.rebindProxyInterface)
}

func (s *Server) rebindProxyInterface() (returned error) {
	defer func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if returned == nil {
			s.proxyNetworkLost = false
			s.proxyNetworkRetry = time.Time{}
			s.safety.monitorError = ""
			return
		}
		// Keep the outage pending even if the restored uplink has the same
		// interface name. Only a complete rebind/check resolves the outage.
		s.proxyNetworkLost = true
		s.proxyNetworkRetry = time.Now().Add(15 * time.Second)
		if !errors.Is(returned, context.Canceled) {
			s.safety.monitorError = diagnostics.Redact(usererror.Display("恢复代理连接", returned, "连接恢复后会自动重试，也可手动重新检测。").Error())
		}
	}()
	s.setMessage("正在识别物理网卡并重新绑定代理…")
	cfg, err := loadConfig(s.configPath)
	if err != nil {
		return err
	}
	p, err := managedproxy.Applied(s.profile, cfg.ProxyURL, cfg.ProxyRevision)
	if err != nil {
		return err
	}
	return s.applyProxy(p, cfg, nil, false)
}
