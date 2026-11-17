using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.SqlClient;

internal static class SqlPermissions
{
    internal sealed record Check(string id, string group, string status, string detail);
    internal sealed record Observation(string Kind, string Target, string Permission, int? Allowed);

    internal static readonly string[] ForbiddenRoles =
        ["db_owner", "db_securityadmin", "db_accessadmin", "db_ddladmin", "db_backupoperator"];
    internal static readonly string[] ForbiddenDatabasePermissions =
        ["CONTROL", "ALTER", "ALTER ANY ROLE", "ALTER ANY USER",
         "ALTER ANY SCHEMA", "CREATE TABLE", "CREATE PROCEDURE", "CREATE FUNCTION",
         "CREATE VIEW", "CREATE SCHEMA", "TAKE OWNERSHIP", "ALTER ANY DATABASE SCOPED CONFIGURATION"];
    internal static readonly string[] RequiredRoles = ["db_datareader", "db_datawriter"];

    internal static Check Evaluate(Observation item)
    {
        var deny = item.Kind is "forbidden-role" or "database-admin" or "schema-admin" or "object-admin" or "user-impersonate";
        var allow = item.Kind is "required-role" or "database-execute" or "table-data" or "routine-execute" or "identity" or "required-metadata";
        if (!deny && !allow)
            throw new InvalidOperationException("Unknown SQL permission evidence kind.");
        if (item.Allowed is not (null or 0 or 1))
            throw new InvalidOperationException("Invalid SQL permission value.");
        return new Check($"sql:{item.Kind}:{item.Target}:{item.Permission}", "sql-effective",
            item.Allowed is null ? "BLOCKED" : item.Allowed == (deny ? 0 : 1) ? "PASS" : "FAIL",
            $"{item.Kind} {item.Target} / {item.Permission}: " +
            (item.Allowed is null ? "SQL returned unknown; not absence of access."
                : deny ? "Effective administrative/DDL permission must be absent."
                : "Effective permission/identity required by the shared runtime data-access contract."));
    }

