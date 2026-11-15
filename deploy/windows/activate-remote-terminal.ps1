[CmdletBinding()]
param(
    [string]$Root='C:\ProgramData\Cage Remote',
    [string]$Install='C:\Program Files\Cage Remote',
    [string]$Bundle='C:\Program Files\Cage Remote\boundary-r11',
    [Parameter(Mandatory)][string]$ControllerCandidate
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$profile=Join-Path $Root 'windows-guest.json'
$binding=Get-Content -LiteralPath $profile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($binding.mode -ne 'remote') { throw 'Remote installation required.' }
$taskName='Cage Remote Controller '+$binding.vm_id
$controller=Join-Path $Install 'cage.exe'
if (!(Test-Path -LiteralPath $ControllerCandidate) -or !(Test-Path -LiteralPath (Join-Path $Bundle 'remote-shell.ps1'))) { throw 'Candidate files are missing.' }
$stamp=Get-Date -Format yyyyMMdd-HHmmss
Copy-Item -LiteralPath $profile -Destination ($profile+'.before-terminal-'+$stamp)
Copy-Item -LiteralPath $controller -Destination ($controller+'.before-terminal-'+$stamp)
Stop-ScheduledTask -TaskName $taskName
# The initial r5 controller has no enabled workload, and its wrapper task can
# leave the child alive. Retire only that exact deployment's serve process;
# proxy, egress, headless jobs and all other Cage installations stay untouched.
$processes=Get-CimInstance Win32_Process -Filter "Name='cage.exe'" | Where-Object {
    $_.ExecutablePath -eq $controller -and $_.CommandLine -eq ('"'+$controller+'" serve')
}
foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId
    Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
}
try {
    $command='$env:CLAUDE_CAGE_CONFIG='''+(Join-Path $Root 'config.json').Replace("'","''")+'''; & '''+$ControllerCandidate.Replace("'","''")+''' serve'
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+$encoded)
    Set-ScheduledTask -TaskName $taskName -Action $action | Out-Null
    $binding.relay_executable=Join-Path $Bundle 'Cage.GuestClipboard.exe'
    [IO.File]::WriteAllText($profile,($binding | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
} finally { Start-ScheduledTask -TaskName $taskName }
[pscustomobject]@{terminal='appcontainer-home';backup=$stamp;workload_ready=$false} | ConvertTo-Json -Compress
