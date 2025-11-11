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
        
        # ===== ADDITIONAL LOOKUP TABLES =====
        @{ Table='Sales.CountryRegionCurrency'; File='CountryRegionCurrency.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Sales.SalesTaxRate'; File='SalesTaxRate.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ScrapReason'; File='ScrapReason.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='dbo.AWBuildVersion'; File='AWBuildVersion.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        
        # ===== HUMAN RESOURCES =====
        @{ Table='HumanResources.Department'; File='Department.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='HumanResources.Shift'; File='Shift.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='HumanResources.EmployeeDepartmentHistory'; File='EmployeeDepartmentHistory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='HumanResources.EmployeePayHistory'; File='EmployeePayHistory.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='HumanResources.JobCandidate'; File='JobCandidate.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        
        # ===== PERSON CONTACTS =====
        @{ Table='Person.BusinessEntityContact'; File='BusinessEntityContact.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        
        # ===== PURCHASING =====
        @{ Table='Purchasing.Vendor'; File='Vendor.csv'; Delimiter="+|"; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Purchasing.ProductVendor'; File='ProductVendor.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Purchasing.PurchaseOrderHeader'; File='PurchaseOrderHeader.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Purchasing.PurchaseOrderDetail'; File='PurchaseOrderDetail.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        
        # ===== PRODUCTION =====
        @{ Table='Production.BillOfMaterials'; File='BillOfMaterials.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.Document'; File='Document.csv'; Delimiter='+|'; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Production.ProductDocument'; File='ProductDocument.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductPhoto'; File='ProductPhoto.csv'; Delimiter="+|"; RowTerminator='&|'; IsWideChar=$true }
        @{ Table='Production.ProductProductPhoto'; File='ProductProductPhoto.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
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
            
            if ($existingCount -gt 0) {
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
                $rows = $csvContent -split '&\|\r?\n'
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
            
            # Check if this table has required UDT/binary columns that we can't load
            $cmd.CommandText = @"
SELECT COUNT(*) 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = '$schemaName' AND TABLE_NAME = '$tableName'
AND IS_NULLABLE = 'NO'
AND DATA_TYPE IN ('hierarchyid', 'geography', 'varbinary', 'image')
"@
            $hasRequiredUdtColumns = ($cmd.ExecuteScalar() -gt 0)
            
            if ($hasRequiredUdtColumns) {
                Write-Output "    Table has required UDT/binary columns that cannot be loaded from CSV - Skipping"
                $csvLoadSkipped++
                continue
            }
            
            # Get column schema from database including nullable information
            $cmd.CommandText = @"
SELECT 
    c.COLUMN_NAME, 
    c.DATA_TYPE, 
    c.ORDINAL_POSITION,
    c.IS_NULLABLE,
    c.COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS c
WHERE c.TABLE_SCHEMA = '$schemaName' AND c.TABLE_NAME = '$tableName'
AND COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsComputed') = 0
ORDER BY c.ORDINAL_POSITION
"@
            $reader = $cmd.ExecuteReader()
            $columns = @()
            while ($reader.Read()) {
                $colName = $reader['COLUMN_NAME']
                $colType = $reader['DATA_TYPE']
                $isNullable = $reader['IS_NULLABLE'] -eq 'YES'
                $colDefault = $reader['COLUMN_DEFAULT']
                
                $columns += @{ 
                    Name = $colName
                    Type = $colType
                    IsNullable = $isNullable
                    Default = $colDefault
                }
                
                # Skip UDT and binary columns that can't be bulk copied from CSV easily
                if ($colType -in @('geography', 'hierarchyid', 'varbinary', 'image')) {
                    continue
                }
                
                # Add column to DataTable with appropriate .NET type
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
                    default { [string] }
                }
                $dataColumn = $dataTable.Columns.Add($colName, $netType)
                $dataColumn.AllowDBNull = $isNullable
            }
            $reader.Close()
            
            # Parse CSV rows into DataTable
            $rowCount = 0
            $delimiter = $config.Delimiter
            
            # Track which columns we're actually loading (excluding skipped UDT/binary columns)
            $loadedColumns = $columns | Where-Object { $_.Type -notin @('geography', 'hierarchyid', 'varbinary', 'image') }
            
            foreach ($row in $rows) {
                if ([string]::IsNullOrWhiteSpace($row)) { continue }
                
                $values = $row -split [regex]::Escape($delimiter)
                if ($values.Count -ne $columns.Count) { continue }
                
                $dataRow = $dataTable.NewRow()
                $dataTableColIndex = 0
                
                for ($i = 0; $i -lt $columns.Count; $i++) {
                    $col = $columns[$i]
                    $val = $values[$i].Trim()
                    
                    # Skip columns we didn't add to DataTable (UDT/binary types)
                    if ($col.Type -in @('geography', 'hierarchyid', 'varbinary', 'image')) {
                        continue
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
                                    $dataRow[$dataTableColIndex] = [datetime]::Parse($val)
                                }
                                'datetime2' {
                                    $dataRow[$dataTableColIndex] = [datetime]::Parse($val)
                                }
                                'date' {
                                    $dataRow[$dataTableColIndex] = [datetime]::Parse($val)
                                }
                                'uniqueidentifier' {
                                    $dataRow[$dataTableColIndex] = [guid]::Parse($val)
                                }
                                default {
                                    $dataRow[$dataTableColIndex] = $val
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
            
            # Use SqlBulkCopy for fast insert
            Write-Output "    Bulk inserting $rowCount rows..."
            $bulkCopy = New-Object System.Data.SqlClient.SqlBulkCopy($conn)
            $bulkCopy.DestinationTableName = "[$schemaName].[$tableName]"
            $bulkCopy.BatchSize = 5000
            $bulkCopy.BulkCopyTimeout = 300
            
            # Map columns (only the ones we loaded, excluding UDT/binary types)
            foreach ($col in $loadedColumns) {
                $null = $bulkCopy.ColumnMappings.Add($col.Name, $col.Name)
            }
            
            $bulkCopy.WriteToServer($dataTable)
            $bulkCopy.Close()
            
            Write-Output "    Successfully loaded $rowCount rows"
            $csvLoadSuccess++
        }
        catch {
            Write-Warning "    Failed to load $($config.File): $($_.Exception.Message)"
            $csvLoadFailed++
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
