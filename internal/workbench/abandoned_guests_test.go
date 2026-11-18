package workbench

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"
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
	binding := filepath.Join(s.profile, "windows-guest.json")
	if err := os.WriteFile(binding, []byte(`{"version":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	if found := status(); !slices.Equal(found, []string{"windows"}) {
		t.Fatalf("bound Windows guest not reported: %v", found)
	}
	if data, err := os.ReadFile(binding); err != nil || string(data) != `{"version":1}` {
		t.Fatal("reporting changed the leftover binding", err)
	}
	if err := os.Remove(binding); err != nil {
		t.Fatal(err)
	}
	disk := filepath.Join(s.profile, "state", "windows-0123456789abcdef0123456789abcdef")
	if err := os.MkdirAll(disk, 0700); err != nil {
		t.Fatal(err)
	}
	if found := abandonedGuests(s.profile); !slices.Equal(found, []string{"windows"}) {
		t.Fatalf("leftover Windows disk directory not reported: %v", found)
	}
	if _, err := os.Stat(disk); err != nil {
		t.Fatal("reporting removed the leftover disk directory", err)
	}
}
