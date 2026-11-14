# Foundation DB only, before product tables exist. Product full backup is implemented in O01.
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'AITestHub'))
$taskDocker=Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
$env:Path=(Split-Path -Parent $taskDocker)+';'+$env:Path
$taskArgs=@('compose','--env-file',(Join-Path $taskRoot 'runtime.env'),'-f',(Join-Path $PSScriptRoot 'compose.yaml'))
$taskGuard=@'
PGPASSWORD="$(cat /run/secrets/postgres_app_password)" psql -h 127.0.0.1 -U aitesthub_app -d aitesthub -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='app';"
'@
$taskCount=(& $taskDocker @taskArgs exec -T postgres sh -c $taskGuard)
if($LASTEXITCODE -ne 0 -or $taskCount.Trim() -ne '0'){throw 'Foundation-only backup refuses to run after product tables exist; use the product backup workflow.'}
$taskId='foundation-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$taskBackupRoot=Join-Path $taskRoot 'backups'
$taskStage=[IO.Path]::GetFullPath((Join-Path $taskBackupRoot ('staging\'+$taskId)))
if(-not $taskStage.StartsWith(([IO.Path]::GetFullPath($taskBackupRoot)+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected backup staging path.'}
New-Item -ItemType Directory -Path $taskStage | Out-Null
$taskContainerDump='/local-backups/staging/'+$taskId+'/postgres.dump'
$taskDump=Join-Path $taskStage 'postgres.dump'
$taskDumpCommand='PGPASSWORD="$(cat /run/secrets/postgres_admin_password)" pg_dump -h 127.0.0.1 -U aitesthub_admin -d aitesthub --format=custom --file='+$taskContainerDump
& $taskDocker @taskArgs exec -T postgres sh -c $taskDumpCommand
if($LASTEXITCODE -ne 0){throw 'Foundation pg_dump failed; incomplete staging retained for diagnosis.'}
& $taskDocker @taskArgs exec -T postgres pg_restore --list $taskContainerDump | Out-Null
if($LASTEXITCODE -ne 0){throw 'pg_dump archive list validation failed.'}
$taskEncrypted=Join-Path $taskBackupRoot ($taskId+'.dump.athenc')
$taskCryptoOutput=& node (Join-Path $PSScriptRoot 'backup\encrypt-foundation.mjs') --input $taskDump --output $taskEncrypted
if($LASTEXITCODE -ne 0){throw 'Foundation backup encryption/round-trip validation failed.'}
$taskMetadata=$taskCryptoOutput | ConvertFrom-Json
$taskMetadata | Add-Member -NotePropertyName createdAt -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o')
$taskMetadata | Add-Member -NotePropertyName encryptedFile -NotePropertyValue $taskEncrypted
$taskMetadata | Add-Member -NotePropertyName productFullBackupVerified -NotePropertyValue $false
$taskMetadata | Add-Member -NotePropertyName s3EvidenceIncluded -NotePropertyValue $false
$taskMetadata | ConvertTo-Json | Set-Content -LiteralPath ($taskEncrypted+'.json') -Encoding utf8
# Exact owned file/directory cleanup; no recursive deletion or cross-shell filesystem commands.
$taskCheckedDump=(Resolve-Path -LiteralPath $taskDump).Path
if($taskCheckedDump -ne (Join-Path $taskStage 'postgres.dump')){throw 'Unexpected staging file path.'}
Remove-Item -LiteralPath $taskCheckedDump -Force
if(@(Get-ChildItem -LiteralPath $taskStage -Force).Count -eq 0){Remove-Item -LiteralPath $taskStage}
$taskMetadata | ConvertTo-Json
