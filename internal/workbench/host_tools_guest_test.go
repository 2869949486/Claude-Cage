package workbench

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// The archive holds the plugin's files, programs still programs, and the
// script on the other side replaces the folder with it.
func TestGuestPluginFilesAreCopiedWhole(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the script runs in the environment, which is Linux")
	}
	source := t.TempDir()
	write := func(name, content string, mode os.FileMode) {
		path := filepath.Join(source, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}
	write("plugin.json", "{}", 0o644)
	write("bin/tool", "#!/bin/sh\necho ran\n", 0o755)
	archive, digest, err := packPlugin(source)
	if err != nil || len(digest) != 64 {
		t.Fatalf("pack: %v %q", err, digest)
	}
	if _, again, _ := packPlugin(source); again != digest {
		t.Fatal("the same files gave another digest")
	}
	home := t.TempDir()
	folder := guestPluginRoot + "/sample"
	stale := filepath.Join(home, folder, "old-file")
	if err := os.MkdirAll(filepath.Dir(stale), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "-c", guestPluginSyncScript, "sh", folder, digest)
	cmd.Env = append(os.Environ(), "HOME="+home)
	cmd.Stdin = bytes.NewReader(archive)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("a file of the version before was kept")
	}
	if saved, _ := os.ReadFile(filepath.Join(home, folder, ".digest")); string(saved) != digest {
		t.Fatalf("digest %q", saved)
	}
	if output, err := exec.Command(filepath.Join(home, folder, "bin", "tool")).Output(); err != nil || string(output) != "ran\n" {
		t.Fatalf("the program did not run: %v %q", err, output)
	}
	write("link", "", 0o644)
	if err := os.Remove(filepath.Join(source, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(source, "link")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := packPlugin(source); err == nil {
		t.Fatal("packed a link")
	}
}
