package workbench

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/sylvinus/agent-vm/internal/guestos"
)

func TestAbandonedGuestsReportLeftoverDataWithoutTouchingIt(t *testing.T) {
	s := testServer(t)
	status := func() []string {
		t.Helper()
		response := desktopRequestForTest(s, http.MethodGet, "/api/status", nil)
		var view struct {
			Abandoned []string `json:"abandoned_guests"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &view) != nil || view.Abandoned == nil {
			t.Fatalf("status lacks the abandoned guest list: %d %s", response.Code, response.Body.String())
		}
		return view.Abandoned
	}
	if found := status(); len(found) != 0 {
		t.Fatalf("clean profile reported abandoned guests: %v", found)
	}
	const content = `{"version":1}`
	for _, leftover := range []struct {
		system, path string
		directory    bool
	}{
		{"windows", "windows-guest.json", false},
		{"windows", filepath.Join("state", "windows-0123456789abcdef0123456789abcdef"), true},
		{"macos", "macos-guest.json", false},
		{"macos", filepath.Join("state", "lima", "mac"), true},
		{"macos", filepath.Join("state", "guest-media", "macos"), true},
	} {
		path := filepath.Join(s.profile, leftover.path)
		var err error
		if leftover.directory {
			err = os.MkdirAll(path, 0700)
		} else {
			err = os.WriteFile(path, []byte(content), 0600)
		}
		if err != nil {
			t.Fatal(err)
		}
		if found := abandonedGuests(s.profile); !slices.Equal(found, []string{leftover.system}) {
			t.Fatalf("%s not reported as %s: %v", leftover.path, leftover.system, found)
		}
		info, err := os.Lstat(path)
		if err != nil || info.IsDir() != leftover.directory {
			t.Fatal("reporting changed the leftover entry", leftover.path, err)
		}
		if !leftover.directory {
			if data, err := os.ReadFile(path); err != nil || string(data) != content {
				t.Fatal("reporting changed the leftover file", leftover.path, err)
			}
		}
		// Each case stands alone; the test owns this temporary profile.
		if err = os.RemoveAll(path); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"windows-guest.json", "macos-guest.json"} {
		if err := os.WriteFile(filepath.Join(s.profile, path), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if found := status(); !slices.Equal(found, []string{"macos", "windows"}) {
		t.Fatalf("status did not list both abandoned guests: %v", found)
	}
}

func TestAbandonedInstallationRecordIsReportedAndRefused(t *testing.T) {
	s := testServer(t)
	install := guestos.Installation{Version: 1, System: guestos.MacOS, ID: uuid.New()}
	if err := guestos.SaveInstallation(s.profile, install); err != nil {
		t.Fatal(err)
	}
	record := filepath.Join(s.profile, "guest-install.json")
	before, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	if found := s.abandonedGuestList(); !slices.Equal(found, []string{"macos"}) {
		t.Fatalf("pending macOS installation not reported: %v", found)
	}
	for _, body := range []string{`{}`, `{"guest_system":"macos"}`, `{"guest_system":"windows-11"}`} {
		response := desktopRequestForTest(s, http.MethodPost, "/api/start", []byte(body))
		if response.Code != http.StatusConflict {
			t.Fatalf("abandoned installation was started by %s: %d %s", body, response.Code, response.Body.String())
		}
	}
	if s.jobs.snapshot().Running {
		t.Fatal("refused start still launched a job")
	}
	view, err := s.guestInstallView()
	if err != nil || view.Available || view.Reason == "" || view.Pending == nil {
		t.Fatalf("install view does not explain the abandoned record: %+v %v", view, err)
	}
	if after, err := os.ReadFile(record); err != nil || string(after) != string(before) {
		t.Fatal("refusal changed the installation record", err)
	}
}
