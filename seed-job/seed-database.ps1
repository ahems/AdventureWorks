# Database Seeding Script for Container App Job
# Uses Managed Identity for authentication (configured in infrastructure)
$ScriptVersion = '2026-02-13.3'

# CRITICAL: Setup error handling FIRST before anything else
$ErrorActionPreference = 'Continue'  # Don't stop on errors initially
$ProgressPreference = 'SilentlyContinue'

# Setup logging to volume mount - do this FIRST
$logDir = "/logs"
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = "$logDir/seed-$timestamp.log"

# Function to write to both console and log file
function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $logMessage = "[$timestamp] $Message"
    Write-Output $logMessage
    try {
        Add-Content -Path $script:logFile -Value $logMessage -ErrorAction Stop
    } catch {
        Write-Output "WARNING: Could not write to log file: $_"
    }
}

# Global error handler
trap {
    Write-Log "FATAL ERROR TRAPPED: $($_.Exception.Message)"
    Write-Log "Error Type: $($_.Exception.GetType().FullName)"
    Write-Log "Stack Trace: $($_.ScriptStackTrace)"
    exit 1
}

# Now set strict error handling
$ErrorActionPreference = 'Stop'

# Capture start time for duration tracking
$scriptStartTime = Get-Date
Write-Log "=========================================="
Write-Log "DATABASE SEEDING SCRIPT STARTED"
Write-Log "Seed script version: $ScriptVersion"
Write-Log "Start Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Log "Log File: $logFile"
Write-Log "PowerShell Version: $($PSVersionTable.PSVersion)"
Write-Log "OS: $($PSVersionTable.OS)"
Write-Log "=========================================="

# Import required modules
Write-Log "Importing PowerShell modules..."
try {
    Import-Module Az.Accounts -ErrorAction Stop
    Write-Log "  ✓ Az.Accounts imported"
    Import-Module Az.Resources -ErrorAction Stop
    Write-Log "  ✓ Az.Resources imported"
} catch {
    Write-Log "FATAL: Failed to import required modules: $($_.Exception.Message)"
    Write-Log "Stack trace: $($_.ScriptStackTrace)"
    exit 1
}

# Get environment variables from container environment (set by infrastructure)
$resourceGroupName = $env:AZURE_RESOURCE_GROUP
$sqlServerName = $env:SQL_SERVER_NAME
$sqlDatabaseName = $env:SQL_DATABASE_NAME
$managedIdentityName = $env:USER_MANAGED_IDENTITY_NAME
$tenantId = $env:TENANT_ID
$azureClientId = $env:AZURE_CLIENT_ID

# Validate required environment variables
if ([string]::IsNullOrWhiteSpace($resourceGroupName)) {
    Write-Error "AZURE_RESOURCE_GROUP environment variable is not set"
    exit 1
}
if ([string]::IsNullOrWhiteSpace($sqlServerName)) {
    Write-Error "SQL_SERVER_NAME environment variable is not set"
    exit 1
}
if ([string]::IsNullOrWhiteSpace($sqlDatabaseName)) {
    Write-Error "SQL_DATABASE_NAME environment variable is not set"
    exit 1
}
if ([string]::IsNullOrWhiteSpace($managedIdentityName)) {
    Write-Error "USER_MANAGED_IDENTITY_NAME environment variable is not set"
    exit 1
}
if ([string]::IsNullOrWhiteSpace($tenantId)) {
    Write-Error "TENANT_ID environment variable is not set"
    exit 1
}
if ([string]::IsNullOrWhiteSpace($azureClientId)) {
    Write-Error "AZURE_CLIENT_ID environment variable is not set"
    exit 1
}

Write-Log "Environment variables:"
Write-Log "  Resource Group: $resourceGroupName"
Write-Log "  SQL Server: $sqlServerName"
Write-Log "  SQL Database: $sqlDatabaseName"
Write-Log "  Managed Identity: $managedIdentityName"
Write-Log "  Tenant ID: $tenantId"
Write-Log "  Client ID: $azureClientId"

# Connect using Managed Identity (no interactive authentication needed)
Write-Log "`nConnecting to Azure using Managed Identity..."
Write-Log "  Client ID: $azureClientId"
Write-Log "  Tenant ID: $tenantId"

try {
    Write-Log "  Attempting Connect-AzAccount -Identity..."
    Connect-AzAccount -Identity -AccountId $azureClientId -TenantId $tenantId -ErrorAction Stop -WarningAction SilentlyContinue
    
    Write-Log "  ✓ Successfully connected to Azure using Managed Identity"
    $context = Get-AzContext
    Write-Log "  Account: $($context.Account.Id)"
    Write-Log "  Subscription: $($context.Subscription.Name)"
    
} catch {
    Write-Log "FATAL: Failed to connect to Azure using Managed Identity"
    Write-Log "Error Message: $($_.Exception.Message)"
    Write-Log "Error Type: $($_.Exception.GetType().FullName)"
    
    if ($_.Exception.InnerException) {
        Write-Log "Inner Exception: $($_.Exception.InnerException.Message)"
    }
    
    Write-Log "Stack Trace: $($_.ScriptStackTrace)"
    exit 1
}

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
    
    Write-Log "  Loading [$SchemaName].[$TableName] from JSON file..."
    
    try {
        # Read and parse JSON file
        if (-not (Test-Path $JsonFilePath)) {
            Write-Warning "    JSON file not found: $JsonFilePath - Skipping"
            return $false
        }
        
        $jsonContent = Get-Content -Path $JsonFilePath -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($jsonContent)) {
            Write-Log "    JSON file is empty - Skipping"
            return $true
        }
        
        $records = $jsonContent | ConvertFrom-Json
        if (-not $records -or $records.Count -eq 0) {
            Write-Log "    No records in JSON file - Skipping"
            return $true
        }
        
        Write-Log "    Parsed $($records.Count) records from JSON"
        
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
                if ($insertedRows % 1000 -eq 0) {
                    Write-Log "    ...inserted $insertedRows rows"
                }
            }
            
            $transaction.Commit()
            Write-Log "    Successfully loaded $insertedRows rows from JSON"
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

# ---------------------------------------------------------------------------
# Acquire Azure AD access token for SQL (scope: https://database.windows.net/.default)
# Using Managed Identity
# ---------------------------------------------------------------------------
Write-Log "`nObtaining access token for SQL Database..."
try {
    $rawToken = (Get-AzAccessToken -ResourceUrl 'https://database.windows.net/').Token
    if (-not $rawToken) { throw 'Access token empty' }
    $sqlToken = Convert-SecureIfNeededToPlainText -Value $rawToken
    if (-not ($sqlToken -is [string])) { $sqlToken = [string]$sqlToken }
    Write-Log "  ✓ Obtained Azure AD access token for SQL using Managed Identity"
}
catch {
    Write-Log "FATAL: Failed to obtain Azure AD access token"
    Write-Log "Error: $($_.Exception.Message)"
    Write-Log "Error Type: $($_.Exception.GetType().FullName)"
    exit 1
}

# -----------------------------------------------------------------------------
# Connect to SQL Database and perform seeding operations
# Note: Database roles are assigned by postprovision.sh before this runs
# -----------------------------------------------------------------------------

# server FQDN
$serverFqdn = "$sqlServerName.database.windows.net"

