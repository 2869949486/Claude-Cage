package workbench

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestHostToolDirsListsTheCurrentProjectFirst(t *testing.T) {
	s := &Server{projectShares: map[string]*projectShare{"/p/b": {}, "/p/a": {}, "/p/c": {}}}
	s.preferences.Workspace = "/p/b"
	if got, want := s.hostToolDirs(), []string{"/p/b", "/p/a", "/p/c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	s.preferences.Workspace = "/p/unshared"
	if got, want := s.hostToolDirs(), []string{"/p/a", "/p/b", "/p/c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestHostToolsTokenIsKeptAcrossStarts(t *testing.T) {
	s := &Server{profile: t.TempDir()}
	first, err := s.hostToolsToken()
	if err != nil || len(first) < 32 {
		t.Fatalf("token %q: %v", first, err)
	}
	second, err := s.hostToolsToken()
	if err != nil || second != first {
		t.Fatalf("second token %q, first %q: %v", second, first, err)
	}
	if info, err := os.Stat(filepath.Join(s.profile, "host-tools.token")); err != nil || info.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/' {
		t.Fatalf("token file: %v %v", info, err)
	}
}

// The script receives the entry on stdin and writes it into the profile of
// whichever home it runs in.
func TestHostToolsConfigInputWritesTheEntry(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is unavailable")
	}
	home := t.TempDir()
	cmd := exec.Command(python, "-", "computer")
	cmd.Env = append(os.Environ(), "HOME="+home)
	cmd.Stdin = strings.NewReader(hostToolsConfigInput([]byte(`{"type":"http","url":"http://127.0.0.1:18962/","headers":{"Authorization":"Bearer \"q\\"}}`)))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	written, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"computer"`, `"http://127.0.0.1:18962/"`, `Bearer \"q\\`} {
		if !strings.Contains(string(written), want) {
			t.Fatalf("%s is missing from %s", want, written)
		}
	}
}
