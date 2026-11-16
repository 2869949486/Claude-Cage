package workbench

import (
	"context"
	"time"
)

const projectNetworkWait = 15 * time.Second

type projectAccountEpochKey struct{}

// Permit a project request to wait out a periodic network check. Other
// operation conflicts keep their immediate busy response.
func (s *Server) lockProjectOperation(ctx context.Context) bool {
	epoch, _ := ctx.Value(projectAccountEpochKey{}).(context.Context)
	if ctx.Err() != nil || (epoch != nil && epoch.Err() != nil) {
		return false
	}
	s.mu.Lock()
	if s.op.TryLock() {
		s.mu.Unlock()
		return true
	}
	done := s.networkMonitorDone
	if done == nil || !s.ready || s.closing || s.busy() {
		s.mu.Unlock()
		return false
	}
	s.projectOperationWaiters++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.projectOperationWaiters--
		s.mu.Unlock()
	}()

	wait, cancel := context.WithTimeout(ctx, projectNetworkWait)
	defer cancel()
	var accountDone <-chan struct{}
	if epoch != nil {
		accountDone = epoch.Done()
	}
	select {
	case <-wait.Done():
		return false
	case <-accountDone:
		return false
	case <-done:
	}
	if !s.op.TryLock() {
		return false
	}
	if wait.Err() != nil || (epoch != nil && epoch.Err() != nil) {
		s.op.Unlock()
		return false
	}
	return true
}
