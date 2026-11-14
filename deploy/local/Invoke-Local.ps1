param(
    [ValidateSet('Config','Pull','Up','Status','Stop','Logs')][string]$Action='Status'
)
$ErrorActionPreference='Stop'
$taskDockerCommand=Get-Command docker.exe -ErrorAction SilentlyContinue
$taskDocker=if($taskDockerCommand){$taskDockerCommand.Source}else{Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'}
if(-not(Test-Path -LiteralPath $taskDocker)){throw 'Docker CLI is not installed.'}
# The running Codex app can retain the pre-install PATH. Make the installed credential helper
# available in this child process without changing system/user PATH or touching credential stores.
$taskDockerBin=Split-Path -Parent $taskDocker
if(($env:Path -split ';') -notcontains $taskDockerBin){$env:Path=$taskDockerBin+';'+$env:Path}
$taskRuntimeEnv=Join-Path $env:LOCALAPPDATA 'AITestHub\runtime.env'
if(-not(Test-Path -LiteralPath $taskRuntimeEnv)){throw 'Run setup/Initialize-LocalEnvironment.ps1 first.'}
$taskArguments=@('compose','--env-file',$taskRuntimeEnv,'-f',(Join-Path $PSScriptRoot 'compose.yaml'))
switch($Action){
    'Config' {$taskArguments+=@('config','--quiet')}
    'Pull' {$taskArguments+=@('pull')}
    'Up' {$taskArguments+=@('up','-d')}
    'Status' {$taskArguments+=@('ps')}
    'Stop' {$taskArguments+=@('stop')}
    'Logs' {$taskArguments+=@('logs','--tail','60')}
}
& $taskDocker @taskArguments
if($LASTEXITCODE -ne 0){throw "Docker operation failed: $Action (exit $LASTEXITCODE)"}
