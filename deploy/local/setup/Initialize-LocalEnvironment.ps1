# Local foundation configuration only; values never printed or written into the repository.
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'AITestHub'))
$taskDirectories = @('secrets','backups','logs','setup\logs','recovery','control')
New-Item -ItemType Directory -Path $taskRoot -Force | Out-Null
if ((Get-Item -LiteralPath $taskRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'The local runtime root must not be a junction or symlink.'
}
$taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($taskRelative in $taskDirectories) {
    $taskDirectory = Join-Path $taskRoot $taskRelative
    New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
    if ((Get-Item -LiteralPath $taskDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Runtime directories must not be junctions or symlinks.'
    }
    $taskAcl = Get-Acl -LiteralPath $taskDirectory
    $taskAcl.SetAccessRuleProtection($true,$false)
    $taskInherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $taskPropagate = [Security.AccessControl.PropagationFlags]::None
    $taskAcl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskSid,'FullControl',$taskInherit,$taskPropagate,'Allow'))
    $taskAcl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl',$taskInherit,$taskPropagate,'Allow'))
    Set-Acl -LiteralPath $taskDirectory -AclObject $taskAcl
}
$taskEncoding = [Text.UTF8Encoding]::new($false)
$taskSecretNames = @('postgres-admin-password','postgres-app-password','s3-admin-access','s3-admin-secret','s3-app-access','s3-app-secret','platform-master-key','backup-encryption-key')
foreach($taskName in $taskSecretNames) {
    $taskPath = Join-Path $taskRoot ('secrets\'+$taskName)
    if (-not (Test-Path -LiteralPath $taskPath)) {
        $taskRandom = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
        if($taskName -like '*-access'){$taskRandom=$taskRandom.Substring(0,20)}
        [IO.File]::WriteAllText($taskPath,$taskRandom,$taskEncoding)
    }
}
$taskIamPath = Join-Path $taskRoot 'secrets\s3-iam.json'
if(-not (Test-Path -LiteralPath $taskIamPath)) {
    $taskAdminCredential=@{accessKey=[IO.File]::ReadAllText((Join-Path $taskRoot 'secrets\s3-admin-access'));secretKey=[IO.File]::ReadAllText((Join-Path $taskRoot 'secrets\s3-admin-secret'))}
    $taskAppCredential=@{accessKey=[IO.File]::ReadAllText((Join-Path $taskRoot 'secrets\s3-app-access'));secretKey=[IO.File]::ReadAllText((Join-Path $taskRoot 'secrets\s3-app-secret'))}
    $taskIam=@{identities=@(
        @{name='aitesthub-local-bootstrap';credentials=@($taskAdminCredential);actions=@('Admin','Read','Write','List','Tagging')},
        @{name='aitesthub-local-app';credentials=@($taskAppCredential);actions=@('Read:aitesthub-dev','Write:aitesthub-dev','List:aitesthub-dev','Tagging:aitesthub-dev')}
    )}
    [IO.File]::WriteAllText($taskIamPath,($taskIam | ConvertTo-Json -Depth 6),$taskEncoding)
}
foreach($taskName in @('platform-master-key','backup-encryption-key')) {
    $taskRecoveryPath=Join-Path $taskRoot ('recovery\'+$taskName)
    if(-not (Test-Path -LiteralPath $taskRecoveryPath)) {
        [IO.File]::WriteAllText($taskRecoveryPath,[IO.File]::ReadAllText((Join-Path $taskRoot ('secrets\'+$taskName))),$taskEncoding)
    }
}
$taskRuntimeEnv=Join-Path $taskRoot 'runtime.env'
if(-not (Test-Path -LiteralPath $taskRuntimeEnv)) {
    $taskImageLock=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\images.lock.json') -Raw | ConvertFrom-Json
    $taskText = 'AITESTHUB_LOCAL_ROOT='+$taskRoot.Replace('\','/')+"`nAITESTHUB_POSTGRES_PORT=55432`nAITESTHUB_S3_PORT=58333`nAITESTHUB_POSTGRES_IMAGE="+$taskImageLock.postgres+"`nAITESTHUB_SEAWEED_IMAGE="+$taskImageLock.seaweedfs+"`n"
    [IO.File]::WriteAllText($taskRuntimeEnv,$taskText,$taskEncoding)
}
[pscustomobject]@{runtimeRoot=$taskRoot;privateSecretsCreated=$taskSecretNames.Count;secretValuesPrinted=$false;runtimeEnv=$taskRuntimeEnv;backupDirectory=(Join-Path $taskRoot 'backups');existingFilesPreserved=$true} | ConvertTo-Json
