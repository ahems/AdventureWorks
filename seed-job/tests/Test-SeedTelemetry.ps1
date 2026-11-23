$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot '../SeedTelemetry.psm1') -Force

function Assert($Condition, [string] $Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

class FakeReader {
    [object[]] $Row
    [bool] $Disposed
    [bool] Read() { return $true }
    [bool] IsDBNull([int] $i) { return $null -eq $this.Row[$i] }
    [object] GetValue([int] $i) { return $this.Row[$i] }
    [void] Dispose() { $this.Disposed = $true }
}
class FakeCommand {
    [string] $CommandText
    [FakeReader] $Reader
    [bool] $Disposed
    [object] ExecuteReader() { return $this.Reader }
    [void] Dispose() { $this.Disposed = $true }
}
class FakeConnection {
    [FakeCommand] $Command = [FakeCommand]::new()
    [object] CreateCommand() { return $this.Command }
}

$key = '00000000-0000-0000-0000-000000000001'
$client = '11111111-2222-3333-4444-555555555555'
Assert ($null -eq (ConvertFrom-AppInsightsConnectionString '')) 'Empty connection string disables telemetry'
Assert ($null -eq (ConvertFrom-AppInsightsConnectionString "InstrumentationKey=$key;IngestionEndpoint=http://x.example.test/")) 'Plain HTTP refused'
Assert ($null -eq (ConvertFrom-AppInsightsConnectionString 'InstrumentationKey=nope;IngestionEndpoint=https://x.example.test/')) 'Invalid key refused'
$target = ConvertFrom-AppInsightsConnectionString "InstrumentationKey=$key;IngestionEndpoint=https://ingest.example.test/path/"
Assert ($target.Url -eq 'https://ingest.example.test/v2.1/track') 'Track URL derived from ingestion authority'

# Hash parity with SqlPrincipalTelemetry.Hash (SHA-256 of the lowercase "D" GUID string).
Assert ((Get-ClientIdHash ([guid] $client)) -eq '666ff6ccaa5b3c07feaa3a95d3a4bd2c46ac9e9abdb09ca9133528d3dc1e8952') 'Hash matches SqlPrincipalTelemetry.Hash'
$byName = Get-SqlPrincipalClassification "$client@tenant" $null $client
Assert ($byName.PrincipalMatch -eq 'match' -and $byName.PrincipalSource -eq 'login-name') 'Login name prefix matches'
$bySid = Get-SqlPrincipalClassification 'contained-user' ([guid] $client).ToByteArray() $client
Assert ($bySid.PrincipalMatch -eq 'match' -and $bySid.PrincipalSource -eq 'sid') 'Contained-user SID matches'
$other = Get-SqlPrincipalClassification 'aaaaaaaa-0000-0000-0000-000000000000@t' $null $client
Assert ($other.PrincipalMatch -eq 'mismatch' -and $other.ServerPrincipalHash -ne $other.ExpectedClientHash) 'Different principal mismatches'
Assert ((Get-SqlPrincipalClassification 'sa' $null $client).PrincipalMatch -eq 'unverified') 'Non-Entra login is unverified'
Assert ((Get-SqlPrincipalClassification "$client@t" $null '').PrincipalMatch -eq 'unconfigured') 'Missing expectation is unconfigured'

$sent = [System.Collections.Generic.List[object]]::new()
$sender = { param($url, $body) $sent.Add([pscustomobject]@{ Url = $url; Body = $body }) }
Assert (-not (Send-SeedTelemetryEvent 'X' @{} $sender)) 'Nothing is sent before initialisation'
Assert (-not (Initialize-SeedTelemetry '')) 'Initialisation without a connection string is disabled'
Assert (Initialize-SeedTelemetry "InstrumentationKey=$key;IngestionEndpoint=https://ingest.example.test/") 'Initialisation enabled'

$connection = [FakeConnection]::new()
$connection.Command.Reader = [FakeReader]::new()
$connection.Command.Reader.Row = @("$client@tenant", $null)
Assert (Send-SeedSqlPrincipalEvent $connection 'seed:full' $client $sender) 'Principal event sent'
Assert ($connection.Command.CommandText -eq 'SELECT SUSER_SNAME(), SUSER_SID()') 'Only reads the session principal'
Assert ($connection.Command.Disposed -and $connection.Command.Reader.Disposed) 'Command and reader disposed'
$event = $sent[0].Body | ConvertFrom-Json
Assert ($sent[0].Url -eq 'https://ingest.example.test/v2.1/track') 'Posts to the track endpoint'
Assert ($event.iKey -eq $key -and $event.tags.'ai.cloud.role' -eq 'seed-job') 'Envelope role and key'
$props = $event.data.baseData.properties
Assert ($event.data.baseData.name -eq 'Sql.SessionPrincipal' -and $props.Service -eq 'seed-job' -and $props.Scope -eq 'seed:full') 'Event contract'
Assert ($props.PrincipalMatch -eq 'match' -and $props.ExpectedClientHash -eq $props.ServerPrincipalHash) 'Match recorded with hashes'
Assert ($sent[0].Body -notmatch [regex]::Escape($client) -and $sent[0].Body -notmatch 'tenant') 'Raw client ID and login never exported'

$failing = [FakeConnection]::new()
Assert (-not (Send-SeedSqlPrincipalEvent $failing 'seed:full' $client $sender)) 'Reader failures are swallowed'
Assert (-not (Send-SeedTelemetryEvent 'Seed.Completed' @{ Outcome = 'succeeded' } { throw 'network down' })) 'Send failures are swallowed'
Assert (Send-SeedTelemetryEvent 'Seed.Completed' ([ordered]@{ Mode = 'full'; Outcome = 'succeeded' }) $sender) 'Completion event sent'
Assert ((($sent[-1].Body | ConvertFrom-Json).tags.'ai.operation.id') -eq $event.tags.'ai.operation.id') 'Events share one operation per run'
Write-Output 'SeedTelemetry tests passed.'

$sent.Clear()
Assert (Initialize-SeedTelemetry "InstrumentationKey=$key;IngestionEndpoint=https://ingest.example.test/") 'New lifecycle initialized'
Assert (Send-SeedLifecycleEvent -Phase started -Mode full -ScriptVersion 'abcdef12' -Sender $sender) 'Sparse start sent'
Assert (Send-SeedLifecycleEvent -Phase stage -Stage modules -Sender $sender) 'Module stage sent'
Assert (-not (Send-SeedLifecycleEvent -Phase stage -Stage modules -Sender $sender)) 'Repeated stage suppressed'
Assert (Send-SeedLifecycleEvent -Phase failed -Stage modules -Mode 'Bearer marker-secret' -ScriptVersion 'marker-secret' -Sender $sender) 'Early failure sent'
Assert (-not (Send-SeedLifecycleEvent -Phase completed -Sender $sender)) 'Terminal event emitted at most once'
Assert ($sent.Count -eq 3) 'Lifecycle bounded and sparse'
$terminal = $sent[-1].Body | ConvertFrom-Json
Assert ($terminal.data.baseData.name -eq 'Seed.Failed') 'Startup failure distinguished from successful completion'
Assert ($sent[-1].Body -notmatch 'marker-secret') 'Lifecycle arbitrary values cannot leak'
Assert ((($sent[0].Body | ConvertFrom-Json).tags.'ai.operation.id') -eq $terminal.tags.'ai.operation.id') 'Lifecycle shares causal seed operation'
Write-Output 'Seed lifecycle telemetry tests passed.'
