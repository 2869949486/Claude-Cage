"""Local deployment diagnostic. No credentials or file contents are emitted."""
import json
import os
import subprocess
import sys
from pathlib import Path


def report(kind, **values):
    print(json.dumps({"probe": kind, **values}), flush=True)


report("python", version=sys.version.split()[0])
try:
    import ctypes
    report("ctypes", loaded=True)
except ImportError as error:
    report("ctypes", loaded=False, error=str(error))
try:
    with open(os.devnull, "r+b"):
        report("null_device", allowed=True)
except OSError as error:
    report("null_device", allowed=False, errno=error.errno, winerror=error.winerror)

for path in [Path.home() / "owned.txt", Path(r"C:\Users\CageRemote\outside-sandbox.txt"),
             Path(r"C:\ProgramData\Cage Remote\config.json"),
             Path(r"C:\ProgramData\Cage Remote\gui-credential.clixml")]:
    try:
        if path.name == "owned.txt":
            path.write_text("sandbox-owned", encoding="utf-8")
        with path.open("rb") as file:
            file.read(1)
        report("file", name=path.name, allowed=True)
    except OSError as error:
        report("file", name=path.name, allowed=False, winerror=error.winerror)

try:
    import socket
    for host, port in [("1.1.1.1", 443), ("127.0.0.1", 17777), ("127.0.0.1", 17896), ("::1", 17777)]:
        try:
            with socket.create_connection((host, port), timeout=3):
                report("tcp", host=host, port=port, allowed=True)
        except OSError as error:
            report("tcp", host=host, port=port, allowed=False, error=error.errno)
    try:
        result = socket.getaddrinfo("www.cloudflare.com", 443)
        report("dns", allowed=True, count=len(result))
    except OSError as error:
        report("dns", allowed=False, error=error.errno)
except ImportError as error:
    report("socket_module", error=str(error))

if os.environ.get("HTTP_PROXY"):
    import base64
    import http.client
    from urllib.parse import urlsplit

    proxy = urlsplit(os.environ["HTTP_PROXY"])
    authorization = "Basic " + base64.b64encode((proxy.username + ":" + proxy.password).encode()).decode()
    # Only the existing fixed diagnostic service can reach upstream in checking
    # mode. A real arbitrary CONNECT must still fail until gate admission.
    for path in ["/", "/egress", "/dns"]:
        connection = http.client.HTTPConnection(proxy.hostname, proxy.port, timeout=20)
        try:
            connection.request("GET", "http://198.18.0.254" + path,
                               headers={"Proxy-Authorization": authorization})
            response = connection.getresponse()
            body = response.read(1024).decode("utf-8", errors="replace")
            report("broker_diagnostic", path=path, status=response.status, body=body)
        except OSError as error:
            report("broker_diagnostic", path=path, error=type(error).__name__, errno=error.errno)
        finally:
            connection.close()
    for target, credential in [("1.1.1.1:443", authorization), ("127.0.0.1:17777", authorization),
                               ("example.com:443", authorization), ("198.18.0.254:80", "Basic invalid")]:
        connection = http.client.HTTPConnection(proxy.hostname, proxy.port, timeout=6)
        try:
            connection.request("CONNECT", target, headers={"Proxy-Authorization": credential})
            response = connection.getresponse()
            report("broker_connect", target=target, authenticated=credential == authorization, status=response.status)
            response.read(1024)
        except OSError as error:
            report("broker_connect", target=target, error=type(error).__name__, errno=error.errno)
        finally:
            connection.close()

tools = Path(sys.argv[1])
commands = {
    "cmd": [os.environ["COMSPEC"], "/d", "/c", "echo cage-cmd-ok"],
    "powershell": [str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output cage-powershell-ok"],
    "claude": [str(next((tools / "claude").rglob("claude.exe"))), "--version"],
    "git": [str(next((tools / "git").glob("*/cmd/git.exe"))), "--version"],
    "bash": [str(next((tools / "git").glob("*/bin/bash.exe"))), "--noprofile", "--norc", "-c", "printf cage-bash-ok"],
}
for name, command in commands.items():
    try:
        result = subprocess.run(command, input="", capture_output=True, text=True, timeout=7, errors="replace")
        report("tool", name=name, exit=result.returncode, output=(result.stdout + result.stderr)[:1500])
    except (OSError, subprocess.TimeoutExpired) as error:
        report("tool", name=name, error=type(error).__name__, winerror=getattr(error, "winerror", None))
