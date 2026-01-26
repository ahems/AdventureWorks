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

function Import-JsonTable {
    param(
        [Parameter(Mandatory)]
        [string] $SchemaName,
        
        [Parameter(Mandatory)]
        [string] $TableName,
        
        [Parameter(Mandatory)]
        [string] $JsonFilePath,
        
        [Parameter(Mandatory)]
        [System.Data.Common.DbConnection] $Connection,
        
        [Parameter(Mandatory)]
        [System.Data.Common.DbCommand] $Command
    )
    
    Write-Output "  Loading [$SchemaName].[$TableName] from JSON file..."
    
    try {
        # Check if table already has data
        $Command.CommandText = "SELECT COUNT(*) FROM [$SchemaName].[$TableName]"
        $existingCount = $Command.ExecuteScalar()
        
        if ($existingCount -gt 0) {
            Write-Output "    Table already contains $existingCount rows - Skipping"
            return $true
        }
        
        # Read and parse JSON file
        if (-not (Test-Path $JsonFilePath)) {
            Write-Warning "    JSON file not found: $JsonFilePath - Skipping"
            return $false
        }
        
        $jsonContent = Get-Content -Path $JsonFilePath -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($jsonContent)) {
            Write-Output "    JSON file is empty - Skipping"
            return $true
        }
        
        $records = $jsonContent | ConvertFrom-Json
        if (-not $records -or $records.Count -eq 0) {
            Write-Output "    No records in JSON file - Skipping"
            return $true
        }
        
        Write-Output "    Parsed $($records.Count) records from JSON"
        
        # Get column information (excluding IDENTITY and computed columns)
        $Command.CommandText = @"
SELECT 
    c.COLUMN_NAME, 
    c.DATA_TYPE,
    c.IS_NULLABLE,
    COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsComputed') AS IsComputed,
    COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') AS IsIdentity
FROM INFORMATION_SCHEMA.COLUMNS c
WHERE c.TABLE_SCHEMA = '$SchemaName' AND c.TABLE_NAME = '$TableName'
    AND COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsComputed') = 0
    AND COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') = 0
ORDER BY c.ORDINAL_POSITION
"@
        $reader = $Command.ExecuteReader()
        $columns = @()
        while ($reader.Read()) {
            $columns += @{
                Name = $reader['COLUMN_NAME']
                Type = $reader['DATA_TYPE']
                IsNullable = $reader['IS_NULLABLE'] -eq 'YES'
            }
        }
        $reader.Close()
        
        # Build INSERT statements in batches
        $batchSize = 100
        $insertedRows = 0
        $transaction = $Connection.BeginTransaction()
        $Command.Transaction = $transaction
        
        try {
            for ($i = 0; $i -lt $records.Count; $i += $batchSize) {
                $batchEnd = [Math]::Min($i + $batchSize, $records.Count)
                $batchRecords = $records[$i..($batchEnd - 1)]
                
                # Build column list
                $columnList = ($columns | ForEach-Object { "[$($_.Name)]" }) -join ', '
                $insertSql = "INSERT INTO [$SchemaName].[$TableName] ($columnList) VALUES "
                
                $valuesClauses = @()
                foreach ($record in $batchRecords) {
                    $values = @()
                    foreach ($col in $columns) {
                        $value = $record.($col.Name)
                        
                        if ($null -eq $value -or $value -eq '') {
                            $values += "NULL"
                        }
                        elseif ($col.Type -eq 'xml') {
                            # Escape single quotes and wrap in XML cast
                            $escapedVal = $value.ToString().Replace("'", "''")
                            $values += "CAST(N'$escapedVal' AS XML)"
                        }
                        elseif ($col.Type -eq 'vector') {
                            # VECTOR columns: Cast JSON array to VECTOR
                            # Format: "[0.1,0.2,0.3,...]" -> CAST('[...]' AS VECTOR(1536))
                            $escapedVal = $value.ToString().Replace("'", "''")
                            $values += "CAST('$escapedVal' AS VECTOR(1536))"
                        }
                        elseif ($col.Type -eq 'hierarchyid') {
                            # Use hierarchyid::Parse()
                            $values += "hierarchyid::Parse('$($value.ToString())')"
                        }
                        elseif ($col.Type -eq 'varbinary') {
                            # Value should be hex string with 0x prefix
                            if ($value.ToString().StartsWith('0x')) {
                                $values += $value.ToString()
                            } else {
                                $values += "0x$($value.ToString())"
                            }
                        }
                        elseif ($col.Type -in @('varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext')) {
                            # Escape single quotes
                            $escapedVal = $value.ToString().Replace("'", "''")
                            $values += "N'$escapedVal'"
                        }
                        elseif ($col.Type -eq 'bit') {
                            $values += if ($value -eq $true -or $value -eq 1) { '1' } else { '0' }
                        }
                        elseif ($col.Type -in @('datetime', 'datetime2', 'date')) {
                            $values += "'$($value.ToString())'"
                        }
                        elseif ($col.Type -eq 'uniqueidentifier') {
                            $values += "'$($value.ToString())'"
                        }
                        else {
                            # Numeric types
                            $values += $value.ToString()
                        }
                    }
                    $valuesClauses += "(" + ($values -join ', ') + ")"
                }
                
                $insertSql += ($valuesClauses -join ",`n")
                $Command.CommandText = $insertSql
                $Command.ExecuteNonQuery() | Out-Null
                
                $insertedRows += ($batchEnd - $i)
                if ($insertedRows % 500 -eq 0) {
                    Write-Output "    ...inserted $insertedRows rows"
                }
            }
            
            $transaction.Commit()
            Write-Output "    Successfully loaded $insertedRows rows from JSON"
            return $true
        }
        catch {
            $transaction.Rollback()
            throw
        }
        finally {
            $Command.Transaction = $null
        }
    }
    catch {
        Write-Warning "    Failed to load from JSON: $($_.Exception.Message)"
        return $false
    }
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
    $createTableSqlPath = Join-Path $PSScriptRoot 'sql\AdventureWorks.sql'
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
                $errorMsg -notmatch 'Invalid object name' -and
                $errorMsg -notmatch 'There is already an object named' -and
                $errorMsg -notmatch 'already has a primary key defined on it' -and
                $errorMsg -notmatch 'Altering existing schema components is not allowed' -and
                $errorMsg -notmatch 'A full-text index for table') {
                Write-Warning "Batch $batchNum failed: $errorMsg"
            }
        }
    }
    
    Write-Output "Completed SQL script execution:"
    Write-Output "  - $successCount batches succeeded"
    Write-Output "  - $failCount batches failed (may be expected)"
    Write-Output "  - $skipCount batches skipped (unsupported operations)"
    
    # ---------------------------------------------------------------------
    # Apply AI enhancements to schema
    # ---------------------------------------------------------------------
    $aiEnhancementsSqlPath = Join-Path $PSScriptRoot 'sql\AdventureWorks-AI.sql'
    if (Test-Path $aiEnhancementsSqlPath) {
        Write-Output "`nApplying AI schema enhancements from $aiEnhancementsSqlPath..."
        $aiSql = Get-Content -Path $aiEnhancementsSqlPath -Raw
        
        # Split on GO statements
        $aiBatches = $aiSql -split '(?mi)^\s*GO\s*$'
        
        foreach ($batch in $aiBatches) {
            $trimmedBatch = $batch.Trim()
            if ($trimmedBatch.Length -eq 0) { continue }
            
            try {
                $cmd.CommandText = $trimmedBatch
                $null = $cmd.ExecuteNonQuery()
                Write-Output "  AI enhancement applied successfully"
            }
            catch {
                Write-Warning "AI enhancement batch failed: $($_.Exception.Message)"
            }
        }
    } else {
        Write-Output "`nAI enhancements SQL file not found, skipping..."
    }
    
    # ---------------------------------------------------------------------
    # Load CSV data into tables using SqlBulkCopy
    # ---------------------------------------------------------------------
    Write-Output "`nLoading CSV data into tables using SqlBulkCopy..."
    
    $csvFolder = Join-Path $PSScriptRoot 'sql'
    
    # Define table load order and CSV configurations
    # Format: @{ Table='SchemaName.TableName'; File='filename.csv'; Delimiter='\t' or '+|'; RowTerminator='\n' or '&|'; IsWideChar=$true/$false }
    # Loading e-commerce relevant tables in dependency order
    $csvLoadConfig = @(
        # ===== LOOKUP/REFERENCE TABLES =====
        @{ Table='Production.UnitMeasure'; File='UnitMeasure.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.Culture'; File='Culture.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Sales.Currency'; File='Currency.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        # Modern Turkish Lira (TRY, post-2005) to replace old TRL
        @{ Table='Sales.Currency'; File='Currency-ai.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
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
        @{ Table='Person.StateProvince'; File='StateProvince-ai.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Person.Address'; File='Address.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }

        # ===== CUSTOMER/PERSON DATA =====
        @{ Table='Person.BusinessEntity'; File='BusinessEntity.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
    @{ Table='Person.BusinessEntityAddress'; File='BusinessEntityAddress.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Person.Person'; File='Person.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Person.Password'; File='Password.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Person.EmailAddress'; File='EmailAddress.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Person.PersonPhone'; File='PersonPhone.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='HumanResources.Employee'; File='Employee.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
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
        # Enhanced product descriptions with embeddings (DescriptionEmbedding VECTOR field, JSON array)
        @{ Table='Production.ProductDescription'; File='ProductDescription-ai.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false; VectorColumns=@('DescriptionEmbedding') }
        # AI-translated product descriptions (actual text content for 16 new cultures)
        @{ Table='Production.ProductDescription'; File='ProductDescription-ai-translations.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductModelProductDescriptionCulture'; File='ProductModelProductDescriptionCulture.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        # AI-translated product description culture mappings (16 additional cultures beyond base AdventureWorks 7)
        @{ Table='Production.ProductModelProductDescriptionCulture'; File='ProductModelProductDescriptionCulture-ai.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductModelIllustration'; File='ProductModelIllustration.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.Product'; File='Product.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductReview'; File='ProductReview.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false; HexColumns=@('Comments') }
        # AI-generated product reviews with embeddings (CommentsEmbedding VECTOR field, JSON array)
        @{ Table='Production.ProductReview'; File='ProductReview-ai.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false; HexColumns=@('Comments'); VectorColumns=@('CommentsEmbedding') }
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
        
        # ===== ADDITIONAL LOOKUP TABLES =====
        @{ Table='Sales.CountryRegionCurrency'; File='CountryRegionCurrency.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        # Modern currency mapping for Turkey (TRY)
        @{ Table='Sales.CountryRegionCurrency'; File='CountryRegionCurrency-ai.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Sales.SalesTaxRate'; File='SalesTaxRate.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        # Additional sales tax rates for new language regions
        @{ Table='Sales.SalesTaxRate'; File='SalesTaxRate-ai.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ScrapReason'; File='ScrapReason.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='dbo.AWBuildVersion'; File='AWBuildVersion.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        
        # ===== HUMAN RESOURCES =====
        @{ Table='HumanResources.Department'; File='Department.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='HumanResources.Shift'; File='Shift.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='HumanResources.EmployeeDepartmentHistory'; File='EmployeeDepartmentHistory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='HumanResources.EmployeePayHistory'; File='EmployeePayHistory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        
        # ===== PERSON CONTACTS =====
        @{ Table='Person.BusinessEntityContact'; File='BusinessEntityContact.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        
        # ===== PURCHASING =====
        @{ Table='Purchasing.Vendor'; File='Vendor.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Purchasing.ProductVendor'; File='ProductVendor.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Purchasing.PurchaseOrderHeader'; File='PurchaseOrderHeader.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Purchasing.PurchaseOrderDetail'; File='PurchaseOrderDetail.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        
        # ===== PRODUCTION =====
        @{ Table='Production.BillOfMaterials'; File='BillOfMaterials.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        # ProductPhoto has ThumbNailPhoto and LargePhoto fields hex-encoded to handle varbinary data
        @{ Table='Production.ProductPhoto'; File='ProductPhoto.csv'; Delimiter="+|"; RowTerminator="`n"; IsWideChar=$false; HexColumns=@('ThumbNailPhoto', 'LargePhoto') }
        @{ Table='Production.ProductProductPhoto'; File='ProductProductPhoto.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        # AI-generated photo mappings (links AI photos to products)
        @{ Table='Production.ProductProductPhoto'; File='ProductProductPhoto-ai.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        # Additional cultures for languages added to the website
        @{ Table='Production.Culture'; File='Culture-ai.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        # Document has hierarchyid DocumentNode (hex-encoded), varbinary Document field (hex-encoded), and nvarchar DocumentSummary (hex-encoded to handle newlines)
        @{ Table='Production.Document'; File='Document.csv'; Delimiter="+|"; RowTerminator="`n"; IsWideChar=$false; HexColumns=@('DocumentNode', 'DocumentSummary', 'Document') }
        # ProductDocument references ProductIDs that all exist in Product.csv - load order ensures Product is loaded first
        @{ Table='Production.ProductDocument'; File='ProductDocument.csv'; Delimiter="+|"; RowTerminator="`n"; IsWideChar=$false; HexColumns=@('DocumentNode') }
        @{ Table='Production.TransactionHistory'; File='TransactionHistory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.TransactionHistoryArchive'; File='TransactionHistoryArchive.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.WorkOrder'; File='WorkOrder.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.WorkOrderRouting'; File='WorkOrderRouting.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        
        # ===== SALES HISTORY =====
        @{ Table='Sales.SalesPersonQuotaHistory'; File='SalesPersonQuotaHistory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Sales.SalesTerritoryHistory'; File='SalesTerritoryHistory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
    )
    
    $csvLoadSuccess = 0
    $csvLoadFailed = 0
    $csvLoadSkipped = 0
    
    # Define base record counts for -ai.csv files (additive data)
    # These files should only be loaded when table has exactly the base AdventureWorks count
    $aiCsvBaseRecordCounts = @{
        'Culture-ai.csv' = 8
        'Currency-ai.csv' = 105
        'StateProvince-ai.csv' = 181
        'CountryRegionCurrency-ai.csv' = 109
        'SalesTaxRate-ai.csv' = 29
        'ProductProductPhoto-ai.csv' = 504
        'ProductDescription-ai.csv' = 762
        'ProductDescription-ai-translations.csv' = 2921
        'ProductReview-ai.csv' = 4
        'ProductModelProductDescriptionCulture-ai.csv' = 874
    }
    
    foreach ($config in $csvLoadConfig) {
        $csvPath = Join-Path $csvFolder $config.File
        
        if (-not (Test-Path $csvPath)) {
            Write-Warning "CSV file not found: $csvPath - Skipping"
            $csvLoadSkipped++
            continue
        }
        
        Write-Output "  Loading $($config.Table) from $($config.File)..."
        
        try {
            # Parse table name
            $tableParts = $config.Table -split '\.'
            if ($tableParts.Count -ne 2) {
                Write-Warning "    Invalid table name format - Skipping"
                $csvLoadSkipped++
                continue
            }
            $schemaName = $tableParts[0]
            $tableName = $tableParts[1]
            
            # Check if table already has data
            $cmd.CommandText = "SELECT COUNT(*) FROM [$schemaName].[$tableName]"
            $existingCount = $cmd.ExecuteScalar()
            
            # Determine if this is an additive -ai.csv file
            $isAiCsv = $config.File -match '-ai\.csv$'
            $baseRecordCount = $aiCsvBaseRecordCounts[$config.File]
            
            if ($isAiCsv -and $baseRecordCount) {
                # For -ai.csv files, only load if table has exactly the base record count
                if ($existingCount -eq $baseRecordCount) {
                    Write-Output "    Table contains base $existingCount rows, adding AI enhancements..."
                }
                elseif ($existingCount -gt $baseRecordCount) {
                    Write-Output "    Table already contains $existingCount rows (expected $baseRecordCount) - AI data already loaded, skipping"
                    $csvLoadSkipped++
                    continue
                }
                else {
                    Write-Output "    Table contains $existingCount rows (expected $baseRecordCount) - Base data not loaded yet, skipping AI data"
                    $csvLoadSkipped++
                    continue
                }
            }
            elseif ($existingCount -gt 0) {
                # For regular CSV files, skip if any data exists
                Write-Output "    Table already contains $existingCount rows - Skipping"
                $csvLoadSkipped++
                continue
            }
            
            # Read CSV with proper encoding
            $encoding = if ($config.IsWideChar) { [System.Text.Encoding]::Unicode } else { [System.Text.Encoding]::UTF8 }
            $csvContent = [System.IO.File]::ReadAllText($csvPath, $encoding)
            
            # Parse CSV into DataTable
            $dataTable = New-Object System.Data.DataTable
            
            # Split into rows
            if ($config.IsWideChar -and $config.RowTerminator -eq '&|') {
                # Split on &| which may be followed by optional newline characters
                $rows = $csvContent -split '&\|(?:\r?\n)?'
            }
            else {
                $rows = $csvContent -split [regex]::Escape($config.RowTerminator)
            }
            $rows = $rows | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
            
            if ($rows.Count -eq 0) {
                Write-Warning "    No data rows found - Skipping"
                $csvLoadSkipped++
                continue
            }
            
            # Check if this table has hierarchyid or geography columns (we'll handle these with INSERT statements)
            # Also use INSERT for tables with hex-encoded columns (varbinary/text with special handling)
            $cmd.CommandText = @"
SELECT COUNT(*) 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = '$schemaName' AND TABLE_NAME = '$tableName'
AND DATA_TYPE IN ('hierarchyid', 'geography', 'geometry')
"@
            $hasSpecialColumns = ($cmd.ExecuteScalar() -gt 0) -or ($config.HexColumns -and $config.HexColumns.Count -gt 0) -or ($config.Base64Columns -and $config.Base64Columns.Count -gt 0) -or ($config.VectorColumns -and $config.VectorColumns.Count -gt 0)
            
            # First, get ALL columns from the database to understand CSV structure
            $cmd.CommandText = @"
SELECT 
    c.COLUMN_NAME, 
    c.DATA_TYPE, 
    c.ORDINAL_POSITION,
    c.IS_NULLABLE,
    c.COLUMN_DEFAULT,
    COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsComputed') AS IsComputed,
    COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') AS IsIdentity
FROM INFORMATION_SCHEMA.COLUMNS c
WHERE c.TABLE_SCHEMA = '$schemaName' AND c.TABLE_NAME = '$tableName'
ORDER BY c.ORDINAL_POSITION
"@
            $reader = $cmd.ExecuteReader()
            $allColumns = @()
            $columns = @()
            $csvColumnIndex = 0
            
            while ($reader.Read()) {
                $colName = $reader['COLUMN_NAME']
                $colType = $reader['DATA_TYPE']
                $isNullable = $reader['IS_NULLABLE'] -eq 'YES'
                $colDefault = $reader['COLUMN_DEFAULT']
                $isComputed = $reader['IsComputed'] -eq 1
                $isIdentity = $reader['IsIdentity'] -eq 1
                
                # Track all columns for CSV parsing (to know CSV column positions)
                $allColumns += @{
                    Name = $colName
                    CSVIndex = $csvColumnIndex
                    IsComputed = $isComputed
                    IsIdentity = $isIdentity
                }
                $csvColumnIndex++
                
                # Only process non-computed columns for insertion (INCLUDE identity columns to preserve IDs from CSV)
                if (-not $isComputed) {
                    $columns += @{ 
                        Name = $colName
                        Type = $colType
                        IsNullable = $isNullable
                        Default = $colDefault
                        CSVIndex = $allColumns.Count - 1  # Track original CSV column position
                        IsIdentity = $isIdentity
                    }
                    
                    # Add column to DataTable with appropriate .NET type (include hierarchyid as string for INSERT method)
                    $netType = switch ($colType) {
                        'int' { [int] }
                        'bigint' { [long] }
                        'smallint' { [Int16] }
                        'tinyint' { [byte] }
                        'bit' { [bool] }
                        'decimal' { [decimal] }
                        'numeric' { [decimal] }
                        'money' { [decimal] }
                        'float' { [double] }
                        'datetime' { [datetime] }
                        'datetime2' { [datetime] }
                        'date' { [datetime] }
                        'uniqueidentifier' { [guid] }
                        'varbinary' { [byte[]] }
                        default { [string] }
                    }
                    $dataColumn = $dataTable.Columns.Add($colName, $netType)
                    $dataColumn.AllowDBNull = $isNullable
                }
            }
            $reader.Close()
            
            # Parse CSV rows into DataTable
            $rowCount = 0
            $delimiter = $config.Delimiter
            
            # Track which columns we're actually loading (all columns now, including hierarchyid)
            $loadedColumns = $columns
            
            foreach ($row in $rows) {
                if ([string]::IsNullOrWhiteSpace($row)) { continue }
                
                $values = $row -split [regex]::Escape($delimiter)
                
                # Handle leading delimiter (empty first value)
                if ($values.Count -gt 0 -and [string]::IsNullOrWhiteSpace($values[0])) {
                    $values = $values[1..($values.Count-1)]
                }
                
                # Check against total column count (CSV should have all columns including IDENTITY/computed)
                if ($values.Count -ne $allColumns.Count) { 
                    continue 
                }
                
                $dataRow = $dataTable.NewRow()
                $dataTableColIndex = 0
                
                # Process only the columns we're inserting (skip IDENTITY/computed)
                for ($i = 0; $i -lt $columns.Count; $i++) {
                    $col = $columns[$i]
                    # Use the CSVIndex to get the correct value from the CSV
                    $val = $values[$col.CSVIndex].Trim()
                    
                        # BCP with -w (Unicode) and -t delimiter may add & prefix to fields - remove it
                        if ($config.IsWideChar -and $val.StartsWith('&')) {
                            $val = $val.Substring(1).Trim()
                        
                        }
                    # Handle NULL values
                    $isNull = [string]::IsNullOrWhiteSpace($val) -or $val -in @('NULL', '\N', 'null')
                    
                    if ($isNull) {
                        if (-not $col.IsNullable) {
                            # Provide default values for non-nullable columns
                            switch ($col.Type) {
                                'bit' { $dataRow[$dataTableColIndex] = $false }
                                'int' { $dataRow[$dataTableColIndex] = 0 }
                                'bigint' { $dataRow[$dataTableColIndex] = 0 }
                                'smallint' { $dataRow[$dataTableColIndex] = 0 }
                                'tinyint' { $dataRow[$dataTableColIndex] = 0 }
                                'decimal' { $dataRow[$dataTableColIndex] = 0 }
                                'numeric' { $dataRow[$dataTableColIndex] = 0 }
                                'money' { $dataRow[$dataTableColIndex] = 0 }
                                'float' { $dataRow[$dataTableColIndex] = 0.0 }
                                { $_ -in @('datetime', 'datetime2', 'date') } { $dataRow[$dataTableColIndex] = [datetime]::new(1900, 1, 1, 0, 0, 0) }
                                'uniqueidentifier' { $dataRow[$dataTableColIndex] = [guid]::Empty }
                                default { $dataRow[$dataTableColIndex] = '' }
                            }
                        }
                        else {
                            $dataRow[$dataTableColIndex] = [DBNull]::Value
                        }
                    }
                    else {
                        try {
                            # Convert string value to appropriate type
                            switch ($col.Type) {
                                'bit' {
                                    $dataRow[$dataTableColIndex] = $val -in @('1', 'true', 'True', 'TRUE')
                                }
                                'int' {
                                    $dataRow[$dataTableColIndex] = [int]::Parse($val)
                                }
                                'bigint' {
                                    $dataRow[$dataTableColIndex] = [long]::Parse($val)
                                }
                                'smallint' {
                                    $dataRow[$dataTableColIndex] = [Int16]::Parse($val)
                                }
                                'tinyint' {
                                    $dataRow[$dataTableColIndex] = [byte]::Parse($val)
                                }
                                'decimal' {
                                    $dataRow[$dataTableColIndex] = [decimal]::Parse($val)
                                }
                                'numeric' {
                                    $dataRow[$dataTableColIndex] = [decimal]::Parse($val)
                                }
                                'money' {
                                    $dataRow[$dataTableColIndex] = [decimal]::Parse($val)
                                }
                                'float' {
                                    $dataRow[$dataTableColIndex] = [double]::Parse($val)
                                }
                                'datetime' {
                                    # Handle extra fractional seconds (truncate to 3 digits for SQL Server datetime)
                                    if ($val -match '\.(\d{4,})') {
                                        $truncated = $val -replace '\.(\d{3})\d+', '.$1'
                                        $dataRow[$dataTableColIndex] = [datetime]::Parse($truncated)
                                    }
                                    else {
                                        try {
                                            $dataRow[$dataTableColIndex] = [datetime]::Parse($val)
                                        }
                                        catch {
                                            Write-Warning "Failed to parse datetime for column '$($col.Name)': Value=[$val], Length=$($val.Length), Chars=$([string]::Join(',', [char[]]$val))"
                                            throw
                                        }
                                    }
                                }
                                'datetime2' {
                                    # Handle extra fractional seconds (truncate to 7 digits for SQL Server)
                                    if ($val -match '\.(\d{8,})') {
                                        $truncated = $val -replace '\.(\d{7})\d+', '.$1'
                                        $dataRow[$dataTableColIndex] = [datetime]::Parse($truncated)
                                    }
                                    else {
                                        $dataRow[$dataTableColIndex] = [datetime]::Parse($val)
                                    }
                                }
                                'date' {
                                    $dataRow[$dataTableColIndex] = [datetime]::Parse($val)
                                }
                                'uniqueidentifier' {
                                    $dataRow[$dataTableColIndex] = [guid]::Parse($val)
                                }
                                'varbinary' {
                                    # Check if this column is base64-encoded (for embeddings from GraphQL API)
                                    if ($config.Base64Columns -and $col.Name -in $config.Base64Columns) {
                                        # Decode base64 string to byte array
                                        if ([string]::IsNullOrWhiteSpace($val)) {
                                            $dataRow[$dataTableColIndex] = [System.DBNull]::Value
                                        } else {
                                            $bytes = [Convert]::FromBase64String($val)
                                            $dataRow[$dataTableColIndex] = $bytes
                                        }
                                    }
                                    # Check if this column is hex-encoded (for large binary data exported via CONVERT)
                                    elseif ($config.HexColumns -and $col.Name -in $config.HexColumns) {
                                        # Decode hex string to byte array using helper function
                                        $bytes = Convert-HexStringToByteArray -HexString $val
                                        $dataRow[$dataTableColIndex] = $bytes
                                    }
                                    else {
                                        # Convert hex string to byte array (original logic for inline hex)
                                        $byteArray = New-Object byte[] ($val.Length / 2)
                                        for ($j = 0; $j -lt $val.Length; $j += 2) {
                                            $byteArray[$j / 2] = [Convert]::ToByte($val.Substring($j, 2), 16)
                                        }
                                        $dataRow[$dataTableColIndex] = $byteArray
                                    }
                                }
                                'vector' {
                                    # VECTOR columns contain JSON arrays of floats
                                    # Format: "[0.1,0.2,0.3,...]"
                                    if ([string]::IsNullOrWhiteSpace($val)) {
                                        $dataRow[$dataTableColIndex] = [System.DBNull]::Value
                                    } else {
                                        # Store as string - will use CAST(@Json AS VECTOR(1536)) in INSERT
                                        $dataRow[$dataTableColIndex] = $val
                                    }
                                }
                                'hierarchyid' {
                                    # Check if this column is hex-encoded (BCP export with CONVERT style 1)
                                    if ($config.HexColumns -and $col.Name -in $config.HexColumns) {
                                        # Keep hex string for INSERT method (will use CONVERT or direct hex)
                                        $dataRow[$dataTableColIndex] = $val
                                    }
                                    else {
                                        # Store as string for INSERT method (will use hierarchyid::Parse())
                                        $dataRow[$dataTableColIndex] = $val
                                    }
                                }
                                'geography' {
                                    # Store hex string as-is for INSERT method (will use geography::STGeomFromWKB())
                                    $dataRow[$dataTableColIndex] = $val
                                }
                                'geometry' {
                                    # Store hex string as-is for INSERT method (will use geometry::STGeomFromWKB())
                                    $dataRow[$dataTableColIndex] = $val
                                }
                                default {
                                    # Check if this column is hex-encoded (for multi-line text fields)
                                    if ($config.HexColumns -and $col.Name -in $config.HexColumns) {
                                        # Decode hex string back to Unicode text
                                        $bytes = Convert-HexStringToByteArray -HexString $val
                                        $decodedValue = [System.Text.Encoding]::Unicode.GetString($bytes)
                                        $dataRow[$dataTableColIndex] = $decodedValue
                                    }
                                    else {
                                        $dataRow[$dataTableColIndex] = $val
                                    }
                                }
                            }
                        }
                        catch {
                            # If conversion fails, use default or NULL
                            if (-not $col.IsNullable) {
                                switch ($col.Type) {
                                    'bit' { $dataRow[$dataTableColIndex] = $false }
                                    { $_ -in @('int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'money', 'float') } {
                                        $dataRow[$dataTableColIndex] = 0
                                    }
                                    { $_ -in @('datetime', 'datetime2', 'date') } { $dataRow[$dataTableColIndex] = [datetime]::new(1900, 1, 1, 0, 0, 0) }
                                    'uniqueidentifier' { $dataRow[$dataTableColIndex] = [guid]::Empty }
                                    'varbinary' { $dataRow[$dataTableColIndex] = [byte[]]::new(0) }
                                    default { $dataRow[$dataTableColIndex] = '' }
                                }
                            }
                            else {
                                $dataRow[$dataTableColIndex] = [DBNull]::Value
                            }
                        }
                    }
                    
                    $dataTableColIndex++
                }
                $dataTable.Rows.Add($dataRow)
                $rowCount++
                
                if ($rowCount % 5000 -eq 0) {
                    Write-Output "    ...parsed $rowCount rows"
                }
            }
            
            # Check if any column is an IDENTITY column (need to enable IDENTITY_INSERT)
            $hasIdentityColumn = $columns | Where-Object { $_.IsIdentity } | Measure-Object | Select-Object -ExpandProperty Count
            $hasIdentityColumn = $hasIdentityColumn -gt 0
            
            # Use different insert method depending on whether table has special columns, hex encoding, or identity columns
            # SqlBulkCopy does NOT support IDENTITY_INSERT, so we must use batched INSERT for identity columns
            if ($hasSpecialColumns -or $hasIdentityColumn) {
                # Use batched INSERT statements for special tables (hierarchyid, geography, hex-encoded columns)
                Write-Output "    Inserting $rowCount rows using batched INSERT (special columns)..."
                
                $batchSize = 100
                $insertedRows = 0
                $skippedRows = 0
                $transaction = $conn.BeginTransaction()
                
                # Enable IDENTITY_INSERT if needed
                if ($hasIdentityColumn) {
                    $cmd.Transaction = $transaction
                    $cmd.CommandText = "SET IDENTITY_INSERT [$schemaName].[$tableName] ON"
                    $cmd.ExecuteNonQuery() | Out-Null
                    Write-Output "    Enabled IDENTITY_INSERT for table with identity column"
                }
                
                # Get primary key or unique constraint columns for idempotent inserts
                $cmd.Transaction = $transaction
                $cmd.CommandText = @"
SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = '$schemaName' AND TABLE_NAME = '$tableName'
AND CONSTRAINT_NAME LIKE 'PK_%' OR CONSTRAINT_NAME LIKE 'AK_%'
ORDER BY ORDINAL_POSITION
"@
                $pkReader = $cmd.ExecuteReader()
                $pkColumns = @()
                while ($pkReader.Read()) {
                    $pkColumns += $pkReader['COLUMN_NAME']
                }
                $pkReader.Close()
                
                try {
                    for ($batchStart = 0; $batchStart -lt $dataTable.Rows.Count; $batchStart += $batchSize) {
                        $batchEnd = [Math]::Min($batchStart + $batchSize, $dataTable.Rows.Count)
                        
                        # Build INSERT statement for this batch - use MERGE for AI CSV files to avoid duplicates
                        $columnList = ($loadedColumns | ForEach-Object { "[$($_.Name)]" }) -join ', '
                        
                        # For AI CSV files with duplicates, use individual INSERT IF NOT EXISTS
                        if ($isAiCsv -and $pkColumns.Count -gt 0) {
                            for ($r = $batchStart; $r -lt $batchEnd; $r++) {
                                $row = $dataTable.Rows[$r]
                                $values = @()
                                
                                # Build WHERE clause for existence check using primary/unique key
                                $whereConditions = @()
                                foreach ($pkCol in $pkColumns) {
                                    $colIndex = ($loadedColumns | Where-Object { $_.Name -eq $pkCol }).CSVIndex
                                    if ($null -ne $colIndex) {
                                        $pkValue = $row[$loadedColumns.IndexOf(($loadedColumns | Where-Object { $_.Name -eq $pkCol }))]
                                        $col = $loadedColumns | Where-Object { $_.Name -eq $pkCol }
                                        
                                        if ($pkValue -is [DBNull] -or $null -eq $pkValue) {
                                            $whereConditions += "[$pkCol] IS NULL"
                                        }
                                        elseif ($col.Type -in @('varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'uniqueidentifier')) {
                                            $escapedVal = $pkValue.ToString().Replace("'", "''")
                                            $whereConditions += "[$pkCol] = N'$escapedVal'"
                                        }
                                        else {
                                            $whereConditions += "[$pkCol] = $($pkValue.ToString())"
                                        }
                                    }
                                }
                                
                                $whereClause = $whereConditions -join ' AND '
                                
                                # Build values for INSERT
                                for ($c = 0; $c -lt $loadedColumns.Count; $c++) {
                                    $col = $loadedColumns[$c]
                                    $value = $row[$c]
                                    
                                    if ($value -is [DBNull] -or $null -eq $value) {
                                        $values += "NULL"
                                    }
                                    elseif ($col.Type -eq 'hierarchyid') {
                                        $values += "CAST(0x$($value.ToString()) AS hierarchyid)"
                                    }
                                    elseif ($col.Type -eq 'geography') {
                                        $values += "CAST(0x$($value.ToString()) AS geography)"
                                    }
                                    elseif ($col.Type -eq 'geometry') {
                                        $values += "CAST(0x$($value.ToString()) AS geometry)"
                                    }
                                    elseif ($col.Type -eq 'varbinary') {
                                        $hexStr = ($value | ForEach-Object { $_.ToString('X2') }) -join ''
                                        $values += "0x$hexStr"
                                    }
                                    elseif ($col.Type -in @('varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'uniqueidentifier', 'xml')) {
                                        $escapedVal = $value.ToString().Replace("'", "''")
                                        $values += "N'$escapedVal'"
                                    }
                                    elseif ($col.Type -eq 'bit') {
                                        $values += if ($value) { '1' } else { '0' }
                                    }
                                    elseif ($col.Type -in @('datetime', 'datetime2', 'date', 'time', 'datetimeoffset')) {
                                        if ($col.Type -eq 'date') {
                                            $dateStr = ([datetime]$value).ToString('yyyy-MM-dd')
                                        }
                                        elseif ($col.Type -eq 'datetime') {
                                            $dateStr = ([datetime]$value).ToString('yyyy-MM-dd HH:mm:ss.fff')
                                        }
                                        else {
                                            $dateStr = ([datetime]$value).ToString('yyyy-MM-dd HH:mm:ss.fffffff')
                                        }
                                        $values += "'$dateStr'"
                                    }
                                    else {
                                        $values += $value.ToString()
                                    }
                                }
                                
                                $insertSql = @"
IF NOT EXISTS (SELECT 1 FROM [$schemaName].[$tableName] WHERE $whereClause)
BEGIN
    INSERT INTO [$schemaName].[$tableName] ($columnList) VALUES ($(($values -join ', ')))
END
"@
                                
                                $cmd.Transaction = $transaction
                                $cmd.CommandText = $insertSql
                                try {
                                    $affected = $cmd.ExecuteNonQuery()
                                    if ($affected -gt 0) {
                                        $insertedRows++
                                    } else {
                                        $skippedRows++
                                    }
                                }
                                catch {
                                    # If we still get duplicate errors, just skip this row
                                    $skippedRows++
                                }
                                
                                if (($insertedRows + $skippedRows) % 100 -eq 0) {
                                    Write-Output "    ...processed $($insertedRows + $skippedRows) rows ($insertedRows inserted, $skippedRows skipped)"
                                }
                            }
                        }
                        else {
                            # Original batch insert logic for non-AI CSV files
                            $insertSql = "INSERT INTO [$schemaName].[$tableName] ($columnList) VALUES "
                            
                            $valuesClauses = @()
                            for ($r = $batchStart; $r -lt $batchEnd; $r++) {
                                $row = $dataTable.Rows[$r]
                                $values = @()
                            
                            for ($c = 0; $c -lt $loadedColumns.Count; $c++) {
                                $col = $loadedColumns[$c]
                                $value = $row[$c]
                                
                                if ($value -is [DBNull] -or $null -eq $value) {
                                    $values += "NULL"
                                }
                                elseif ($col.Type -eq 'hierarchyid') {
                                    # hierarchyid in CSV is hex-encoded binary, convert to binary format
                                    # Format: CAST(0x6AC0 AS hierarchyid)
                                    $values += "CAST(0x$($value.ToString()) AS hierarchyid)"
                                }
                                elseif ($col.Type -eq 'geography') {
                                    # geography in CSV is hex-encoded in SQL Server's internal format
                                    # Use direct CAST from varbinary to geography
                                    $values += "CAST(0x$($value.ToString()) AS geography)"
                                }
                                elseif ($col.Type -eq 'geometry') {
                                    # geometry in CSV is hex-encoded in SQL Server's internal format
                                    # Use direct CAST from varbinary to geometry
                                    $values += "CAST(0x$($value.ToString()) AS geometry)"
                                }
                                elseif ($col.Type -eq 'varbinary') {
                                    # Convert byte array to hex string with 0x prefix
                                    $hexStr = ($value | ForEach-Object { $_.ToString('X2') }) -join ''
                                    $values += "0x$hexStr"
                                }
                                elseif ($col.Type -in @('varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'uniqueidentifier', 'xml')) {
                                    # Escape single quotes
                                    $escapedVal = $value.ToString().Replace("'", "''")
                                    $values += "N'$escapedVal'"
                                }
                                elseif ($col.Type -eq 'bit') {
                                    $values += if ($value) { '1' } else { '0' }
                                }
                                elseif ($col.Type -in @('datetime', 'datetime2', 'date', 'time', 'datetimeoffset')) {
                                    # Format datetime based on column type precision
                                    if ($col.Type -eq 'date') {
                                        $dateStr = ([datetime]$value).ToString('yyyy-MM-dd')
                                    }
                                    elseif ($col.Type -eq 'datetime') {
                                        # datetime has 3 digit precision (milliseconds)
                                        $dateStr = ([datetime]$value).ToString('yyyy-MM-dd HH:mm:ss.fff')
                                    }
                                    else {
                                        # datetime2, time, datetimeoffset have 7 digit precision
                                        $dateStr = ([datetime]$value).ToString('yyyy-MM-dd HH:mm:ss.fffffff')
                                    }
                                    $values += "'$dateStr'"
                                }
                                else {
                                    # Numeric types
                                    $values += $value.ToString()
                                }
                            }
                            
                            $valuesClauses += "(" + ($values -join ', ') + ")"
                        }
                        
                        $insertSql += ($valuesClauses -join ",`n")
                        
                        $cmd.Transaction = $transaction
                        $cmd.CommandText = $insertSql
                        $cmd.ExecuteNonQuery() | Out-Null
                        
                        $insertedRows += ($batchEnd - $batchStart)
                        
                        if ($insertedRows % 500 -eq 0) {
                            Write-Output "    ...inserted $insertedRows rows"
                        }
                        }
                    }
                    
                    # Disable IDENTITY_INSERT if it was enabled
                    if ($hasIdentityColumn) {
                        $cmd.CommandText = "SET IDENTITY_INSERT [$schemaName].[$tableName] OFF"
                        $cmd.ExecuteNonQuery() | Out-Null
                    }
                    
                    $transaction.Commit()
                    if ($skippedRows -gt 0) {
                        Write-Output "    Successfully loaded $insertedRows rows ($skippedRows duplicates skipped)"
                    } else {
                        Write-Output "    Successfully loaded $insertedRows rows"
                    }
                    $csvLoadSuccess++
                }
                catch {
                    $transaction.Rollback()
                    throw
                }
                finally {
                    $cmd.Transaction = $null
                }
            }
            else {
                # Use SqlBulkCopy for fast insert (tables without special columns or identity columns)
                Write-Output "    Bulk inserting $rowCount rows..."
                
                $bulkCopy = New-Object System.Data.SqlClient.SqlBulkCopy($conn)
                $bulkCopy.DestinationTableName = "[$schemaName].[$tableName]"
                $bulkCopy.BatchSize = 5000
                $bulkCopy.BulkCopyTimeout = 300
                
                # Map columns
                foreach ($col in $loadedColumns) {
                    $null = $bulkCopy.ColumnMappings.Add($col.Name, $col.Name)
                }
                
                $bulkCopy.WriteToServer($dataTable)
                $bulkCopy.Close()
                
                Write-Output "    Successfully loaded $rowCount rows"
                $csvLoadSuccess++
            }
        }
        catch {
            Write-Warning "    Failed to load $($config.File): $($_.Exception.Message)"
            $csvLoadFailed++
        }
    }
    
    Write-Output "`nCSV Data Loading Summary:"
    Write-Output "  - $csvLoadSuccess tables loaded successfully"
    Write-Output "  - $csvLoadFailed tables failed to load"
    Write-Output "  - $csvLoadSkipped tables skipped"
    
    # Upload AI-generated PNG images from images directory
    Write-Output "`nUploading AI-generated PNG images..."
    
    # Check if AI photos already uploaded (idempotency check)
    # Base AdventureWorks data uses ProductPhotoIDs 1-100, AI photos use IDs > 100
    $cmd.CommandText = "SELECT COUNT(*) FROM Production.ProductPhoto WHERE ProductPhotoID > 100"
    $aiPhotoCount = $cmd.ExecuteScalar()
    
    if ($aiPhotoCount -gt 0) {
        Write-Output "  AI-generated photos already uploaded ($aiPhotoCount AI photos found) - Skipping"
    }
    else {
        $imagesDir = Join-Path $PSScriptRoot ".." "images"
        
        if (Test-Path $imagesDir) {
            $pngFiles = Get-ChildItem -Path $imagesDir -Filter "*.png" | Sort-Object Name
            $totalPngFiles = $pngFiles.Count
            
            if ($totalPngFiles -gt 0) {
                Write-Output "  Found $totalPngFiles PNG files to upload"
                
                $uploadedCount = 0
                $skippedCount = 0
                $failedCount = 0
                $currentFile = 0
                
                # Start ProductPhotoID at 1000 to match AI-generated photo range
                $nextPhotoId = 1000
            
            foreach ($pngFile in $pngFiles) {
                $currentFile++
                $fileName = $pngFile.Name
                
                try {
                    # Read image bytes
                    $imageBytes = [System.IO.File]::ReadAllBytes($pngFile.FullName)
                    
                    # Determine if this is a thumbnail or large image
                    $isThumbnail = $fileName -like "*_thumb.png" -or $fileName -like "*_small.png"
                    
                    if ($isThumbnail) {
                        # Extract the base filename to find corresponding large image
                        $baseFileName = $fileName -replace '_thumb\.png$', '.png' -replace '_small\.png$', '.png'
                        $largeImagePath = Join-Path $imagesDir $baseFileName
                        
                        if (Test-Path $largeImagePath) {
                            # Read large image
                            $largeImageBytes = [System.IO.File]::ReadAllBytes($largeImagePath)
                            
                            # Check if this ProductPhotoID already exists (idempotency)
                            $checkCmd = $conn.CreateCommand()
                            $checkCmd.CommandText = "SELECT COUNT(*) FROM Production.ProductPhoto WHERE ProductPhotoID = @PhotoID"
                            $checkCmd.Parameters.AddWithValue("@PhotoID", $nextPhotoId) | Out-Null
                            $exists = [int]$checkCmd.ExecuteScalar()
                            
                            if ($exists -eq 0) {
                                # Insert with both thumbnail and large image
                                $cmd = $conn.CreateCommand()
                                $cmd.CommandText = @"
SET IDENTITY_INSERT Production.ProductPhoto ON;
INSERT INTO Production.ProductPhoto 
    (ProductPhotoID, ThumbNailPhoto, ThumbnailPhotoFileName, LargePhoto, LargePhotoFileName, ModifiedDate)
VALUES 
    (@PhotoID, @ThumbBytes, @ThumbFileName, @LargeBytes, @LargeFileName, GETDATE());
SET IDENTITY_INSERT Production.ProductPhoto OFF;
"@
                                $cmd.Parameters.AddWithValue("@PhotoID", $nextPhotoId) | Out-Null
                                $cmd.Parameters.Add("@ThumbBytes", [System.Data.SqlDbType]::VarBinary, $imageBytes.Length).Value = $imageBytes
                                $cmd.Parameters.AddWithValue("@ThumbFileName", $fileName) | Out-Null
                                $cmd.Parameters.Add("@LargeBytes", [System.Data.SqlDbType]::VarBinary, $largeImageBytes.Length).Value = $largeImageBytes
                                $cmd.Parameters.AddWithValue("@LargeFileName", $baseFileName) | Out-Null
                                
                                $cmd.ExecuteNonQuery() | Out-Null
                                $uploadedCount++
                            }
                            else {
                                $skippedCount++
                            }
                            $nextPhotoId++
                            
                            if ($currentFile % 50 -eq 0) {
                                Write-Output "    ...uploaded $currentFile of $totalPngFiles images"
                            }
                        }
                        else {
                            Write-Warning "    [$currentFile/$totalPngFiles] Skipping $fileName - no corresponding large image found"
                            $skippedCount++
                        }
                    }
                    else {
                        # Skip large images - they're processed with their thumbnails
                        $skippedCount++
                    }
                }
                catch {
                    Write-Warning "    [$currentFile/$totalPngFiles] Failed to upload $fileName : $($_.Exception.Message)"
                    $failedCount++
                }
            }
            
            Write-Output "`nPNG Upload Summary:"
            Write-Output "  - $uploadedCount image pairs uploaded successfully"
            Write-Output "  - $skippedCount files skipped"
            Write-Output "  - $failedCount files failed"
        }
        else {
            Write-Output "  No PNG files found in images directory"
        }
    }
    else {
        Write-Output "  Images directory not found: $imagesDir"
    }
    }  # End idempotency check for AI photos
    
    # Now load ProductProductPhoto-ai.csv to link photos to products
    Write-Output "`nLoading AI-generated photo mappings..."
    $csvFolder = Join-Path $PSScriptRoot 'sql'
    $photoMappingFile = Join-Path $csvFolder "ProductProductPhoto-ai.csv"
    if (Test-Path $photoMappingFile) {
        try {
            $mappingData = Import-Csv -Path $photoMappingFile -Delimiter "`t" -Header @('ProductID', 'ProductPhotoID', 'Primary', 'ModifiedDate')
            $mappingCount = $mappingData.Count
            Write-Output "  Loading $mappingCount photo mappings..."
            
            $mappingInserted = 0
            $mappingSkipped = 0
            
            foreach ($mapping in $mappingData) {
                # Check if this mapping already exists (idempotency)
                $checkCmd = $conn.CreateCommand()
                $checkCmd.CommandText = "SELECT COUNT(*) FROM Production.ProductProductPhoto WHERE ProductID = @ProductID AND ProductPhotoID = @ProductPhotoID"
                $checkCmd.Parameters.AddWithValue("@ProductID", [int]$mapping.ProductID) | Out-Null
                $checkCmd.Parameters.AddWithValue("@ProductPhotoID", [int]$mapping.ProductPhotoID) | Out-Null
                $exists = [int]$checkCmd.ExecuteScalar()
                
                if ($exists -eq 0) {
                    $cmd = $conn.CreateCommand()
                    $cmd.CommandText = @"
INSERT INTO Production.ProductProductPhoto 
    (ProductID, ProductPhotoID, [Primary], ModifiedDate)
VALUES 
    (@ProductID, @ProductPhotoID, @Primary, @ModifiedDate)
"@
                    $cmd.Parameters.AddWithValue("@ProductID", [int]$mapping.ProductID) | Out-Null
                    $cmd.Parameters.AddWithValue("@ProductPhotoID", [int]$mapping.ProductPhotoID) | Out-Null
                    $cmd.Parameters.AddWithValue("@Primary", [int]$mapping.Primary) | Out-Null
                    $cmd.Parameters.AddWithValue("@ModifiedDate", [datetime]$mapping.ModifiedDate) | Out-Null
                    
                    $cmd.ExecuteNonQuery() | Out-Null
                    $mappingInserted++
                }
                else {
                    $mappingSkipped++
                }
            }
            
            Write-Output "  Successfully loaded $mappingInserted photo mappings ($mappingSkipped already existed)"
        }
        catch {
            Write-Warning "  Failed to load photo mappings: $($_.Exception.Message)"
        }
    }
    else {
        Write-Output "  ProductProductPhoto-ai.csv not found - skipping photo mappings"
    }
    
    $conn.Close()
}
catch {
    Write-Error "Failed to execute T-SQL for managed identity via ADO.NET: $($_.Exception.Message)"
    exit 1
}

# Set WEBSITE_HOSTNAME for Azure Functions Durable Functions
Write-Output "`nConfiguring WEBSITE_HOSTNAME for Azure Functions..."
$functionsAppName = (azd env get-value 'SERVICE_API_FUNCTIONS_NAME' 2>$null).Trim()

if ($functionsAppName -and $functionsAppName -ne "ERROR: key 'SERVICE_API_FUNCTIONS_NAME' not found in the environment values") {
    try {
        Write-Output "Retrieving FQDN for Functions container app: $functionsAppName"
        
        # Get the container app FQDN using Azure CLI
        $fqdn = az containerapp show `
            --name $functionsAppName `
            --resource-group $resourceGroupName `
            --query "properties.configuration.ingress.fqdn" `
            --output tsv 2>$null
        
        if ($fqdn -and $fqdn -ne '') {
            $websiteHostname = "https://$fqdn"
            Write-Output "Setting WEBSITE_HOSTNAME to: $websiteHostname"
            
            # Update the container app environment variables
            az containerapp update `
                --name $functionsAppName `
                --resource-group $resourceGroupName `
                --set-env-vars "WEBSITE_HOSTNAME=$websiteHostname" `
                --output none 2>$null
            
            if ($LASTEXITCODE -eq 0) {
                Write-Output "Successfully set WEBSITE_HOSTNAME for $functionsAppName"
            } else {
                Write-Warning "Failed to set WEBSITE_HOSTNAME. Exit code: $LASTEXITCODE"
            }
        } else {
            Write-Warning "Could not retrieve FQDN for Functions container app $functionsAppName"
        }
    }
    catch {
        Write-Warning "Error configuring WEBSITE_HOSTNAME: $($_.Exception.Message)"
    }
} else {
    Write-Warning "SERVICE_API_FUNCTIONS_NAME not found in environment. Skipping WEBSITE_HOSTNAME configuration."
}

# Set VITE_API_URL for Static Web App build
$apiUrl = (azd env get-value 'API_URL' 2>$null).Trim()
if ($apiUrl) {
    Write-Output "`nSetting VITE_API_URL for Static Web App build: $apiUrl"
    azd env set 'VITE_API_URL' $apiUrl
} else {
    Write-Warning "API_URL not found in environment. VITE_API_URL will not be set."
}

# Set VITE_API_FUNCTIONS_URL for Static Web App build
$apiFunctionsUrl = (azd env get-value 'API_FUNCTIONS_URL' 2>$null).Trim()
if ($apiFunctionsUrl) {
    Write-Output "`nSetting VITE_API_FUNCTIONS_URL for Static Web App build: $apiFunctionsUrl"
    azd env set 'VITE_API_FUNCTIONS_URL' $apiFunctionsUrl
} else {
    Write-Warning "API_FUNCTIONS_URL not found in environment. VITE_API_FUNCTIONS_URL will not be set."
}

## ---------------------------------------------------------------------------
## AI Agent Configuration (Manual Setup Required)
## ---------------------------------------------------------------------------
Write-Output "`n=========================================="
Write-Output "AI Agent MCP Server Configuration"
Write-Output "=========================================="

# Get required values for agent configuration
$openAiEndpoint = (azd env get-value 'AZURE_OPENAI_ENDPOINT' 2>$null)
if ($openAiEndpoint) {
    $openAiEndpoint = $openAiEndpoint.Trim()
    # Check if it's an error message
    if ($openAiEndpoint -like '*ERROR:*') {
        $openAiEndpoint = $null
    }
}

$chatModelName = (azd env get-value 'chatGptModelName' 2>$null)
if ($chatModelName) {
    $chatModelName = $chatModelName.Trim()
    if ($chatModelName -like '*ERROR:*') {
        $chatModelName = $null
    }
}

$mcpServerUrl = $apiFunctionsUrl

# If endpoint not found, try to construct from account name
if (-not $openAiEndpoint) {
    $openAiAccountName = (azd env get-value 'AZURE_OPENAI_ACCOUNT_NAME' 2>$null)
    if ($openAiAccountName) {
        $openAiAccountName = $openAiAccountName.Trim()
        if ($openAiAccountName -and $openAiAccountName -notlike '*ERROR:*') {
            $openAiEndpoint = "https://$openAiAccountName.cognitiveservices.azure.com/"
            azd env set 'AZURE_OPENAI_ENDPOINT' $openAiEndpoint
        }
    }
}

if ($openAiEndpoint -and $chatModelName -and $mcpServerUrl) {
    Write-Output "`n✅ MCP Server deployed successfully!"
    Write-Output "   AI Foundry Endpoint: $openAiEndpoint"
    Write-Output "   Model Deployment: $chatModelName"
    Write-Output "   MCP Server URL: $mcpServerUrl"
    
    # Save configuration values to azd environment (only if valid)
    azd env set 'AI_AGENT_MCP_ENDPOINT' "$mcpServerUrl/api/mcp"
    azd env set 'AI_AGENT_MODEL' $chatModelName
    if ($openAiEndpoint -notlike '*ERROR:*') {
        azd env set 'AI_AGENT_OPENAI_ENDPOINT' $openAiEndpoint
    }
    
    Write-Output "`n📋 MCP Server Tools Available:"
    Write-Output "   - get_customer_orders: Retrieve customer order history"
    Write-Output "   - get_order_details: Get detailed order information"
    Write-Output "   - search_products: Search product catalog"
    Write-Output "   - get_product_details: Get product specifications"
    Write-Output "   - find_complementary_products: Find related products"
    
    Write-Output "`n📖 To test the AI Agent with the MCP Server:"
    Write-Output "   1. Install Python dependencies: pip install agent-framework-azure-ai --pre"
    Write-Output "   2. Run the test script: python3 test_agent.py"
    Write-Output "   3. See api-functions/MCP_SERVER.md for integration examples"
    
} else {
    Write-Warning "Missing required configuration for AI Agent:"
    if (-not $openAiEndpoint) { Write-Warning "  - AZURE_OPENAI_ENDPOINT not set" }
    if (-not $chatModelName) { Write-Warning "  - chatGptModelName not set" }
    if (-not $mcpServerUrl) { Write-Warning "  - MCP Server URL (API_FUNCTIONS_URL) not set" }
    Write-Output "`nRefer to api-functions/MCP_SERVER.md for manual setup instructions"
}
# Grant current user Contributor role on Container Apps Environment for Aspire Dashboard access
Write-Output "`n========================================="
Write-Output "Configuring Aspire Dashboard Access"
Write-Output "========================================="

$containerAppEnvName = (azd env get-value 'CONTAINER_APP_ENVIRONMENT_NAME' 2>$null).Trim()
if ($containerAppEnvName -and $containerAppEnvName -ne "ERROR: key 'CONTAINER_APP_ENVIRONMENT_NAME' not found in the environment values") {
    try {
        # Get current user's object ID
        $currentContext = Get-AzContext
        $currentUserId = $currentContext.Account.Id
        
        Write-Output "Assigning Contributor role to $currentUserId on Container Apps Environment '$containerAppEnvName'..."
        
        # Assign Contributor role to the current user on the Container Apps Environment
        $roleAssignment = New-AzRoleAssignment `
            -ObjectId $currentContext.Account.ExtendedProperties.HomeAccountId.Split('.')[0] `
            -RoleDefinitionName "Contributor" `
            -ResourceGroupName $resourceGroupName `
            -ResourceType "Microsoft.App/managedEnvironments" `
            -ResourceName $containerAppEnvName `
            -ErrorAction SilentlyContinue
        
        if ($roleAssignment) {
            Write-Output "✅ Contributor role assigned successfully"
            Write-Output "   You can now access the Aspire Dashboard at:"
            Write-Output "   https://aspire-dashboard.ext.$($containerAppEnvName -replace 'av-env-', '').azurecontainerapps.io/"
        } else {
            Write-Warning "Role assignment may have already existed or requires manual intervention"
            Write-Output "   If you get authentication errors accessing the Aspire Dashboard:"
            Write-Output "   1. Go to Azure Portal → Container Apps Environment: $containerAppEnvName"
            Write-Output "   2. Select 'Access Control (IAM)'"
            Write-Output "   3. Add role assignment: Contributor to your user account"
        }
    }
    catch {
        Write-Warning "Failed to assign Contributor role: $($_.Exception.Message)"
        Write-Output "`n   Manual steps to fix Aspire Dashboard authentication:"
        Write-Output "   1. Go to Azure Portal → Container Apps Environment: $containerAppEnvName"
        Write-Output "   2. Select 'Access Control (IAM)'"
        Write-Output "   3. Click 'Add' → 'Add role assignment'"
        Write-Output "   4. Select role: Contributor"
        Write-Output "   5. Assign to your user account: $currentUserId"
    }
} else {
    Write-Warning "CONTAINER_APP_ENVIRONMENT_NAME not found in environment. Skipping Aspire Dashboard access configuration."
    Write-Output "   You may need to manually assign Contributor role on the Container Apps Environment to access the Aspire Dashboard."
}
Write-Output "`n=========================================="
Write-Output "Post-provision script completed"
Write-Output "=========================================="
