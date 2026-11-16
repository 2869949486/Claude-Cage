package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func holdProjectNetworkMonitor(t *testing.T, s *Server) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	probeStarted := make(chan struct{})
	releaseProbe := make(chan struct{})
	monitorStopped := make(chan struct{})
	previous := physicalProxyInterface
	physicalProxyInterface = func(context.Context) (string, error) {
		close(probeStarted)
		<-releaseProbe
		return "en0", nil
	}
	// Exercise the actual monitor lock without probing a running guest or network.
	s.networkPaused = true
	go func() {
		defer close(monitorStopped)
		s.monitorNetwork(ctx)
	}()
	stop := sync.OnceFunc(func() {
		cancel()
		close(releaseProbe)
		<-monitorStopped
		physicalProxyInterface = previous
	})
	select {
	case <-probeStarted:
	case <-time.After(time.Second):
		stop()
		t.Fatal("network monitor did not reach the held interface probe")
	}
	return stop
}

func startProjectOperationRequest(t *testing.T, s *Server, ctx context.Context, path string, input any) <-chan *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequestWithContext(ctx, http.MethodPost, s.origin+path, bytes.NewReader(body))
	r.Header.Set("Origin", s.origin)
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(&http.Cookie{Name: s.cookieName(), Value: s.session})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w := httptest.NewRecorder()
		s.handler().ServeHTTP(w, r)
		done <- w
	}()
	return done
}

func assertProjectOperationWaiting(t *testing.T, done <-chan *httptest.ResponseRecorder) {
	t.Helper()
	synctest.Wait()
	select {
	case w := <-done:
		t.Fatalf("request did not wait for the monitor: %d %s", w.Code, w.Body.String())
	default:
	}
}

func projectOperationResponse(t *testing.T, done <-chan *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case w := <-done:
		return w
	case <-time.After(time.Second):
		t.Fatal("project request did not finish after releasing the monitor or canceling")
		return nil
	}
}

func TestProjectOperationsWaitForNetworkMonitor(t *testing.T) {
	for _, operation := range []string{"save", "open"} {
		t.Run(operation, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				s, folder, _ := groupFixture(t)
				group := projectGroup{Name: "monitor-project", Folders: []string{folder}}
				var body any = group
				if operation == "open" {
					saveGroupRequest(t, s, group, http.StatusOK)
					body = map[string]any{"workspace": folder, "add": false, "activate": true}
				}
				stopMonitor := holdProjectNetworkMonitor(t, s)
				defer stopMonitor()
				done := startProjectOperationRequest(t, s, context.Background(), "/api/projects/"+operation, body)
				assertProjectOperationWaiting(t, done)
				stopMonitor()
				w := projectOperationResponse(t, done)
				if w.Code != http.StatusOK {
					t.Fatalf("%s after monitor released lock: %d %s", operation, w.Code, w.Body.String())
				}
				groups, err := s.projectGroups()
				if err != nil || len(groups) != 1 || groups[0].Workspace != folder {
					t.Fatalf("saved projects = %+v, error = %v; want one project for %q", groups, err, folder)
				}
				if operation == "open" && s.workspace() != folder {
					t.Fatalf("project was not activated: %q", s.workspace())
				}
			})
		})
	}
}

func TestProjectSaveAbandonsNetworkWait(t *testing.T) {
	for _, scenario := range []struct {
		name string
		stop func(*Server, context.CancelFunc)
	}{
		{"request canceled", func(_ *Server, cancel context.CancelFunc) { cancel() }},
		{"account locked", func(s *Server, _ context.CancelFunc) { s.account.lock() }},
		{"timeout", func(_ *Server, _ context.CancelFunc) { time.Sleep(projectNetworkWait) }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				s, folder, _ := groupFixture(t)
				stopMonitor := holdProjectNetworkMonitor(t, s)
				defer stopMonitor()
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				done := startProjectOperationRequest(t, s, ctx, "/api/projects/save", projectGroup{
					Name: "monitor-canceled-project", Folders: []string{folder},
				})
				assertProjectOperationWaiting(t, done)
				scenario.stop(s, cancel)
				w := projectOperationResponse(t, done)
				if w.Code != http.StatusConflict {
					t.Fatalf("abandoned save returned %d: %s", w.Code, w.Body.String())
				}
				stopMonitor()
				synctest.Wait()
				if _, err := os.Stat(filepath.Join(s.profile, "projects.json")); !os.IsNotExist(err) {
					t.Fatalf("abandoned save changed project records: %v", err)
				}
			})
		})
	}
}
