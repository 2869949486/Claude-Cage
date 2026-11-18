package workbench

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCodexNetworkApproval(t *testing.T) {
	const frame = `{"id":9,"method":"item/commandExecution/requestApproval","params":{"kind":"command","turnId":"turn","threadId":"thread","itemId":"exec","environmentId":"local","cwd":"/project","command":"./loopback-test","additionalPermissions":{"network":{"enabled":true},"fileSystem":null},"availableDecisions":["accept","cancel"]}}`
	for _, tc := range []struct {
		before, after string
		want          bool
	}{
		{"", "", false},
		{"", "", true},
		{`"environmentId":"local"`, `"environmentId":"other"`, false},
		{`"fileSystem":null`, `"fileSystem":{"write":["/"]}`, false},
		{`"fileSystem":null`, `"futureScope":true`, false},
		{`"network":{"enabled":true}`, `"network":null`, false},
		{`"kind":"command"`, `"kind":"writeStdin"`, false},
		{`"turnId":"turn"`, `"turnId":"old"`, false},
		{`"threadId":"thread"`, `"threadId":"old"`, false},
		{`"accept","cancel"`, `"cancel"`, false},
	} {
		data := frame
		if tc.before != "" {
			data = strings.Replace(frame, tc.before, tc.after, 1)
		}
		var m codexEvent
		if err := json.Unmarshal([]byte(data), &m); err != nil {
			t.Fatal(err)
		}
		prompted := false
		c := codexConversation{thread: "thread", turn: "turn", approveNetwork: func(r codexNetworkRequest) bool { prompted = true; return tc.want }}
		decision := c.requestReply(m)["result"].(map[string]string)["decision"]
		if prompted != (tc.before == "") || (decision == "accept") != tc.want {
			t.Fatalf("replacement %q, asked %v, decision %q", tc.before, prompted, decision)
		}
	}
}
