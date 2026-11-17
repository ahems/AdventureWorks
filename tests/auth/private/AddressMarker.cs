using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;

internal static class AddressMarker
{
    internal static async Task<object> ReadAsync(SqlConnection connection, JsonElement configuration, string marker)
    {
        var runId = configuration.GetProperty("runId").GetString();
        if (runId is null || runId.Length != 53 || runId[16] != '-' ||
            !Guid.TryParseExact(runId[^36..], "D", out var runGuid))
            throw new InvalidOperationException("A valid private run ID is required.");
        var prefix = runGuid.ToString("N")[..16];
        if (marker != "AuthMutation-" + prefix &&
            !Regex.IsMatch(marker, "^AuthDeny-" + prefix + "-[AB]-(anonymous|forged|dab-audience)$",
                RegexOptions.CultureInvariant))
            throw new InvalidOperationException("Address marker is not owned by this private run.");
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 30;
        command.CommandText = """
            SELECT
                (SELECT COUNT_BIG(*) FROM Person.Address WHERE AddressLine1=@marker),
                (SELECT COUNT_BIG(*) FROM Person.BusinessEntityAddress b
                 INNER JOIN Person.Address a ON a.AddressID=b.AddressID WHERE a.AddressLine1=@marker);
            """;
        command.Parameters.Add("@marker", System.Data.SqlDbType.NVarChar, 60).Value = marker;
        await using var reader = await command.ExecuteReaderAsync();
        if (!await reader.ReadAsync())
            throw new InvalidOperationException("Missing address marker evidence.");
        return new { addresses = reader.GetInt64(0), links = reader.GetInt64(1) };
    }
}
