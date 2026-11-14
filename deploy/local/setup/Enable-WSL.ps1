# Authorized local environment preparation only. No automatic reboot or user distro.
$ErrorActionPreference = 'Stop'
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskPrincipal = [Security.Principal.WindowsPrincipal]::new($taskIdentity)
if (-not $taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Enable-WSL.ps1 requires the normal Windows administrator/UAC approval.'
}
$taskRoot = Join-Path $env:LOCALAPPDATA 'AITestHub'
$taskLogs = Join-Path $taskRoot 'setup\logs'
New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
$taskResultPath = Join-Path $taskLogs 'wsl-install-result.json'
try {
    $taskProcess = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wsl.exe') `
        -ArgumentList @('--install','--no-distribution','--web-download') `
        -WindowStyle Hidden -Wait -PassThru `
        -RedirectStandardOutput (Join-Path $taskLogs 'wsl-install.stdout.log') `
        -RedirectStandardError (Join-Path $taskLogs 'wsl-install.stderr.log')
    [ordered]@{
        action='wsl --install --no-distribution --web-download'
        exitCode=$taskProcess.ExitCode
        autoRebootRequested=$false
        completedAt=(Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $taskResultPath -Encoding utf8
} catch {
    [ordered]@{action='WSL installation';error=$_.Exception.Message;autoRebootRequested=$false} |
        ConvertTo-Json | Set-Content -LiteralPath $taskResultPath -Encoding utf8
    throw
}
