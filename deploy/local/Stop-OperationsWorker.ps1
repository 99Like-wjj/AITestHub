param([int]$WaitSeconds=60)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'OperationsWorkerIdentity.ps1')
$taskPrivateRoot=if($env:AITESTHUB_LOCAL_ROOT){$env:AITESTHUB_LOCAL_ROOT}else{Join-Path $env:LOCALAPPDATA 'AITestHub'}
$taskDirectory=Join-Path $taskPrivateRoot 'setup\operations'
$taskPidFile=Join-Path $taskDirectory 'worker.json'
if(-not(Test-Path -LiteralPath $taskPidFile)){Write-Output 'No recorded operations worker.';return}
$taskRecorded=Get-Content -LiteralPath $taskPidFile -Raw|ConvertFrom-Json
$taskProcess=Get-Process -Id $taskRecorded.pid -ErrorAction SilentlyContinue
if(-not $taskProcess){Write-Output 'Recorded operations worker has exited.';return}
if(-not(Test-AITestHubOperationsProcessIdentity -TaskProcess $taskProcess -TaskRecordedStart $taskRecorded.startedAt)){throw 'PID belongs to another process; no stop was sent.'}
'requested'|Set-Content -LiteralPath (Join-Path $taskDirectory 'stop.request') -Encoding utf8
try{Wait-Process -Id $taskRecorded.pid -Timeout $WaitSeconds -ErrorAction Stop;Write-Output 'Operations worker finished its current transaction/backup and exited.'}catch{Write-Output 'Graceful stop is pending; current backup is allowed to finish. No force termination was sent.'}
