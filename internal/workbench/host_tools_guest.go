package workbench

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/sylvinus/agent-vm/internal/hostbridge"
)

// guestPluginRoot is where plugin files are kept in the environment, under
// the user's home there. The name says nothing about this application.
const guestPluginRoot = ".local/share/plugins"

// guestPluginLimit is the most a plugin's files may add up to.
const guestPluginLimit = 100 << 20

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'" }

// packPlugin is the plugin's files as a tar archive and its digest. Only
// plain files and folders go in, as when a plugin is installed.
func packPlugin(dir string) ([]byte, string, error) {
	var buffer bytes.Buffer
	archive := tar.NewWriter(&buffer)
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || path == dir {
			return err
		}
		relative, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		header := &tar.Header{Name: filepath.ToSlash(relative), Mode: 0o644}
		switch {
		case info.IsDir():
			header.Typeflag, header.Mode = tar.TypeDir, 0o755
			header.Name += "/"
			return archive.WriteHeader(header)
		case !info.Mode().IsRegular():
			return fmt.Errorf("%s is not a plain file", relative)
		}
		// Windows keeps no executable bit; there every file may be a program.
		if info.Mode().Perm()&0o111 != 0 || filepath.Separator == '\\' {
			header.Mode = 0o755
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if buffer.Len()+len(data) > guestPluginLimit {
			return errors.New("the plugin is too large")
		}
		header.Typeflag, header.Size = tar.TypeReg, int64(len(data))
		if err := archive.WriteHeader(header); err != nil {
			return err
		}
		_, err = archive.Write(data)
		return err
	})
	if err != nil {
		return nil, "", err
	}
	if err := archive.Close(); err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(buffer.Bytes())
	return buffer.Bytes(), hex.EncodeToString(digest[:]), nil
}

// guestPluginSyncScript replaces the plugin's folder with the archive on its
// standard input, whole or not at all. $1 is the folder, $2 the digest.
const guestPluginSyncScript = `set -e
dir="$HOME/$1"
rm -rf "$dir.new"
mkdir -p "$dir.new"
tar -xf - -C "$dir.new"
printf '%s' "$2" > "$dir.new/.digest"
rm -rf "$dir"
mv "$dir.new" "$dir"`

// guestPluginCommand copies the plugin's files into the environment, unless
// they are there already, and returns the command that runs its server
// there, with its standard input and output carried over SSH.
func (s *Server) guestPluginCommand(ctx context.Context, manifest hostbridge.Manifest, dir string) (*exec.Cmd, error) {
	command := manifest.ServerCommand()
	if len(command) == 0 {
		return nil, errors.New("the plugin has no MCP server")
	}
	archive, digest, err := packPlugin(dir)
	if err != nil {
		return nil, err
	}
	folder := guestPluginRoot + "/" + manifest.Name
	prepare, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	current, _ := s.sshCommand(prepare, "-T", s.sshTarget(), "--", "cat "+shellQuote(folder+"/.digest")+" 2>/dev/null").Output()
	if strings.TrimSpace(string(current)) != digest {
		sync := s.sshCommand(prepare, "-T", s.sshTarget(), "--", "sh -c "+shellQuote(guestPluginSyncScript)+" sh "+shellQuote(folder)+" "+shellQuote(digest))
		sync.Stdin = bytes.NewReader(archive)
		if output, err := sync.CombinedOutput(); err != nil {
			return nil, fmt.Errorf("copying the plugin: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	// A program named with a path is taken from the plugin's folder, as on
	// this computer; a bare name is looked up on PATH.
	program := command[0]
	if !strings.HasPrefix(program, "/") && strings.Contains(program, "/") {
		program = "./" + program
	}
	line := "cd \"$HOME\"/" + shellQuote(folder) + " && exec " + shellQuote(program)
	for _, argument := range command[1:] {
		line += " " + shellQuote(argument)
	}
	// Not tied to ctx, which ends with the call that starts the program: the
	// plugin's own Close ends it.
	return s.sshCommand(s.lifetimeContext(), "-T", s.sshTarget(), "--", line), nil
}
