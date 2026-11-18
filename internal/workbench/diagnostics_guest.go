package workbench

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"strings"

	"al.essio.dev/pkg/shellescape"
)

//go:embed macos_diagnostics.py
var macOSDiagnosticCollector string

func (s *Server) nativeGuestDiagnostics(ctx context.Context) ([]byte, error) {
	var data []byte
	var err error
	command := "exec " + shellescape.QuoteCommand([]string{macCLIInstall + "/bin/python3", "-I", "-c", macOSDiagnosticCollector})
	data, err = s.guestControl(ctx, command, "guest-diagnostics")
	if err != nil {
		return nil, err
	}
	var result struct {
		Version int    `json:"version"`
		Lines   string `json:"lines"`
	}
	if json.Unmarshal(data, &result) != nil || result.Version != 1 || len(result.Lines) > 48<<10 || strings.Count(result.Lines, "\n") > 150 {
		return nil, errors.New("客机诊断记录格式或大小无效")
	}
	return []byte(result.Lines), nil
}
