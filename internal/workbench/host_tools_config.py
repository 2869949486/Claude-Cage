# Adds one MCP server entry to every Claude Code profile of this user.
# ENTRY (a JSON string) is defined by the line placed before this script;
# the server's name is the first argument.
import json
import os
import sys
import tempfile
from pathlib import Path


def profile_files(home):
    files = [home / ".claude.json"]
    accounts = home / ".local/share/cage/claude-accounts"
    files += [d / ".claude.json" for d in sorted(accounts.glob("*/config")) if d.is_dir()]
    return files


def add_server(path, name, entry):
    """Returns whether the file was written."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        data = {}
    except ValueError:
        # Claude may be part-way through rewriting it; the next start retries.
        return False
    if not isinstance(data, dict):
        return False
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
    current = servers.get(name)
    if current == entry:
        return False
    # A server of this name that points elsewhere is the user's own.
    if isinstance(current, dict) and current.get("url") != entry["url"]:
        return False
    servers[name] = entry
    data["mcpServers"] = servers
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=".claude.json.")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as output:
            json.dump(data, output, indent=2)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        os.unlink(temporary)
        raise
    return True


if __name__ == "__main__":
    for file in profile_files(Path.home()):
        add_server(file, sys.argv[1], json.loads(ENTRY))  # noqa: F821
