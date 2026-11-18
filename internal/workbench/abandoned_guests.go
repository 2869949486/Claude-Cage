package workbench

import (
	"path/filepath"
	"slices"

	"github.com/sylvinus/agent-vm/internal/guestos"
)

// abandonedGuestData lists, per guest system Cage no longer runs, the profile
// entries such a guest left behind. Entries are glob patterns relative to the
// profile directory.
var abandonedGuestData = []struct {
	system   string
	patterns []string
}{
	{"macos", []string{"macos-guest.json", filepath.Join("state", "lima", "mac"), filepath.Join("state", "guest-media", "macos")}},
	{"windows", []string{"windows-guest.json", filepath.Join("state", "windows-*")}},
}

// abandonedGuests reports which no longer supported guest systems still have
// data in the profile. It only checks existence: the files stay where they
// are so the user can export or remove them deliberately.
func abandonedGuests(profile string) []string {
	found := []string{}
	for _, guest := range abandonedGuestData {
		for _, pattern := range guest.patterns {
			if matches, _ := filepath.Glob(filepath.Join(profile, pattern)); len(matches) != 0 {
				found = append(found, guest.system)
				break
			}
		}
	}
	return found
}

// abandonedGuestList also names the system of an installation that an earlier
// version recorded but can no longer continue.
func (s *Server) abandonedGuestList() []string {
	found := abandonedGuests(s.profile)
	if pending, err := guestos.LoadInstallation(s.profile); err == nil && pending != nil {
		system := map[string]string{guestos.MacOS: "macos", guestos.Windows11: "windows"}[pending.System]
		if system != "" && !slices.Contains(found, system) {
			found = append(found, system)
			slices.Sort(found)
		}
	}
	return found
}

func abandonedGuestMessage(system string) string {
	name := "所选"
	switch system {
	case "macos":
		name = "macOS"
	case "windows", "windows-11":
		name = "Windows"
	}
	return "Cage 已不再支持 " + name + " 客机，现在只提供 Debian 环境；原有客机数据仍保留在数据目录中，未被改动。"
}
