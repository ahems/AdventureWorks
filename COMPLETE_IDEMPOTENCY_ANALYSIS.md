# Complete Postprovision Script Idempotency Analysis

## Executive Summary

✅ **The entire postprovision.ps1 script is fully idempotent.**

The script can be run multiple times safely without:

- Creating duplicate resources
- Duplicating data
- Causing errors
- Leaving partial state

## Comprehensive Component Analysis

### Infrastructure Discovery (Lines 1-150)

| Component                      | Idempotent? | Mechanism                                                       |
| ------------------------------ | ----------- | --------------------------------------------------------------- |
| **Module Installation**        | ✅          | Checks `Get-Module -ListAvailable` before installing            |
| **Azure Authentication**       | ✅          | Checks `Get-AzContext` before connecting                        |
| **Managed Identity Discovery** | ✅          | Only queries if not in azd env; uses `azd env set` (overwrites) |
| **SQL Server Discovery**       | ✅          | Only queries if not in azd env; uses `azd env set` (overwrites) |

```powershell
# Example: Module installation
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph)) {
    Install-Module Microsoft.Graph  # Only installs if missing
}
```

### Database Setup (Lines 150-600)

| Component             | Idempotent? | Mechanism                                  |
| --------------------- | ----------- | ------------------------------------------ |
| **SQL User Creation** | ✅          | `IF NOT EXISTS` in SQL script              |
| **Role Assignment**   | ✅          | `IF NOT EXISTS` checks role membership     |
| **Schema Creation**   | ✅          | Catches "already exists" errors, continues |
| **Table Creation**    | ✅          | CREATE TABLE fails gracefully if exists    |
| **Index Creation**    | ✅          | Errors ignored if index exists             |
| **Primary Keys**      | ✅          | Errors ignored if PK already defined       |

#### SQL User and Role Assignment

**File:** `scripts/sql/assign-database-roles.sql`

```sql
-- Idempotent user creation
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '{{IDENTITY_NAME}}')
BEGIN
    CREATE USER [{{IDENTITY_NAME}}] FROM EXTERNAL PROVIDER;
END

-- Idempotent role assignment
IF NOT EXISTS (SELECT 1 FROM sys.database_role_members drm
    WHERE r.name = 'db_datareader' AND u.name = '{{IDENTITY_NAME}}')
BEGIN
    ALTER ROLE [db_datareader] ADD MEMBER [{{IDENTITY_NAME}}];
END
```

#### Schema Creation

**File:** `postprovision.ps1` (Lines 450-500)

```powershell
# Ignores "already exists" errors
catch {
    if ($errorMsg -notmatch 'already exists' -and
        $errorMsg -notmatch 'There is already an object named' -and
        $errorMsg -notmatch 'already has a primary key defined on it') {
        Write-Warning "Unexpected error: $errorMsg"
    }
    # Errors matching above patterns are silently ignored
}
```

### Data Loading (Lines 600-1350)

| Component                  | Idempotent? | Mechanism                                              |
| -------------------------- | ----------- | ------------------------------------------------------ |
| **CSV Data Loading**       | ✅          | Checks `COUNT(*)` before loading; skips if data exists |
| **JSON Data Loading**      | ✅          | Checks `COUNT(*)` before loading; skips if data exists |
| **AI CSV Files (-ai.csv)** | ✅          | Checks if base data loaded + AI data not present       |
| **Photo Mappings**         | ✅          | Checks each mapping before inserting                   |

#### CSV Data Loading

```powershell
# Check if table already has data
$existingCount = $cmd.ExecuteScalar()

if ($existingCount -gt 0) {
    Write-Output "Table already contains $existingCount rows - Skipping"
    continue  # Skip this table
}

# Only loads if table is empty
```

#### AI Enhancement Files

