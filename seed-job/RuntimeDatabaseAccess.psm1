Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Initialize-RuntimeDatabaseAccess {
    param(
        [Parameter(Mandatory)] $Connection,
        [Parameter(Mandatory)][string] $IdentityName,
        [Parameter(Mandatory)][guid] $ClientId
    )

    $command = $Connection.CreateCommand()
    try {
        $command.CommandTimeout = 120
        $command.CommandText = @'
DECLARE @sid binary(16) = CONVERT(binary(16), CONVERT(uniqueidentifier, @clientId));
DECLARE @quoted nvarchar(258) = QUOTENAME(@identityName), @sql nvarchar(max);
IF @quoted IS NULL OR LEN(@identityName) = 0
    THROW 51020, 'Invalid runtime database identity name.', 1;
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @identityName AND (sid <> @sid OR type <> 'E'))
    THROW 51021, 'Runtime database principal conflicts with the configured identity SID/type.', 1;
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @identityName)
BEGIN
    SET @sql = N'CREATE USER ' + @quoted + N' WITH SID = ' + CONVERT(varchar(34), @sid, 1) + N', TYPE = E;';
    EXEC sp_executesql @sql;
END;
SET @sql = N'ALTER USER ' + @quoted + N' WITH DEFAULT_SCHEMA = dbo;';
EXEC sp_executesql @sql;
IF IS_ROLEMEMBER('db_datareader', @identityName) <> 1
BEGIN
    SET @sql = N'ALTER ROLE db_datareader ADD MEMBER ' + @quoted + N';';
    EXEC sp_executesql @sql;
END;
IF IS_ROLEMEMBER('db_datawriter', @identityName) <> 1
BEGIN
    SET @sql = N'ALTER ROLE db_datawriter ADD MEMBER ' + @quoted + N';';
    EXEC sp_executesql @sql;
END;
SET @sql = N'GRANT EXECUTE TO ' + @quoted + N';';
EXEC sp_executesql @sql;
'@
        foreach ($entry in @{ '@identityName' = $IdentityName; '@clientId' = $ClientId.ToString() }.GetEnumerator()) {
            $parameter = $command.CreateParameter()
            $parameter.ParameterName = $entry.Key
            $parameter.Value = $entry.Value
            $null = $command.Parameters.Add($parameter)
        }
        $null = $command.ExecuteNonQuery()
    } finally { $command.Dispose() }
}

function Grant-RuntimeChangeTrackingAccess {
    param(
        [Parameter(Mandatory)] $Connection,
        [Parameter(Mandatory)][string] $IdentityName
    )

    $command = $Connection.CreateCommand()
    try {
        $command.CommandTimeout = 120
        $command.CommandText = @'
IF OBJECT_ID('Sales.SalesOrderHeader', 'U') IS NULL
    THROW 51022, 'Cannot grant runtime Change Tracking access: SalesOrderHeader is missing.', 1;
IF NOT EXISTS (SELECT 1 FROM sys.change_tracking_tables WHERE object_id = OBJECT_ID('Sales.SalesOrderHeader'))
    THROW 51023, 'Cannot grant runtime Change Tracking access: SalesOrderHeader tracking is disabled.', 1;
DECLARE @quoted nvarchar(258) = QUOTENAME(@identityName), @sql nvarchar(max);
IF @quoted IS NULL OR LEN(@identityName) = 0
    THROW 51020, 'Invalid runtime database identity name.', 1;
SET @sql = N'GRANT VIEW CHANGE TRACKING ON OBJECT::[Sales].[SalesOrderHeader] TO ' + @quoted + N';';
EXEC sp_executesql @sql;
'@
        $parameter = $command.CreateParameter()
        $parameter.ParameterName = '@identityName'
        $parameter.Value = $IdentityName
        $null = $command.Parameters.Add($parameter)
        $null = $command.ExecuteNonQuery()
    } finally { $command.Dispose() }
}

function Grant-RuntimeXmlSchemaAccess {
    param(
        [Parameter(Mandatory)] $Connection,
        [Parameter(Mandatory)][string] $IdentityName
    )

    $command = $Connection.CreateCommand()
    try {
        $command.CommandTimeout = 120
        # XML_SCHEMA_NAMESPACE requires VIEW DEFINITION plus REFERENCES (or ALTER/CONTROL) on the collection.
        $command.CommandText = @'
IF NOT EXISTS (
    SELECT 1 FROM sys.xml_schema_collections
    WHERE schema_id = SCHEMA_ID(N'Production') AND name = N'ManuInstructionsSchemaCollection')
    THROW 51024, 'Cannot grant runtime XML schema access: Production.ManuInstructionsSchemaCollection is missing.', 1;
DECLARE @quoted nvarchar(258) = QUOTENAME(@identityName), @sql nvarchar(max);
IF @quoted IS NULL OR LEN(@identityName) = 0
    THROW 51020, 'Invalid runtime database identity name.', 1;
SET @sql = N'GRANT REFERENCES, VIEW DEFINITION ON XML SCHEMA COLLECTION::[Production].[ManuInstructionsSchemaCollection] TO ' + @quoted + N';';
EXEC sp_executesql @sql;
'@
        $parameter = $command.CreateParameter()
        $parameter.ParameterName = '@identityName'
        $parameter.Value = $IdentityName
        $null = $command.Parameters.Add($parameter)
        $null = $command.ExecuteNonQuery()
    } finally { $command.Dispose() }
}

Export-ModuleMember -Function Initialize-RuntimeDatabaseAccess, Grant-RuntimeChangeTrackingAccess, Grant-RuntimeXmlSchemaAccess
