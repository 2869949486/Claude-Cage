"""Guest-side stdio MCP server and SSH relay for a Windows preview browser."""
import fcntl
import json
import os
from pathlib import Path
import select
import socket
import sys

ROOT = Path(__file__).resolve().parent
SOCKET = str(ROOT / "window.sock")
LIMIT = 65536
TOOLS = {
    "open_page": ("Open a URL on the configured Windows loopback preview in a visible Edge tab.", "url"),
    "read_tab": ("Read the URL and title of the last Windows preview tab.", None),
}


def encode(value):
    return (json.dumps(value, ensure_ascii=True) + "\n").encode()


def relay():
    with (ROOT / "window.lock").open("a") as lock, socket.socket(socket.AF_UNIX) as listener:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        Path(SOCKET).unlink(missing_ok=True)
        listener.bind(SOCKET)
        os.chmod(SOCKET, 0o600)
        listener.listen(4)
        print('{"ready":true}', flush=True)
        while True:
            ready, _, _ = select.select([listener, sys.stdin], [], [])
            if sys.stdin in ready:
                return
            conn, _ = listener.accept()
            with conn, conn.makefile("rb") as src:
                conn.settimeout(12)
                try:
                    line = src.readline(LIMIT)
                    if not line.endswith(b"\n"):
                        continue
                    sys.stdout.buffer.write(line)
                    sys.stdout.buffer.flush()
                    reply = sys.stdin.buffer.readline(LIMIT)
                    if not reply:
                        return
                    conn.sendall(reply)
                except OSError:
                    continue


def dispatch(method, params):
    if method == "initialize":
        return dict(protocolVersion=params["protocolVersion"], capabilities={"tools": {}},
                    serverInfo=dict(name="windows-browser-preview", version="1.0"))
    if method == "ping":
        return {}
    if method == "tools/list":
        tools = []
        for name, (description, arg) in TOOLS.items():
            schema = dict(type="object", properties={arg: {"type": "string"}} if arg else {},
                          required=[arg] if arg else [], additionalProperties=False)
            tools.append(dict(name=name, description=description, inputSchema=schema))
        return {"tools": tools}
    if method != "tools/call":
        raise KeyError(method)
    try:
        if params["name"] not in TOOLS:
            raise ValueError("Unknown browser tool")
        line = encode([params["name"], params.get("arguments", {})])
        if len(line) >= LIMIT:
            raise ValueError("Input too long")
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(15)
            client.connect(SOCKET)
            client.sendall(line)
            with client.makefile("rb") as src:
                reply = json.loads(src.readline(LIMIT))
        if "error" in reply:
            raise ValueError(reply["error"])
        return dict(content=[dict(type="text", text=json.dumps(reply, ensure_ascii=False))])
    except OSError:
        return dict(isError=True, content=[dict(type="text", text="Windows browser relay offline or busy")])
    except ValueError as err:
        return dict(isError=True, content=[dict(type="text", text=str(err))])


if __name__ == "__main__":
    if "--relay" in sys.argv:
        relay()
    else:
        for raw in sys.stdin.buffer:
            req = json.loads(raw)
            if "id" not in req:
                continue
            msg = dict(jsonrpc="2.0", id=req["id"])
            try:
                msg["result"] = dispatch(req["method"], req.get("params", {}))
            except KeyError:
                msg["error"] = dict(code=-32601, message="Unknown method or missing parameter")
            sys.stdout.buffer.write(encode(msg))
            sys.stdout.buffer.flush()