    internal static async Task<IReadOnlyList<Check>> ReadAsync(SqlConnection connection, Guid clientId)
    {
        var checks = new List<Check>();
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 90;
        command.Parameters.Add("@ClientId", SqlDbType.UniqueIdentifier).Value = clientId;
        command.CommandText = """
            SELECT 'identity', 'current-user', 'external-client-sid',
                CONVERT(int, CASE WHEN type='E' AND sid=CONVERT(binary(16),@ClientId) THEN 1 ELSE 0 END)
            FROM sys.database_principals WHERE principal_id=USER_ID();
            """;
        checks.AddRange(await ReadRows(command));
        if (checks.Count != 1)
            throw new InvalidOperationException("Missing current contained principal evidence.");
        command.Parameters.Clear();
        command.CommandText = """
            SELECT 'required-metadata', 'Production.ProductReview', 'view-definition',
                HAS_PERMS_BY_NAME('Production.ProductReview','OBJECT','VIEW DEFINITION');
            SELECT 'required-metadata', 'Production.ProductReview', 'defaults-present',
                CONVERT(int, CASE WHEN COUNT(*)=4
                    AND SUM(CASE WHEN default_object_id<>0 THEN 1 ELSE 0 END)=4 THEN 1 ELSE 0 END)
            FROM sys.columns
            WHERE object_id=OBJECT_ID('Production.ProductReview')
                AND name IN ('ReviewDate','ModifiedDate','HelpfulVotes','IsModerated');
            SELECT 'required-metadata', 'Production.ProductReview', 'default-definitions',
                CONVERT(int, CASE WHEN COUNT(*)=4
                    AND COUNT(d.definition)=4 THEN 1 ELSE 0 END)
            FROM sys.columns c
            LEFT JOIN sys.default_constraints d ON c.default_object_id=d.object_id
            WHERE c.object_id=OBJECT_ID('Production.ProductReview')
                AND c.name IN ('ReviewDate','ModifiedDate','HelpfulVotes','IsModerated');
            """;
        checks.AddRange(await ReadRows(command));

        foreach (var role in ForbiddenRoles.Concat(RequiredRoles))
        {
            command.Parameters.Clear();
            command.CommandText = "SELECT @Kind, @Role, 'membership', IS_ROLEMEMBER(@Role);";
            command.Parameters.AddWithValue("@Kind", ForbiddenRoles.Contains(role) ? "forbidden-role" : "required-role");
            command.Parameters.AddWithValue("@Role", role);
            checks.AddRange(await ReadRows(command));
        }
        foreach (var permission in ForbiddenDatabasePermissions.Append("EXECUTE"))
        {
            command.Parameters.Clear();
            command.CommandText = "SELECT @Kind, 'database', @Permission, HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE',@Permission);";
            command.Parameters.AddWithValue("@Kind", permission == "EXECUTE" ? "database-execute" : "database-admin");
            command.Parameters.AddWithValue("@Permission", permission);
            checks.AddRange(await ReadRows(command));
        }
        command.Parameters.Clear();
        command.CommandText = """
            SELECT 'user-impersonate', QUOTENAME(name), 'IMPERSONATE',
                HAS_PERMS_BY_NAME(QUOTENAME(name),'USER','IMPERSONATE')
            FROM sys.database_principals
            WHERE type IN ('S','U','E') AND principal_id<>USER_ID()
                AND name NOT IN ('sys','INFORMATION_SCHEMA');

            SELECT 'schema-admin', QUOTENAME(s.name), p.permission,
                HAS_PERMS_BY_NAME(QUOTENAME(s.name),'SCHEMA',p.permission)
            FROM sys.schemas s
            CROSS JOIN (VALUES('CONTROL'),('ALTER'),('TAKE OWNERSHIP')) p(permission)
            WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA');

            SELECT 'object-admin', QUOTENAME(s.name)+'.'+QUOTENAME(o.name), p.permission,
                HAS_PERMS_BY_NAME(QUOTENAME(s.name)+'.'+QUOTENAME(o.name),'OBJECT',p.permission)
            FROM sys.objects o JOIN sys.schemas s ON o.schema_id=s.schema_id
            CROSS JOIN (VALUES('CONTROL'),('ALTER'),('TAKE OWNERSHIP')) p(permission)
            WHERE o.is_ms_shipped=0 AND o.type IN ('U','V','P','PC','FN','FS','IF','TF','FT','SO');

            SELECT 'table-data', QUOTENAME(s.name)+'.'+QUOTENAME(t.name), p.permission,
                HAS_PERMS_BY_NAME(QUOTENAME(s.name)+'.'+QUOTENAME(t.name),'OBJECT',p.permission)
            FROM sys.tables t JOIN sys.schemas s ON t.schema_id=s.schema_id
            CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(permission)
            WHERE t.is_ms_shipped=0;

            SELECT 'routine-execute', QUOTENAME(s.name)+'.'+QUOTENAME(o.name), 'EXECUTE',
                HAS_PERMS_BY_NAME(QUOTENAME(s.name)+'.'+QUOTENAME(o.name),'OBJECT','EXECUTE')
            FROM sys.objects o JOIN sys.schemas s ON o.schema_id=s.schema_id
            WHERE o.is_ms_shipped=0 AND o.type IN ('P','PC','FN','FS');
            """;
        var objectChecks = await ReadRows(command);
        foreach (var kind in new[] { "user-impersonate", "schema-admin", "object-admin", "table-data", "routine-execute" })
        {
            var matches = objectChecks.Where(item => item.id.StartsWith("sql:" + kind + ":", StringComparison.Ordinal))
                .OrderBy(item => item.id, StringComparer.Ordinal).ToArray();
            if (matches.Length == 0)
                checks.Add(new Check("sql:inventory:" + kind, "sql-effective", "BLOCKED",
                    "No visible " + kind + " targets; empty metadata is not complete effective-permission proof."));
            else
            {
                var failed = matches.Count(item => item.status == "FAIL");
                var unknown = matches.Count(item => item.status == "BLOCKED");
                var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(matches))));
                checks.Add(new Check("sql:inventory:" + kind, "sql-effective",
                    failed > 0 ? "FAIL" : unknown > 0 ? "BLOCKED" : "PASS",
                    $"{matches.Length} visible permission observations; {failed} fail, {unknown} unknown. " +
                    $"Sorted observation SHA256: {hash}. Effective catalog permission checks only; no data exported."));
                checks.AddRange(matches.Where(item => item.status != "PASS").Take(50));
                if (failed + unknown > 50)
                    checks.Add(new Check("sql:inventory:" + kind + ":bounded-findings", "sql-effective", "BLOCKED",
                        "More than 50 nonpassing observations; summary retains total counts but detailed findings are bounded."));
            }
        }
        checks.Add(new Check("sql:shared-data-access-exception", "sql-effective", "ACCEPTED_EXCEPTION",
            "The demo deliberately shares db_datareader/db_datawriter and database EXECUTE across runtime services. " +
            "API ownership/roles are enforced above SQL; this is not per-service or row-level least privilege. " +
            "Checks cover current-user visible securables, not other principals, server grants or executable-module escalation."));
        if (checks.Select(item => item.id).Distinct().Count() != checks.Count)
            throw new InvalidOperationException("Duplicate SQL permission evidence.");
        return checks;
    }

    private static async Task<List<Check>> ReadRows(SqlCommand command)
    {
        var checks = new List<Check>();
        await using var reader = await command.ExecuteReaderAsync();
        do
        {
            while (await reader.ReadAsync())
            {
                if (checks.Count >= 20000)
                    throw new InvalidOperationException("SQL permission inventory exceeded its reviewed bound.");
                checks.Add(Evaluate(new Observation(reader.GetString(0), reader.GetString(1),
                    reader.GetString(2), reader.IsDBNull(3) ? null : reader.GetInt32(3))));
            }
        } while (await reader.NextResultAsync());
        return checks;
    }
}
