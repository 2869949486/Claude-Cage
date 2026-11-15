# Only loaded by the isolated remote PowerShell entry. Git for Windows may
# terminate with STATUS_INVALID_HANDLE when attached directly to an AppContainer
# console. Stream its stdout through PowerShell's pipe and retain its exit code.
# Child processes still inherit the AppContainer token and the same Job object.
function global:git {
    & $env:CAGE_REMOTE_GIT @args | ForEach-Object { $_ }
    $global:LASTEXITCODE = $LASTEXITCODE
}
Set-Location -LiteralPath $env:USERPROFILE
