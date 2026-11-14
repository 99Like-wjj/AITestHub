# ConvertFrom-Json preserves ISO values as strings in Windows PowerShell, but
# PowerShell 7 can materialize DateTime. Compare instants without string coercion.
function Test-AITestHubOperationsProcessIdentity {
    param([Diagnostics.Process]$TaskProcess, [object]$TaskRecordedStart)
    if ($null -eq $TaskProcess -or $null -eq $TaskRecordedStart) { return $false }
    try {
        if ($TaskRecordedStart -is [DateTimeOffset]) {
            $taskRecordedUtc = $TaskRecordedStart.UtcDateTime
        } elseif ($TaskRecordedStart -is [DateTime]) {
            $taskRecordedUtc = $TaskRecordedStart.ToUniversalTime()
        } elseif ($TaskRecordedStart -is [string]) {
            $taskRecordedUtc = [DateTime]::ParseExact($TaskRecordedStart, 'O', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        } else {
            throw 'Unsupported process start metadata.'
        }
        return $TaskProcess.StartTime.ToUniversalTime().Ticks -eq $taskRecordedUtc.Ticks
    } catch {
        throw 'Operations process start metadata cannot be verified; no stop or duplicate start is authorized.'
    }
}