Write-Log "`nConnecting to SQL Database..."
Write-Log "  Server: $serverFqdn"
Write-Log "  Database: $sqlDatabaseName"

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
    Write-Log "  ✓ Successfully connected to SQL Database"
    $cmd = $conn.CreateCommand()

    # ---------------------------------------------------------------------
    # Load and execute SQL to create table(s)
    # ---------------------------------------------------------------------
    $createTableSqlPath = Join-Path $PSScriptRoot 'sql' 'AdventureWorks.sql'
    if (-not (Test-Path $createTableSqlPath)) {
        Write-Log "FATAL: SQL script not found: $createTableSqlPath"
        $conn.Close()
        exit 1
    }

    Write-Log "`nLoading AdventureWorks schema SQL script..."
    Write-Log "  Path: $createTableSqlPath"
    $tableSql = Get-Content -Path $createTableSqlPath -Raw
    Write-Log "  ✓ SQL script loaded ($($tableSql.Length) characters)"
    
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
    
    Write-Log "Processing SQL script with $($batches.Count) potential batches..."
    $batchNum = 0
    $successCount = 0
    $skipCount = 0
    $failCount = 0
    $alreadyExistsCount = 0
    $unexpectedErrorCount = 0
    
    foreach ($batch in $batches) {
        # Remove any remaining GO statements from the batch (in case splitting missed any)
        # This handles GO statements that might be on lines with other content or have different formatting
        $cleanBatch = $batch -replace '(?mi)^\s*GO\s*$', ''
        $cleanBatch = $cleanBatch -replace '(?i)\bGO\b(?=\s*$)', ''
        $cleanBatch = $cleanBatch -replace '(?i)\bGO\b(?=\s*\r?\n)', ''
        $trimmedBatch = $cleanBatch.Trim()
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
            @{ Pattern = '(?i)\bGO\b'; Reason = 'Contains unremoved GO statement' }
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
        }
        catch {
            $errorMsg = $_.Exception.Message
            # Categorize failures: expected (already exists) vs unexpected
            if ($errorMsg -match 'already exists' -or 
                $errorMsg -match 'Cannot find the object' -or
                $errorMsg -match 'Invalid object name' -or
                $errorMsg -match 'There is already an object named' -or
                $errorMsg -match 'already has a primary key defined on it' -or
                $errorMsg -match 'Altering existing schema components is not allowed' -or
                $errorMsg -match 'A full-text index for table' -or
                $errorMsg -match 'The specified namespace already exists in the specified XML schema collection') {
                $alreadyExistsCount++
            } else {
                $unexpectedErrorCount++
                Write-Log "  ✗ UNEXPECTED ERROR in batch ${batchNum}: $errorMsg"
            }
            $failCount++
        }
    }
    
    # Provide clear summary
    $elapsed = (Get-Date) - $scriptStartTime
    Write-Log "`nSQL script execution completed: [+$([math]::Floor($elapsed.TotalMinutes))m $($elapsed.Seconds)s]"
    if ($successCount -gt 0) {
        Write-Log "  ✓ $successCount objects created/modified"
    }
    if ($alreadyExistsCount -gt 0) {
        Write-Log "  ⊙ $alreadyExistsCount objects already exist (idempotent - OK)"
    }
    if ($skipCount -gt 0) {
        Write-Log "  ⊘ $skipCount batches skipped (unsupported in Azure SQL DB)"
    }
    if ($unexpectedErrorCount -gt 0) {
        Write-Log "  ✗ $unexpectedErrorCount unexpected errors occurred (see errors above)"
    }
    
    # Overall assessment
    if ($unexpectedErrorCount -eq 0) {
        Write-Log "  ✓ Schema is up to date and ready for use"
    } else {
        Write-Log "FATAL: SQL script execution failed with $unexpectedErrorCount unexpected errors. Cannot proceed with AI enhancements and data loading."
        $conn.Close()
        exit 1
    }
    
    # ---------------------------------------------------------------------
    # Apply AI enhancements to schema
    # ---------------------------------------------------------------------
    $aiEnhancementsSqlPath = Join-Path $PSScriptRoot 'sql' 'AdventureWorks-AI.sql'
    if (Test-Path $aiEnhancementsSqlPath) {
        $elapsed = (Get-Date) - $scriptStartTime
        Write-Log "`n[+$([math]::Floor($elapsed.TotalMinutes))m] Applying AI schema enhancements from $aiEnhancementsSqlPath..."
        $aiSql = Get-Content -Path $aiEnhancementsSqlPath -Raw
        
        # Split on GO statements
        $aiBatches = $aiSql -split '(?mi)^\s*GO\s*$'
        
        $successCount = 0
        $skipCount = 0
        $hasErrors = $false
        foreach ($batch in $aiBatches) {
            # Remove any remaining GO statements from the batch
            $cleanBatch = $batch -replace '(?mi)^\s*GO\s*$', ''
            $cleanBatch = $cleanBatch -replace '(?i)\bGO\b(?=\s*$)', ''
            $cleanBatch = $cleanBatch -replace '(?i)\bGO\b(?=\s*\r?\n)', ''
            $trimmedBatch = $cleanBatch.Trim()
            if ($trimmedBatch.Length -eq 0) { continue }
            
            # Skip if batch still contains GO statement
            if ($trimmedBatch -match '(?i)\bGO\b') {
                $skipCount++
                continue
            }
            
            try {
                $cmd.CommandText = $trimmedBatch
                $null = $cmd.ExecuteNonQuery()
                # Check if this was a skip message or actual work
                if ($trimmedBatch -match 'already exists - skipping') {
                    $skipCount++
                } else {
                    $successCount++
                }
            }
            catch {
                $errorMsg = $_.Exception.Message
                # Only warn on unexpected errors (not "already exists" type errors)
                if ($errorMsg -match 'already exists' -or 
                    $errorMsg -match 'Cannot find the object' -or
                    $errorMsg -match 'There is already an object named' -or
                    $errorMsg -match 'Could not create constraint or index') {
                    $skipCount++
                } else {
                    Write-Warning "AI enhancement batch failed: $errorMsg"
                    $hasErrors = $true
                }
            }
        }
        $elapsed = (Get-Date) - $scriptStartTime
        Write-Log "AI schema enhancements completed: $successCount applied, $skipCount already existed [+$([math]::Floor($elapsed.TotalMinutes))m]"
        
        if ($hasErrors) {
            throw "AI schema enhancements completed with errors. Review the warnings above."
        }
    } else {
        Write-Log "`nAI enhancements SQL file not found, skipping..."
    }
    
    # ---------------------------------------------------------------------
    # Generate ProductProductPhoto-ai.csv from filesystem (source of truth)
    # Scan images/product_<ProductID>_photo_<N>.png and assign ProductPhotoIDs 1000+; junction table CSV is derived from the file list.
    # ---------------------------------------------------------------------
    $imagesDirForCsv = Join-Path $PSScriptRoot "images"
    $aiCsvPathOut = Join-Path $PSScriptRoot 'sql' 'ProductProductPhoto-ai.csv'
    if (Test-Path $imagesDirForCsv) {
        $elapsed = (Get-Date) - $scriptStartTime
        Write-Log "`n[+$([math]::Floor($elapsed.TotalMinutes))m] Generating ProductProductPhoto-ai.csv from image files (filesystem is source of truth)..."
        $pngFilesForCsv = Get-ChildItem -Path $imagesDirForCsv -Filter "*.png" | Sort-Object Name
        $pairsForCsv = @()
        $excludeSuffixPattern = '_thumb\.png$|_small\.png$'
        foreach ($f in $pngFilesForCsv) {
            $name = $f.Name
            if ($name -notmatch $excludeSuffixPattern) { continue }
            $baseName = $name -replace '_thumb\.png$', '.png' -replace '_small\.png$', '.png'
            $largePath = Join-Path $imagesDirForCsv $baseName
            if (-not (Test-Path $largePath)) { continue }
            if ($baseName -match '^product_(\d+)_photo_(\d+)\.png$') {
                $pairsForCsv += @{ ProductID = [int]$Matches[1]; PhotoNum = [int]$Matches[2]; ThumbPath = $f.FullName; LargePath = $largePath }
            }
        }
        $pairsForCsv = $pairsForCsv | Sort-Object { $_.ProductID }, { $_.PhotoNum }
        $nextPhotoId = 1000
        $junctionRows = @()
        foreach ($p in $pairsForCsv) {
            $junctionRows += @{ ProductID = $p.ProductID; ProductPhotoID = $nextPhotoId }
            $nextPhotoId++
        }
        $csvDate = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $csvLinesOut = for ($i = 0; $i -lt $junctionRows.Count; $i++) {
            $r = $junctionRows[$i]
            $isLastForProduct = ($i -eq $junctionRows.Count - 1) -or ($junctionRows[$i + 1].ProductID -ne $r.ProductID)
            $primary = if ($isLastForProduct) { 1 } else { 0 }
            "$($r.ProductID)`t$($r.ProductPhotoID)`t$primary`t$csvDate"
        }
        $csvLinesOut | Set-Content -Path $aiCsvPathOut -Encoding UTF8
        Write-Log "  Wrote $($junctionRows.Count) rows to ProductProductPhoto-ai.csv (ProductPhotoIDs 1000–$($nextPhotoId - 1)) from $($pairsForCsv.Count) image pairs"
    } else {
        Write-Log "`nImages directory not found; ProductProductPhoto-ai.csv will not be regenerated (existing file used if present)."
    }
    
    # ---------------------------------------------------------------------
    # Start PNG image upload as background job (runs concurrently with CSV loading)
    # ---------------------------------------------------------------------
    $elapsed = (Get-Date) - $scriptStartTime
    Write-Log "`n[+$([math]::Floor($elapsed.TotalMinutes))m] Starting PNG image upload in background..."
    
    $pngUploadJob = Start-ThreadJob -ScriptBlock {
        param($connString, $scriptRoot, $startTime, $accountId, $tenantId)
        
        $result = @{
            Uploaded = 0
            Skipped = 0
            Failed = 0
            TotalFiles = 0
            ThumbnailCount = 0
            ImagePairCount = 0
            AlreadyLoaded = $false
            NoFiles = $false
            NoDirec = $false
            Error = $null
            StackTrace = $null
        }
        
        try {
        try {
            # Obtain our own token in this thread (passed token may not serialize correctly across runspaces)
            $threadToken = $null
            try {
                Connect-AzAccount -Identity -AccountId $accountId -TenantId $tenantId -ErrorAction Stop -WarningAction SilentlyContinue | Out-Null
                $rawToken = (Get-AzAccessToken -ResourceUrl 'https://database.windows.net/').Token
                if (-not $rawToken) { throw 'Access token empty' }
                if ($rawToken -is [System.Security.SecureString]) {
                    $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($rawToken)
                    try { $threadToken = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ptr) }
                    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr) }
                } else {
                    $threadToken = [string]$rawToken
                }
            } catch {
                $result.Failed = -1
                $result.Error = "Failed to obtain SQL token in PNG job: $($_.Exception.Message)"
                $result.StackTrace = $_.ScriptStackTrace
                return $result
            }
            
            # Create connection for idempotency check
            $connType = [System.Type]::GetType('Microsoft.Data.SqlClient.SqlConnection, Microsoft.Data.SqlClient')
            if (-not $connType) { $connType = [System.Data.SqlClient.SqlConnection] }
            
            $checkConn = [Activator]::CreateInstance($connType, $connString)
            $accessTokenProp = $connType.GetProperty('AccessToken')
            if ($accessTokenProp) {
                $accessTokenProp.SetValue($checkConn, $threadToken)
            }
            $checkConn.Open()
            
            # Build ProductID -> ordered ProductPhotoIDs from ProductProductPhoto-ai.csv so we use the same IDs the junction table expects.
            # Filenames are product_877_photo_2_small.png (ProductID 877, photo 2) -> we use the 1st ProductPhotoID for that product from CSV, etc.
            $aiCsvPath = Join-Path $scriptRoot 'sql' 'ProductProductPhoto-ai.csv'
            $productToPhotoIds = @{}
            $firstAiPhotoId = $null
            if (Test-Path $aiCsvPath) {
                $csvLines = Get-Content -Path $aiCsvPath -Encoding UTF8
                foreach ($line in $csvLines) {
                    if ([string]::IsNullOrWhiteSpace($line)) { continue }
                    $cols = $line -split "`t"
                    if ($cols.Count -lt 2) { continue }
                    $productIdFromCsv = [int]$cols[0]
                    $photoId = [int]$cols[1]
                    if ($null -eq $firstAiPhotoId) { $firstAiPhotoId = $photoId }
                    if (-not $productToPhotoIds.ContainsKey($productIdFromCsv)) { $productToPhotoIds[$productIdFromCsv] = @() }
                    $productToPhotoIds[$productIdFromCsv] += $photoId
                }
            }
            # Idempotency: if any AI CSV ProductPhotoID already exists in ProductPhoto, skip upload
            if ($null -ne $firstAiPhotoId) {
                $cmd = $checkConn.CreateCommand()
                $cmd.CommandText = "SELECT COUNT(*) FROM Production.ProductPhoto WHERE ProductPhotoID = @PhotoID"
                $null = $cmd.Parameters.AddWithValue("@PhotoID", $firstAiPhotoId)
                $aiPhotoExists = [int]$cmd.ExecuteScalar()
                if ($aiPhotoExists -gt 0) {
                    $checkConn.Close()
                    $result.AlreadyLoaded = $true
                    return $result
                }
            }
            $checkConn.Close()
            
            $imagesDir = Join-Path $scriptRoot "images"
            
            if (-not (Test-Path $imagesDir)) {
                $result.NoDirec = $true
                return $result
            }
            
            $pngFiles = Get-ChildItem -Path $imagesDir -Filter "*.png" | Sort-Object Name
            $result.TotalFiles = $pngFiles.Count
            
            if ($result.TotalFiles -eq 0) {
                $result.NoFiles = $true
                return $result
            }
            
            $result.ThumbnailCount = ($pngFiles | Where-Object { $_.Name -like "*_thumb.png" -or $_.Name -like "*_small.png" }).Count
            
            # Pre-process: create image pairs. Only product_<ProductID>_photo_<2|3|4> files are uploaded (no other filenames).
            # Use ProductPhotoID from ProductProductPhoto-ai.csv so junction table rows resolve.
            $imagePairs = @()
            foreach ($pngFile in $pngFiles) {
                $fileName = $pngFile.Name
                $isThumbnail = $fileName -like "*_thumb.png" -or $fileName -like "*_small.png"
                if (-not $isThumbnail) { continue }
                $baseFileName = $fileName -replace '_thumb\.png$', '.png' -replace '_small\.png$', '.png'
                $largeImagePath = Join-Path $imagesDir $baseFileName
                if (-not (Test-Path $largeImagePath)) { continue }
                if ($baseFileName -notmatch '^product_(\d+)_photo_(\d+)\.png$') { continue }
                $productId = [int]$Matches[1]
                $photoNum = [int]$Matches[2]
                $photoIndex = $photoNum - 2
                if (-not $productToPhotoIds.ContainsKey($productId)) { continue }
                if ($photoIndex -lt 0 -or $photoIndex -ge $productToPhotoIds[$productId].Count) { continue }
                $assignedPhotoId = $productToPhotoIds[$productId][$photoIndex]
                $imagePairs += @{
                    PhotoID = $assignedPhotoId
                    ThumbPath = $pngFile.FullName
                    ThumbName = $fileName
                    LargePath = $largeImagePath
                    LargeName = $baseFileName
                }
            }
            
            $result.ImagePairCount = $imagePairs.Count
            
            # Parallel upload (2 threads) - use same token obtained in this job
            $uploadResults = $imagePairs | ForEach-Object -ThrottleLimit 2 -Parallel {
                $pair = $_
                $uploadResult = @{ Success = $false; Skipped = $false; Failed = $false }
                
                try {
                    $thumbBytes = [System.IO.File]::ReadAllBytes($pair.ThumbPath)
                    $largeBytes = [System.IO.File]::ReadAllBytes($pair.LargePath)
                    
                    $connStr = $using:connString
                    $token = $using:threadToken
                    
                    $connType = [System.Type]::GetType('Microsoft.Data.SqlClient.SqlConnection, Microsoft.Data.SqlClient')
                    if (-not $connType) { $connType = [System.Data.SqlClient.SqlConnection] }
                    
                    $threadConn = [Activator]::CreateInstance($connType, $connStr)
                    $accessTokenProp = $connType.GetProperty('AccessToken')
                    if ($accessTokenProp) {
                        $accessTokenProp.SetValue($threadConn, $token)
                    }
                    
                    $threadConn.Open()
                    
                    try {
                        $checkCmd = $threadConn.CreateCommand()
                        $checkCmd.CommandText = "SELECT COUNT(*) FROM Production.ProductPhoto WHERE ProductPhotoID = @PhotoID"
                        $checkCmd.Parameters.AddWithValue("@PhotoID", $pair.PhotoID) | Out-Null
                        $exists = [int]$checkCmd.ExecuteScalar()
                        
                        if ($exists -eq 0) {
                            $insertCmd = $threadConn.CreateCommand()
                            $insertCmd.CommandText = @"
SET IDENTITY_INSERT Production.ProductPhoto ON;
INSERT INTO Production.ProductPhoto 
    (ProductPhotoID, ThumbNailPhoto, ThumbnailPhotoFileName, LargePhoto, LargePhotoFileName, ModifiedDate)
VALUES 
    (@PhotoID, @ThumbBytes, @ThumbFileName, @LargeBytes, @LargeFileName, GETDATE());
SET IDENTITY_INSERT Production.ProductPhoto OFF;
"@
                            $insertCmd.Parameters.AddWithValue("@PhotoID", $pair.PhotoID) | Out-Null
                            $insertCmd.Parameters.Add("@ThumbBytes", [System.Data.SqlDbType]::VarBinary, $thumbBytes.Length).Value = $thumbBytes
                            $insertCmd.Parameters.AddWithValue("@ThumbFileName", $pair.ThumbName) | Out-Null
                            $insertCmd.Parameters.Add("@LargeBytes", [System.Data.SqlDbType]::VarBinary, $largeBytes.Length).Value = $largeBytes
                            $insertCmd.Parameters.AddWithValue("@LargeFileName", $pair.LargeName) | Out-Null
                            
                            $insertCmd.ExecuteNonQuery() | Out-Null
                            $uploadResult.Success = $true
                        }
                        else {
                            $uploadResult.Skipped = $true
                        }
                    }
                    finally {
                        $threadConn.Close()
                        $threadConn.Dispose()
                    }
                }
                catch {
                    $uploadResult.Failed = $true
                    $uploadResult.Error = $_.Exception.Message
                }
                
                $uploadResult
            }
            
            $result.Uploaded = ($uploadResults | Where-Object { $_.Success }).Count
            $result.Skipped = ($uploadResults | Where-Object { $_.Skipped }).Count
            $result.Failed = ($uploadResults | Where-Object { $_.Failed }).Count
            
            if ($result.Failed -gt 0) {
                $result.Errors = ($uploadResults | Where-Object { $_.Failed } | ForEach-Object { $_.Error } | Select-Object -First 5)
            }
        }
        catch {
            $result.Failed = -1
            $result.Error = $_.Exception.Message
            $result.StackTrace = $_.ScriptStackTrace
        }
        return $result
        } catch {
            # Outer catch: any uncaught failure in the job (e.g. assembly load, serialization)
            $result.Failed = -1
            $result.Error = $_.Exception.Message
            $result.StackTrace = $_.ScriptStackTrace
            return $result
        }
    } -ArgumentList $connectionString, $PSScriptRoot, $scriptStartTime, $azureClientId, $tenantId
    
    Write-Log "  PNG upload job started (running in background while CSV data loads)..."
    Write-Log "  Base product images (ProductPhoto.csv) load later in the CSV step so both base and PNG images are present."
    
    # ---------------------------------------------------------------------
    # Load CSV data into tables using SqlBulkCopy
    # ---------------------------------------------------------------------
    $elapsed = (Get-Date) - $scriptStartTime
    Write-Log "`n[+$([math]::Floor($elapsed.TotalMinutes))m] Loading CSV data into tables using SqlBulkCopy..."
    
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
        # Enhanced product descriptions with embeddings (DescriptionEmbedding VECTOR field, JSON array).
        # ProductDescription-ai.csv adds NEW rows only (IDs 2011+); the 762 base rows from ProductDescription.csv never get embeddings here.
        @{ Table='Production.ProductDescription'; File='ProductDescription-ai.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false; VectorColumns=@('DescriptionEmbedding') }
        # AI-translated product descriptions (actual text content for 16 new cultures; CSV has only ID, Description, ModifiedDate).
        # DefaultColumns and Update path omit DescriptionEmbedding so existing embeddings are preserved (not overwritten).
        @{ Table='Production.ProductDescription'; File='ProductDescription-ai-translations.csv'; Delimiter="|"; RowTerminator="`n"; IsWideChar=$false; DefaultColumns=@('rowguid', 'DescriptionEmbedding'); UpdateIfExists=$true }
        @{ Table='Production.ProductModelProductDescriptionCulture'; File='ProductModelProductDescriptionCulture.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        # AI-translated product description culture mappings (16 additional cultures beyond base AdventureWorks 7)
        @{ Table='Production.ProductModelProductDescriptionCulture'; File='ProductModelProductDescriptionCulture-ai.csv'; Delimiter="|"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductModelIllustration'; File='ProductModelIllustration.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.Product'; File='Product.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false }
        @{ Table='Production.ProductReview'; File='ProductReview.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false; HexColumns=@('Comments'); DefaultColumns=@('CommentsEmbedding','HelpfulVotes','UserID') }
        # AI-generated product reviews: Comments are plain text (not hex); CommentsEmbedding is VECTOR; HelpfulVotes/UserID not in CSV
        @{ Table='Production.ProductReview'; File='ProductReview-ai.csv'; Delimiter="`t"; RowTerminator="`n"; IsWideChar=$false; VectorColumns=@('CommentsEmbedding'); DefaultColumns=@('HelpfulVotes','UserID') }
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
    
    Write-Log "  Total CSV files to process: $($csvLoadConfig.Count)"
    $csvProcessed = 0
    foreach ($config in $csvLoadConfig) {
        $csvPath = Join-Path $csvFolder $config.File
        
        if (-not (Test-Path $csvPath)) {
            Write-Log "  ⚠ CSV file not found: $csvPath - Skipping"
            $csvLoadSkipped++
            continue
        }
        
        $elapsed = (Get-Date) - $scriptStartTime
        $csvProcessed++
        Write-Log "  [$csvProcessed/$($csvLoadConfig.Count)] [+$([math]::Floor($elapsed.TotalMinutes))m] Loading $($config.Table) from $($config.File)..."
        
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
            $isAiCsv = $config.File -match '-ai\.csv$' -or $config.File -eq 'ProductDescription-ai-translations.csv'
            
            # Schema script drops tables if they exist before create; we assume empty tables for CSV load.
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
            
            # If config specifies DefaultColumns, CSV has fewer columns - those use DB DEFAULT when inserting
            $defaultCols = @()
            if ($config.DefaultColumns) { $defaultCols = @($config.DefaultColumns) }
            $expectedCsvColumnCount = $allColumns.Count
            foreach ($col in $columns) { $col.UseDefault = $false }
            if ($defaultCols.Count -gt 0) {
                $csvIdx = 0
                foreach ($ac in $allColumns) {
                    if ($ac.Name -in $defaultCols) {
                        $ac.CSVIndex = -1
                    } else {
                        $ac.CSVIndex = $csvIdx++
                    }
                }
                foreach ($col in $columns) {
                    # Wrap in @() to prevent PowerShell's single-result unwrap: without @(), Where-Object
                    # returns the hashtable directly when there's exactly one match, and [0] then treats
                    # it as a hashtable key lookup (returning $null) instead of an array element access.
                    $col.CSVIndex = @($allColumns | Where-Object { $_.Name -eq $col.Name })[0].CSVIndex
                    $col.UseDefault = ($col.Name -in $defaultCols)
                }
                $expectedCsvColumnCount = $allColumns.Count - $defaultCols.Count
                Write-Log "    CSV has $expectedCsvColumnCount columns (using DB DEFAULT for: $($defaultCols -join ', '))"
            }
            
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
                # Strip trailing empty fields (e.g. ProductReview.csv has two trailing tabs)
                $values = Remove-TrailingEmptyFields -Values $values
                
                # Skip header row: if first column looks like a header (not a number), skip
                if ($values.Count -ge 1) {
                    $firstVal = $values[0].Trim()
                    if ($firstVal -and $firstVal -notmatch '^\d+$') { continue }
                }
                
                $dataRow = $dataTable.NewRow()
                $dataTableColIndex = 0
                
                # Process only the columns we're inserting (skip IDENTITY/computed)
                for ($i = 0; $i -lt $columns.Count; $i++) {
                    $col = $columns[$i]
                    # Use the CSVIndex to get the correct value from the CSV (or use default for DefaultColumns)
                    if ($col.CSVIndex -lt 0) {
                        $val = $null  # Column uses DB DEFAULT - placeholder for row cell
                    } else {
                        # Guard against out-of-bounds: if CSV has fewer fields than expected,
                        # treat the missing field as null (will use column default or DBNull)
                        $raw = if ($col.CSVIndex -lt $values.Count) { $values[$col.CSVIndex] } else { $null }
                        $val = if ($null -ne $raw) { $raw.Trim() } else { $null }
                    }
                    
                    # Column uses DB DEFAULT - no value from CSV (use placeholder so non-nullable columns accept the row; INSERT will use DEFAULT/NULL)
                    if ($col.UseDefault) {
                        if ($col.IsNullable) {
                            $dataRow[$dataTableColIndex] = [DBNull]::Value
                        } else {
                            # Placeholder so DataTable accepts the row; INSERT builder will use DEFAULT
                            switch ($col.Type) {
                                'uniqueidentifier' { $dataRow[$dataTableColIndex] = [guid]::Empty }
                                'bit' { $dataRow[$dataTableColIndex] = $false }
                                'int' { $dataRow[$dataTableColIndex] = 0 }
                                'datetime' { $dataRow[$dataTableColIndex] = [datetime]::new(1900, 1, 1, 0, 0, 0) }
                                'datetime2' { $dataRow[$dataTableColIndex] = [datetime]::new(1900, 1, 1, 0, 0, 0) }
                                default { $dataRow[$dataTableColIndex] = [DBNull]::Value }
                            }
                        }
                        $dataTableColIndex++
                        continue
                    }
                    
                    # BCP with -w (Unicode) and -t delimiter may add & prefix to fields - remove it
                    if ($config.IsWideChar -and $null -ne $val -and $val.StartsWith('&')) {
                        $val = $val.Substring(1).Trim()
                    }
                    # Handle NULL values
                    $isNull = [string]::IsNullOrWhiteSpace($val) -or $val -in @('NULL', '\N', 'null')
                    
                    if ($isNull) {
                        if (-not $col.IsNullable) {
                            # Provide default values for non-nullable columns
                            switch ($col.Type) {
                                'bit' { $dataRow[$dataTableColIndex] = $false }
                                'int' {
                                    # Rating CHECK constraint (1-5): use 1 not 0 to satisfy constraint when value is missing
                                    $dataRow[$dataTableColIndex] = if ($col.Name -eq 'Rating') { 1 } else { 0 }
                                }
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
                                    $parsed = [int]::Parse($val)
                                    # Production.ProductReview.Rating has CHECK (1-5); clamp to avoid constraint violation
                                    if ($schemaName -eq 'Production' -and $tableName -eq 'ProductReview' -and $col.Name -eq 'Rating') {
                                        if ($parsed -lt 1) { $parsed = 1 }; if ($parsed -gt 5) { $parsed = 5 }
                                    }
                                    $dataRow[$dataTableColIndex] = $parsed
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
                                        # Rating on Production.ProductReview must be 1-5 (CHECK constraint); use 1 not 0 on parse failure
                                        $dataRow[$dataTableColIndex] = if ($col.Name -eq 'Rating') { 1 } else { 0 }
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
                # Skip placeholder/invalid row: Production.ProductDescription must not have ProductDescriptionID 0
                if ($schemaName -eq 'Production' -and $tableName -eq 'ProductDescription') {
                    $pidx = [array]::IndexOf(($columns | ForEach-Object { $_.Name }), 'ProductDescriptionID')
                    if ($pidx -ge 0) {
                        $pkVal = $dataRow[$pidx]
                        if ($null -ne $pkVal -and [int]$pkVal -eq 0) { continue }
                    }
                }
                $dataTable.Rows.Add($dataRow)
                $rowCount++
                
                if ($rowCount % 10000 -eq 0) {
                    Write-Log "    ...parsed $rowCount rows"
                }
            }
            
            # Check if any column is an IDENTITY column (need to enable IDENTITY_INSERT)
            $hasIdentityColumn = $columns | Where-Object { $_.IsIdentity } | Measure-Object | Select-Object -ExpandProperty Count
            $hasIdentityColumn = $hasIdentityColumn -gt 0
            
            # Use different insert method depending on whether table has special columns, hex encoding, identity columns, or AI CSV files
            # SqlBulkCopy does NOT support IDENTITY_INSERT or idempotent inserts, so we must use batched INSERT for:
            # - Identity columns, special columns (hierarchyid, geography, etc.)
            # - AI CSV files (use INSERT...SELECT WHERE NOT EXISTS for idempotent load; no IF batch to avoid PowerShell parse errors)
            if ($hasSpecialColumns -or $hasIdentityColumn -or $isAiCsv) {
                # Use batched INSERT statements for special tables (hierarchyid, geography, hex-encoded columns)
                Write-Log "    Inserting $rowCount rows using batched INSERT (special columns)..."
                
                $batchSize = 100
                $insertedRows = 0
                $skippedRows = 0
                $updatedRows = 0
                $transaction = $conn.BeginTransaction()
                
                # Enable IDENTITY_INSERT if needed
                if ($hasIdentityColumn) {
                    $cmd.Transaction = $transaction
                    $cmd.CommandText = "SET IDENTITY_INSERT [$schemaName].[$tableName] ON"
                    $cmd.ExecuteNonQuery() | Out-Null
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
                
                $updateErrorLogged = $false
                try {
                    for ($batchStart = 0; $batchStart -lt $dataTable.Rows.Count; $batchStart += $batchSize) {
                        $batchEnd = [Math]::Min($batchStart + $batchSize, $dataTable.Rows.Count)
                        
                        # Build INSERT statement for this batch - use MERGE for AI CSV files to avoid duplicates
                        # Exclude UseDefault columns from the column list; SQL Server will apply their defaults
                        # automatically. Using the DEFAULT keyword in VALUES with IDENTITY_INSERT ON can trigger
                        # spurious CHECK constraint violations on adjacent columns (e.g. CK_ProductReview_Rating).
                        $insertColumns = $loadedColumns | Where-Object { -not $_.UseDefault }
                        $columnList = ($insertColumns | ForEach-Object { "[$($_.Name)]" }) -join ', '
                        
                        # For AI CSV files with PK, use parameterized INSERT...SELECT WHERE NOT EXISTS (no IF batch)
                        if ($isAiCsv -and $pkColumns.Count -gt 0) {
                            if ($batchStart -eq 0) { Write-Log "    Using parameterized INSERT...SELECT for idempotent load (version $ScriptVersion)" }
                            $doUpdateIfExists = ($config.UpdateIfExists -eq $true) -or ($config.File -eq 'ProductDescription-ai-translations.csv')
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
                                
                                # Build INSERT: use parameterized INSERT...SELECT (no IF) to avoid "if" parse errors; omit UseDefault columns so SELECT has no DEFAULT
                                $insertColumnListParam = @()
                                $selectPlaceholdersParam = @()
                                $insertParamValues = @()
                                $values = @()
                                $paramIdx = 0
                                $canParameterize = @('int', 'bigint', 'smallint', 'tinyint', 'bit', 'datetime', 'datetime2', 'date', 'time', 'datetimeoffset', 'nvarchar', 'varchar', 'nchar', 'char', 'uniqueidentifier', 'decimal', 'numeric', 'money', 'float', 'real')
                                for ($c = 0; $c -lt $loadedColumns.Count; $c++) {
                                    $col = $loadedColumns[$c]
                                    $value = $row[$c]
                                    if ($col.UseDefault) {
                                        $defaultOrNull = if ($col.Default -and [string]::IsNullOrWhiteSpace($col.Default) -eq $false) { "DEFAULT" } else { "NULL" }
                                        $values += $defaultOrNull
                                        continue
                                    }
                                    $insertColumnListParam += "[$($col.Name)]"
                                    if ($col.Type -in $canParameterize -and ($null -eq $value -or $value -is [DBNull] -or $value -is [string] -or $value -is [DateTime] -or $value -is [decimal] -or $value -is [Guid] -or ($null -ne $value -and $value.GetType().IsPrimitive))) {
                                        if ($col.Name -in $pkColumns) {
                                            $pkIdx = [array]::IndexOf($pkColumns, $col.Name)
                                            $selectPlaceholdersParam += "@pk$pkIdx"
                                        } else {
                                            $selectPlaceholdersParam += "@ins$paramIdx"
                                            $insVal = if ($null -eq $value -or $value -is [DBNull]) { [DBNull]::Value } else { $value }
                                            $insertParamValues += $insVal
                                            $paramIdx++
                                        }
                                        $values += "NULL"
                                    }
                                    else {
                                        if ($value -is [DBNull] -or $null -eq $value) { $lit = "NULL" }
                                        elseif ($col.Type -eq 'hierarchyid') { $lit = "CAST(0x$($value.ToString()) AS hierarchyid)" }
                                        elseif ($col.Type -eq 'geography') { $lit = "CAST(0x$($value.ToString()) AS geography)" }
                                        elseif ($col.Type -eq 'geometry') { $lit = "CAST(0x$($value.ToString()) AS geometry)" }
                                        elseif ($col.Type -eq 'varbinary') { $hexStr = ($value | ForEach-Object { $_.ToString('X2') }) -join ''; $lit = "0x$hexStr" }
                                        elseif ($col.Type -eq 'vector') { $escapedVal = $value.ToString().Replace("'", "''"); $lit = "CAST(N'$escapedVal' AS VECTOR(1536))" }
                                        elseif ($col.Type -in @('varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'uniqueidentifier', 'xml')) { $escapedVal = $value.ToString().Replace("'", "''"); $lit = "N'$escapedVal'" }
                                        elseif ($col.Type -eq 'bit') { $bitVal = if ($value) { '1' } else { '0' }; $lit = $bitVal }
                                        elseif ($col.Type -in @('datetime', 'datetime2', 'date', 'time', 'datetimeoffset')) {
                                            if ($col.Type -eq 'date') { $dateStr = ([datetime]$value).ToString('yyyy-MM-dd') }
                                            elseif ($col.Type -eq 'datetime') { $dateStr = ([datetime]$value).ToString('yyyy-MM-dd HH:mm:ss.fff') }
                                            else { $dateStr = ([datetime]$value).ToString('yyyy-MM-dd HH:mm:ss.fffffff') }
                                            $lit = "'$dateStr'"
                                        }
                                        else { $lit = $value.ToString() }
                                        $selectPlaceholdersParam += $lit
                                        $values += $lit
                                    }
                                }
                                $whereParamParts = @()
                                $whereParamValues = @()
                                $pkIdx = 0
                                foreach ($pkCol in $pkColumns) {
                                    $colIdx = [array]::IndexOf(($loadedColumns | ForEach-Object { $_.Name }), $pkCol)
                                    if ($colIdx -ge 0) {
                                        $whereParamParts += "[$pkCol] = @pk$pkIdx"
                                        $whereParamValues += $row[$colIdx]
                                        $pkIdx++
                                    }
                                }
                                $insertColList = $insertColumnListParam -join ', '
                                $insertSql = "INSERT INTO [$schemaName].[$tableName] ($insertColList) SELECT " + ($selectPlaceholdersParam -join ', ') + " FROM (SELECT 1 AS _d) AS _t WHERE NOT EXISTS (SELECT 1 FROM [$schemaName].[$tableName] WHERE " + ($whereParamParts -join ' AND ') + ")"
                                $cmd.Transaction = $transaction
                                $cmd.CommandText = $insertSql
                                $cmd.Parameters.Clear()
                                for ($i = 0; $i -lt $whereParamValues.Count; $i++) {
                                    $v = $whereParamValues[$i]
                                    $pval = if ($null -eq $v -or $v -is [DBNull]) { [DBNull]::Value } else { $v }
                                    $null = $cmd.Parameters.AddWithValue("@pk$i", $pval)
                                }
                                for ($i = 0; $i -lt $insertParamValues.Count; $i++) {
                                    $null = $cmd.Parameters.AddWithValue("@ins$i", $insertParamValues[$i])
                                }
                                try {
                                    $affected = $cmd.ExecuteNonQuery()
                                    $cmd.Parameters.Clear()
                                    if ($affected -gt 0) {
                                        $insertedRows++
                                    } else {
                                        # Row already exists: update non-PK columns if config requests it (e.g. translations)
                                        if ($doUpdateIfExists -and $pkColumns.Count -gt 0) {
                                            $setParts = @()
                                            $setParamValues = @()
                                            $paramIdx = 0
                                            for ($c = 0; $c -lt $loadedColumns.Count; $c++) {
                                                $col = $loadedColumns[$c]
                                                if ($col.Name -in $pkColumns -or $col.UseDefault) { continue }
                                                $setParts += "[$($col.Name)] = @set$paramIdx"
                                                $setParamValues += $row[$c]
                                                $paramIdx++
                                            }
                                            if ($setParts.Count -gt 0) {
                                                $whereParamParts = @()
                                                $whereParamValues = @()
                                                $pkIdx = 0
                                                foreach ($pkCol in $pkColumns) {
                                                    $colIdx = [array]::IndexOf(($loadedColumns | ForEach-Object { $_.Name }), $pkCol)
                                                    if ($colIdx -ge 0) {
                                                        $whereParamParts += "[$pkCol] = @pk$pkIdx"
                                                        $whereParamValues += $row[$colIdx]
                                                        $pkIdx++
                                                    }
                                                }
                                                $updateSql = "UPDATE [$schemaName].[$tableName] SET " + ($setParts -join ', ') + " WHERE " + ($whereParamParts -join ' AND ')
                                                $cmd.CommandText = $updateSql
                                                $cmd.Parameters.Clear()
                                                for ($i = 0; $i -lt $setParamValues.Count; $i++) {
                                                    $val = $setParamValues[$i]
                                                    $paramVal = if ($null -eq $val -or $val -is [DBNull]) { [DBNull]::Value } else { $val }
                                                    $null = $cmd.Parameters.AddWithValue("@set$i", $paramVal)
                                                }
                                                for ($i = 0; $i -lt $whereParamValues.Count; $i++) {
                                                    $val = $whereParamValues[$i]
                                                    $paramVal = if ($null -eq $val -or $val -is [DBNull]) { [DBNull]::Value } else { $val }
                                                    $null = $cmd.Parameters.AddWithValue("@pk$i", $paramVal)
                                                }
                                                try {
                                                    $cmd.ExecuteNonQuery() | Out-Null
                                                    $updatedRows++
                                                } catch {
                                                    if (-not $updateErrorLogged) {
                                                        Write-Log "    Update failed (first row): $($_.Exception.Message)"
                                                        $updateErrorLogged = $true
                                                    }
                                                    $skippedRows++
                                                }
                                                $cmd.Parameters.Clear()
                                            } else {
                                                $skippedRows++
                                            }
                                        } else {
                                            $skippedRows++
                                        }
                                    }
                                }
                                catch {
                                    # If we still get duplicate errors, just skip this row
                                    if (-not $updateErrorLogged) {
                                        Write-Log "    Insert/Update failed (first row): $($_.Exception.Message)"
                                        if ($_.ScriptStackTrace) { Write-Log "    Stack: $($_.ScriptStackTrace)" }
                                        $updateErrorLogged = $true
                                    }
                                    $skippedRows++
                                }
                                
                                $processed = $insertedRows + $updatedRows + $skippedRows
                                if ($processed % 500 -eq 0) {
                                    $msg = "    ...processed $processed rows ($insertedRows inserted, $updatedRows updated, $skippedRows skipped)"
                                    Write-Log $msg
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
                                
                                if ($col.UseDefault) {
                                    # Column excluded from INSERT column list - skip value entirely
                                    continue
                                }
                                elseif ($value -is [DBNull] -or $null -eq $value) {
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
                                elseif ($col.Type -eq 'vector') {
                                    # VECTOR columns need CAST from JSON string
                                    $escapedVal = $value.ToString().Replace("'", "''")
                                    $values += "CAST(N'$escapedVal' AS VECTOR(1536))"
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
                        
                        if ($insertedRows % 1000 -eq 0) {
                            Write-Log "    ...inserted $insertedRows rows"
                        }
                        }
                    }
                    
                    # Disable IDENTITY_INSERT if it was enabled
                    if ($hasIdentityColumn) {
                        $cmd.CommandText = "SET IDENTITY_INSERT [$schemaName].[$tableName] OFF"
                        $cmd.ExecuteNonQuery() | Out-Null
                    }
                    
                    $transaction.Commit()
                    $loadedCount = $insertedRows + $updatedRows
                    $msg = "Successfully loaded $loadedCount rows"
                    if ($insertedRows -gt 0 -and $updatedRows -gt 0) { $msg += " ($insertedRows inserted, $updatedRows updated)" }
                    elseif ($updatedRows -gt 0) { $msg += " ($updatedRows updated)" }
                    if ($skippedRows -gt 0) { $msg += " ($skippedRows duplicates skipped)" }
                    Write-Log "    $msg"
                    $csvLoadSuccess++
                }
                catch {
                    $transaction.Rollback()
                    throw
                }
                finally {
                    if ($hasIdentityColumn) {
                        $cmd.Transaction = $null
                        try {
                            $cmd.CommandText = "SET IDENTITY_INSERT [$schemaName].[$tableName] OFF"
                            $cmd.ExecuteNonQuery() | Out-Null
                        } catch { }
                    }
                    $cmd.Transaction = $null
                }
            }
            else {
                # Use SqlBulkCopy for fast insert (tables without special columns or identity columns)
                Write-Log "    Bulk inserting $rowCount rows..."
                
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
                
                Write-Log "    Successfully loaded $rowCount rows"
                $csvLoadSuccess++
            }
        }
        catch {
            Write-Log "    ✗ Failed to load $($config.Table) from $($config.File): $($_.Exception.Message)"
            if ($_.Exception.InnerException) {
                Write-Log "    Inner: $($_.Exception.InnerException.Message)"
            }
            Write-Log "    Error type: $($_.Exception.GetType().FullName)"
            if ($_.ScriptStackTrace) {
                $stackLines = $_.ScriptStackTrace -split "`n"
                foreach ($line in $stackLines | Select-Object -First 5) {
                    Write-Log "    at $line"
                }
            }
            $csvLoadFailed++
        }
    }
    
$elapsed = (Get-Date) - $scriptStartTime
Write-Log "`nCSV Data Loading Summary: [+$([math]::Floor($elapsed.TotalMinutes))m]"
    Write-Log "  - $csvLoadSuccess tables loaded successfully"
    Write-Log "  - $csvLoadFailed tables failed to load"
    Write-Log "  - $csvLoadSkipped tables skipped"
    
    # CSV loading summary
    $elapsed = (Get-Date) - $scriptStartTime
    Write-Log "`n[+$([math]::Floor($elapsed.TotalMinutes))m] CSV Data Loading Complete"
    Write-Log "  ✓ Successfully loaded: $csvLoadSuccess tables"
    Write-Log "  ⊙ Skipped (file not found / no data): $csvLoadSkipped tables"
    if ($csvLoadFailed -gt 0) {
        Write-Log "  ✗ Failed: $csvLoadFailed tables"
    }

    # Apply ProductDescription embeddings from source API CSV (updates existing rows only).
    # Build the CSV with: scripts/utilities/export-product-description-embeddings-from-source-api.sh
    $embeddingsFromSourcePath = Join-Path $csvFolder 'ProductDescription-ai-embeddings.csv'
    if (Test-Path $embeddingsFromSourcePath) {
        $elapsed = (Get-Date) - $scriptStartTime
        Write-Log "`n[+$([math]::Floor($elapsed.TotalMinutes))m] Applying ProductDescription embeddings from source API CSV..."
        $updateEmbeddingSql = "UPDATE Production.ProductDescription SET DescriptionEmbedding = CAST(@emb AS VECTOR(1536)), ModifiedDate = @mod WHERE ProductDescriptionID = @id"
        $cmd.Transaction = $null
        $cmd.CommandText = $updateEmbeddingSql
        $lines = Get-Content -Path $embeddingsFromSourcePath -Encoding UTF8
        $applied = 0
        $batchSize = 100
        for ($i = 1; $i -lt $lines.Count; $i++) {
            $line = $lines[$i]
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $parts = $line -split "`t", 3
            if ($parts.Count -lt 2) { continue }
            $id = [int]::Parse($parts[0].Trim())
            if ($id -eq 0) { continue }
            $embJson = $parts[1].Trim()
            $modStr = if ($parts.Count -ge 3 -and -not [string]::IsNullOrWhiteSpace($parts[2])) { $parts[2].Trim() } else { $null }
            $cmd.Parameters.Clear()
            $null = $cmd.Parameters.AddWithValue('@id', $id)
            $null = $cmd.Parameters.AddWithValue('@emb', $embJson)
            if ($null -ne $modStr) {
                try {
                    $modDate = [DateTime]::Parse($modStr)
                    $null = $cmd.Parameters.AddWithValue('@mod', $modDate)
                } catch {
                    $null = $cmd.Parameters.AddWithValue('@mod', [DateTime]::UtcNow)
                }
            } else {
                $null = $cmd.Parameters.AddWithValue('@mod', [DateTime]::UtcNow)
            }
            try {
                $n = $cmd.ExecuteNonQuery()
                if ($n -gt 0) { $applied++ }
            } catch {
                Write-Log "  Warning: Update failed for ProductDescriptionID $id : $($_.Exception.Message)"
            }
            if ($applied -gt 0 -and $applied % $batchSize -eq 0) {
                Write-Log "  ...applied $applied embedding updates"
            }
        }
        Write-Log "  Applied $applied ProductDescription embedding updates from ProductDescription-ai-embeddings.csv"
    }

    # Apply ProductReview UserID from ProductReview-ai-UserID.csv (assigns random Individual Person IDs to reviews).
    # Generate with: node scripts/utilities/generate-product-review-userids.js (requires API_URL pointing at DAB).
    $productReviewUserIDPath = Join-Path $csvFolder 'ProductReview-ai-UserID.csv'
    if (Test-Path $productReviewUserIDPath) {
        $elapsed = (Get-Date) - $scriptStartTime
        Write-Log "`n[+$([math]::Floor($elapsed.TotalMinutes))m] Applying ProductReview UserID from ProductReview-ai-UserID.csv..."
        $updateUserIDSql = "UPDATE Production.ProductReview SET UserID = @uid, ModifiedDate = GETDATE() WHERE ProductReviewID = @rid"
        $cmd.Transaction = $null
        $cmd.CommandText = $updateUserIDSql
        $lines = Get-Content -Path $productReviewUserIDPath -Encoding UTF8
        $applied = 0
        $batchSize = 500
        for ($i = 1; $i -lt $lines.Count; $i++) {
            $line = $lines[$i]
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $parts = $line -split "`t", 2
            if ($parts.Count -lt 2) { continue }
            $rid = [int]::Parse($parts[0].Trim())
            $uid = [int]::Parse($parts[1].Trim())
            $cmd.Parameters.Clear()
            $null = $cmd.Parameters.AddWithValue('@rid', $rid)
            $null = $cmd.Parameters.AddWithValue('@uid', $uid)
            try {
                $n = $cmd.ExecuteNonQuery()
                if ($n -gt 0) { $applied++ }
            } catch {
                Write-Log "  Warning: Update failed for ProductReviewID $rid : $($_.Exception.Message)"
            }
            if ($applied -gt 0 -and $applied % $batchSize -eq 0) {
                Write-Log "  ...applied $applied UserID updates"
            }
        }
        Write-Log "  Applied $applied ProductReview UserID updates from ProductReview-ai-UserID.csv"
    }

    # Apply CommentsEmbedding for the 4 original AdventureWorks ProductReview records.
    # These rows are seeded from ProductReview.csv with CommentsEmbedding left NULL because
    # the hex-encoded comments cannot be embedded at bulk-insert time.
    # Generate this file with: scripts/generators/generate-original-review-embeddings.sh
    $reviewEmbeddingsPath = Join-Path $csvFolder 'ProductReview-ai-Embeddings.csv'
    if (Test-Path $reviewEmbeddingsPath) {
        $elapsed = (Get-Date) - $scriptStartTime
        Write-Log "`n[+$([math]::Floor($elapsed.TotalMinutes))m] Applying ProductReview embeddings from ProductReview-ai-Embeddings.csv..."
        $updateReviewEmbSql = "UPDATE Production.ProductReview SET CommentsEmbedding = CAST(@emb AS VECTOR(1536)), ModifiedDate = @mod WHERE ProductReviewID = @rid AND CommentsEmbedding IS NULL"
        $cmd.Transaction = $null
        $cmd.CommandText = $updateReviewEmbSql
        $lines = Get-Content -Path $reviewEmbeddingsPath -Encoding UTF8
        $applied = 0
        $batchSize = 10
        for ($i = 1; $i -lt $lines.Count; $i++) {
            $line = $lines[$i]
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $parts = $line -split "`t", 3
            if ($parts.Count -lt 2) { continue }
            $rid = [int]::Parse($parts[0].Trim())
            if ($rid -eq 0) { continue }
            $embJson = $parts[1].Trim()
            $modStr = if ($parts.Count -ge 3 -and -not [string]::IsNullOrWhiteSpace($parts[2])) { $parts[2].Trim() } else { $null }
            $cmd.Parameters.Clear()
            $null = $cmd.Parameters.AddWithValue('@rid', $rid)
            $null = $cmd.Parameters.AddWithValue('@emb', $embJson)
            if ($null -ne $modStr) {
                try {
                    $modDate = [DateTime]::Parse($modStr)
                    $null = $cmd.Parameters.AddWithValue('@mod', $modDate)
                } catch {
                    $null = $cmd.Parameters.AddWithValue('@mod', [DateTime]::UtcNow)
                }
            } else {
                $null = $cmd.Parameters.AddWithValue('@mod', [DateTime]::UtcNow)
            }
            try {
                $n = $cmd.ExecuteNonQuery()
                if ($n -gt 0) { $applied++ }
            } catch {
                Write-Log "  Warning: Embedding update failed for ProductReviewID $rid : $($_.Exception.Message)"
            }
        }
        Write-Log "  Applied $applied ProductReview embedding updates from ProductReview-ai-Embeddings.csv"
    }

    # Remove any stray ProductDescriptionID 0 row (placeholder from malformed CSV or parse fallback)
    try {
        $cmd.CommandText = "DELETE FROM Production.ProductDescription WHERE ProductDescriptionID = 0"
        $deleted = $cmd.ExecuteNonQuery()
        if ($deleted -gt 0) { Write-Log "  Removed $deleted placeholder row(s) (ProductDescriptionID = 0)" }
    } catch { }

    # Remove any stray ProductReviewID 0 row (parse-error fallback from a failed seed run)
    try {
        $cmd.CommandText = "DELETE FROM Production.ProductReview WHERE ProductReviewID = 0"
        $deleted = $cmd.ExecuteNonQuery()
        if ($deleted -gt 0) { Write-Log "  Removed $deleted placeholder row(s) (ProductReviewID = 0)" }
    } catch { }

    # Log ProductDescription embedding coverage (after applying source CSV if present)
    try {
        $cmd.CommandText = "SELECT SUM(CASE WHEN DescriptionEmbedding IS NOT NULL THEN 1 ELSE 0 END) AS WithEmb, SUM(CASE WHEN DescriptionEmbedding IS NULL THEN 1 ELSE 0 END) AS MissingEmb, COUNT(*) AS Total FROM Production.ProductDescription"
        $cmd.Transaction = $null
        $rd = $cmd.ExecuteReader()
        if ($rd.Read()) {
            $withEmb = [int64]($rd.GetValue(0)); $missEmb = [int64]($rd.GetValue(1)); $tot = [int64]($rd.GetValue(2))
            $rd.Close()
            Write-Log "  ProductDescription embeddings: $withEmb with embedding, $missEmb missing (of $tot total). Backfill NULLs via GenerateProductEmbeddings if needed."
        } else { $rd.Close() }
    } catch {
        # Non-fatal: schema or table may differ
    }

    # Remove placeholder image (ProductPhotoID 1 "no image available") from product-photo mappings.
    # This must run AFTER ProductProductPhoto.csv and ProductProductPhoto-ai.csv are loaded;
    # AdventureWorks-AI.sql used to run this before any CSV load (empty table), so it had no effect.
    $elapsed = (Get-Date) - $scriptStartTime
    Write-Log "`n[+$([math]::Floor($elapsed.TotalMinutes))m] Removing placeholder ProductPhotoID 1 and setting Primary photo..."
    try {
        $cmd.CommandText = "DELETE FROM [Production].[ProductProductPhoto] WHERE [ProductPhotoID] = 1"
        $deleted = $cmd.ExecuteNonQuery()
        Write-Log "  Removed $deleted ProductProductPhoto row(s) referencing placeholder image (ProductPhotoID 1)"
        $cmd.CommandText = @"
WITH RankedPhotos AS (
    SELECT ProductID, ProductPhotoID,
           ROW_NUMBER() OVER (PARTITION BY ProductID ORDER BY ModifiedDate DESC) AS PhotoRank
    FROM [Production].[ProductProductPhoto]
)
UPDATE pp
SET pp.[Primary] = CASE WHEN rp.PhotoRank = 1 THEN 1 ELSE 0 END
FROM [Production].[ProductProductPhoto] pp
INNER JOIN RankedPhotos rp ON pp.ProductID = rp.ProductID AND pp.ProductPhotoID = rp.ProductPhotoID
"@
        $null = $cmd.ExecuteNonQuery()
        Write-Log "  Updated Primary flag: most recent photo set as Primary for all products"
    } catch {
        Write-Warning "  Placeholder photo cleanup failed: $($_.Exception.Message)"
    }
    
    # Wait for background PNG upload job to complete
    $elapsed = (Get-Date) - $scriptStartTime
    Write-Log "`n[+$([math]::Floor($elapsed.TotalMinutes))m] Waiting for PNG image upload to complete..."
    
    # Wait for the job and get results
    $pngResult = Receive-Job -Job $pngUploadJob -Wait
    $pngJobState = $pngUploadJob.State
    $pngJobError = $pngUploadJob.Error
    Remove-Job -Job $pngUploadJob
    
    $elapsed = (Get-Date) - $scriptStartTime
    Write-Log "`nPNG Upload Summary: [+$([math]::Floor($elapsed.TotalMinutes))m]"
    
    # Job failed before returning (e.g. runspace/assembly error)
    if ($pngJobState -eq 'Failed') {
        Write-Log "  PNG upload job failed (job state: Failed). Error: $($pngJobError | Out-String)"
    }
    # No result object (serialization or job never produced output)
    elseif ($null -eq $pngResult) {
        Write-Log "  PNG upload job returned no output (job may have failed or serialization issue). Job state: $pngJobState"
    }
    # Result may be a hashtable with string keys from deserialization
    elseif ($true -eq $pngResult.AlreadyLoaded) {
        Write-Log "  AI-generated photos already uploaded - Skipping"
    }
    elseif ($true -eq $pngResult.NoDirec) {
        Write-Log "  Images directory not found - Skipping"
    }
    elseif ($true -eq $pngResult.NoFiles) {
        Write-Log "  No PNG files found in images directory"
    }
    elseif ($pngResult.Failed -eq -1) {
        Write-Log "  PNG upload job failed: $($pngResult.Error)"
        if ($pngResult.StackTrace) {
            Write-Log "  Stack trace: $($pngResult.StackTrace)"
        }
    }
    elseif ($null -ne $pngResult.TotalFiles -or $null -ne $pngResult.Uploaded) {
        $largeImageCount = [int]$pngResult.TotalFiles - [int]$pngResult.ThumbnailCount
        Write-Log "  Found $($pngResult.TotalFiles) PNG files ($($pngResult.ThumbnailCount) thumbnails, $largeImageCount large images)"
        Write-Log "  Processed $($pngResult.ImagePairCount) image pairs using parallel upload (2 threads)"
        if ($pngResult.ImagePairCount -eq 0 -and $pngResult.TotalFiles -gt 0) {
            Write-Log "  No image pairs formed (expected *_thumb.png / *_small.png with matching .png; check images/ naming)"
        }
        Write-Log "  - $($pngResult.Uploaded) image pairs uploaded successfully"
        if ($pngResult.Skipped -gt 0) {
            Write-Log "  - $($pngResult.Skipped) files skipped (already exist)"
        }
        if ($pngResult.Failed -gt 0) {
            Write-Log "  - $($pngResult.Failed) files failed"
            if ($pngResult.Errors) {
                Write-Log "  First few errors: $($pngResult.Errors -join '; ')"
            }
        }
    }
    else {
        Write-Log "  PNG upload result was unexpected. Job state: $pngJobState. Result: $($pngResult | ConvertTo-Json -Compress -Depth 3)"
    }
    
    # Note: ProductProductPhoto-ai.csv mappings are loaded earlier in the CSV data loading section
    
    $conn.Close()
}
catch {
    Write-Error "Failed to execute database seeding: $($_.Exception.Message)"
} finally {
    $scriptEndTime = Get-Date
    $scriptDuration = $scriptEndTime - $scriptStartTime
    Write-Log "`n=========================================="
    Write-Log "DATABASE SEEDING SCRIPT COMPLETED SUCCESSFULLY"
    Write-Log "Finished at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Write-Log "Total duration: $([math]::Floor($scriptDuration.TotalMinutes))m $($scriptDuration.Seconds)s"
    Write-Log "=========================================="
}

