#requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-host-image.ps1')
function Assert-Check([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
$credential = [pscredential]::new('CageAdmin', (ConvertTo-SecureString 'Test-only<&>"Account!123' -AsPlainText -Force))
$answer = New-CageISOAnswer $credential
$named = New-CageISOAnswer $credential 'MY-PC'
$ns = [Xml.XmlNamespaceManager]::new($answer.NameTable)
$ns.AddNamespace('u', 'urn:schemas-microsoft-com:unattend')
Assert-Check ($answer.SelectSingleNode('//u:ComputerName', $ns).InnerText -ceq '*') 'Default ISO computer name is fixed.'
Assert-Check ($named.SelectSingleNode('//u:ComputerName', $ns).InnerText -ceq 'MY-PC') 'ISO setup ignored the manual name.'
$roundtrip = [xml]$answer.OuterXml
Assert-Check ($roundtrip.SelectSingleNode('//u:LocalAccount/u:Name', $ns).InnerText -ceq 'CageAdmin') 'Initial account name changed.'
Assert-Check ($roundtrip.SelectSingleNode('//u:LocalAccount/u:Password/u:Value', $ns).InnerText -ceq $credential.GetNetworkCredential().Password) 'Password XML escaping changed the credential.'
Assert-Check ($answer.SelectSingleNode('//u:LocalAccount/u:Group', $ns).InnerText -ceq 'Administrators') 'PowerShell Direct needs the initial administrator.'
foreach ($setting in @('HideOnlineAccountScreens', 'HideWirelessSetupInOOBE')) {
    Assert-Check ($answer.SelectSingleNode('//u:OOBE/u:'+$setting, $ns).InnerText -ceq 'true') 'Offline OOBE settings are missing.'
}
# Windows Setup ignores an Autounattend.xml without windowsPE settings ("does not
# meet criteria"), which silently drops the specialize and oobeSystem passes. The
# one windowsPE setting must stay Setup's own default so no manual page changes.
$winPE = @($answer.SelectNodes('//u:settings[@pass="windowsPE"]//u:component', $ns))
Assert-Check ($winPE.Count -eq 1 -and $winPE[0].GetAttribute('name') -ceq 'Microsoft-Windows-Setup') 'The manual ISO answer needs one windowsPE component so Windows Setup accepts it.'
Assert-Check (@($winPE[0].ChildNodes | Where-Object NodeType -eq 'Element').Count -eq 1 -and $winPE[0].SelectSingleNode('u:EnableNetwork', $ns).InnerText -ceq 'true') 'The windowsPE setting must only keep Setup''s default network behaviour.'
Assert-Check ($answer.SelectNodes('//u:DiskConfiguration | //u:ImageInstall | //u:HideEULAPage | //u:AcceptEula | //u:ProductKey | //u:AutoLogon | //u:UILanguage | //u:SkipMachineOOBE', $ns).Count -eq 0) 'Manual ISO choices or administrator sign-in were overridden.'
foreach ($name in @('Administrator', 'cagesetup', 'host\user', 'user@example.com', 'abcdefghijklmnopqrstu')) {
    try {
        $null = New-CageISOAnswer ([pscredential]::new($name, $credential.Password))
        throw 'Invalid account accepted'
    } catch { if ($_.Exception.Message -eq 'Invalid account accepted') { throw } }
}

# Execute the production branch which chooses the answer before creating a disk.
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'new-windows-test-vm.ps1'), [ref]$null, [ref]$errors)
Assert-Check ($errors.Count -eq 0) 'VM creation script failed to parse.'
$selection = @($ast.EndBlock.Statements | Where-Object { $_.Extent.Text.StartsWith('if ($fromHost) {') })[0]
Assert-Check ($null -ne $selection) 'Missing production answer selection.'
$createAnswer = [scriptblock]::Create($selection.Extent.Text)
$script:prompts = 0
function Get-Credential { param($UserName, $Message); $script:prompts++; return $credential }
$fromHost = $false
$ComputerName = 'Office-PC'
$GuestAdministrator = $null
. $createAnswer
Assert-Check ($script:prompts -eq 1 -and $answer.SelectNodes('//u:LocalAccount', $ns).Count -eq 1) 'The manual route did not collect an offline account.'
Assert-Check ($answer.SelectSingleNode('//u:ComputerName', $ns).InnerText -ceq $ComputerName) 'The manual route dropped the selected computer name.'
. $createAnswer
Assert-Check ($script:prompts -eq 1) 'An explicit credential prompted again.'
$fromHost = $true
$GuestAdministrator = [pscredential]::new('cagesetup', $credential.Password)
$ImageLanguage = 'zh-CN'
. $createAnswer
Assert-Check ($answer.SelectSingleNode('//u:LocalAccount/u:Name', $ns).InnerText -ceq 'cagesetup') 'Clone setup account changed.'
Assert-Check ($answer.SelectSingleNode('//u:UILanguage', $ns).InnerText -ceq 'zh-CN') 'Clone locale changed.'
Assert-Check ($answer.SelectSingleNode('//u:ComputerName', $ns).InnerText -ceq $ComputerName) 'The clone route dropped the selected computer name.'

