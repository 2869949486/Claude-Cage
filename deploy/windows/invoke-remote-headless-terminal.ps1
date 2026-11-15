[CmdletBinding()]
param(
    [string]$Root = 'C:\ProgramData\Cage Remote',
    [string]$Bundle = 'C:\Program Files\Cage Remote\boundary-r11',
    [string]$CommandFile,
    [switch]$InsideControllerSession
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$profile=Join-Path $Root 'windows-guest.json'
$binding=Get-Content -LiteralPath $profile -Raw -Encoding UTF8 | ConvertFrom-Json
$receipt=Join-Path $Root 'headless-terminal-receipt.log'
if ($InsideControllerSession) {
    & (Join-Path $Bundle 'Cage.GuestClipboard.exe') --relay-profile $profile headless-status
    if ($LASTEXITCODE) { throw 'Headless status authentication failed.' }
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=Join-Path $Bundle 'Cage.GuestClipboard.exe'
    $start.Arguments='--relay-profile "' + $profile + '" headless-terminal'
    $start.UseShellExecute=$false
    $start.CreateNoWindow=$true
    $start.RedirectStandardInput=$true
    $start.RedirectStandardOutput=$true
    $start.RedirectStandardError=$true
    $process=[Diagnostics.Process]::Start($start)
    $output=$process.StandardOutput.ReadToEndAsync()
    $errorOutput=$process.StandardError.ReadToEndAsync()
    try {
        $open=@{action='open';shell='powershell';workspace='home';cols=160;rows=40} | ConvertTo-Json -Compress
        # Commands run inside AppContainer; never display proxy environment or credentials.
        $command='try { $ErrorActionPreference=''Continue''; Write-Output CAGE_HEADLESS_RPC_BEGIN; Write-Output ([Security.Principal.WindowsIdentity]::GetCurrent().Name); Write-Output (Get-Location).Path; Set-Content -LiteralPath (Join-Path $env:USERPROFILE ''rpc-owned.txt'') -Value ''cage-headless-write-ok''; Get-Content -LiteralPath (Join-Path $env:USERPROFILE ''rpc-owned.txt''); python --version; Write-Output (''python_exit=''+$LASTEXITCODE); git --version; Write-Output (''git_exit=''+$LASTEXITCODE); claude --version; Write-Output (''claude_exit=''+$LASTEXITCODE); Write-Output CAGE_HEADLESS_RPC_END } finally { exit 0 }' + "`r"
        if ($CommandFile) {
            $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText($CommandFile)))
            $command="& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$payload'))))`r"
        }
        $inputMessage=@{action='input';data=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($command))} | ConvertTo-Json -Compress
        $process.StandardInput.WriteLine($open)
        $process.StandardInput.WriteLine($inputMessage)
        $process.StandardInput.Flush()
        $process.StandardInput.Close()
        $timedOut=-not $process.WaitForExit(40000)
        if ($timedOut) { $process.Kill(); $process.WaitForExit() }
        $wire=$output.GetAwaiter().GetResult()
        foreach ($line in ($wire -split "`n")) {
            if (-not $line.Trim()) { continue }
            $message=$line | ConvertFrom-Json
            if ($message.data) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($message.data)) }
            else { $line }
        }
        $errorOutput.GetAwaiter().GetResult()
        if ($timedOut) { throw 'Headless terminal timed out.' }
        if ($process.ExitCode) { throw 'Headless terminal relay failed.' }
    } finally { $process.Dispose() }
    exit 0
}
$taskName='Cage Remote Headless Terminal Probe ' + $binding.vm_id
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Probe already registered.' }
# Use the already logged-on controller identity for user-scoped DPAPI. SSH
# key logons may not load that master key; do not change DPAPI scope or keys.
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
function Quote-PS([string]$value) { "'" + $value.Replace("'","''") + "'" }
$command='& ' + (Quote-PS $PSCommandPath) + ' -InsideControllerSession -Root ' + (Quote-PS $Root) + ' -Bundle ' + (Quote-PS $Bundle) + ' > ' + (Quote-PS $receipt) + ' 2>&1; exit $LASTEXITCODE'
if ($CommandFile) {
    $command='& ' + (Quote-PS $PSCommandPath) + ' -InsideControllerSession -Root ' + (Quote-PS $Root) + ' -Bundle ' + (Quote-PS $Bundle) + ' -CommandFile ' + (Quote-PS $CommandFile) + ' > ' + (Quote-PS $receipt) + ' 2>&1; exit $LASTEXITCODE'
}
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $encoded)
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Principal $principal -Action $action -Settings $settings | Out-Null
try {
    Start-ScheduledTask -TaskName $taskName
    $deadline=[DateTime]::UtcNow.AddSeconds(50)
    do {
        Start-Sleep -Seconds 1
        $task=Get-ScheduledTask -TaskName $taskName
        $info=Get-ScheduledTaskInfo -TaskName $taskName
    } while (($task.State -eq 'Running' -or $info.LastTaskResult -eq 267011) -and [DateTime]::UtcNow -lt $deadline)
    Get-Content -LiteralPath $receipt -Raw
    [pscustomobject]@{state=[string]$task.State;exit=$info.LastTaskResult;workload_ready=$false} | ConvertTo-Json -Compress
} finally {
    if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
