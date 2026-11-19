Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$result = [ordered]@{
    status = 'BLOCKED'
    phase = 'connect'
    token = 'BLOCKED'
    database = 'BLOCKED'
    session = 'BLOCKED'
    control = 'BLOCKED'
    catalog = 'BLOCKED'
    runtimePrincipal = 'BLOCKED'
    runtimeDataRoles = 'BLOCKED'
    runtimeExecute = 'BLOCKED'
    externalAdminRoles = 'BLOCKED'
    externalInventory = 'BLOCKED'
    externalRoleClosure = 'BLOCKED'
    externalDatabaseAdminGrants = 'BLOCKED'
    externalScopedAdminGrants = 'BLOCKED'
    dbo = $null
    owner = $null
    principalCount = $null
    privilegedExternalRoleCount = $null
    runtimeExplicitDenies = $null
    permissionEntries = $null
    transitivePrivilegedRoleCount = $null
    truncatedRolePathCount = $null
    publicRoleCount = $null
    privilegedDatabaseGrantCount = $null
    privilegedScopedGrantCount = $null
}
$connection = $null
$reader = $null
try {
    Import-Module Az.Accounts -ErrorAction Stop | Out-Null
    Disable-AzContextAutosave -Scope Process | Out-Null
    Connect-AzAccount -Identity -AccountId $seedProbeConfig.clientId `
        -TenantId $seedProbeConfig.tenantId -ErrorAction Stop | Out-Null
    $result.phase = 'token'
    $rawToken = (Get-AzAccessToken -ResourceUrl 'https://database.windows.net/').Token
    if ($rawToken -is [Security.SecureString]) {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($rawToken)
        try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    } else {
        $token = [string]$rawToken
    }
    $result.token = 'FAIL'
    $result.status = 'FAIL'
    $parts = $token.Split('.')
    if ($parts.Length -ne 3) { throw 'Malformed SQL token' }
    $payload = $parts[1].Replace('-', '+').Replace('_', '/')
    $payload = $payload.PadRight([int]([Math]::Ceiling($payload.Length / 4.0) * 4), '=')
    $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
    $client = if ($claims.PSObject.Properties.Name -contains 'azp') { $claims.azp } else { $claims.appid }
    if ([string]$claims.oid -ine $seedProbeConfig.principalId -or
        [string]$claims.tid -ine $seedProbeConfig.tenantId -or
        [string]$client -ine $seedProbeConfig.clientId -or
        [string]$claims.aud -notin @('https://database.windows.net/', 'https://database.windows.net')) {
        $result.token = 'FAIL'
        $result.status = 'FAIL'
        throw 'Unexpected SQL token identity'
    }
    $result.token = 'PASS'
    $result.status = 'BLOCKED'

    $result.phase = 'sql-connect'
    $connectionString = "Server=$($seedProbeConfig.sqlHost);Database=$($seedProbeConfig.database);Encrypt=True;TrustServerCertificate=False;Connect Timeout=30"
    $type = [System.Type]::GetType('Microsoft.Data.SqlClient.SqlConnection, Microsoft.Data.SqlClient')
    if (-not $type) { $type = [System.Data.SqlClient.SqlConnection] }
    $connection = [Activator]::CreateInstance($type, $connectionString)
    $accessTokenProperty = $type.GetProperty('AccessToken')
    if (-not $accessTokenProperty) { throw 'SQL access token support is unavailable' }
    $accessTokenProperty.SetValue($connection, $token)
    $connection.Open()

    $result.phase = 'sql-query'
    $command = $connection.CreateCommand()
    $command.CommandTimeout = 30
    $command.CommandText = @'
WITH ExternalRolePaths AS (
    SELECT m.member_principal_id AS external_principal_id, m.role_principal_id, 1 AS path_depth
    FROM sys.database_role_members m
    JOIN sys.database_principals p ON p.principal_id = m.member_principal_id
    WHERE p.type IN ('E', 'X')
    UNION ALL
    SELECT path.external_principal_id, m.role_principal_id, path.path_depth + 1
    FROM ExternalRolePaths path
    JOIN sys.database_role_members m ON m.member_principal_id = path.role_principal_id
    WHERE path.path_depth < 64
),
ExternalGrantees AS (
    SELECT p.principal_id AS external_principal_id, p.principal_id AS grantee_principal_id
    FROM sys.database_principals p
    WHERE p.type IN ('E', 'X')
    UNION
    SELECT external_principal_id, role_principal_id FROM ExternalRolePaths
    UNION
    SELECT p.principal_id, r.principal_id
    FROM sys.database_principals p
    CROSS JOIN sys.database_principals r
    WHERE p.type IN ('E', 'X') AND r.name = 'public' AND r.type = 'R'
),
ExternalRoleEvidence AS (
    SELECT
        (SELECT COUNT(*) FROM (
            SELECT DISTINCT path.external_principal_id, path.role_principal_id
            FROM ExternalRolePaths path
            JOIN sys.database_principals r ON r.principal_id = path.role_principal_id
            WHERE r.name IN ('db_owner', 'db_securityadmin', 'db_accessadmin', 'db_ddladmin', 'db_backupoperator')
        ) privileged_roles) AS PrivilegedRoleCount,
        (SELECT COUNT(*) FROM ExternalRolePaths path
            WHERE path.path_depth = 64 AND EXISTS (
                SELECT 1 FROM sys.database_role_members m WHERE m.member_principal_id = path.role_principal_id
            )) AS TruncatedPathCount,
        (SELECT COUNT(*) FROM sys.database_principals WHERE name = 'public' AND type = 'R') AS PublicRoleCount,
        (SELECT COUNT(*) FROM (
            SELECT DISTINCT g.external_principal_id, d.grantee_principal_id, d.permission_name
            FROM ExternalGrantees g
            JOIN sys.database_permissions d ON d.grantee_principal_id = g.grantee_principal_id
            WHERE d.class = 0 AND d.state IN ('G', 'W')
              AND (d.permission_name IN ('CONTROL', 'ALTER', 'TAKE OWNERSHIP', 'IMPERSONATE ANY USER',
                                         'ADMINISTER DATABASE BULK OPERATIONS')
                   OR d.permission_name LIKE 'ALTER ANY %' OR d.permission_name LIKE 'CREATE %')
        ) privileged_grants) AS PrivilegedGrantCount,
        (SELECT COUNT(*) FROM (
            SELECT DISTINCT g.external_principal_id, d.grantee_principal_id, d.class,
                            d.major_id, d.minor_id, d.permission_name
            FROM ExternalGrantees g
            JOIN sys.database_permissions d ON d.grantee_principal_id = g.grantee_principal_id
            WHERE d.state IN ('G', 'W')
              AND ((d.class IN (1, 3, 4)
                    AND d.permission_name IN ('CONTROL', 'ALTER', 'TAKE OWNERSHIP', 'IMPERSONATE'))
                   OR d.state = 'W')
        ) privileged_scoped_grants) AS PrivilegedScopedGrantCount
)
SELECT DB_NAME() AS DatabaseName, ORIGINAL_LOGIN() AS OriginalLogin,
    SUSER_SNAME() AS ServerLogin, USER_NAME() AS DatabaseUser,
    CASE WHEN SUSER_SID() IS NULL THEN NULL
         WHEN SUSER_SID() = CONVERT(binary(16), @clientId)
           OR SUSER_SID() = CONVERT(binary(16), @principalId) THEN 1 ELSE 0 END AS LoginSidMatches,
    IS_ROLEMEMBER(N'db_owner') AS IsDbOwner,
    HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', N'CONTROL') AS HasControl,
    (SELECT COUNT(*) FROM sys.database_principals WHERE type IN ('E', 'X')) AS EntraPrincipals,
    (SELECT COUNT(*) FROM sys.database_principals
        WHERE type = 'E' AND name = @runtimeName
          AND sid = CONVERT(binary(16), @runtimeClientId)) AS RuntimePrincipals,
    (SELECT COUNT(*) FROM sys.database_role_members m
        JOIN sys.database_principals p ON p.principal_id = m.member_principal_id
        JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
        WHERE p.type = 'E' AND p.name = @runtimeName
          AND p.sid = CONVERT(binary(16), @runtimeClientId)
          AND r.name IN ('db_datareader', 'db_datawriter')) AS RuntimeDataRoles,
    (SELECT COUNT(*) FROM sys.database_permissions d
        JOIN sys.database_principals p ON p.principal_id = d.grantee_principal_id
        WHERE p.type = 'E' AND p.name = @runtimeName
          AND p.sid = CONVERT(binary(16), @runtimeClientId)
          AND d.class = 0 AND d.permission_name = 'EXECUTE' AND d.state IN ('G', 'W')) AS RuntimeExecute,
    (SELECT COUNT(*) FROM sys.database_role_members m
        JOIN sys.database_principals p ON p.principal_id = m.member_principal_id
        JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
        WHERE p.type IN ('E', 'X')
          AND r.name IN ('db_owner', 'db_securityadmin', 'db_accessadmin', 'db_ddladmin', 'db_backupoperator'))
        AS PrivilegedExternalRoleMemberships,
    (SELECT COUNT(*) FROM sys.database_permissions d
        JOIN sys.database_principals p ON p.principal_id = d.grantee_principal_id
        WHERE p.type = 'E' AND p.name = @runtimeName
          AND p.sid = CONVERT(binary(16), @runtimeClientId) AND d.state = 'D') AS RuntimeExplicitDenies,
    (SELECT COUNT(*) FROM sys.database_permissions) AS PermissionEntries,
    (SELECT PrivilegedRoleCount FROM ExternalRoleEvidence) AS TransitivePrivilegedRoleCount,
    (SELECT TruncatedPathCount FROM ExternalRoleEvidence) AS TruncatedRolePathCount,
    (SELECT PublicRoleCount FROM ExternalRoleEvidence) AS PublicRoleCount,
    (SELECT PrivilegedGrantCount FROM ExternalRoleEvidence) AS PrivilegedDatabaseGrantCount,
    (SELECT PrivilegedScopedGrantCount FROM ExternalRoleEvidence) AS PrivilegedScopedGrantCount;
'@
    foreach ($entry in @(
        @{ Name = '@clientId'; Value = [guid]$seedProbeConfig.clientId; Type = [System.Data.DbType]::Guid },
        @{ Name = '@principalId'; Value = [guid]$seedProbeConfig.principalId; Type = [System.Data.DbType]::Guid },
        @{ Name = '@runtimeClientId'; Value = [guid]$seedProbeConfig.runtimeClientId; Type = [System.Data.DbType]::Guid },
        @{ Name = '@runtimeName'; Value = $seedProbeConfig.runtimeName; Type = [System.Data.DbType]::String }
    )) {
        $parameter = $command.CreateParameter()
        $parameter.ParameterName = $entry.Name
        $parameter.DbType = $entry.Type
        $parameter.Value = $entry.Value
        $null = $command.Parameters.Add($parameter)
    }
    $reader = $command.ExecuteReader()
    if (-not $reader.Read()) { throw 'SQL principal query returned no result' }
    if (-not $reader.IsDBNull(0)) {
        $result.database = if ([string]$reader.GetValue(0) -ieq $seedProbeConfig.database) { 'PASS' } else { 'FAIL' }
    }
    $names = @()
    foreach ($index in @(1, 2)) {
        if (-not $reader.IsDBNull($index)) { $names += [string]$reader.GetValue($index) }
    }
    if (-not $reader.IsDBNull(3)) { $result.dbo = [string]$reader.GetValue(3) -ieq 'dbo' }
    $sidMatches = if ($reader.IsDBNull(4)) { $null } else { [int]$reader.GetValue(4) -eq 1 }
    if ($names.Count -gt 0 -or $null -ne $sidMatches) {
        $expectedNames = @($seedProbeConfig.seedName, $seedProbeConfig.clientId, $seedProbeConfig.principalId)
        $nameMatches = @($names | Where-Object { $_ -iin $expectedNames }).Count -gt 0
        $result.session = if ($nameMatches -or $sidMatches -eq $true) { 'PASS' } else { 'FAIL' }
    }
    if (-not $reader.IsDBNull(5)) { $result.owner = [int]$reader.GetValue(5) -eq 1 }
    if (-not $reader.IsDBNull(6)) {
        $result.control = if ([int]$reader.GetValue(6) -eq 1) { 'PASS' } else { 'FAIL' }
    }
    if (-not $reader.IsDBNull(7)) {
        $result.principalCount = [int]$reader.GetValue(7)
    }
    if (-not $reader.IsDBNull(8)) {
        $runtimeMatches = [int]$reader.GetValue(8)
        $result.runtimePrincipal = if ($runtimeMatches -eq 1) { 'PASS' } else { 'FAIL' }
        if ($null -ne $result.principalCount -and $runtimeMatches -eq 1) {
            $result.externalInventory = if ($result.principalCount -eq 1) { 'PASS' } else { 'BLOCKED' }
        }
    }
    if (-not $reader.IsDBNull(9)) {
        $result.runtimeDataRoles = if ([int]$reader.GetValue(9) -eq 2) { 'PASS' } else { 'FAIL' }
    }
    if (-not $reader.IsDBNull(10)) {
        $result.runtimeExecute = if ([int]$reader.GetValue(10) -eq 1) { 'PASS' } else { 'FAIL' }
    }
    if (-not $reader.IsDBNull(11)) {
        $result.privilegedExternalRoleCount = [int]$reader.GetValue(11)
        $result.externalAdminRoles = if ($result.privilegedExternalRoleCount -eq 0) { 'PASS' } else { 'FAIL' }
    }
    if (-not $reader.IsDBNull(12)) { $result.runtimeExplicitDenies = [int]$reader.GetValue(12) }
    if (-not $reader.IsDBNull(13)) {
        $result.permissionEntries = [int]$reader.GetValue(13)
        if ($result.principalCount -gt 0 -and $result.permissionEntries -gt 0) { $result.catalog = 'PASS' }
    }
    if (-not $reader.IsDBNull(14) -and -not $reader.IsDBNull(15) -and
        -not $reader.IsDBNull(16) -and -not $reader.IsDBNull(17) -and -not $reader.IsDBNull(18)) {
        $result.transitivePrivilegedRoleCount = [int]$reader.GetValue(14)
        $result.truncatedRolePathCount = [int]$reader.GetValue(15)
        $result.publicRoleCount = [int]$reader.GetValue(16)
        $result.privilegedDatabaseGrantCount = [int]$reader.GetValue(17)
        $result.privilegedScopedGrantCount = [int]$reader.GetValue(18)
        $result.externalRoleClosure = if ($result.transitivePrivilegedRoleCount -gt 0) { 'FAIL' }
            elseif ($result.principalCount -gt 0 -and $result.truncatedRolePathCount -eq 0) { 'PASS' }
            else { 'BLOCKED' }
        $result.externalDatabaseAdminGrants = if ($result.privilegedDatabaseGrantCount -gt 0) { 'FAIL' }
            elseif ($result.principalCount -gt 0 -and $result.truncatedRolePathCount -eq 0 -and
                    $result.publicRoleCount -eq 1) { 'PASS' }
            else { 'BLOCKED' }
        $result.externalScopedAdminGrants = if ($result.privilegedScopedGrantCount -gt 0) { 'FAIL' }
            elseif ($result.principalCount -gt 0 -and $result.truncatedRolePathCount -eq 0 -and
                    $result.publicRoleCount -eq 1) { 'PASS' }
            else { 'BLOCKED' }
    }
    $result.phase = 'complete'
    $statuses = @($result.token, $result.database, $result.session, $result.control, $result.catalog,
        $result.runtimePrincipal, $result.runtimeDataRoles, $result.runtimeExecute,
        $result.externalAdminRoles, $result.externalInventory, $result.externalRoleClosure,
        $result.externalDatabaseAdminGrants, $result.externalScopedAdminGrants)
    $result.status = if ('FAIL' -in $statuses) { 'FAIL' } elseif ('BLOCKED' -in $statuses) { 'BLOCKED' } else { 'PASS' }
} catch {
    if ($result.status -ne 'FAIL') { $result.status = 'BLOCKED' }
} finally {
    try {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $connection) { $connection.Dispose() }
    } catch {
        $result.phase = 'cleanup'
        if ($result.status -ne 'FAIL') { $result.status = 'BLOCKED' }
    }
}
$json = ConvertTo-Json -InputObject $result -Compress -Depth 3
[Console]::Out.WriteLine("AUTH_SEED_SQL_PRINCIPAL:$($seedProbeConfig.nonce):$json")
if ($result.status -eq 'PASS') { exit 0 }
if ($result.status -eq 'FAIL') { exit 1 }
exit 2