# The owner's progress reader accepts only known stages and reads the final
# stage after process exit. Arbitrary child output never becomes UI content.
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'setup-windows-guest.ps1'), [ref]$null, [ref]$errors)
Assert-Check ($errors.Count -eq 0) 'Setup orchestration failed to parse.'
$wait = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-CageWindowsInstaller' }, $true)
. ([scriptblock]::Create($wait.Extent.Text))
$progressFile = [IO.Path]::GetTempFileName()
$heldProgress = [IO.File]::Open($progressFile, 'Open', 'ReadWrite', 'ReadWrite')
$writer = [IO.File]::Open($progressFile, 'Open', 'Write', 'ReadWrite')
try {
    $process = [pscustomobject]@{ Position = 0; Writer = $writer; Stages = @('CAGE_GUEST_STAGE windows-11 account', 'private diagnostic fixture', 'CAGE_GUEST_STAGE windows-11 media', 'CAGE_GUEST_STAGE windows-11 tools', 'CAGE_GUEST_STAGE windows-11 services', 'CAGE_GUEST_STAGE windows-11 oobe') }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
        param($Timeout)
        $bytes = [Text.Encoding]::UTF8.GetBytes($this.Stages[$this.Position])
        $this.Writer.Position = 0
        $this.Writer.SetLength(0)
        $this.Writer.Write($bytes, 0, $bytes.Length)
        $this.Writer.Flush()
        $this.Position++
        return $this.Position -eq $this.Stages.Count
    }
    $stages = @(Wait-CageWindowsInstaller $process $progressFile)
    Assert-Check ($stages.Count -eq 5 -and $stages[-1] -ceq 'CAGE_GUEST_STAGE windows-11 oobe') 'Final progress or stage filtering failed.'
    $writer.Dispose()

    # Execute the exact encoded wrapper in a real child PowerShell process.
    # UAC itself is covered by native acceptance, while file sharing is exercised here.
    $wrapper = $ast.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$command' -and $node.Right.Extent.Text.StartsWith("@'") }, $true)
    $literal = $wrapper.Right.Find({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] }, $true)
    $command = $literal.Value
    $fixtureScript = $progressFile+'.ps1'
    $stdout = $progressFile+'.stdout'
    $stderr = $progressFile+'.stderr'
    try {
        $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{ProgressFile=$progressFile}|ConvertTo-Json -Compress)))
        $scriptPath = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($fixtureScript))
        $command = $command.Replace('__PARAMETERS__', $payload).Replace('__SCRIPT__', $scriptPath)
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
        foreach ($case in @(
            @{Last="Write-Output 'CAGE_GUEST_STAGE windows-11 oobe'"; Expected='CAGE_GUEST_STAGE windows-11 oobe'; Exit=0}
            @{Last="throw 'CAGE_WINDOWS_ISO_BOOT failed'"; Expected='CAGE_WINDOWS_ISO_BOOT failed'; Exit=1}
            @{Last="throw 'CAGE_WINDOWS_ISO_BOOT unconfirmed'"; Expected='CAGE_WINDOWS_ISO_BOOT unconfirmed'; Exit=1}
            @{Last="throw 'CAGE_WINDOWS_ISO_BOOT failed with private diagnostic'"; Expected='CAGE_GUEST_STAGE windows-11 account'; Exit=1}
        )) {
            $heldProgress.SetLength(0)
            [IO.File]::WriteAllLines($fixtureScript, @("Write-Output 'CAGE_GUEST_STAGE windows-11 account'", "Write-Output 'private diagnostic fixture'", $case.Last))
            $child = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
            try {
                $null = $child.Handle
                $forwarded = @(Wait-CageWindowsInstaller $child $progressFile)
                Assert-Check ($child.ExitCode -eq $case.Exit) ('Unexpected installer exit code. '+[IO.File]::ReadAllText($stderr))
                Assert-Check ($forwarded[-1] -ceq $case.Expected) ('Expected final installer marker '+$case.Expected)
            } finally { $child.Dispose() }
        }
    } finally {
        foreach ($path in @($fixtureScript,$stdout,$stderr)) { [IO.File]::Delete($path) }
    }
} finally { $writer.Dispose(); $heldProgress.Dispose(); [IO.File]::Delete($progressFile) }

