# Trust PSGallery to suppress the untrusted repository prompt
try {
    $gallery = Get-PSRepository -Name 'PSGallery' -ErrorAction Stop
    if ($gallery.InstallationPolicy -ne 'Trusted') {
        Write-Output "Setting PSGallery repository to Trusted..."
        Set-PSRepository -Name 'PSGallery' -InstallationPolicy Trusted
    }
} catch {
    # PSGallery not registered, so register it
    Write-Output "Registering PSGallery repository..."
    Register-PSRepository -Name 'PSGallery' -SourceLocation 'https://www.powershellgallery.com/api/v2' -InstallationPolicy Trusted
}

# Install Microsoft Graph module if not already installed
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph)) {
    Write-Output "Installing Microsoft Graph module..."
    Install-Module Microsoft.Graph -Scope CurrentUser -Force -Confirm:$false
}

# Ensure required Az modules are installed (install only what we explicitly need)
if (-not (Get-Module -ListAvailable -Name Az.Resources)) {
    Write-Output "Installing Az.Resources module..."
    Install-Module Az.Resources -Scope CurrentUser -Force -Confirm:$false
}
if (-not (Get-Module -ListAvailable -Name Az.ManagedServiceIdentity)) {
    Write-Output "Installing Az.ManagedServiceIdentity module..."
    Install-Module Az.ManagedServiceIdentity -Scope CurrentUser -Force -Confirm:$false
}
if (-not (Get-Module -ListAvailable -Name Az.Sql)) {
    Write-Output "Installing Az.Sql module..."
    Install-Module Az.Sql -Scope CurrentUser -Force -Confirm:$false
}

# Import required modules
Import-Module Az.Resources -ErrorAction Stop
Import-Module Az.ManagedServiceIdentity -ErrorAction Stop
Import-Module Az.Sql -ErrorAction Stop

# Get tenant ID from azd environment (trim to avoid stray newlines)
$tenantId = (azd env get-value 'TENANT_ID' 2>$null).Trim()

# Get SQL database name from azd environment, default to 'todo' if not found
$sqlDatabaseName = (azd env get-value 'SQL_DATABASE_NAME' 2>$null).Trim()
if ($sqlDatabaseName -ceq "ERROR: key 'SQL_DATABASE_NAME' not found in the environment values" -or [string]::IsNullOrWhiteSpace($sqlDatabaseName)) {
    $sqlDatabaseName = 'todo'
} else {
    Write-Output "Using SQL database name: '$sqlDatabaseName'"
}

# Authenticate if not already logged in
if (-not (Get-AzContext -ErrorAction SilentlyContinue)) {
    Write-Output "Connecting to Azure..."
    if ($tenantId) {
        Write-Output "Connecting to Azure with specified tenant ID..."
        Connect-AzAccount -Tenant $tenantId -UseDeviceAuthentication | Out-Null
    } else {
        Write-Warning "TENANT_ID not found in azd environment. Proceeding without specifying tenant."
        Connect-AzAccount -UseDeviceAuthentication | Out-Null
    }
}

# Get Resource Group and Location from azd environment
$resourceGroupName = (azd env get-value 'AZURE_RESOURCE_GROUP' 2>$null).Trim()
$ManagedIdentityName = (azd env get-value 'USER_MANAGED_IDENTITY_NAME' 2>$null).Trim()

if( $ManagedIdentityName -ceq "ERROR: key 'USER_MANAGED_IDENTITY_NAME' not found in the environment values") {
    try {
        Write-Output "Locating first User Assigned Managed Identity in resource group '$resourceGroupName'..."
        $userAssignedIdentities = Get-AzUserAssignedIdentity -ResourceGroupName $resourceGroupName -ErrorAction Stop | Sort-Object Name

        if (-not $userAssignedIdentities -or $userAssignedIdentities.Count -eq 0) {
            Write-Warning "No user-assigned managed identities found in resource group '$resourceGroupName'."
        } else {
            $selectedIdentity = $userAssignedIdentities | Select-Object -First 1
            $ManagedIdentityName       = $selectedIdentity.Name

            Write-Output "Selected User Assigned Managed Identity: $ManagedIdentityName"

            azd env set 'USER_MANAGED_IDENTITY_NAME' $ManagedIdentityName
        }
    }
    catch {
        Write-Warning "Failed to retrieve user-assigned managed identities: $($_.Exception.Message)"
    }
} else {
    Write-Output "USER_MANAGED_IDENTITY_NAME already set to '$ManagedIdentityName'. Skipping retrieval of user-assigned managed identity."   
}
if( -not $ManagedIdentityName ) {
    Write-Error "USER_MANAGED_IDENTITY_NAME not found in azd environment and no user-assigned managed identity could be located. Please ensure you have a user-assigned managed identity deployed in the resource group."
    exit 1
}

