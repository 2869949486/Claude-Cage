# Build Cage-owned assets only. Third-party Windows packages are fetched when
# Windows is selected. Claude releases resolve from official metadata then;
# other packages use the digests in windows-workbench-packages.json.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Destination,
    [switch]$SkipAnalysis,
    [switch]$RequireAnalysis
)
$ErrorActionPreference='Stop'
if ($SkipAnalysis -and $RequireAnalysis) { throw 'Cage.GuestClipboard analysis is required for this build.' }
$root=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$dest=[IO.Path]::GetFullPath($Destination)
$null=New-Item -ItemType Directory -Force $dest
$build=Join-Path ([IO.Path]::GetTempPath()) ('cage-windows-publish-'+[guid]::NewGuid())
Push-Location $root
$oldOS=$env:GOOS; $oldArch=$env:GOARCH; $oldCGO=$env:CGO_ENABLED
try {
    $project = Join-Path $PSScriptRoot 'guest-clipboard-windows/Cage.GuestClipboard.csproj'
    $publish = Join-Path $build 'publish'
    # Use a fresh obj directory so a signed build cannot reuse a compilation
    # from a local build that skipped its analyzers.
    $publishProperties = @('-r', 'win-x64', '-p:Configuration=Release', '-p:SelfContained=true',
        '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true',
        '--artifacts-path', (Join-Path $build 'artifacts'))
    if ($RequireAnalysis) {
        $publishProperties += @('-p:RunAnalyzers=true', '-p:RunAnalyzersDuringBuild=true',
            '-p:EnableNETAnalyzers=true', '-p:EnableSingleFileAnalyzer=true')
    } elseif ($SkipAnalysis) {
        $publishProperties += @('-p:RunAnalyzers=false', '-p:RunAnalyzersDuringBuild=false')
        Write-Warning 'Skipping build analyzers for Cage.GuestClipboard in this local build.'
    }
    Write-Host 'Restoring .NET dependencies for Cage.GuestClipboard'
    dotnet restore $project @publishProperties
    if ($LASTEXITCODE) { throw 'Could not restore Cage.GuestClipboard dependencies.' }
    Write-Host 'Compiling and publishing Cage.GuestClipboard'
    $publishTime = [Diagnostics.Stopwatch]::StartNew()
    dotnet publish $project @publishProperties --no-restore -o $publish
    if ($LASTEXITCODE) {throw 'Could not publish the native Windows guest bridge.'}
    Write-Host ('Published Cage.GuestClipboard in {0:F1} s' -f $publishTime.Elapsed.TotalSeconds)
    Copy-Item -LiteralPath (Join-Path $publish 'Cage.GuestClipboard.exe') -Destination $dest
    $env:GOOS='windows'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
    go build -trimpath -o (Join-Path $dest 'cage-guest-files.exe') ./cmd/cage-guest-files
    if ($LASTEXITCODE) {throw 'Could not build the Windows guest file helper.'}
    go build -trimpath -o (Join-Path $dest 'cage-guest-boot.exe') ./cmd/cage-guest-boot
    if ($LASTEXITCODE) {throw 'Could not build the Windows guest boot service.'}
    go build -trimpath -o (Join-Path $dest 'Cage.HyperVManager.exe') ./cmd/cage-hyperv-manager
    if ($LASTEXITCODE) {throw 'Could not build the scoped Windows host manager.'}
    Push-Location (Join-Path $root 'tools/tailnet')
    try { go build -trimpath -ldflags '-s -w' -o (Join-Path $dest 'cage-tailnet.exe') .; if ($LASTEXITCODE) { throw 'Could not build Cage Tailscale.' } } finally { Pop-Location }
    Copy-Item -LiteralPath (Join-Path $root 'internal/cage/tailnet-client.mjs') -Destination $dest
    Copy-Item -LiteralPath (Join-Path $root 'internal/cage/device-observation.mjs') -Destination $dest
    foreach ($file in @('windows-browser.mjs','browser-protocol.mjs','windows-browser-extensions.mjs','windows-phone-browser.mjs','windows-workbench-packages.json','install-windows-workbench-user-tools.ps1','claude-desktop-windows.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $dest
    }
    foreach ($file in @('install-cli.ps1','cli-dependencies.json')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('guest-clipboard-windows/'+$file)) -Destination $dest
    }
    $moduleDir=Join-Path $dest 'modules'
    $null=New-Item -ItemType Directory -Force $moduleDir
    foreach ($name in @('clipboard','uploads','downloads','cookies','extensions','vault','phone','phone-network')) {
        Copy-Item -LiteralPath (Join-Path $root "internal/cage/browser-$name.mjs") -Destination $moduleDir
    }
    Copy-Item -LiteralPath (Join-Path $root 'internal/cage/split-extension') -Destination $dest -Recurse -Force
} finally {
    $env:GOOS=$oldOS; $env:GOARCH=$oldArch; $env:CGO_ENABLED=$oldCGO
    Pop-Location
    if (Test-Path -LiteralPath $build) { Remove-Item -LiteralPath $build -Recurse -Force }
}
