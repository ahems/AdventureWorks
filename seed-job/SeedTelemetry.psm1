# Minimal Application Insights emitter for the seed job. It exports only categorical outcomes and
# hashes; SQL text, connection strings, tokens and row data are never sent. Failures are swallowed so
# telemetry can never change the seed result.
Set-StrictMode -Version Latest

$script:TelemetryTarget = $null
$script:TelemetryOperationId = $null
$script:LifecycleTerminal = $false
$script:LifecycleStages = @{}
$script:TelemetryDiagnosticWritten = $false

function ConvertFrom-AppInsightsConnectionString {
    param([string] $ConnectionString)
    if ([string]::IsNullOrWhiteSpace($ConnectionString)) { return $null }
    $values = @{}
    foreach ($part in $ConnectionString.Split(';')) {
        $index = $part.IndexOf('=')
        if ($index -gt 0) { $values[$part.Substring(0, $index).Trim().ToLowerInvariant()] = $part.Substring($index + 1).Trim() }
    }
    $key = $values['instrumentationkey']
    $endpoint = $values['ingestionendpoint']
    $parsedKey = [guid]::Empty
    if (-not $key -or -not [guid]::TryParse($key, [ref] $parsedKey) -or -not $endpoint) { return $null }
    $uri = $null
    if (-not [uri]::TryCreate($endpoint, [UriKind]::Absolute, [ref] $uri) -or $uri.Scheme -ne 'https') { return $null }
    return [pscustomobject]@{
        InstrumentationKey = $parsedKey.ToString('D')
        Url                = $uri.GetLeftPart([UriPartial]::Authority) + '/v2.1/track'
    }
}

