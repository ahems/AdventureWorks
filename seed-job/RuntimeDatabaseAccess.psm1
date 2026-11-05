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
DECLARE @tables TABLE (name nvarchar(256));
IF SCHEMA_ID('az_func') IS NULL
    EXEC(N'CREATE SCHEMA [az_func]');
IF OBJECT_ID('az_func.GlobalState', 'U') IS NULL
    CREATE TABLE [az_func].[GlobalState] (
        UserFunctionID char(16) NOT NULL,
        UserTableID int NOT NULL,
        LastSyncVersion bigint NOT NULL,
        LastAccessTime datetime NOT NULL DEFAULT GETUTCDATE(),
        PRIMARY KEY (UserFunctionID, UserTableID)
    );
ELSE IF COL_LENGTH('az_func.GlobalState', 'LastAccessTime') IS NULL
    ALTER TABLE [az_func].[GlobalState] ADD LastAccessTime datetime NOT NULL DEFAULT GETUTCDATE();
INSERT INTO @tables VALUES
    ('Sales.SalesOrderHeader'), ('Sales.ShoppingCartItem'), ('Sales.SalesOrderDetail'),
    ('Production.WorkOrder'), ('Production.WorkOrderRouting'), ('Production.ProductInventory'),
    ('Production.Location'), ('Production.BillOfMaterials'), ('Production.Product'),
    ('Production.ProductCostHistory'), ('Production.ProductListPriceHistory'), ('Production.ProductModel'),
    ('Production.TransactionHistory'), ('Production.TransactionHistoryArchive'),
    ('Purchasing.Vendor'), ('Purchasing.ProductVendor'),
    ('Purchasing.PurchaseOrderHeader'), ('Purchasing.PurchaseOrderDetail'),
    ('Production.ProductReview'), ('Production.ProductReviewReply'),
    ('Sales.SpecialOffer'), ('Sales.SpecialOfferProduct'), ('Sales.CurrencyRate');
DECLARE @table nvarchar(256), @qualified nvarchar(518), @lease nvarchar(258),
    @keys nvarchar(max), @columns nvarchar(max);
DECLARE tracked_tables CURSOR LOCAL FAST_FORWARD FOR SELECT name FROM @tables;
OPEN tracked_tables;
FETCH NEXT FROM tracked_tables INTO @table;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF OBJECT_ID(@table, 'U') IS NULL
        THROW 51024, 'A realtime notification table is missing.', 1;
    SET @qualified = QUOTENAME(PARSENAME(@table, 2)) + N'.' + QUOTENAME(PARSENAME(@table, 1));
    IF NOT EXISTS (SELECT 1 FROM sys.change_tracking_tables WHERE object_id = OBJECT_ID(@table))
    BEGIN
        SET @sql = N'ALTER TABLE ' + @qualified + N' ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF);';
        EXEC sp_executesql @sql;
    END;
    SET @sql = N'GRANT VIEW CHANGE TRACKING ON OBJECT::' + @qualified + N' TO ' + @quoted + N';';
    EXEC sp_executesql @sql;
    SET @lease = QUOTENAME('Notifications_' + PARSENAME(@table, 1));
    SELECT @keys = STRING_AGG(CAST(QUOTENAME(c.name) AS nvarchar(max)), ',') WITHIN GROUP (ORDER BY ic.key_ordinal),
        @columns = STRING_AGG(CAST(QUOTENAME(c.name) + N' ' + TYPE_NAME(c.system_type_id) +
            CASE WHEN TYPE_NAME(c.system_type_id) IN ('nvarchar', 'nchar')
                THEN N'(' + CONVERT(nvarchar(10), c.max_length / 2) + N')'
                WHEN TYPE_NAME(c.system_type_id) IN ('varchar', 'char', 'binary', 'varbinary')
                THEN N'(' + CONVERT(nvarchar(10), c.max_length) + N')'
                WHEN TYPE_NAME(c.system_type_id) IN ('decimal', 'numeric')
                THEN N'(' + CONVERT(nvarchar(10), c.precision) + N',' + CONVERT(nvarchar(10), c.scale) + N')'
                ELSE N'' END + N' NOT NULL' AS nvarchar(max)), ',') WITHIN GROUP (ORDER BY ic.key_ordinal)
    FROM sys.indexes i
    INNER JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    INNER JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE i.object_id = OBJECT_ID(@table) AND i.is_primary_key = 1;
    IF @keys IS NULL
        THROW 51025, 'Realtime notification tables require a primary key.', 1;
    IF OBJECT_ID(N'az_func.' + @lease, 'U') IS NULL
    BEGIN
        SET @sql = N'CREATE TABLE [az_func].' + @lease + N' (' + @columns +
            N', [_az_func_ChangeVersion] bigint NOT NULL, [_az_func_AttemptCount] int NOT NULL,' +
            N' [_az_func_LeaseExpirationTime] datetime2, PRIMARY KEY (' + @keys + N'));';
        EXEC sp_executesql @sql;
    END;
    FETCH NEXT FROM tracked_tables INTO @table;
END;
CLOSE tracked_tables;
DEALLOCATE tracked_tables;
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
