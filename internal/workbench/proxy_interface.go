package workbench

import (
	"context"
	"path/filepath"

	"github.com/sylvinus/agent-vm/internal/managedproxy"
)

var physicalProxyInterface = managedproxy.PhysicalInterface

type proxyInterfaceObservation struct {
	name, configuration, jobID string
	err                        error
}

// Reading the host route can block inside the operating system and does not
// need to serialize with projects, terminals or environment operations.
func (s *Server) observeProxyInterface(ctx context.Context) proxyInterfaceObservation {
	job := s.jobs.snapshot()
	if job.Running {
		return proxyInterfaceObservation{}
	}
	cfg, err := loadConfig(s.configPath)
	if err != nil || cfg.RequireManagedProxy(s.profile) != nil {
		return proxyInterfaceObservation{}
	}
	name, err := physicalProxyInterface(ctx)
	return proxyInterfaceObservation{name: name, configuration: cfg.Fingerprint(), jobID: job.ID, err: err}
}

// The lifecycle lock covers effects such as revocation and recovery admission.
// Discard observations made before a configuration change or a lifecycle job.
func (s *Server) applyProxyInterfaceObservation(observed proxyInterfaceObservation) {
	job := s.jobs.snapshot()
	if observed.configuration == "" || job.Running || job.ID != observed.jobID {
		return
	}
	cfg, err := loadConfig(s.configPath)
	if err != nil || cfg.Fingerprint() != observed.configuration || cfg.RequireManagedProxy(s.profile) != nil {
		return
	}
	if observed.err != nil {
		reason := observed.err.Error()
		_ = s.closeProxyGate(reason)
		s.mu.Lock()
		s.safety.monitorError = reason
		s.proxyNetworkLost = true
		s.mu.Unlock()
		return
	}
	s.mu.Lock()
	lost := s.proxyNetworkLost
	s.mu.Unlock()
	bound, err := managedproxy.BoundInterface(filepath.Join(managedproxy.Dir(s.profile), "config.yaml"))
	if err != nil || (bound == observed.name && !lost) {
		return
	}
	// Revoke the previous report before the asynchronous recovery can start.
	if err := s.closeProxyGate("物理网卡已变化，正在重新绑定代理并检查出口"); err != nil {
		return
	}
	s.mu.Lock()
	s.proxyNetworkLost = false
	s.mu.Unlock()
	_, _ = s.submitJob("proxy-network", s.rebindProxyInterface)
}

func (s *Server) rebindProxyInterface() error {
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
