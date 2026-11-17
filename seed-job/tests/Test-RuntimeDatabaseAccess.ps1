$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot '../RuntimeDatabaseAccess.psm1') -Force

class RuntimeTestParameter {
    [string] $ParameterName
    [object] $Value
}
class RuntimeTestCommand {
    [int] $CommandTimeout
    [string] $CommandText
    [bool] $Executed
    [bool] $Disposed
    [bool] $Fail
    [System.Collections.Generic.List[object]] $Parameters = [System.Collections.Generic.List[object]]::new()
    [System.Collections.Generic.List[string]] $ExecutedSql = [System.Collections.Generic.List[string]]::new()
    [object] CreateParameter() { return [RuntimeTestParameter]::new() }
    [int] ExecuteNonQuery() {
        $this.Executed = $true
        $this.ExecutedSql.Add($this.CommandText)
        if ($this.Fail) { throw 'Simulated SID conflict' }
        return 0
    }
    [void] Dispose() { $this.Disposed = $true }
}
class RuntimeTestConnection {
    [RuntimeTestCommand] $Command = [RuntimeTestCommand]::new()
    [object] CreateCommand() { return $this.Command }
}
function Assert($Condition, [string] $Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

$connection = [RuntimeTestConnection]::new()
Initialize-RuntimeDatabaseAccess $connection "runtime's identity" '00112233-4455-6677-8899-aabbccddeeff'
$command = $connection.Command
Assert ($command.Executed -and $command.Disposed) 'Executes and disposes'
Assert ($command.Parameters.Count -eq 2) 'Binds identity and principal ID'
Assert ($command.CommandText -notmatch "runtime's identity|00112233") 'Values never interpolated'
Assert ($command.CommandText -match 'CONVERT\(binary\(16\), CONVERT\(uniqueidentifier, @clientId\)\)') 'SQL converts the application/client ID to its contained-user SID'
Assert (($command.Parameters | Where-Object ParameterName -eq '@clientId').Value -eq '00112233-4455-6677-8899-aabbccddeeff') 'Binds the client ID, not the Entra object ID'
Assert ($command.CommandText.Contains("N'CREATE USER ' + @quoted + N' WITH SID = '")) 'Creates user with explicit SID'
Assert ($command.CommandText -match 'TYPE = E' -and $command.CommandText -notmatch 'EXTERNAL PROVIDER') 'No Graph identity lookup'
Assert ($command.CommandText -match 'THROW 51021') 'Existing mismatched SID/type fails'
Assert ($command.CommandText -notmatch 'DROP MEMBER|REVOKE|DENY|db_owner|db_ddladmin') 'Preserves all existing legacy role memberships'
Assert ($command.CommandText -match 'IS_ROLEMEMBER') 'Idempotent additive role maintenance'
Assert ($command.CommandText -match 'GRANT EXECUTE' -and $command.CommandText -notmatch 'GRANT VIEW CHANGE TRACKING') 'Initial grants do not reference not-yet-seeded tables'

$tracking = [RuntimeTestConnection]::new()
Grant-RuntimeChangeTrackingAccess $tracking 'runtime'
Assert ($tracking.Command.CommandText.Contains('GRANT VIEW CHANGE TRACKING ON OBJECT::[Sales].[SalesOrderHeader] TO')) 'Change Tracking grant uses object-level SQL syntax'
Assert ($tracking.Command.CommandText -match 'sys.change_tracking_tables' -and $tracking.Command.CommandText -match 'THROW 51023') 'Grant requires tracked table'
Assert ($tracking.Command.Disposed -and $tracking.Command.Parameters.Count -eq 1) 'Tracking grant binds identity and disposes'
Assert ($tracking.Command.ExecutedSql.Count -eq 2 -and $tracking.Command.ExecutedSql[0] -match 'RealtimeNotify_') 'Runs the outbox migration before binding grants'
Assert ($tracking.Command.CommandText -match "dbo.RealtimeNotificationOutbox") 'Tracking and explicit leases cover the consolidated outbox'
Assert ($tracking.Command.CommandText -notmatch 'Production.WorkOrder') 'No per-source SQL binding leases are provisioned'
$outbox = Get-Content -Raw (Join-Path $PSScriptRoot '../sql/realtime-notification-outbox.sql')
Assert ($outbox -match 'BEGIN TRANSACTION' -and $outbox -match 'COMMIT TRANSACTION') 'Outbox schema and triggers migrate atomically'
Assert ($outbox -match 'CREATE OR ALTER TRIGGER' -and $outbox -match 'AFTER INSERT, UPDATE, DELETE') 'Idempotent triggers capture every committed mutation'
Assert ($outbox -notmatch 'ShoppingCartID|CustomerID|DISABLE CHANGE_TRACKING|DROP TABLE') 'Signals carry no private identifiers and migration preserves existing data/tracking'
$seed = Get-Content -Raw (Join-Path $PSScriptRoot '../seed-database.ps1')
Assert ($seed -match 'if \(\$RealtimeNotificationsOnly\)' -and
    $seed.IndexOf('Realtime notification outbox, transactional triggers') -lt $seed.IndexOf('Read-ManufacturingOverlays')) 'Migration-only mode exits before any seed artifacts are read/imported'

$xmlSchema = [RuntimeTestConnection]::new()
Grant-RuntimeXmlSchemaAccess $xmlSchema "runtime's identity"
Assert ($xmlSchema.Command.CommandText.Contains('GRANT REFERENCES, VIEW DEFINITION ON XML SCHEMA COLLECTION::[Production].[ManuInstructionsSchemaCollection] TO')) 'XML schema grant is collection-scoped and sufficient for XML_SCHEMA_NAMESPACE'
Assert ($xmlSchema.Command.CommandText -match 'sys.xml_schema_collections' -and $xmlSchema.Command.CommandText -match 'THROW 51024') 'XML schema grant requires the collection'
Assert ($xmlSchema.Command.CommandText -notmatch "runtime's identity|ALTER ON|CONTROL") 'XML schema grant binds identity and stays least-privilege'
Assert ($xmlSchema.Command.Disposed -and $xmlSchema.Command.Parameters.Count -eq 1) 'XML schema grant binds identity and disposes'

$connection = [RuntimeTestConnection]::new()
$connection.Command.Fail = $true
$failed = $false
try { Initialize-RuntimeDatabaseAccess $connection 'runtime' '00112233-4455-6677-8899-aabbccddeeff' } catch {
    $failed = $_.Exception.Message -match 'Simulated SID conflict'
}
Assert ($failed -and $connection.Command.Disposed) 'SQL errors propagate and dispose'

$metadata = [RuntimeTestConnection]::new()
Grant-RuntimeDefaultMetadataAccess $metadata "runtime's identity"
Assert ($metadata.Command.Executed -and $metadata.Command.Disposed) 'Metadata grants execute and dispose'
Assert ($metadata.Command.Parameters.Count -eq 1 -and $metadata.Command.Parameters[0].Value -eq "runtime's identity") 'Metadata identity is parameterized'
Assert ($metadata.Command.CommandText -match 'GRANT VIEW DEFINITION ON OBJECT::' -and
    $metadata.Command.CommandText -notmatch "runtime's identity|GRANT CONTROL|GRANT ALTER|ON DATABASE|ON SCHEMA|db_owner") 'Metadata grants are object-scoped, not data/DDL/admin elevation'
Assert ($metadata.Command.CommandText -match 'sys.tables' -and $metadata.Command.CommandText -match 'sys.columns' -and
    $metadata.Command.CommandText -match 'default_object_id<>0 OR c.is_computed=1' -and
    $metadata.Command.CommandText -match 't.is_ms_shipped=0') 'Only user tables needing default/computed metadata are selected'
Assert ($metadata.Command.CommandText -match 'QUOTENAME\(s.name\)' -and
    $metadata.Command.CommandText -match 'QUOTENAME\(t.name\)' -and
    $metadata.Command.CommandText -match 'QUOTENAME\(@identityName\)') 'All dynamic SQL identifiers are quoted'
Assert ($metadata.Command.CommandText -match 'THROW 51025' -and
    $metadata.Command.CommandText -match 'THROW 51026') 'Missing schema/empty metadata inventory cannot silently succeed'
$metadata.Command.Fail = $true
$failed = $false
try { Grant-RuntimeDefaultMetadataAccess $metadata 'runtime' } catch {
    $failed = $_.Exception.Message -match 'Simulated SID conflict'
}
Assert ($failed -and $metadata.Command.Disposed) 'Metadata SQL failures propagate'
$seed = Get-Content -Raw (Join-Path $PSScriptRoot '../seed-database.ps1')
Assert (($seed | Select-String 'Grant-RuntimeDefaultMetadataAccess' -AllMatches).Matches.Count -eq 2) 'Normal fresh and existing seed paths wire metadata grant'
Assert ($seed.LastIndexOf('Grant-RuntimeDefaultMetadataAccess') -gt
    $seed.LastIndexOf('Initialize-GuestCartSchema')) 'Fresh metadata grants follow final application-table setup'
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot '../RuntimeDatabaseAccess.psm1'), [ref]$null, [ref]$parseErrors)
Assert ($parseErrors.Count -eq 0) 'Module AST parses'
Write-Output 'PASS: runtime SID binding, no-Graph SQL bootstrap, conflict propagation and least-privilege role contracts.'
