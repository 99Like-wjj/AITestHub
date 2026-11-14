param([Parameter(ValueFromRemainingArguments=$true)][string[]]$TaskArguments)
$ErrorActionPreference='Stop'
$taskPnpm=Join-Path $env:APPDATA 'npm\pnpm.cmd'
if(-not(Test-Path -LiteralPath $taskPnpm)){throw 'The standalone project pnpm is not installed.'}
& $taskPnpm @TaskArguments
if($LASTEXITCODE -ne 0){throw "pnpm command failed (exit $LASTEXITCODE)"}