function Get-ClientIdHash {
    param([guid] $ClientId)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($ClientId.ToString('D'))
    return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

# Mirrors SqlPrincipalTelemetry.Classify: Entra logins report "clientId@tenantId", and contained users
# created FROM EXTERNAL PROVIDER carry the client ID as their 16-byte SID.
function Get-SqlPrincipalClassification {
    param([string] $LoginName, [byte[]] $Sid, [string] $ExpectedClientId)
    $observed = $null
    $source = 'none'
    if (-not [string]::IsNullOrWhiteSpace($LoginName)) {
        $prefix = $LoginName.Split('@')[0]
        $parsed = [guid]::Empty
        if ([guid]::TryParse($prefix, [ref] $parsed)) { $observed = $parsed; $source = 'login-name' }
    }
    if ($null -eq $observed -and $null -ne $Sid -and $Sid.Length -eq 16) {
        $observed = [guid]::new($Sid)
        $source = 'sid'
    }
    $expected = [guid]::Empty
    $hasExpected = [guid]::TryParse($ExpectedClientId, [ref] $expected)
    if ($null -eq $observed) {
        return [ordered]@{ PrincipalMatch = 'unverified'; ServerPrincipalHash = 'unknown'; PrincipalSource = $source
            ExpectedClientHash = $(if ($hasExpected) { Get-ClientIdHash $expected } else { 'unconfigured' }) }
    }
    return [ordered]@{
        PrincipalMatch      = $(if (-not $hasExpected) { 'unconfigured' } elseif ($observed -eq $expected) { 'match' } else { 'mismatch' })
        ServerPrincipalHash = Get-ClientIdHash $observed
        PrincipalSource     = $source
        ExpectedClientHash  = $(if ($hasExpected) { Get-ClientIdHash $expected } else { 'unconfigured' })
    }
}

function Initialize-SeedTelemetry {
    param([string] $ConnectionString)
    $script:TelemetryTarget = ConvertFrom-AppInsightsConnectionString $ConnectionString
    $script:TelemetryOperationId = [guid]::NewGuid().ToString('N')
    $script:LifecycleTerminal = $false
    $script:LifecycleStages = @{}
    $script:TelemetryDiagnosticWritten = $false
    return $null -ne $script:TelemetryTarget
}

function New-SeedTelemetryEnvelope {
    param([string] $Name, [System.Collections.IDictionary] $Properties, [string] $InstrumentationKey, [string] $OperationId)
    $clean = [ordered]@{}
    foreach ($entry in $Properties.GetEnumerator()) { $clean[[string] $entry.Key] = [string] $entry.Value }
    return [ordered]@{
        name = 'Microsoft.ApplicationInsights.Event'
        time = [DateTime]::UtcNow.ToString('o')
        iKey = $InstrumentationKey
        tags = [ordered]@{ 'ai.cloud.role' = 'seed-job'; 'ai.operation.id' = $OperationId }
        data = [ordered]@{ baseType = 'EventData'; baseData = [ordered]@{ ver = 2; name = $Name; properties = $clean } }
    }
}

function Send-SeedTelemetryEvent {
    param([string] $Name, [System.Collections.IDictionary] $Properties, [scriptblock] $Sender)
    if ($null -eq $script:TelemetryTarget) { return $false }
    try {
        $envelope = New-SeedTelemetryEnvelope $Name $Properties $script:TelemetryTarget.InstrumentationKey $script:TelemetryOperationId
        $body = $envelope | ConvertTo-Json -Depth 6 -Compress
        if ($Sender) { & $Sender $script:TelemetryTarget.Url $body }
        else {
            $null = Invoke-RestMethod -Method Post -Uri $script:TelemetryTarget.Url -Body $body `
                -ContentType 'application/x-json-stream' -TimeoutSec 2
        }
        return $true
    } catch {
        if (-not $script:TelemetryDiagnosticWritten) {
            $script:TelemetryDiagnosticWritten = $true
            [Console]::Error.WriteLine('Seed telemetry: export_failed (console/system logs remain the fallback).')
        }
        return $false
    }
}

function Send-SeedLifecycleEvent {
    param(
        [ValidateSet('started', 'stage', 'failed', 'completed')][string] $Phase,
        [ValidateSet('startup', 'modules', 'configuration', 'identity', 'sql', 'data', 'assets', 'finalize')][string] $Stage = 'startup',
        [string] $Mode = 'full', [string] $ScriptVersion = 'unknown',
        [double] $DurationSeconds = 0, [scriptblock] $Sender
    )
    if ($script:LifecycleTerminal) { return $false }
    if ($Phase -eq 'stage') {
        if ($script:LifecycleStages.ContainsKey($Stage)) { return $false }
        $script:LifecycleStages[$Stage] = $true
    }
    if ($Phase -in @('failed', 'completed')) { $script:LifecycleTerminal = $true }
    $safeMode = if ($Mode -in @('full', 'guest-carts', 'realtime-notifications', 'manufacturing-overlays',
        'manufacturing-overlays-verify')) { $Mode } else { 'unknown' }
    $safeVersion = if ($ScriptVersion -match '^[0-9a-fA-F]{8}$') { $ScriptVersion } else { 'unknown' }
    $name = switch ($Phase) {
        'started' { 'Seed.Started' }
        'stage' { 'Seed.Stage' }
        'failed' { 'Seed.Failed' }
        'completed' { 'Seed.Completed' }
    }
    $properties = [ordered]@{ Stage = $Stage; Mode = $safeMode; ScriptVersion = $safeVersion
        Outcome = $(if ($Phase -eq 'completed') { 'succeeded' } else { $Phase })
        DurationSeconds = [string][math]::Max(0, [math]::Floor($DurationSeconds)) }
    return Send-SeedTelemetryEvent $name $properties $Sender
}

function Send-SeedSqlPrincipalEvent {
    param($Connection, [string] $Scope, [string] $ExpectedClientId, [scriptblock] $Sender)
    if ($null -eq $script:TelemetryTarget) { return $false }
    $command = $null
    $reader = $null
    try {
        $command = $Connection.CreateCommand()
        $command.CommandText = 'SELECT SUSER_SNAME(), SUSER_SID()'
        $reader = $command.ExecuteReader()
        if (-not $reader.Read()) { return $false }
        $name = if ($reader.IsDBNull(0)) { $null } else { [string] $reader.GetValue(0) }
        $sid = if ($reader.IsDBNull(1)) { $null } else { [byte[]] $reader.GetValue(1) }
        $properties = Get-SqlPrincipalClassification $name $sid $ExpectedClientId
        $properties['Service'] = 'seed-job'
        $properties['Scope'] = $Scope
        $properties['ConnectionMatchesProbe'] = 'true'
        $properties['VerifiedAgeSeconds'] = '0'
        return Send-SeedTelemetryEvent 'Sql.SessionPrincipal' $properties $Sender
    } catch {
        return $false
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($command) { $command.Dispose() }
    }
}

Export-ModuleMember -Function ConvertFrom-AppInsightsConnectionString, Get-ClientIdHash, Get-SqlPrincipalClassification,
    Initialize-SeedTelemetry, New-SeedTelemetryEnvelope, Send-SeedTelemetryEvent, Send-SeedSqlPrincipalEvent,
    Send-SeedLifecycleEvent
