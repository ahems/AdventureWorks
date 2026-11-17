using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;

internal static class CustomerState
{
    internal static async Task<object> ReadAsync(SqlConnection connection, string[] arguments)
    {
        if (arguments.Length != 3 ||
            !int.TryParse(arguments[0], NumberStyles.None, CultureInfo.InvariantCulture, out var first) ||
            !int.TryParse(arguments[1], NumberStyles.None, CultureInfo.InvariantCulture, out var second) ||
            !int.TryParse(arguments[2], NumberStyles.None, CultureInfo.InvariantCulture, out var territory) ||
            first <= 0 || second <= 0 || first == second || territory <= 0)
            throw new InvalidOperationException("Two distinct owners and a valid territory are required.");

        await using var command = connection.CreateCommand();
        command.CommandTimeout = 30;
        command.CommandText = """
            SELECT owners.Ordinal, COUNT_BIG(c.CustomerID), MIN(c.CustomerID),
                   COUNT_BIG(CASE WHEN c.StoreID IS NULL AND c.TerritoryID=@Territory THEN 1 END)
            FROM (VALUES (0, @First), (1, @Second)) AS owners(Ordinal, PersonID)
            LEFT JOIN Sales.Customer c ON c.PersonID=owners.PersonID
            GROUP BY owners.Ordinal
            ORDER BY owners.Ordinal;
            """;
        command.Parameters.Add("@First", SqlDbType.Int).Value = first;
        command.Parameters.Add("@Second", SqlDbType.Int).Value = second;
        command.Parameters.Add("@Territory", SqlDbType.Int).Value = territory;

        var customers = new List<object>();
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            if (reader.GetInt32(0) != customers.Count)
                throw new InvalidOperationException("Customer state order is invalid.");
            customers.Add(new
            {
                count = reader.GetInt64(1),
                firstId = reader.IsDBNull(2) ? (int?)null : reader.GetInt32(2),
                matching = reader.GetInt64(3),
            });
        }
        if (customers.Count != 2)
            throw new InvalidOperationException("Both customer states are required.");
        return new { customers };
    }
}
