param([string]$WorkspaceRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'OperationsWorkerIdentity.ps1')
$taskWorkspace=(Resolve-Path -LiteralPath $WorkspaceRoot).Path
$taskScript=Join-Path $taskWorkspace 'dist\scripts\operations-worker.js'
if(-not(Test-Path -LiteralPath $taskScript -PathType Leaf)){throw 'Build the approved server first; operations worker is not compiled.'}
$taskPrivateRoot=if($env:AITESTHUB_LOCAL_ROOT){$env:AITESTHUB_LOCAL_ROOT}else{Join-Path $env:LOCALAPPDATA 'AITestHub'}
$taskRunDirectory=Join-Path $taskPrivateRoot 'setup\operations'
New-Item -ItemType Directory -Path $taskRunDirectory -Force|Out-Null
$taskPidFile=Join-Path $taskRunDirectory 'worker.json'
if(Test-Path -LiteralPath $taskPidFile){$taskPrior=Get-Content -LiteralPath $taskPidFile -Raw|ConvertFrom-Json;$taskProcess=Get-Process -Id $taskPrior.pid -ErrorAction SilentlyContinue;if($taskProcess -and (Test-AITestHubOperationsProcessIdentity -TaskProcess $taskProcess -TaskRecordedStart $taskPrior.startedAt)){throw 'The recorded operations process is still running; inspect it before starting another.'}}
$taskNode=(Get-Command node -ErrorAction Stop).Source
# Keep prior daemon diagnostics before Start-Process redirects the current filenames.
$taskExistingLogs=@('worker.stdout.log','worker.stderr.log','worker.json')|Where-Object {Test-Path -LiteralPath (Join-Path $taskRunDirectory $_) -PathType Leaf}
if($taskExistingLogs.Count -gt 0){
  $taskHistoryDirectory=Join-Path $taskRunDirectory ('history\'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $taskHistoryDirectory|Out-Null
  foreach($taskLogName in $taskExistingLogs){Copy-Item -LiteralPath (Join-Path $taskRunDirectory $taskLogName) -Destination (Join-Path $taskHistoryDirectory $taskLogName) -ErrorAction Stop}
}
$taskStopFile=Join-Path $taskRunDirectory 'stop.request'
if(Test-Path -LiteralPath $taskStopFile){Remove-Item -LiteralPath $taskStopFile}
$env:AITESTHUB_OPERATIONS_STOP_FILE=$taskStopFile
$taskChild=Start-Process -FilePath $taskNode -ArgumentList @(('"'+$taskScript+'"')) -WorkingDirectory $taskWorkspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRunDirectory 'worker.stdout.log') -RedirectStandardError (Join-Path $taskRunDirectory 'worker.stderr.log') -PassThru
@{pid=$taskChild.Id;startedAt=$taskChild.StartTime.ToUniversalTime().ToString('O');workspace=$taskWorkspace}|ConvertTo-Json|Set-Content -LiteralPath $taskPidFile -Encoding utf8
Write-Output ('Operations worker started: pid='+$taskChild.Id+'; safe logs='+$taskRunDirectory)
