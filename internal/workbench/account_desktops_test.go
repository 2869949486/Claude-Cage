package workbench

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sylvinus/agent-vm/internal/guestos"
)

func TestDesktopCatalogUsesStableNumbersWithoutStartingGuest(t *testing.T) {
	s := testServer(t)
	accounts := []claudeAccount{{ID: strings.Repeat("a", 24), Label: "工作", Number: 9, DesktopDedicatedNetwork: true}, {ID: strings.Repeat("b", 24), Label: "个人", Number: 3}}
	if err := s.saveClaudeAccounts(claudeAccountList{Accounts: accounts}); err != nil {
		t.Fatal(err)
	}
	var view struct {
		Supported bool
		Accounts  []desktopEntry
	}
	resp := request(s, "GET", "/api/desktop-instances", s.origin, "", true)
	if resp.Code != http.StatusOK || json.Unmarshal(resp.Body.Bytes(), &view) != nil || !view.Supported || len(view.Accounts) != 2 {
		t.Fatalf("catalog: %d %s", resp.Code, resp.Body.String())
	}
	if a := view.Accounts[0]; a.Number != 9 || a.ID != accounts[0].ID || a.Running || !a.Dedicated {
		t.Fatalf("incorrect account state: %+v", a)
	}
	if a := view.Accounts[1]; a.Number != 3 || a.Dedicated {
		t.Fatalf("second entry: %+v", a)
	}
}

func TestDesktopInstanceNeverFallsBackToNativeDefault(t *testing.T) {
	s := testServer(t)
	id := strings.Repeat("a", 24)
	if w := request(s, "POST", "/api/desktop-instances/"+id+"/start", "https://claude.ai", "{}", true); w.Code != 403 {
		t.Fatalf("cross-origin start: %d", w.Code)
	}
	if w := request(s, "POST", "/api/desktop-instances/default/start", s.origin, "{}", true); w.Code != 404 {
		t.Fatalf("invalid instance: %d", w.Code)
	}
	if w := request(s, "POST", "/api/desktop-instances/"+id+"/stop", s.origin, "{}", false); w.Code != 401 {
		t.Fatalf("unauthenticated stop: %d", w.Code)
	}
	for _, platform := range []string{"macos", "windows"} {
		if platform == "macos" {
			s.macosGuest = &guestos.MacOSProfile{}
		} else {
			s.macosGuest = nil
			s.windowsGuest = &guestos.WindowsProfile{}
		}
		r := httptest.NewRequest("GET", "/api/desktop-instances/"+id+"/vnc", nil)
		r.SetPathValue("id", id)
		r.SetPathValue("action", "vnc")
		w := httptest.NewRecorder()
		s.accountDesktop(w, r)
		if w.Code != http.StatusNotImplemented {
			t.Fatalf("%s account display: got %d", platform, w.Code)
		}
	}
	if !macOSWorkbenchRoute("/api/desktop-instances") || !windowsWorkbenchRoute("/api/desktop-instances") {
		t.Fatal("native platform cannot query capabilities")
	}
}

func TestBoundAccountProbeUsesSubscriptionAndGuestCapability(t *testing.T) {
	s := testServer(t)
	first := claudeAccount{ID: strings.Repeat("a", 24), Source: "default", Email: "one@example.org", ProxyNodeID: strings.Repeat("c", 24)}
	second := claudeAccount{ID: strings.Repeat("b", 24), Source: "default", Email: "two@example.org"}
	if err := s.saveClaudeAccounts(claudeAccountList{Accounts: []claudeAccount{first, second}}); err != nil {
		t.Fatal(err)
	}
	for _, a := range []claudeAccount{first, second} {
		route, err := s.boundGuestAccount("default", claudeIdentityHash(a.Email, ""))
		if err != nil {
			t.Fatal(err)
		}
		if a.ID == first.ID && (route == nil || route.ID != first.ID) || a.ID == second.ID && route != nil {
			t.Fatal("default profile took another subscription's route")
		}
	}
	s.windowsGuest = &guestos.WindowsProfile{}
	if _, err := s.readWindowsClaudeAccount(t.Context(), "usage", "default", claudeIdentityHash(first.Email, "")); err != errUnsupportedAccountNetwork {
		t.Fatal("expected to stop before the native CLI used the shared route", err)
	}
	s.windowsGuest = nil
	s.macosGuest = &guestos.MacOSProfile{}
	if _, err := s.readClaudeGuestSnapshot(t.Context(), "default"); err != errUnsupportedAccountNetwork {
		t.Fatal("native identity discovery used a bound default profile", err)
	}
}
