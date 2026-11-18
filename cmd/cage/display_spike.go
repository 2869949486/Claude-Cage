package main

import (
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"strconv"
	"time"

	"github.com/sylvinus/agent-vm/internal/guestos"
)

// displaySpike asks the process that runs the local virtual Mac to show its
// display in a host window. It exists to measure a direct display and is not
// part of the product.
func displaySpike(config string, args []string) error {
	usage := errors.New("usage: cage display-spike open <width> <height> [--follow] | close")
	request := guestos.MacLoginRequest{}
	switch {
	case len(args) == 1 && args[0] == "close":
		request.Action = "direct-close"
	case (len(args) == 3 || len(args) == 4 && args[3] == "--follow") && args[0] == "open":
		width, errWidth := strconv.Atoi(args[1])
		height, errHeight := strconv.Atoi(args[2])
		if errWidth != nil || errHeight != nil {
			return usage
		}
		request.Action, request.X, request.Y, request.Shift = "direct-open", width, height, len(args) == 4
	default:
		return usage
	}
	conn, err := net.DialTimeout("unix", filepath.Join(filepath.Dir(config), "state", "lima", "mac", "cage-login.sock"), 2*time.Second)
	if err != nil {
		return errors.New("the local virtual Mac is not running")
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return err
	}
	var result guestos.MacLoginReply
	if err := json.NewDecoder(conn).Decode(&result); err != nil {
		return err
	}
	if result.Error != "" {
		return errors.New(result.Error)
	}
	return nil
}
