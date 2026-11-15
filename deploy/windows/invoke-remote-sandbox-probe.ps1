[CmdletBinding()]
param(
    [string]$Profile = 'C:\ProgramData\Cage Remote\windows-guest.json',
    [Parameter(Mandatory)][string]$Bundle
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$binding = Get-Content -LiteralPath $Profile -Raw -Encoding UTF8 | ConvertFrom-Json
$userProfile = (Get-CimInstance Win32_UserProfile -Filter ("SID='" + $binding.gui_user_sid + "'")).LocalPath
$receipt = Join-Path $userProfile 'cage-sandbox-probe.log'
$outside = Join-Path $userProfile 'outside-sandbox.txt'
if (-not (Test-Path -LiteralPath $outside)) { [IO.File]::WriteAllText($outside,'Cage private-user boundary marker') }
foreach ($path in @($receipt,$outside)) {
    if (-not (Test-Path -LiteralPath $path)) { [IO.File]::WriteAllText($path,'') }
    $acl=Get-Acl -LiteralPath $path
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($binding.gui_user_sid),'Read,Write','Allow'))
    Set-Acl -LiteralPath $path -AclObject $acl
}
$taskName = 'Cage Remote Sandbox Probe ' + $binding.vm_id
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'A sandbox probe is already registered.' }
function Quote-PS([string]$value) { return "'" + $value.Replace("'","''") + "'" }
$command = '$ErrorActionPreference=''Continue''; & ' + (Quote-PS (Join-Path $Bundle 'Cage.GuestClipboard.exe')) + ' remote-sandbox-probe --vm-id ' + (Quote-PS $binding.vm_id) + ' --sid ' + (Quote-PS $binding.gui_user_sid) + ' > ' + (Quote-PS $receipt) + ' 2>&1; exit $LASTEXITCODE'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $encoded)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$credential = Import-Clixml -LiteralPath (Join-Path (Split-Path -Parent $Profile) 'gui-credential.clixml')
Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -User $credential.UserName -Password $credential.GetNetworkCredential().Password -RunLevel Limited | Out-Null
try {
    Start-ScheduledTask -TaskName $taskName
    $deadline=[DateTime]::UtcNow.AddSeconds(65)
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