$sqlServerName = (azd env get-value 'SQL_SERVER_NAME' 2>$null).Trim()
if( $sqlServerName -ceq "ERROR: key 'SQL_SERVER_NAME' not found in the environment values") {
    try {
        Write-Output "Locating first SQL Server in resource group '$resourceGroupName'..."
        $sqlServers = Get-AzSqlServer -ResourceGroupName $resourceGroupName -ErrorAction Stop | Sort-Object Name

        if (-not $sqlServers -or $sqlServers.Count -eq 0) {
            Write-Warning "No SQL Servers found in resource group '$resourceGroupName'."
        } else {
            $selectedSqlServer = $sqlServers | Select-Object -First 1
            $sqlServerName     = $selectedSqlServer.ServerName

            Write-Output "Selected SQL Server: $sqlServerName"

            azd env set 'SQL_SERVER_NAME' $sqlServerName
        }
    }
    catch {
        Write-Warning "Failed to retrieve SQL Servers: $($_.Exception.Message)"
    }
} else {
    Write-Output "SQL_SERVER_NAME already set to '$sqlServerName'. Skipping retrieval of SQL server."
}
if( -not $sqlServerName ) {
    Write-Error "SQL_SERVER_NAME not found in azd environment and no SQL Server could be located. Please ensure you have a SQL Server deployed in the resource group."
    exit 1
}

## ---------------------------------------------------------------------------
## Acquire Azure AD access token for SQL (scope: https://database.windows.net/.default)
## Primary execution path uses ADO.NET with AccessToken (sqlcmd removed)
## ---------------------------------------------------------------------------
function Convert-SecureIfNeededToPlainText {
    param(
        [Parameter(Mandatory)] $Value
    )
    if ($Value -is [System.Security.SecureString]) {
        $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($Value)
        try { return [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ptr) }
        finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr) }
    }
    return $Value
}

function Convert-HexStringToByteArray {
    param(
        [Parameter(Mandatory)]
        [string] $HexString
    )

    $cleanHex = $HexString.Trim()
    if ([string]::IsNullOrWhiteSpace($cleanHex)) {
        return ,([byte[]]::new(0))
    }

    if ($cleanHex.StartsWith('0x', [System.StringComparison]::OrdinalIgnoreCase)) {
        $cleanHex = $cleanHex.Substring(2)
    }

    if ($cleanHex.Length % 2 -ne 0) {
        throw "Hex string length must be even."
    }

    $byteCount = $cleanHex.Length / 2
    $bytes = New-Object byte[] $byteCount

    for ($i = 0; $i -lt $cleanHex.Length; $i += 2) {
        $bytes[$i / 2] = [System.Convert]::ToByte($cleanHex.Substring($i, 2), 16)
    }

    return ,([byte[]]$bytes)
}

function Remove-TrailingEmptyFields {
    param(
        [Parameter(Mandatory)]
        [object] $Values
    )

    if ($null -eq $Values) {
        return @()
    }

    $arrayValues = if ($Values -is [System.Array]) { $Values } else { ,([string]$Values) }

    if ($arrayValues.Count -eq 0) {
        return @()
    }

    $list = New-Object 'System.Collections.Generic.List[string]'
    foreach ($value in $arrayValues) {
        $list.Add([string]$value)
    }

    while ($list.Count -gt 0 -and [string]::IsNullOrWhiteSpace($list[$list.Count - 1])) {
        $list.RemoveAt($list.Count - 1)
    }

    return $list.ToArray()
}

try {
    $rawToken = (Get-AzAccessToken -ResourceUrl 'https://database.windows.net/').Token
    if (-not $rawToken) { throw 'Access token empty' }
    $sqlToken = Convert-SecureIfNeededToPlainText -Value $rawToken
    if (-not ($sqlToken -is [string])) { $sqlToken = [string]$sqlToken }
    Write-Output 'Obtained Azure AD access token for SQL.'
}
catch {
    Write-Error "Failed to obtain Azure AD access token: $($_.Exception.Message). Cannot proceed with database role assignments without token."
    exit 1
}

