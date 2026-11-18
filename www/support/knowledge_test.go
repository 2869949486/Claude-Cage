package main

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImplementationLookupIncludesReturnAfterChunkBoundary(t *testing.T) {
	name := filepath.Join(t.TempDir(), "source.tar.gz")
	f, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	archive := tar.NewWriter(gz)
	files := map[string]string{
		"source/docs/guide/update.md":        strings.Repeat("更新器遇到限流，请稍后重试。\n", 8),
		"source/internal/appupdate/retry.go": "func updateSourceError() {\n" + strings.Repeat("// Inspect response headers.\n", 39) + "return now.Add(5 * time.Minute) // fallback retry time\n}",
	}
	for path, data := range files {
		if err := archive.WriteHeader(&tar.Header{Name: path, Mode: 0644, Size: int64(len(data))}); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.Write([]byte(data)); err != nil {
			t.Fatal(err)
		}
	}
	for _, closer := range []interface{ Close() error }{archive, gz, f} {
		if err := closer.Close(); err != nil {
			t.Fatal(err)
		}
	}
	ix, err := loadIndex(name, "pinned")
	if err != nil {
		t.Fatal(err)
	}
	hits := ix.search("更新器 updateSourceError 遇到限流会多久后重试？请查看源码", "")
	if len(hits) < 2 || !strings.Contains(hits[0].Text, "updateSourceError") || !strings.Contains(hits[1].Text, "5 * time.Minute") || !strings.Contains(hits[1].URL, "#L41-") {
		t.Fatalf("missing the matched function or its fallback branch: %#v", hits)
	}
}