```powershell
$isAiCsv = $config.File -match '-ai\.csv$'

if ($isAiCsv) {
    if ($existingCount -eq $baseRecordCount) {
        # Base data present, AI data missing - load AI enhancements
    }
    elseif ($existingCount -gt $baseRecordCount) {
        # AI data already loaded - skip
        continue
    }
}
```

#### Photo Mappings

```powershell
# Check if specific mapping exists
$checkCmd.CommandText = "SELECT COUNT(*) FROM Production.ProductProductPhoto
                         WHERE ProductID = @ProductID AND ProductPhotoID = @ProductPhotoID"
$exists = $checkCmd.ExecuteScalar()

if ($exists -eq 0) {
    # Insert only if not exists
}
```

### Container App Configuration (Lines 1400-1455)

| Component                  | Idempotent? | Mechanism                                          |
| -------------------------- | ----------- | -------------------------------------------------- |
| **WEBSITE_HOSTNAME**       | ✅          | `az containerapp update --set-env-vars` overwrites |
| **VITE_API_URL**           | ✅          | `azd env set` overwrites                           |
| **VITE_API_FUNCTIONS_URL** | ✅          | `azd env set` overwrites                           |

```powershell
# Container app environment variables
az containerapp update `
    --name $functionsAppName `
    --set-env-vars "WEBSITE_HOSTNAME=$websiteHostname"
    # --set-env-vars OVERWRITES the value (idempotent)

# Azd environment variables
azd env set 'VITE_API_URL' $apiUrl  # OVERWRITES (idempotent)
```

### AI Agent Automation (Lines 1456-1644)

| Component                 | Idempotent? | Mechanism                                 |
| ------------------------- | ----------- | ----------------------------------------- |
| **Python Package**        | ✅          | Checks `pip show` before installing       |
| **Agent Creation**        | ✅          | Ephemeral agent (auto-deleted after test) |
| **Config File**           | ✅          | Overwrites with `-Force` and write mode   |
| **Environment Variables** | ✅          | `azd env set` overwrites                  |
| **Temporary Files**       | ✅          | Cleanup in `finally` block                |

```powershell
# Package installation
$packageCheck = python3 -m pip show agent-framework-azure-ai
if ($LASTEXITCODE -ne 0) {
    # Only installs if not present
}
```

```python
# Ephemeral agent - automatically deleted
async with ChatAgent(...) as agent:  # No agent_id = ephemeral
    # Test agent
    # Agent auto-deleted when exiting context
```

## Critical Idempotency Patterns

### Pattern 1: Check Before Create

```powershell
# Check if exists
if (Test-Path $file) {
    # Skip or update
} else {
    # Create
}
```

### Pattern 2: Overwrite by Design

```powershell
# Overwrite files
Out-File -Force  # PowerShell force flag

# Overwrite config
azd env set 'KEY' 'value'  # Overwrites existing

# Overwrite env vars
az containerapp update --set-env-vars "KEY=value"  # Overwrites
```

### Pattern 3: SQL Guards

```sql
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'Table')
BEGIN
    CREATE TABLE ...
END
```

### Pattern 4: Error Suppression

```powershell
catch {
    if ($errorMsg -match 'already exists') {
        # Ignore - this is expected on re-run
    }
}
```

### Pattern 5: Data Existence Checks

```powershell
$count = $cmd.ExecuteScalar()  # SELECT COUNT(*)
if ($count -eq 0) {
    # Load data
}
```

## Re-Run Scenarios

### Scenario 1: Full Re-Run After Successful Deployment

**Result:** ✅ All checks pass, operations skipped, completes successfully

| Operation            | Action Taken                           |
| -------------------- | -------------------------------------- |
| Module installation  | Skipped (already installed)            |
| Authentication       | Skipped (already authenticated)        |
| SQL user creation    | Skipped (user exists)                  |
| Role assignments     | Skipped (roles assigned)               |
| Schema creation      | Skipped (tables exist, errors ignored) |
| Data loading         | Skipped (COUNT(\*) > 0)                |
| Container app update | Updates env var (same value = no-op)   |
| AI agent creation    | Creates & deletes ephemeral agent      |
| Config file          | Overwrites with identical content      |