# An interrupted or unauthenticated guest retains its answer media. Successful
# cleanup only removes the fixed tools ISO and preserves the original disk.
$directory = Join-Path ([IO.Path]::GetTempPath()) ('cage-iso-answer-'+[guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($directory)
try {
    $iso = Join-Path $directory 'windows-guest-tools.iso'
    $disk = Join-Path $directory 'system.vhdx'
    [IO.File]::WriteAllText($iso, 'private answer fixture')
    [IO.File]::WriteAllText($disk, 'existing personal disk fixture')
    $vm = [pscustomobject]@{ Id = [guid]::NewGuid() }
    $script:guestReady = $false
    $script:removedDVDs = @()
    function Invoke-Command { param($Session, $ArgumentList, $ScriptBlock); if (!$script:guestReady) { throw 'Guest setup incomplete' } }
    function Hyper-V\Get-VMDvdDrive { process { @([pscustomobject]@{Path=$iso}, [pscustomobject]@{Path='original-windows.iso'}) } }
    function Hyper-V\Remove-VMDvdDrive { process { $script:removedDVDs += $_.Path } }
    try { Remove-CageISOAnswer $vm 'session' $directory; throw 'Incomplete setup was accepted' }
    catch { if ($_.Exception.Message -cne 'Guest setup incomplete') { throw } }
    Assert-Check ((Test-Path -LiteralPath $iso) -and $script:removedDVDs.Count -eq 0) 'Unfinished setup lost its answer media.'
    $script:guestReady = $true
    Remove-CageISOAnswer $vm 'session' $directory
    Assert-Check (!(Test-Path -LiteralPath $iso) -and $script:removedDVDs.Count -eq 1 -and $script:removedDVDs[0] -eq $iso) 'Cleanup touched the wrong DVD.'
    Assert-Check ([IO.File]::ReadAllText($disk) -ceq 'existing personal disk fixture') 'Cleanup changed the retained disk.'
} finally { [IO.Directory]::Delete($directory, $true) }
Write-Output 'Passed manual ISO account/OOBE XML, retained manual choices, clone parity and elevated installer progress forwarding.'

# Exercise the real firmware reader and boot wait with host-local substitutes.
& {
    $target = [guid]::NewGuid()
    $since = Get-Date
    function New-BootEvent($Id, $VMId, $Time) {
        [pscustomobject]@{ Id=$Id; TimeCreated=$Time; Properties=@(@{Value='Windows'}, @{Value=$VMId.ToString('B')}) }
    }
    $events = @((New-BootEvent 18601 ([guid]::NewGuid()) $since), (New-BootEvent 18603 $target $since), (New-BootEvent 18601 $target $since.AddMinutes(-2)))
    function Get-WinEvent($FilterHashtable) {
        Assert-Check ($FilterHashtable.LogName -ceq 'Microsoft-Windows-Hyper-V-Worker-Admin' -and $FilterHashtable.ProviderName -ceq 'Microsoft-Windows-Hyper-V-Chipset') 'Wrong firmware event source.'
        $events | Where-Object { $_.TimeCreated -ge $FilterHashtable.StartTime -and $FilterHashtable.Id -contains $_.Id }
    }
    Assert-Check ((Get-CageWindowsBootEvent $target $since) -eq 18603) 'A different VM masked the boot failure.'
    Assert-Check ($null -eq (Get-CageWindowsBootEvent $target $since.AddSeconds(1))) 'A previous boot supplied evidence.'

    $keys = [Collections.Generic.List[uint32]]::new()
    $vm = [pscustomobject]@{ Id=$target; Heartbeat='NoContact'; State='Running'; Uptime=[timespan]::FromSeconds(10) }
    function Hyper-V\Get-VM($Id) { Assert-Check ($Id -eq $target) 'Polled a different VM.'; $vm }
    function Get-CimInstance($Namespace, $ClassName, $Filter) {
        Assert-Check ($Namespace -eq 'root/virtualization/v2' -and $ClassName -eq 'Msvm_Keyboard' -and $Filter -eq "SystemName='$target'") 'Selected a different keyboard.'
        [pscustomobject]@{ SystemName=$target }
    }
    function Invoke-CimMethod($InputObject, $MethodName, $Arguments) {
        Assert-Check ($InputObject.SystemName -eq $target -and $MethodName -eq 'TypeKey') 'Wrong virtual keyboard input.'
        $keys.Add($Arguments.keyCode)
        [pscustomobject]@{ ReturnValue=0 }
    }

    $instance = Join-Path ([IO.Path]::GetTempPath()) ('cage-boot-'+$target)
    $null = [IO.Directory]::CreateDirectory($instance)
    $disk = Join-Path $instance 'system.vhdx'
    [IO.File]::WriteAllBytes($disk, [byte[]]@())
    try {
        $events = @()
        $vm.Heartbeat = 'OkApplicationsHealthy'
        Wait-CageWindowsISOBoot $target $since $disk 0 $false -TimeoutSeconds 0
        $vm.Heartbeat = 'NoContact'

        # Run the production statements that choose whether to press a key and open Setup.
        $statements = $ast.EndBlock.Statements
        $start = ($statements | Where-Object { $_.Extent.Text.StartsWith('$manualISO =') }).Extent.StartOffset
        $end = ($statements | Where-Object { $_.Extent.Text.Contains("Write-Output 'CAGE_GUEST_STAGE windows-11 oobe'") -and $_.Extent.StartOffset -gt $start } | Select-Object -Last 1).Extent.EndOffset
        $boot = [scriptblock]::Create($ast.Extent.Text.Substring($start, $end - $start))
        $fromHost=$false; $published=$false; $IsoPath='fixture.iso'; $receipt=Join-Path $instance 'receipt'
        function Hyper-V\Get-VMHardDiskDrive { process { [pscustomobject]@{Path=$disk} } }
        function Hyper-V\Get-VMDvdDrive { process { [pscustomobject]@{Path=$IsoPath} } }
        function Hyper-V\Get-VHD { [pscustomobject]@{Attached=$false} }
        function Hyper-V\Mount-VHD { [pscustomobject]@{DiskNumber=1} }
        function Hyper-V\Dismount-VHD {}
        function Get-Disk { [pscustomobject]@{PartitionStyle=$partitionStyle} }
        function Hyper-V\Start-VM { $vm.State='Running'; $vm }
        function Start-Process {}
        function Start-Sleep { $events.Add((New-BootEvent 18601 $target (Get-Date))) }
        foreach ($scenario in @('new disk','retained RAW','retained GPT')) {
            $createdNow=$scenario -eq 'new disk'; $readyToProvision=!$createdNow
            $partitionStyle=if ($scenario -eq 'retained GPT') { 'GPT' } else { 'RAW' }
            $expectSetup=$partitionStyle -eq 'RAW'
            $vm.State='Off'; $keys.Clear()
            $events=[Collections.Generic.List[object]]::new()
            $stages = @(& $boot)
            Assert-Check (($keys.Count -gt 0) -eq $expectSetup) "Wrong DVD prompt key behaviour for $scenario."
            Assert-Check (($stages -contains 'CAGE_GUEST_STAGE windows-11 oobe') -eq $expectSetup) "Wrong OOBE handoff for $scenario."
        }
        [IO.File]::Delete($receipt)
        $vm.State='Running'; $readyToProvision=$false
        $productionWait = (Get-Command Wait-CageWindowsISOBoot).ScriptBlock
        function Wait-CageWindowsISOBoot { & $productionWait @args -TimeoutSeconds 0 }
        foreach ($outcome in @('failed','unconfirmed')) {
            $events = @(if ($outcome -eq 'failed') { New-BootEvent 18603 $target (Get-Date) })
            $result = try { & $boot; throw 'Unexpected boot success' } catch { $_.Exception.Message }
            Assert-Check (@($result)[-1] -ceq "CAGE_WINDOWS_ISO_BOOT $outcome" -and $result -notcontains 'CAGE_GUEST_STAGE windows-11 oobe' -and !(Test-Path $receipt)) "A $outcome boot reached the OOBE handoff."
        }
    } finally { [IO.Directory]::Delete($instance, $true) }
}
Write-Output 'Passed Windows ISO boot evidence, keyboard targeting, first-start and resume tests.'
