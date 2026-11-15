[CmdletBinding()]
param(
    [string]$Root = 'C:\ProgramData\Cage Remote',
    [string]$Install = 'C:\Program Files\Cage Remote'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:CLAUDE_CAGE_CONFIG = Join-Path $Root 'config.json'
& (Join-Path $Install 'cage.exe') proxy-start
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$record = Get-Content -LiteralPath (Join-Path $Root 'proxy\managed-process.json') -Raw | ConvertFrom-Json
$core = Get-Process -Id $record.pid -ErrorAction Stop
if ($core.Path -ne (Join-Path $Install 'mihomo.exe')) { throw 'Unexpected managed proxy process.' }
# Keep the Task Scheduler job alive with its proxy child, independently of SSH.
$core.WaitForExit()
exit 1
