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
    [object] CreateParameter() { return [RuntimeTestParameter]::new() }
    [int] ExecuteNonQuery() {
        $this.Executed = $true
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

$connection = [RuntimeTestConnection]::new()
$connection.Command.Fail = $true
$failed = $false
try { Initialize-RuntimeDatabaseAccess $connection 'runtime' '00112233-4455-6677-8899-aabbccddeeff' } catch {
    $failed = $_.Exception.Message -match 'Simulated SID conflict'
}
Assert ($failed -and $connection.Command.Disposed) 'SQL errors propagate and dispose'
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot '../RuntimeDatabaseAccess.psm1'), [ref]$null, [ref]$parseErrors)
Assert ($parseErrors.Count -eq 0) 'Module AST parses'
Write-Output 'PASS: runtime SID binding, no-Graph SQL bootstrap, conflict propagation and least-privilege role contracts.'
