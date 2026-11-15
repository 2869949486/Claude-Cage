[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][string]$Source,
    [string]$Root = 'C:\ProgramData\Cage Remote',
    [string]$Components = 'C:\Program Files\Cage Remote\bridge'
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$binding=Get-Content -LiteralPath (Join-Path $Root 'windows-guest.json') -Raw | ConvertFrom-Json
if ($binding.mode -ne 'remote') { throw 'Remote binding required.' }
$account=Get-LocalUser -Name $binding.gui_user
if ($account.SID.Value -ne $binding.gui_user_sid) { throw 'Remote account identity mismatch.' }
$profile=(Get-CimInstance Win32_UserProfile | Where-Object SID -eq $account.SID.Value).LocalPath
if (-not $profile) { throw 'The bound account profile is not installed.' }
$destination=Join-Path $profile 'Cage\CLI\tools\chromium-headless-1254'
if (-not (Test-Path -LiteralPath $destination)) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive,$destination)
}
foreach ($name in @('node.exe','playwright','modules','browser-protocol.mjs','windows-browser-extensions.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $destination $name))) {
        Copy-Item -LiteralPath (Join-Path $Components $name) -Destination $destination -Recurse
    }
}
foreach ($name in @('windows-browser.mjs','windows-remote-browser.mjs','windows-appcontainer-spawn.mjs','tailnet-client.mjs')) {
    Copy-Item -LiteralPath (Join-Path $Source $name) -Destination $destination -Force
}
# Publish only browser presentation settings, never the host config/proxy
# credential. The installed tool tree is read-only to the AppContainer.
$config=Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
$browserSettings=@{timezone=$config.timezone;language=$config.browser_language}
if (-not ($browserSettings.timezone -is [string]) -or -not $browserSettings.timezone -or
    $browserSettings.timezone.Length -gt 128 -or
    $browserSettings.language -notmatch '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$') { throw 'Browser region settings are invalid.' }
[IO.File]::WriteAllText((Join-Path $destination 'remote-browser-settings.json'),($browserSettings | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CageBrowserPackageIdentity {
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll")] public static extern IntPtr FreeSid(IntPtr sid);
}
'@
$pointer=[IntPtr]::Zero
[Runtime.InteropServices.Marshal]::ThrowExceptionForHR([CageBrowserPackageIdentity]::DeriveAppContainerSidFromAppContainerName('Cage.Remote.'+([guid]$binding.vm_id).ToString('N'),[ref]$pointer))
try { $package=[Security.Principal.SecurityIdentifier]::new($pointer) }
finally { [void][CageBrowserPackageIdentity]::FreeSid($pointer) }
$acl=Get-Acl -LiteralPath $destination
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($package,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $destination -AclObject $acl
# Data is kept in the package home, never in this installed tool tree.
[pscustomobject]@{phase='browser_components_installed';path=$destination;network='unchanged';workload_ready=$false} | ConvertTo-Json -Compress