# -----------------------------------------------------------------------------
# Load and execute T-SQL to create external user mapped to Managed Identity and grant roles
# -----------------------------------------------------------------------------

$escapedIdentityName = $ManagedIdentityName -replace ']', ']]'

# Load SQL script from file
$roleAssignmentSqlPath = Join-Path $PSScriptRoot 'sql\assign-database-roles.sql'
if (-not (Test-Path $roleAssignmentSqlPath)) {
    Write-Error "SQL script not found: $roleAssignmentSqlPath"
    exit 1
}

$tsql = Get-Content -Path $roleAssignmentSqlPath -Raw
# Replace placeholder with actual identity name
$tsql = $tsql -replace '\{\{IDENTITY_NAME\}\}', $escapedIdentityName

Write-Output "Applying (idempotent) database role assignments for managed identity '$ManagedIdentityName' on database '$sqlDatabaseName'..."

# server FQDN
$serverFqdn = "$sqlServerName.database.windows.net"

try {
    $connectionString = "Server=$serverFqdn;Database=$sqlDatabaseName;Encrypt=True;TrustServerCertificate=False;";
    $connType = [System.Type]::GetType('Microsoft.Data.SqlClient.SqlConnection, Microsoft.Data.SqlClient')
    if (-not $connType) { $connType = [System.Data.SqlClient.SqlConnection] }
    $conn = [Activator]::CreateInstance($connType, $connectionString)
    $accessTokenProp = $connType.GetProperty('AccessToken')
    if (-not $accessTokenProp) { throw 'Current SQL client library does not expose AccessToken property; install Microsoft.Data.SqlClient package.' }
    # Ensure token is a plain string (some environments may still hand back SecureString)
    $plainToken = Convert-SecureIfNeededToPlainText -Value $sqlToken
    $accessTokenProp.SetValue($conn, $plainToken)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $tsql
    $null = $cmd.ExecuteNonQuery()
    Write-Output "Successfully ensured user and role memberships for '$ManagedIdentityName'."

    # ---------------------------------------------------------------------
    # Load and execute SQL to create table(s)
    # ---------------------------------------------------------------------
    $createTableSqlPath = Join-Path $PSScriptRoot 'sql\instawdb.sql'
    if (-not (Test-Path $createTableSqlPath)) {
        Write-Error "SQL script not found: $createTableSqlPath"
        $conn.Close()
        exit 1
    }

    Write-Output "Loading SQL script from $createTableSqlPath..."
    $tableSql = Get-Content -Path $createTableSqlPath -Raw
    
    # Process SQLCMD variables and split into batches
    # Remove SQLCMD variable declarations and USE statements
    $tableSql = $tableSql -replace '(?m)^\s*:setvar\s+.*$', ''
    $tableSql = $tableSql -replace '(?i)USE\s+\[?master\]?\s*;?\s*', ''
    $tableSql = $tableSql -replace '(?i)USE\s+\$\(DatabaseName\)\s*;?\s*', ''
    
    # Replace $(DatabaseName) variable with actual database name
    $tableSql = $tableSql -replace '\$\(DatabaseName\)', $sqlDatabaseName
    $tableSql = $tableSql -replace '\$\(SqlSamplesSourceDataPath\)', ''
    
    # Split on GO statements (case insensitive, with optional whitespace)
    $batches = $tableSql -split '(?mi)^\s*GO\s*$'
    
    Write-Output "Processing SQL script with $($batches.Count) potential batches..."
    $batchNum = 0
    $successCount = 0
    $skipCount = 0
    $failCount = 0
    
    foreach ($batch in $batches) {
        $trimmedBatch = $batch.Trim()
        if ($trimmedBatch.Length -eq 0 -or $trimmedBatch -match '^\s*--.*$') { 
            continue 
        }
        
        # Skip batches with unsupported operations or checks
        $shouldSkip = $false
        $skipReasons = @(
            @{ Pattern = '(?i)DROP\s+DATABASE'; Reason = 'DROP DATABASE' }
            @{ Pattern = '(?i)CREATE\s+DATABASE'; Reason = 'CREATE DATABASE' }
            @{ Pattern = '(?i)ALTER\s+DATABASE'; Reason = 'ALTER DATABASE (unsupported in Azure SQL DB)' }
            @{ Pattern = 'RAISERROR.*SqlSamplesSourceDataPath'; Reason = 'SQLCMD variable check' }
            @{ Pattern = 'sys\.databases.*name\s*='; Reason = 'Database existence check' }
            @{ Pattern = '(?i)SET\s+NOEXEC\s+ON'; Reason = 'SET NOEXEC' }
            @{ Pattern = 'PRINT.*Database does not exist'; Reason = 'Error message print' }
            @{ Pattern = '(?i)CREATE\s+TRIGGER.*ON\s+DATABASE'; Reason = 'Database-level DDL trigger' }
            @{ Pattern = '(?i)sp_addextendedproperty.*ddlDatabaseTriggerLog'; Reason = 'Extended property for skipped database trigger' }
            @{ Pattern = '(?i)IF\s+''.*SqlSamplesSourceDataPath.*IS\s+NULL'; Reason = 'SQLCMD variable validation' }
            @{ Pattern = '(?i)OPENROWSET|BULK\s+INSERT'; Reason = 'OPENROWSET/BULK INSERT (CSV loading not supported)' }
        )
        
        foreach ($skipCheck in $skipReasons) {
            if ($trimmedBatch -match $skipCheck.Pattern) {
                $shouldSkip = $true
                $skipCount++
                break
            }
        }
        
        if ($shouldSkip) { continue }
        
        $batchNum++
        try {
            $cmd.CommandText = $trimmedBatch
            $null = $cmd.ExecuteNonQuery()
            $successCount++
            if ($batchNum % 100 -eq 0) {
                Write-Output "  Progress: $successCount successful, $failCount failed, $skipCount skipped..."
            }
        }
        catch {
            $failCount++
            $errorMsg = $_.Exception.Message
            # Only warn on unexpected errors (ignore common expected failures)
            if ($errorMsg -notmatch 'already exists' -and 
                $errorMsg -notmatch 'Cannot find the object' -and
                $errorMsg -notmatch 'Invalid object name') {
                Write-Warning "Batch $batchNum failed: $errorMsg"
            }
        }
    }
    
    Write-Output "Completed SQL script execution:"
    Write-Output "  - $successCount batches succeeded"
    Write-Output "  - $failCount batches failed (may be expected)"
    Write-Output "  - $skipCount batches skipped (unsupported operations)"
    
    # ---------------------------------------------------------------------
    # Load CSV data into tables
    # ---------------------------------------------------------------------
    Write-Output "`nLoading CSV data into tables..."
    
    $csvFolder = Join-Path $PSScriptRoot 'sql'
    
    # Define table load order and CSV configurations
    # Format: @{ Table='SchemaName.TableName'; File='filename.csv'; Delimiter='\t' or '+|'; RowTerminator='\n' or '&|\n'; IsWideChar=$true/$false }
    # Loading e-commerce relevant tables in dependency order
    $csvLoadConfig = @(
        # ===== LOOKUP/REFERENCE TABLES =====
        @{ Table='Production.UnitMeasure'; File='UnitMeasure.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.Culture'; File='Culture.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Sales.Currency'; File='Currency.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Person.AddressType'; File='AddressType.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Person.ContactType'; File='ContactType.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Person.PhoneNumberType'; File='PhoneNumberType.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Sales.SalesReason'; File='SalesReason.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Sales.CreditCard'; File='CreditCard.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Sales.CurrencyRate'; File='CurrencyRate.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Person.CountryRegion'; File='CountryRegion.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Sales.SalesTerritory'; File='SalesTerritory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
    @{ Table='Purchasing.ShipMethod'; File='ShipMethod.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        
    # ===== GEOGRAPHY =====
        @{ Table='Person.StateProvince'; File='StateProvince.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Person.Address'; File='Address.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }

        # ===== CUSTOMER/PERSON DATA =====
        @{ Table='Person.BusinessEntity'; File='BusinessEntity.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
    @{ Table='Person.BusinessEntityAddress'; File='BusinessEntityAddress.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Person.Person'; File='Person.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Person.Password'; File='Password.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Person.EmailAddress'; File='EmailAddress.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Person.PersonPhone'; File='PersonPhone.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='HumanResources.Employee'; File='Employee.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$true }
        @{ Table='Sales.PersonCreditCard'; File='PersonCreditCard.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
    @{ Table='Sales.SalesPerson'; File='SalesPerson.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Sales.Store'; File='Store.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Sales.Customer'; File='Customer.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        
        # ===== PRODUCT CATALOG =====
        @{ Table='Production.Illustration'; File='Illustration.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Production.Location'; File='Location.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductCategory'; File='ProductCategory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductSubcategory'; File='ProductSubcategory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductModel'; File='ProductModel.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Production.ProductDescription'; File='ProductDescription.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductModelProductDescriptionCulture'; File='ProductModelProductDescriptionCulture.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductModelIllustration'; File='ProductModelIllustration.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        # Skipping ProductPhoto - contains binary data (varbinary) that requires special handling
        @{ Table='Production.Product'; File='Product.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductReview'; File='ProductReview.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductCostHistory'; File='ProductCostHistory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductListPriceHistory'; File='ProductListPriceHistory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductInventory'; File='ProductInventory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        
        # ===== SALES & PROMOTIONS =====
        @{ Table='Sales.SpecialOffer'; File='SpecialOffer.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Sales.SpecialOfferProduct'; File='SpecialOfferProduct.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        
        # ===== SALES ORDERS =====
        @{ Table='Sales.SalesOrderHeader'; File='SalesOrderHeader.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Sales.SalesOrderDetail'; File='SalesOrderDetail.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Sales.SalesOrderHeaderSalesReason'; File='SalesOrderHeaderSalesReason.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        
        # ===== SHOPPING CART =====
        @{ Table='Sales.ShoppingCartItem'; File='ShoppingCartItem.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
    )
    
    $csvLoadSuccess = 0
    $csvLoadFailed = 0
    $csvLoadSkipped = 0
    
    foreach ($config in $csvLoadConfig) {
        $csvPath = Join-Path $csvFolder $config.File
        
        if (-not (Test-Path $csvPath)) {
            Write-Warning "CSV file not found: $csvPath - Skipping"
            $csvLoadSkipped++
            continue
        }
        
        Write-Output "  Loading $($config.Table) from $($config.File)..."
        $hasIdentity = $false
        $schemaName = $null
        $tableName = $null

        try {
            $tableParts = $config.Table.Split('.', 2)
            if ($tableParts.Count -ne 2) {
                Write-Warning "  Invalid table specification '$($config.Table)' - Skipping"
                $csvLoadSkipped++
                continue
            }

            $schemaName = $tableParts[0]
            $tableName = $tableParts[1]

            # Ensure table exists before attempting to load
            $cmd.Parameters.Clear()
            $cmd.CommandText = @"
SELECT COUNT(*)
FROM sys.tables t
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE t.name = '$tableName'
  AND s.name = '$schemaName'
"@
            $tableExists = ($cmd.ExecuteScalar() -gt 0)
            if (-not $tableExists) {
                Write-Warning "    Table $($config.Table) not found - Skipping"
                $csvLoadSkipped++
                continue
            }

            # Check if table already has data
            $cmd.Parameters.Clear()
            $cmd.CommandText = "SELECT COUNT(*) FROM [$schemaName].[$tableName]"
            $existingCount = $cmd.ExecuteScalar()
            
            if ($existingCount -gt 0) {
                Write-Output "    Table already contains $existingCount rows - Skipping"
                $csvLoadSkipped++
                continue
            }
            
            # Read CSV file with proper encoding
            $encoding = if ($config.IsWideChar) { [System.Text.Encoding]::Unicode } else { [System.Text.Encoding]::Default }
            $csvContent = [System.IO.File]::ReadAllText($csvPath, $encoding)
            
            # Split into rows - handle different row terminators
            if ($config.IsWideChar -and $config.RowTerminator -eq '&|') {
                # For wide char files with &| terminator, it's actually &|\r\n in the file
                $rows = $csvContent -split '&\|\r?\n' | Where-Object { $_.Trim() -ne '' }
            }
            else {
                $rows = $csvContent -split $config.RowTerminator | Where-Object { $_.Trim() -ne '' }
            }
            
            if ($rows.Count -eq 0) {
                Write-Warning "  No data rows found in $($config.File) - Skipping"
                $csvLoadSkipped++
                continue
            }
            
            # Get table schema to understand column types (exclude computed columns)
            $schemaQuery = @"
SELECT 
    c.COLUMN_NAME,
    c.DATA_TYPE,
    c.ORDINAL_POSITION,
        COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsComputed') as IsComputed,
        c.CHARACTER_MAXIMUM_LENGTH,
        c.NUMERIC_PRECISION,
        c.NUMERIC_SCALE
FROM INFORMATION_SCHEMA.COLUMNS c
WHERE c.TABLE_SCHEMA = '$schemaName'
  AND c.TABLE_NAME = '$tableName'
ORDER BY c.ORDINAL_POSITION
"@
            
            $cmd.Parameters.Clear()
            $cmd.CommandText = $schemaQuery
            $reader = $cmd.ExecuteReader()
            $columns = @()
            while ($reader.Read()) {
                $columns += @{
                    Name = $reader['COLUMN_NAME']
                    Type = $reader['DATA_TYPE']
                    Position = $reader['ORDINAL_POSITION']
                    IsComputed = $reader['IsComputed']
                    CharacterLength = $reader['CHARACTER_MAXIMUM_LENGTH']
                    NumericPrecision = $reader['NUMERIC_PRECISION']
                    NumericScale = $reader['NUMERIC_SCALE']
                }
            }
            $reader.Close()
            
            if ($columns.Count -eq 0) {
                Write-Warning "  Could not retrieve schema for $($config.Table) - Skipping"
                $csvLoadSkipped++
                continue
            }
            
            # Filter out columns with unsupported data types and computed columns
            $unsupportedTypes = @('geometry', 'varbinary', 'image')
            $supportedColumns = $columns | Where-Object { 
                $_.Type -notin $unsupportedTypes -and 
                $_.IsComputed -eq 0
            }
            
            if ($supportedColumns.Count -eq 0) {
                Write-Warning "  No supported columns found in $($config.Table) - Skipping"
                $csvLoadSkipped++
                continue
            }
            
            # Check if table has identity column
            $identityCheckQuery = @"
SELECT COUNT(*) as HasIdentity
FROM sys.columns c
INNER JOIN sys.tables t ON c.object_id = t.object_id
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE s.name = '$schemaName'
  AND t.name = '$tableName'
  AND c.is_identity = 1
"@
            $cmd.Parameters.Clear()
            $cmd.CommandText = $identityCheckQuery
            $identityResult = $cmd.ExecuteScalar()
            $hasIdentity = ($identityResult -gt 0)
            
            # Build parameterized INSERT statement (only for supported columns)
            $cmd.Parameters.Clear()
            $columnMapping = @{}
            $columnNames = @()
            $valueExpressions = @()
            $paramCounter = 0

            for ($i = 0; $i -lt $columns.Count; $i++) {
                $columnInfo = $columns[$i]

                if ($columnInfo.Type -in $unsupportedTypes -or $columnInfo.IsComputed -ne 0) {
                    continue
                }

                $paramCounter++
                $paramName = "@p$paramCounter"
                $param = $cmd.CreateParameter()
                $param.ParameterName = $paramName

                switch ($columnInfo.Type) {
                    'uniqueidentifier' { $param.SqlDbType = [System.Data.SqlDbType]::UniqueIdentifier }
                    'int' { $param.SqlDbType = [System.Data.SqlDbType]::Int }
                    'bigint' { $param.SqlDbType = [System.Data.SqlDbType]::BigInt }
                    'smallint' { $param.SqlDbType = [System.Data.SqlDbType]::SmallInt }
                    'tinyint' { $param.SqlDbType = [System.Data.SqlDbType]::TinyInt }
                    'bit' { $param.SqlDbType = [System.Data.SqlDbType]::Bit }
                    'datetime' { $param.SqlDbType = [System.Data.SqlDbType]::DateTime }
                    'datetime2' { $param.SqlDbType = [System.Data.SqlDbType]::DateTime2 }
                    'date' { $param.SqlDbType = [System.Data.SqlDbType]::Date }
                    'money' { $param.SqlDbType = [System.Data.SqlDbType]::Money }
                    'decimal' { $param.SqlDbType = [System.Data.SqlDbType]::Decimal }
                    'numeric' { $param.SqlDbType = [System.Data.SqlDbType]::Decimal }
                    'float' { $param.SqlDbType = [System.Data.SqlDbType]::Float }
                    'xml' { $param.SqlDbType = [System.Data.SqlDbType]::Xml }
                    'geography' { $param.SqlDbType = [System.Data.SqlDbType]::VarBinary }
                    'hierarchyid' { $param.SqlDbType = [System.Data.SqlDbType]::VarBinary }
                    default { $param.SqlDbType = [System.Data.SqlDbType]::NVarChar }
                }

                if ($columnInfo.Type -in @('decimal', 'numeric')) {
                    if ($null -ne $columnInfo.NumericPrecision -and $columnInfo.NumericPrecision -ne [DBNull]::Value) {
                        $param.Precision = [byte][int]$columnInfo.NumericPrecision
                    }
                    if ($null -ne $columnInfo.NumericScale -and $columnInfo.NumericScale -ne [DBNull]::Value) {
                        $param.Scale = [byte][int]$columnInfo.NumericScale
                    }
                }

                if ($columnInfo.Type -in @('nvarchar', 'varchar', 'nchar', 'char')) {
                    if ($null -ne $columnInfo.CharacterLength -and $columnInfo.CharacterLength -ne [DBNull]::Value) {
                        $lengthValue = [int]$columnInfo.CharacterLength
                        if ($lengthValue -gt 0) {
                            $param.Size = $lengthValue
                        }
                        elseif ($lengthValue -eq -1) {
                            $param.Size = -1
                        }
                    }
                }

                if ($columnInfo.Type -eq 'geography') {
                    $param.Size = -1
                }
                elseif ($columnInfo.Type -eq 'hierarchyid') {
                    $param.Size = -1
                }

                $null = $cmd.Parameters.Add($param)

                $columnNames += "[$($columnInfo.Name)]"
                if ($columnInfo.Type -eq 'geography') {
                    $valueExpressions += "geography::Deserialize($paramName)"
                }
                elseif ($columnInfo.Type -eq 'hierarchyid') {
                    $valueExpressions += "CAST($paramName AS hierarchyid)"
                }
                else {
                    $valueExpressions += $paramName
                }

                $columnMapping[$i] = @{
                    ParamIndex = $paramCounter - 1
                    Column = $columnInfo
                }
            }

            $insertSql = "INSERT INTO [$schemaName].[$tableName] ($($columnNames -join ', ')) VALUES ($($valueExpressions -join ', '))"
            $cmd.CommandText = $insertSql
            
            # Insert rows in batches
            $batchSize = 1000
            $rowCount = 0
            $mismatchRows = 0
            $transaction = $conn.BeginTransaction()
            $cmd.Transaction = $transaction
            
            try {
                # Enable IDENTITY_INSERT if needed (must be inside transaction)
                if ($hasIdentity) {
                    $tempCmd = $conn.CreateCommand()
                    $tempCmd.Transaction = $transaction
                    $tempCmd.CommandText = "SET IDENTITY_INSERT [$schemaName].[$tableName] ON"
                    $null = $tempCmd.ExecuteNonQuery()
                }
                
                for ($rowIndex = 0; $rowIndex -lt $rows.Count; $rowIndex++) {
                    $row = $rows[$rowIndex]
                    if ([string]::IsNullOrWhiteSpace($row)) { continue }
                    
                    $values = $row -split [regex]::Escape($config.Delimiter)
                    if ($values -isnot [System.Array]) {
                        $values = @($values)
                    }

                    $values = Remove-TrailingEmptyFields -Values $values
                    
                    if ($values.Count -eq 0 -or $values.Count -ne $columns.Count) {
                        $mismatchRows++
                        continue
                    }
                    
                    $displayRowNumber = $rowIndex + 1

                    # Set parameter values with proper type conversion (only for supported columns)
                    for ($i = 0; $i -lt $values.Count; $i++) {
                        if (-not $columnMapping.ContainsKey($i)) {
                            continue
                        }

                        $mapping = $columnMapping[$i]
                        $param = $cmd.Parameters[$mapping.ParamIndex]
                        $columnDef = $mapping.Column
                        $trimmedValue = $values[$i].Trim()

                        if ([string]::IsNullOrWhiteSpace($trimmedValue) -or $trimmedValue -eq 'NULL' -or $trimmedValue -eq '\\N' -or $trimmedValue -eq 'null') {
                            $param.Value = [DBNull]::Value
                            continue
                        }

                        if ($columnDef.Type -eq 'uniqueidentifier') {
                            $cleanGuid = $trimmedValue -replace '[{}]', ''
                            try {
                                $param.Value = [Guid]::Parse($cleanGuid)
                            }
                            catch {
                                Write-Warning "  Invalid GUID format in row $displayRowNumber, column $($columnDef.Name): $trimmedValue"
                                $param.Value = [DBNull]::Value
                            }
                        }
                        elseif ($columnDef.Type -in @('datetime', 'datetime2', 'date')) {
                            try {
                                $param.Value = [DateTime]::Parse($trimmedValue)
                            }
                            catch {
                                $param.Value = [DBNull]::Value
                            }
                        }
                        elseif ($columnDef.Type -eq 'bit') {
                            $param.Value = if ($trimmedValue -in @('1', 'true', 'True', 'TRUE')) { $true } else { $false }
                        }
                        elseif ($columnDef.Type -eq 'geography') {
                            try {
                                $bytes = Convert-HexStringToByteArray -HexString $trimmedValue
                                if ($bytes.Length -eq 0) {
                                    $param.Value = [DBNull]::Value
                                }
                                else {
                                    $param.Value = [byte[]]$bytes
                                }
                            }
                            catch {
                                Write-Warning "  Invalid geography payload in row $displayRowNumber, column $($columnDef.Name): $($_.Exception.Message)"
                                $param.Value = [DBNull]::Value
                            }
                        }
                        elseif ($columnDef.Type -eq 'hierarchyid') {
                            try {
                                $bytes = Convert-HexStringToByteArray -HexString $trimmedValue
                                if ($bytes.Length -eq 0) {
                                    $param.Value = [DBNull]::Value
                                }
                                else {
                                    $param.Value = [byte[]]$bytes
                                }
                            }
                            catch {
                                Write-Warning "  Invalid hierarchyid payload in row $displayRowNumber, column $($columnDef.Name): $($_.Exception.Message)"
                                $param.Value = [DBNull]::Value
                            }
                        }
                        else {
                            $param.Value = $trimmedValue
                        }
                    }
                    
                    $null = $cmd.ExecuteNonQuery()
                    $rowCount++
                    
                    # Show progress for large tables
                    if ($rowCount % 500 -eq 0) {
                        Write-Output "    ...inserted $rowCount rows"
                    }
                    
                    # Commit in batches to avoid long-running transactions
                    if ($rowCount % $batchSize -eq 0) {
                        # Disable IDENTITY_INSERT before commit if enabled
                        if ($hasIdentity) {
                            $tempCmd = $conn.CreateCommand()
                            $tempCmd.Transaction = $transaction
                            $tempCmd.CommandText = "SET IDENTITY_INSERT [$schemaName].[$tableName] OFF"
                            $null = $tempCmd.ExecuteNonQuery()
                        }
                        
                        $transaction.Commit()
                        $transaction = $conn.BeginTransaction()
                        $cmd.Transaction = $transaction
                        
                        # Re-enable IDENTITY_INSERT for next batch if needed
                        if ($hasIdentity) {
                            $tempCmd = $conn.CreateCommand()
                            $tempCmd.Transaction = $transaction
                            $tempCmd.CommandText = "SET IDENTITY_INSERT [$schemaName].[$tableName] ON"
                            $null = $tempCmd.ExecuteNonQuery()
                        }
                    }
                }
                
                # Disable IDENTITY_INSERT before final commit if enabled
                if ($hasIdentity) {
                    $tempCmd = $conn.CreateCommand()
                    $tempCmd.Transaction = $transaction
                    $tempCmd.CommandText = "SET IDENTITY_INSERT [$schemaName].[$tableName] OFF"
                    $null = $tempCmd.ExecuteNonQuery()
                }
                
                $transaction.Commit()
                $cmd.Transaction = $null
                
                if ($mismatchRows -gt 0) {
                    Write-Warning "    Skipped $mismatchRows row(s) in $($config.File) due to unexpected column counts."
                }

                Write-Output "    Loaded $rowCount rows into $($config.Table)"
                $csvLoadSuccess++
            }
            catch {
                try {
                    $transaction.Rollback()
                }
                catch {
                    # Transaction may already be rolled back
                }
                $cmd.Transaction = $null
                throw
            }
        }
        catch {
            Write-Warning "  Failed to load $($config.File): $($_.Exception.Message)"
            $csvLoadFailed++
            
            # Ensure IDENTITY_INSERT is turned off for this table if it has identity
            if ($hasIdentity -and $schemaName -and $tableName) {
                try {
                    $cleanupCmd = $conn.CreateCommand()
                    $cleanupCmd.CommandText = "SET IDENTITY_INSERT [$schemaName].[$tableName] OFF"
                    $null = $cleanupCmd.ExecuteNonQuery()
                }
                catch {
                    # Ignore cleanup errors
                }
            }
        }
    }
    
    $conn.Close()
    
    Write-Output "`nCSV Data Loading Summary:"
    Write-Output "  - $csvLoadSuccess tables loaded successfully"
    Write-Output "  - $csvLoadFailed tables failed to load"
    Write-Output "  - $csvLoadSkipped tables skipped"
}
catch {
    Write-Error "Failed to execute T-SQL for managed identity via ADO.NET: $($_.Exception.Message)"
    exit 1
}