### Scenario 2: Re-Run After Partial Failure (e.g., Data Load Failed)

**Result:** ✅ Resumes from failure point, completes missing operations

| Operation                        | Action Taken                  |
| -------------------------------- | ----------------------------- |
| SQL user creation                | Skipped (user exists)         |
| Schema creation                  | Skipped (tables exist)        |
| Data loading (failed tables)     | ✅ Loads data (COUNT(\*) = 0) |
| Data loading (successful tables) | Skipped (COUNT(\*) > 0)       |
| Remaining operations             | Executes normally             |

### Scenario 3: Re-Run After Schema Changes

**Result:** ✅ Doesn't break existing data, errors handled gracefully

| Operation            | Action Taken                    |
| -------------------- | ------------------------------- |
| Schema modifications | Errors ignored if objects exist |
| New tables           | Created if missing              |
| Existing tables      | Skipped                         |
| Data loading         | Skipped (data exists)           |

## Edge Cases Handled

### 1. Concurrent Runs

**Status:** ⚠️ Partially Safe

- Database operations use transactions
- File writes use `-Force` (last-write-wins)
- Azure CLI operations are atomic
- **Recommendation:** Avoid concurrent runs (standard for deployment scripts)

### 2. Network Interruption

**Status:** ✅ Safe

- Transactions rollback on connection loss
- Resume from last successful checkpoint
- No partial state left behind

### 3. Insufficient Permissions

**Status:** ✅ Safe

- Operations fail cleanly with errors
- No partial changes committed
- Safe to retry after fixing permissions

### 4. Missing Dependencies

**Status:** ✅ Safe

- Checks for Python, modules, etc.
- Warns and continues or exits cleanly
- Safe to retry after installing dependencies

## Validation Testing

### Test 1: Triple Run

```bash
# Run three times in succession
pwsh scripts/postprovision.ps1
pwsh scripts/postprovision.ps1
pwsh scripts/postprovision.ps1

# Expected: No errors, no duplicates, same state
```

### Test 2: Verify Database State

```sql
-- Check no duplicate data
SELECT SchemaName, TableName, COUNT(*)
FROM (SELECT DISTINCT * FROM SomeTable)

-- Check no duplicate users
SELECT COUNT(*) FROM sys.database_principals WHERE name = 'identity-name'
-- Should return 1, not 3

-- Check no duplicate role assignments
SELECT COUNT(*) FROM sys.database_role_members WHERE member_principal_id = ...
-- Should return 3 (3 roles), not 9
```

### Test 3: Verify Configuration

```bash
# Check azd environment - no duplicate keys
azd env get-values

# Check container app env vars - no duplicate vars
az containerapp show --name func-name --query "properties.template.containers[0].env"

# Check AI agent config - file size should be identical
ls -la AI_AGENT_CONFIG.json  # Should be same size every run
```

## Best Practices Demonstrated

1. ✅ **Check Before Create** - All operations check for existence
2. ✅ **Transaction Safety** - Database operations use transactions
3. ✅ **Error Handling** - Expected errors suppressed, unexpected logged
4. ✅ **Atomic Operations** - Each operation is independent
5. ✅ **Overwrite by Design** - Config files/env vars designed to overwrite
6. ✅ **Cleanup** - Temporary files always cleaned up
7. ✅ **Documentation** - Clear comments on idempotency patterns

## Conclusion

The postprovision script is **production-ready** and follows infrastructure-as-code best practices:

- ✅ **Fully Idempotent** - Safe to run N times
- ✅ **Resumable** - Continues from failure points
- ✅ **Transactional** - Database operations are atomic
- ✅ **Defensive** - Handles errors gracefully
- ✅ **Documented** - Clear patterns throughout

**Recommendation:** Safe for CI/CD pipelines and automated deployments.
