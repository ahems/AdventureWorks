using System.Data;
using System.Globalization;
using System.Text.Json;
using Microsoft.Data.SqlClient;

internal static class AddressFixtures
{
    internal static string Marker(string runId, int ownerA, int ownerB)
    {
        if (runId.Length != 53 || runId[16] != '-'
            || !DateTime.TryParseExact(runId[..16], "yyyyMMdd'T'HHmmss'Z'",
                CultureInfo.InvariantCulture, DateTimeStyles.None, out _)
            || !Guid.TryParseExact(runId[^36..], "D", out var runGuid)
            || ownerA <= 0 || ownerB <= 0 || ownerA == ownerB)
            throw new InvalidOperationException("Distinct fixture owners and a run UUID are required.");
        return "AuthAssurance-" + runGuid.ToString("N");
    }

    internal static async Task<object> ReadAsync(SqlConnection connection, JsonElement configuration)
    {
        var values = configuration.GetProperty("values");
        var owners = new[] { "A", "B" }.Select(label =>
        {
            var prefix = "AUTH_TEST_CONSUMER_" + label + "_";
            if (values.GetProperty(prefix + "STATE").GetString() != "ready"
                || !int.TryParse(values.GetProperty(prefix + "BUSINESS_ENTITY_ID").GetString(),
                    NumberStyles.None, CultureInfo.InvariantCulture, out var id)
                || string.IsNullOrWhiteSpace(values.GetProperty(prefix + "EMAIL").GetString()))
                throw new InvalidOperationException("Existing ready consumers are required.");
            return (Id: id, Email: values.GetProperty(prefix + "EMAIL").GetString()!);
        }).ToArray();
        var marker = Marker(configuration.GetProperty("runId").GetString()!, owners[0].Id, owners[1].Id);
        SqlCommand Command(string sql)
        {
            var command = connection.CreateCommand();
            command.CommandTimeout = 30;
            command.CommandText = sql;
            command.Parameters.Add("@Marker", SqlDbType.NVarChar, 60).Value = marker;
            command.Parameters.Add("@First", SqlDbType.Int).Value = owners[0].Id;
            command.Parameters.Add("@Second", SqlDbType.Int).Value = owners[1].Id;
            return command;
        }

        await using var ownerCommand = Command("""
            SELECT
                CASE WHEN EXISTS (SELECT 1 FROM Person.EmailAddress
                    WHERE BusinessEntityID=@First AND EmailAddress=@FirstEmail)
                    AND EXISTS (SELECT 1 FROM Person.EmailAddress
                    WHERE BusinessEntityID=@Second AND EmailAddress=@SecondEmail)
                    THEN 1 ELSE 0 END,
                (SELECT COUNT_BIG(*) FROM Person.BusinessEntityAddress WHERE BusinessEntityID=@First),
                (SELECT COUNT_BIG(*) FROM Person.BusinessEntityAddress WHERE BusinessEntityID=@Second);
            """);
        ownerCommand.Parameters.Add("@FirstEmail", SqlDbType.NVarChar, 50).Value = owners[0].Email;
        ownerCommand.Parameters.Add("@SecondEmail", SqlDbType.NVarChar, 50).Value = owners[1].Email;
        bool ownersMatch;
        long firstLinks;
        long secondLinks;
        await using (var reader = await ownerCommand.ExecuteReaderAsync())
        {
            if (!await reader.ReadAsync())
                throw new InvalidOperationException("Missing owner evidence.");
            ownersMatch = reader.GetInt32(0) == 1;
            firstLinks = reader.GetInt64(1);
            secondLinks = reader.GetInt64(2);
        }

        var addresses = new List<object>();
        await using (var command = Command("""
            SELECT a.AddressID, a.AddressLine1, a.AddressLine2, a.City, a.StateProvinceID,
                   a.PostalCode, a.rowguid, a.ModifiedDate,
                   (SELECT COUNT_BIG(*) FROM Person.BusinessEntityAddress b
                    WHERE b.AddressID=a.AddressID AND b.BusinessEntityID NOT IN (@First,@Second)),
                   (SELECT COUNT_BIG(*) FROM Sales.SalesOrderHeader o
                    WHERE o.BillToAddressID=a.AddressID OR o.ShipToAddressID=a.AddressID)
            FROM Person.Address a
            WHERE a.AddressLine1=@Marker
            ORDER BY a.AddressID;
            """))
        await using (var reader = await command.ExecuteReaderAsync())
        {
            while (await reader.ReadAsync())
                addresses.Add(new
                {
                    id = reader.GetInt32(0), marker = reader.GetString(1),
                    line2 = reader.IsDBNull(2) ? null : reader.GetString(2),
                    city = reader.GetString(3), state = reader.GetInt32(4),
                    postal = reader.GetString(5), rowGuid = reader.GetGuid(6),
                    modified = reader.GetDateTime(7), foreignLinks = reader.GetInt64(8),
                    orderReferences = reader.GetInt64(9),
                });
        }

        var links = new List<object>();
        await using (var command = Command("""
            SELECT b.AddressID, b.BusinessEntityID, b.AddressTypeID, b.rowguid, b.ModifiedDate
            FROM Person.BusinessEntityAddress b
            INNER JOIN Person.Address a ON a.AddressID=b.AddressID
            WHERE a.AddressLine1=@Marker AND b.BusinessEntityID IN (@First,@Second)
            ORDER BY b.AddressID, b.BusinessEntityID, b.AddressTypeID;
            """))
        await using (var reader = await command.ExecuteReaderAsync())
        {
            while (await reader.ReadAsync())
                links.Add(new
                {
                    addressId = reader.GetInt32(0), owner = reader.GetInt32(1),
                    type = reader.GetInt32(2), rowGuid = reader.GetGuid(3),
                    modified = reader.GetDateTime(4),
                });
        }
        return new { addressAudit = new { ownersMatch, ownerLinks = new[] { firstLinks, secondLinks }, addresses, links } };
    }
}
