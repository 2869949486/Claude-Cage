package workbench

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/sylvinus/agent-vm/internal/guestos"
	"github.com/sylvinus/agent-vm/internal/hostimage"
)

func TestPendingLinuxCloneRetryReturnsToInstallerAdmission(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("this case verifies rejection on a different host family")
	}
	s := testServer(t)
	install := guestos.Installation{
		Version: 1, ID: uuid.New(), System: "ubuntu-22.04",
		Source: hostimage.Plan{
			Host:    hostimage.Identity{System: "ubuntu-22.04", Version: "22.04", Arch: "amd64"},
			Version: "22.04", Format: "qcow2", Path: filepath.Join(s.profile, "ubuntu.img"),
			Digest: "sha256:" + strings.Repeat("a", 64),
		},
	}
	if err := guestos.SaveInstallation(s.profile, install); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{}`, `{"guest_system":"ubuntu-22.04"}`} {
		r := httptest.NewRequest(http.MethodPost, "/api/start", strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: s.cookieName() + "-desktop", Value: trustedViewProof(s.token)})
		w := httptest.NewRecorder()
		s.start(w, r)
		if w.Code == http.StatusOK || s.jobs.snapshot().Running {
			t.Fatal("pending clone bypassed installer admission through the generic start path")
		}
	}
}
