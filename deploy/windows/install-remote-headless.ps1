[CmdletBinding()]
param(
    [string]$Root = 'C:\ProgramData\Cage Remote',
    [string]$Bundle = 'C:\Program Files\Cage Remote\boundary-r11'
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$binding=Get-Content -LiteralPath (Join-Path $Root 'windows-guest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($binding.mode -ne 'remote') { throw 'Remote binding required.' }
$taskName='Cage Remote Headless ' + $binding.vm_id
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Existing headless task must be preserved.' }
$key=Join-Path $env:ProgramData ('Cage Remote Guest\' + $binding.vm_id + '\pairing.key')
$arguments='serve-headless --vm-id {0} --sid {1} --token-file "{2}" --machine-id {3}' -f $binding.vm_id,$binding.gui_user_sid,$key,$binding.machine_id
$action=New-ScheduledTaskAction -Execute (Join-Path $Bundle 'Cage.GuestClipboard.exe') -Argument $arguments
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([timespan]::Zero) -MultipleInstances IgnoreNew
$credential=Import-Clixml -LiteralPath (Join-Path $Root 'gui-credential.clixml')
Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -User $credential.UserName -Password $credential.GetNetworkCredential().Password -RunLevel Limited | Out-Null
Start-ScheduledTask -TaskName $taskName
[pscustomobject]@{task=$taskName;execution='appcontainer-headless';workload_ready=$false} | ConvertTo-Json -Compress
