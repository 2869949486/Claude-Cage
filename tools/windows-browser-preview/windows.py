"""Connect Claude's local-preview tools to a visible, dedicated Windows Edge window."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import shlex
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
REMOTE = "/home/cage/.local/share/windows-browser-preview"
EDGE = Path(os.environ["ProgramFiles(x86)"]) / "Microsoft/Edge/Application/msedge.exe"


def ssh_args(host_id, profile):
    hosts = profile / "desktop-entry" / "remote-hosts.json"
    entries = json.loads(hosts.read_text(encoding="utf-8-sig"))["hosts"]
    host = next((h for h in entries if h["id"] == host_id), None)
    if host is None:
        raise SystemExit(f"Unknown Cage host ID in {hosts}")
    return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "IdentitiesOnly=yes", "-o", "ServerAliveInterval=20", "-i", host["auth"]["identity_file"],
            "-p", str(host["port"]), host["user"] + "@" + host["host"]]


class Preview:
    def __init__(self, port):
        self.origin = f"http://127.0.0.1:{port}"
        self.process = None
        self.tab = None
        self.port = None

    def request(self, path, method="GET"):
        req = Request(f"http://127.0.0.1:{self.port}" + path, method=method)
        with urlopen(req, timeout=3) as response:
            return json.load(response)

    def perform(self, action, args):
        if action == "open_page":
            url = args["url"]
            parsed = urlsplit(url)
            if (parsed.scheme, parsed.netloc) != ("http", urlsplit(self.origin).netloc):
                raise ValueError(f"Use the local preview at {self.origin}/")
            if self.process is None or self.process.poll() is not None:
                profile = Path(tempfile.mkdtemp(prefix="cage-preview-edge-"))
                self.process = subprocess.Popen([str(EDGE), "--user-data-dir=" + str(profile),
                    "--remote-debugging-port=0", "--no-first-run", "--disable-background-mode",
                    "--new-window", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                endpoint = profile / "DevToolsActivePort"
                for _ in range(75):
                    if endpoint.exists() and endpoint.read_text().splitlines():
                        break
                    time.sleep(.1)
                self.port = int(endpoint.read_text().splitlines()[0])
                self.tab = None
            else:
                target = self.request("/json/new?" + quote(url, safe=""), "PUT")
                self.tab = target["id"]
        elif action != "read_tab" or not self.tab:
            raise ValueError("Open a preview tab first")
        for _ in range(30):
            for item in self.request("/json/list"):
                if item["type"] != "page" or (self.tab and item["id"] != self.tab):
                    continue
                if item["url"].startswith(self.origin + "/") and item["title"] and item["title"] != item["url"]:
                    self.tab = item["id"]
                    return {"browser": "Windows Edge", "tab": self.tab, "title": item["title"], "url": item["url"]}
            time.sleep(.1)
        raise ValueError("Preview page has not loaded in the browser")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-id", required=True)
    parser.add_argument("--profile", type=Path, default=Path.home() / ".claude-cage")
    parser.add_argument("--port", type=int, default=18786, help="Windows preview HTTP port")
    parser.add_argument("--install", action="store_true", help="Copy the guest MCP script into Cage")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be in 1..65535")
    ssh = ssh_args(args.host_id, args.profile)
    if args.install:
        payload = base64.b64encode((HERE / "guest.py").read_bytes()).decode()
        script = (f"from pathlib import Path;import base64;p=Path('{REMOTE}');"
                  f"p.mkdir(mode=0o700, parents=True, exist_ok=True);"
                  f"(p/'guest.py').write_bytes(base64.b64decode('{payload}'))")
        subprocess.run(ssh + ["~/.claude-cage/cloud-host/bin/cage run python3 -c " + shlex.quote(script)], check=True)
        return
    preview = Preview(args.port)
    command = f"TOKIO_WORKER_THREADS=1 ~/.claude-cage/cloud-host/bin/cage run python3 {REMOTE}/guest.py --relay"
    with subprocess.Popen(ssh + [command], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          creationflags=subprocess.CREATE_NO_WINDOW) as relay:
        for line in relay.stdout:
            req = json.loads(line)
            if req == {"ready": True}:
                print("Connected", flush=True)
                continue
            try:
                result = preview.perform(*req)
            except (KeyError, ValueError, OSError) as exc:
                result = {"error": str(exc)}
            print(json.dumps([req[0], result], ensure_ascii=True), flush=True)
            relay.stdin.write((json.dumps(result) + "\n").encode())
            relay.stdin.flush()


if __name__ == "__main__":
    main()
