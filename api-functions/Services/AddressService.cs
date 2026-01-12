using Microsoft.Data.SqlClient;
using AddressFunctions.Models;
using Dapper;
using Azure.Core;
using Azure.Identity;

namespace AddressFunctions.Services;

public class AddressService
{
    private readonly string _connectionString;

    public AddressService(string connectionString)
    {
        _connectionString = connectionString;
    }

    /// <summary>
    /// Creates a SQL connection with Azure AD authentication via connection string
    /// </summary>
    private async Task<SqlConnection> CreateConnectionAsync()
    {
        // Connection string contains Authentication=Active Directory Default
        // which handles credential acquisition automatically using DefaultAzureCredential
        var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        return connection;
    }

    /// <summary>
    /// Get all addresses with optional pagination
    /// </summary>
    public async Task<IEnumerable<Address>> GetAddressesAsync(int? limit = 100, int? offset = 0)
    {
        using var connection = await CreateConnectionAsync();

        var sql = @"
            SELECT 
                AddressID, 
                AddressLine1, 
                AddressLine2, 
                City, 
                StateProvinceID, 
                PostalCode, 
                rowguid, 
                ModifiedDate
            FROM [Person].[Address]
            ORDER BY AddressID
            OFFSET @Offset ROWS
            FETCH NEXT @Limit ROWS ONLY";

        return await connection.QueryAsync<Address>(sql, new { Offset = offset, Limit = limit });
    }

    /// <summary>
    /// Get a single address by ID
    /// </summary>
    public async Task<Address?> GetAddressByIdAsync(int id)
    {
        using var connection = await CreateConnectionAsync();

        var sql = @"
            SELECT 
                AddressID, 
                AddressLine1, 
                AddressLine2, 
                City, 
                StateProvinceID, 
                PostalCode, 
                rowguid, 
                ModifiedDate
            FROM [Person].[Address]
            WHERE AddressID = @Id";

        return await connection.QuerySingleOrDefaultAsync<Address>(sql, new { Id = id });
    }

    /// <summary>
    /// Create a new address
    /// </summary>
    public async Task<Address> CreateAddressAsync(CreateAddressRequest request)
    {
        using var connection = await CreateConnectionAsync();

        var sql = @"
            INSERT INTO [Person].[Address] 
                (AddressLine1, AddressLine2, City, StateProvinceID, PostalCode, rowguid, ModifiedDate)
            OUTPUT 
                INSERTED.AddressID,
                INSERTED.AddressLine1,
                INSERTED.AddressLine2,
                INSERTED.City,
                INSERTED.StateProvinceID,
                INSERTED.PostalCode,
                INSERTED.rowguid,
                INSERTED.ModifiedDate
            VALUES 
                (@AddressLine1, @AddressLine2, @City, @StateProvinceID, @PostalCode, NEWID(), GETDATE())";

        try
        {
            var address = await connection.QuerySingleAsync<Address>(sql, request);
            return address;
        }
        catch (SqlException ex)
        {
            // Check for foreign key constraint violation (error 547)
            if (ex.Number == 547)
            {
                throw new InvalidOperationException($"Invalid StateProvinceID: {request.StateProvinceID}. The StateProvinceID must reference a valid state/province.", ex);
            }
            throw;
        }
    }

    /// <summary>
    /// Update an existing address
    /// </summary>
    public async Task<Address?> UpdateAddressAsync(int id, UpdateAddressRequest request)
    {
        using var connection = await CreateConnectionAsync();

        // Build dynamic SQL for partial updates
        var setClauses = new List<string>();
        var parameters = new DynamicParameters();
        parameters.Add("@Id", id);

        if (request.AddressLine1 != null)
        {
            setClauses.Add("AddressLine1 = @AddressLine1");
            parameters.Add("@AddressLine1", request.AddressLine1);
        }
        if (request.AddressLine2 != null)
        {
            setClauses.Add("AddressLine2 = @AddressLine2");
            parameters.Add("@AddressLine2", request.AddressLine2);
        }
        if (request.City != null)
        {
            setClauses.Add("City = @City");
            parameters.Add("@City", request.City);
        }
        if (request.StateProvinceID.HasValue)
        {
            setClauses.Add("StateProvinceID = @StateProvinceID");
            parameters.Add("@StateProvinceID", request.StateProvinceID.Value);
        }
        if (request.PostalCode != null)
        {
            setClauses.Add("PostalCode = @PostalCode");
            parameters.Add("@PostalCode", request.PostalCode);
        }

        if (!setClauses.Any())
        {
            // No fields to update, just return the existing record
            return await GetAddressByIdAsync(id);
        }

        // Always update ModifiedDate
        setClauses.Add("ModifiedDate = GETDATE()");

        var sql = $@"
            UPDATE [Person].[Address]
            SET {string.Join(", ", setClauses)}
            OUTPUT 
                INSERTED.AddressID,
                INSERTED.AddressLine1,
                INSERTED.AddressLine2,
                INSERTED.City,
                INSERTED.StateProvinceID,
                INSERTED.PostalCode,
                INSERTED.rowguid,
                INSERTED.ModifiedDate
            WHERE AddressID = @Id";

        return await connection.QuerySingleOrDefaultAsync<Address>(sql, parameters);
    }

    /// <summary>
    /// Delete an address by ID
    /// </summary>
    public async Task<bool> DeleteAddressAsync(int id)
    {
        using var connection = await CreateConnectionAsync();

        var sql = "DELETE FROM [Person].[Address] WHERE AddressID = @Id";
        var rowsAffected = await connection.ExecuteAsync(sql, new { Id = id });

        return rowsAffected > 0;
    }
}
