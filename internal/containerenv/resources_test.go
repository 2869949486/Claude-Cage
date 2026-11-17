package containerenv

import (
	"slices"
	"strconv"
	"strings"
	"testing"
)

const cgroupMount = "698 756 0:25 / /sys/fs/cgroup rw,relatime - cgroup2 none rw\n"

func fixtureLimits() cgroupLimits {
	return cgroupLimits{memory: "4294967296", cpu: "200000 100000", pids: strconv.Itoa(PIDLimit)}
}

func TestKernelResourceEvidenceRejectsIgnoredOrDifferentLimits(t *testing.T) {
	scope := fixtureLimits()
	if evidence, err := parseResourceEvidence(fixtureLimits(), &scope, cgroupMount, fixtureConfig()); err != nil || evidence.CPUs != 2 || evidence.MemoryBytes != 4<<30 || evidence.PIDs != PIDLimit {
		t.Fatalf("valid cgroup evidence: %+v %v", evidence, err)
	}
	for _, change := range []func(*cgroupLimits){
		func(l *cgroupLimits) { l.memory = "max" },
		func(l *cgroupLimits) { l.cpu = "max 100000" },
		func(l *cgroupLimits) { l.pids = "max" },
		func(l *cgroupLimits) { l.pids = "1024" },
		func(l *cgroupLimits) { l.cpu = "400000 100000" },
	} {
		slice := fixtureLimits()
		change(&slice)
		if _, err := parseResourceEvidence(slice, &scope, cgroupMount, fixtureConfig()); err == nil {
			t.Fatalf("accepted non-enforced slice limits %+v", slice)
		}
	}
	for _, mount := range []string{strings.Replace(cgroupMount, "cgroup2", "tmpfs", 1), strings.Replace(cgroupMount, "/sys/fs/cgroup", "/somewhere", 1)} {
		if _, err := parseResourceEvidence(fixtureLimits(), &scope, mount, fixtureConfig()); err == nil {
			t.Fatalf("accepted resource evidence without a cgroup v2 mount %q", mount)
		}
	}
}

// A container keeps the PID limit it was created with while the slice is
// re-applied on every start, so only the scope check can see the stale value.
func TestContainerScopeKeepingCreateTimePIDLimitIsRejected(t *testing.T) {
	if _, err := parseResourceEvidence(fixtureLimits(), nil, cgroupMount, fixtureConfig()); err != nil {
		t.Fatalf("slice-only evidence before a container exists: %v", err)
	}
	for _, pids := range []string{"1024", strconv.Itoa(PIDLimit * 2), "max", ""} {
		scope := fixtureLimits()
		scope.pids = pids
		if _, err := parseResourceEvidence(fixtureLimits(), &scope, cgroupMount, fixtureConfig()); err == nil {
			t.Fatalf("accepted container scope pids.max %q", pids)
		}
	}
}

func TestResourceUpdateTouchesOnlyStaleContainers(t *testing.T) {
	container := &engineContainer{ID: "c1"}
	want := []string{"update", "--pids-limit", strconv.Itoa(PIDLimit), "c1"}
	for _, limit := range []int64{0, 1024, PIDLimit * 2} {
		container.HostConfig.PidsLimit = &limit
		if got := resourceUpdate(container); !slices.Equal(got, want) {
			t.Fatalf("PidsLimit %d: got %q", limit, got)
		}
	}
	container.HostConfig.PidsLimit = nil
	if got := resourceUpdate(container); !slices.Equal(got, want) {
		t.Fatalf("missing PidsLimit: got %q", got)
	}
	current := int64(PIDLimit)
	container.HostConfig.PidsLimit = &current
	if got := resourceUpdate(container); got != nil {
		t.Fatalf("current container: got %q", got)
	}
}
