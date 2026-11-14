param([Parameter(Mandatory=$true)][string]$TaskRoot)
$ErrorActionPreference='Stop'
$taskPrincipal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Normal administrator/UAC approval is required.'}
$taskResolved=[IO.Path]::GetFullPath($TaskRoot)
if((Split-Path -Leaf $taskResolved) -ne 'AITestHub'){throw 'Unexpected task runtime directory.'}
$taskLogs=Join-Path $taskResolved 'setup\logs'
$taskMsi=Join-Path $taskResolved 'setup\downloads\wsl.3.0.5.0.x64.msi'
$taskHash=(Get-FileHash -LiteralPath $taskMsi -Algorithm SHA256).Hash.ToLowerInvariant()
if($taskHash -ne '2313efc5873e3f8552f42e77f950fabd913c0289078fa89d2100f3421a525eaa'){throw 'WSL MSI checksum mismatch.'}
$taskSignature=Get-AuthenticodeSignature -LiteralPath $taskMsi
if($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notmatch 'Microsoft'){throw 'WSL MSI signature invalid.'}
try {
    $taskFeature=Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
    $taskFeatureBefore=$taskFeature.State.ToString()
    $taskFeatureRestart=$false
    if($taskFeature.State -eq 'Disabled'){
        $taskEnabled=Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All -NoRestart
        $taskFeatureRestart=[bool]$taskEnabled.RestartNeeded
    } elseif($taskFeature.State.ToString() -match 'Pending') {
        $taskFeatureRestart=$true
    }
    $taskMsiLog=Join-Path $taskLogs 'wsl-msi-install.log'
    $taskProcess=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') `
        -ArgumentList @('/i',('"'+$taskMsi+'"'),'/qn','/norestart','/l*v',('"'+$taskMsiLog+'"')) `
        -WindowStyle Hidden -Wait -PassThru
    $taskFinalFeature=Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
    [ordered]@{action='Microsoft WSL 3.0.5 MSI + VirtualMachinePlatform';featureBefore=$taskFeatureBefore;featureAfter=$taskFinalFeature.State.ToString();exitCode=$taskProcess.ExitCode;restartNeeded=($taskFeatureRestart -or $taskProcess.ExitCode -eq 3010);autoRebootRequested=$false;completedAt=(Get-Date).ToUniversalTime().ToString('o')} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskLogs 'wsl-msi-install-result.json') -Encoding utf8
} catch {
    [ordered]@{action='WSL MSI installation';error=$_.Exception.Message;autoRebootRequested=$false} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskLogs 'wsl-msi-install-result.json') -Encoding utf8
    throw
}
