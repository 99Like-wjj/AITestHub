param([ValidateSet('Build','Migrate','Up','Status','Stop','Logs','StartApiWorker','StopApiWorker','StartAiWorker','StopAiWorker')][string]$Action='Status',[ValidateRange(1,2)][int]$ApiWorkerCount=2)
$ErrorActionPreference='Stop'
$taskDockerCommand=Get-Command docker.exe -ErrorAction SilentlyContinue
$taskDocker=if($taskDockerCommand){$taskDockerCommand.Source}else{Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'}
if(-not(Test-Path -LiteralPath $taskDocker)){throw 'Docker CLI is not installed.'}
$taskDockerBin=Split-Path -Parent $taskDocker
if(($env:Path -split ';') -notcontains $taskDockerBin){$env:Path=$taskDockerBin+';'+$env:Path}
$taskRuntimeEnv=Join-Path $env:LOCALAPPDATA 'AITestHub\runtime.env'
if(-not(Test-Path -LiteralPath $taskRuntimeEnv)){throw 'Existing local runtime configuration is required.'}
$taskArguments=@('compose','--env-file',$taskRuntimeEnv,'-f',(Join-Path $PSScriptRoot 'compose.yaml'),'-f',(Join-Path $PSScriptRoot 'compose.app.yaml'))
if($Action -match 'Worker$') {$taskArguments+=@('-f',(Join-Path $PSScriptRoot 'compose.workers.yaml'),'--profile','workers')}
switch($Action){
  'Build' {$taskArguments+=@('build','api')}
  'Migrate' {$taskArguments+=@('run','--rm','--no-deps','api','node','dist/scripts/migrate.js')}
  'Up' {$taskArguments+=@('up','-d','--no-build','api')}
  'Status' {$taskArguments+=@('ps')}
  'Stop' {$taskArguments+=@('stop','api')}
  'Logs' {$taskArguments+=@('logs','--tail','60','api')}
  'StartApiWorker' {$taskArguments+=@('up','-d','--no-build','--no-deps','--scale',('api-worker='+$ApiWorkerCount),'api-worker')}
  'StopApiWorker' {$taskArguments+=@('stop','api-worker')}
  'StartAiWorker' {$taskArguments+=@('up','-d','--no-build','--no-deps','ai-worker')}
  'StopAiWorker' {$taskArguments+=@('stop','ai-worker')}
}
& $taskDocker @taskArguments
if($LASTEXITCODE -ne 0){throw "Application operation failed: $Action (exit $LASTEXITCODE)"}
