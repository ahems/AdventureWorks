using Microsoft.Data.SqlClient;
using AddressFunctions.Models;
using Dapper;
using Azure.Core;
using Azure.Identity;
using System.Data;
using System.Data.Common;

namespace AddressFunctions.Services;

public interface IAddressService
{
    Task<IEnumerable<PersonAddressResult>> GetPersonAddressesAsync(IEnumerable<int> businessEntityIds);
    Task<bool> IsAddressOwnedByAsync(int addressId, int businessEntityId);
    Task<IEnumerable<Address>> GetAddressesAsync(int? limit = 100, int? offset = 0, int? businessEntityId = null);
    Task<Address?> GetAddressByIdAsync(int id, int? businessEntityId = null);
    Task<Address> CreateAddressAsync(CreateAddressRequest request);
    Task<Address?> UpdateAddressAsync(int id, UpdateAddressRequest request);
    Task<OwnedAddressUpdateResult> UpdateOwnedAddressAsync(int id, int businessEntityId, UpdateAddressRequest request);
    Task<SetAddressTypeResult> SetAddressTypeAsync(int businessEntityId, int addressId, int addressTypeId);
    Task<bool> DeleteAddressAsync(int id);
    Task<bool> DeleteOwnedAddressAsync(int id, int businessEntityId);
}

public class AddressService : IAddressService
{
    /// <summary>AdventureWorks Person.AddressType "Home" — used as the owner's single default address.</summary>
    public const int DefaultAddressTypeId = 2;
    public const int ShippingAddressTypeId = 3;

    private readonly string _connectionString;

    public AddressService(string connectionString)
    {
        _connectionString = connectionString;
    }

    /// <summary>
    /// Creates a SQL connection with Azure AD authentication via connection string
    /// </summary>
    protected virtual async Task<DbConnection> CreateConnectionAsync()
    {
        // Connection string contains Authentication=Active Directory Default
        // which handles credential acquisition automatically using DefaultAzureCredential
        var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        return connection;
    }

    /// <summary>
    /// Get addresses for multiple persons by BusinessEntityID, joined with StateProvince and CountryRegion.
    /// This avoids the DAB limitation with the geography-typed SpatialLocation column in Person.Address.
    /// </summary>
    public async Task<IEnumerable<PersonAddressResult>> GetPersonAddressesAsync(IEnumerable<int> businessEntityIds)
    {
        var idList = businessEntityIds.ToList();
        if (!idList.Any())
            return Enumerable.Empty<PersonAddressResult>();

        using var connection = await CreateConnectionAsync();

        var sql = @"
            SELECT
                bea.BusinessEntityID,
                a.AddressLine1,
                a.AddressLine2,
                a.City,
                a.PostalCode,
                sp.Name AS StateProvinceName,
                cr.Name AS CountryName
            FROM Person.BusinessEntityAddress bea
            INNER JOIN Person.Address a ON bea.AddressID = a.AddressID
            INNER JOIN Person.StateProvince sp ON a.StateProvinceID = sp.StateProvinceID
            INNER JOIN Person.CountryRegion cr ON sp.CountryRegionCode = cr.CountryRegionCode
            WHERE bea.BusinessEntityID IN @Ids";

        return await connection.QueryAsync<PersonAddressResult>(sql, new { Ids = idList });
    }

    /// <summary>
    /// Returns true when the given AddressID is linked to the given BusinessEntityID via
    /// Person.BusinessEntityAddress. Used for consumer record-level ownership checks so a signed-in
    /// consumer can only read or modify their own address records.
    /// </summary>
    public async Task<bool> IsAddressOwnedByAsync(int addressId, int businessEntityId)
    {
        using var connection = await CreateConnectionAsync();

        const string sql = @"
            SELECT CASE WHEN EXISTS (
                SELECT 1 FROM Person.BusinessEntityAddress
                WHERE AddressID = @AddressId AND BusinessEntityID = @BusinessEntityId
            ) THEN 1 ELSE 0 END";

        return await connection.ExecuteScalarAsync<int>(sql, new { AddressId = addressId, BusinessEntityId = businessEntityId }) == 1;
    }

    /// <summary>
    /// Returns the set of AddressIDs owned (linked) by the given BusinessEntityID. Used to filter a
    /// bulk address listing down to a consumer's own records.
    /// </summary>
    public async Task<IReadOnlyCollection<int>> GetOwnedAddressIdsAsync(int businessEntityId)
    {
        using var connection = await CreateConnectionAsync();

        const string sql = @"
            SELECT AddressID FROM Person.BusinessEntityAddress
            WHERE BusinessEntityID = @BusinessEntityId";

        var ids = await connection.QueryAsync<int>(sql, new { BusinessEntityId = businessEntityId });
        return ids.ToHashSet();
    }

    /// <summary>
    /// Get all addresses with optional pagination
    /// </summary>
    public async Task<IEnumerable<Address>> GetAddressesAsync(int? limit = 100, int? offset = 0, int? businessEntityId = null)
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
            FROM [Person].[Address] a
            WHERE @BusinessEntityId IS NULL OR EXISTS (
                SELECT 1 FROM Person.BusinessEntityAddress bea
                WHERE bea.AddressID = a.AddressID
                  AND bea.BusinessEntityID = @BusinessEntityId)
            ORDER BY AddressID
            OFFSET @Offset ROWS
            FETCH NEXT @Limit ROWS ONLY";

        return await connection.QueryAsync<Address>(sql, new { Offset = offset, Limit = limit, BusinessEntityId = businessEntityId });
    }

    /// <summary>
    /// Get a single address by ID
    /// </summary>
    public async Task<Address?> GetAddressByIdAsync(int id, int? businessEntityId = null)
    {
        using var connection = await CreateConnectionAsync();
        return await ReadAddressAsync(connection, id, businessEntityId, null, false);
    }

    private static Task<Address?> ReadAddressAsync(
        DbConnection connection, int id, int? businessEntityId, DbTransaction? transaction, bool lockForUpdate)
    {
        var addressLock = lockForUpdate ? "WITH (UPDLOCK, HOLDLOCK)" : "";
        var linkLock = lockForUpdate ? "WITH (UPDLOCK, HOLDLOCK)" : "";
        var sql = $@"
            SELECT a.AddressID, a.AddressLine1, a.AddressLine2, a.City, a.StateProvinceID,
                   a.PostalCode, a.rowguid, a.ModifiedDate
            FROM [Person].[Address] a {addressLock}
            WHERE a.AddressID = @Id
              AND (@BusinessEntityId IS NULL OR EXISTS (
                  SELECT 1 FROM [Person].[BusinessEntityAddress] bea {linkLock}
                  WHERE bea.AddressID = a.AddressID AND bea.BusinessEntityID = @BusinessEntityId))";

        return connection.QuerySingleOrDefaultAsync<Address>(
            sql, new { Id = id, BusinessEntityId = businessEntityId }, transaction);
    }

    /// <summary>
    /// Create a new address and optionally link it to a BusinessEntity
    /// </summary>
    public async Task<Address> CreateAddressAsync(CreateAddressRequest request)
    {
        using var connection = await CreateConnectionAsync();
        using var transaction = connection.BeginTransaction();

        try
        {
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

            var address = await connection.QuerySingleAsync<Address>(sql, request, transaction);

            // If BusinessEntityID is provided, create the link in BusinessEntityAddress.
            // Single-default rule: an owner's first address (or any address added while they have no
            // default) becomes the default; requesting Home (2) explicitly moves the default to it.
            if (request.BusinessEntityID.HasValue)
            {
                var businessEntityId = request.BusinessEntityID.Value;
                var links = await LockOwnerLinksAsync(connection, transaction, businessEntityId);
                var hasDefault = links.Any(l => l.AddressTypeID == DefaultAddressTypeId);

                var addressTypeId = !hasDefault
                    ? DefaultAddressTypeId
                    : request.AddressTypeID ?? ShippingAddressTypeId;

                if (hasDefault && addressTypeId == DefaultAddressTypeId)
                {
                    await DemoteOtherDefaultsAsync(connection, transaction, businessEntityId, address.AddressID);
                }

                var linkSql = @"
                    INSERT INTO [Person].[BusinessEntityAddress]
                        (BusinessEntityID, AddressID, AddressTypeID, rowguid, ModifiedDate)
                    VALUES
                        (@BusinessEntityID, @AddressID, @AddressTypeID, NEWID(), GETDATE())";

                await connection.ExecuteAsync(linkSql, new
                {
                    BusinessEntityID = businessEntityId,
                    AddressID = address.AddressID,
                    AddressTypeID = addressTypeId
                }, transaction);
            }

            transaction.Commit();
            return address;
        }
        catch (SqlException ex)
        {
            transaction.Rollback();

            // Check for foreign key constraint violation (error 547)
            if (ex.Number == 547)
            {
                if (ex.Message.Contains("StateProvince"))
                {
                    throw new InvalidOperationException($"Invalid StateProvinceID: {request.StateProvinceID}. The StateProvinceID must reference a valid state/province.", ex);
                }
                else if (ex.Message.Contains("BusinessEntity"))
                {
                    throw new InvalidOperationException($"Invalid BusinessEntityID: {request.BusinessEntityID}. The BusinessEntityID must reference a valid business entity.", ex);
                }
                throw new InvalidOperationException("Foreign key constraint violation. Please check your input values.", ex);
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
        return await UpdateAddressCoreAsync(connection, null, id, null, request);
    }

    public async Task<OwnedAddressUpdateResult> UpdateOwnedAddressAsync(
        int id, int businessEntityId, UpdateAddressRequest request)
    {
        using var connection = await CreateConnectionAsync();
        using var transaction = connection.BeginTransaction(IsolationLevel.Serializable);
        var address = await ReadAddressAsync(connection, id, businessEntityId, transaction, true);
        if (address is null)
        {
            transaction.Rollback();
            return new(OwnedAddressUpdateStatus.NotOwned);
        }

        if (!HasChanges(address, request))
        {
            transaction.Commit();
            return new(OwnedAddressUpdateStatus.Updated, address);
        }

        var shared = await connection.ExecuteScalarAsync<int>(@"
            SELECT CASE WHEN EXISTS (
                SELECT 1 FROM [Person].[BusinessEntityAddress] WITH (UPDLOCK, HOLDLOCK)
                WHERE AddressID = @Id AND BusinessEntityID <> @BusinessEntityId
            ) OR EXISTS (
                SELECT 1 FROM [Sales].[SalesOrderHeader] soh WITH (UPDLOCK, HOLDLOCK)
                LEFT JOIN [Sales].[Customer] customer WITH (HOLDLOCK)
                    ON customer.CustomerID = soh.CustomerID
                WHERE (soh.BillToAddressID = @Id OR soh.ShipToAddressID = @Id)
                  AND (customer.PersonID IS NULL OR customer.PersonID <> @BusinessEntityId)
            ) THEN 1 ELSE 0 END",
            new { Id = id, BusinessEntityId = businessEntityId }, transaction);
        if (shared != 0)
        {
            transaction.Rollback();
            return new(OwnedAddressUpdateStatus.Shared);
        }

        var updated = await UpdateAddressCoreAsync(connection, transaction, id, businessEntityId, request);
        if (updated is null)
        {
            transaction.Rollback();
            return new(OwnedAddressUpdateStatus.NotOwned);
        }

        transaction.Commit();
        return new(OwnedAddressUpdateStatus.Updated, updated);
    }

    private static bool HasChanges(Address address, UpdateAddressRequest request) =>
        (request.AddressLine1 is not null && request.AddressLine1 != address.AddressLine1) ||
        (request.AddressLine2 is not null && request.AddressLine2 != address.AddressLine2) ||
        (request.City is not null && request.City != address.City) ||
        (request.StateProvinceID is not null && request.StateProvinceID != address.StateProvinceID) ||
        (request.PostalCode is not null && request.PostalCode != address.PostalCode);

    private static async Task<Address?> UpdateAddressCoreAsync(
        DbConnection connection, DbTransaction? transaction, int id, int? businessEntityId,
        UpdateAddressRequest request)
    {
        // Build dynamic SQL for partial updates
        var setClauses = new List<string>();
        var parameters = new DynamicParameters();
        parameters.Add("@Id", id);
        parameters.Add("@BusinessEntityId", businessEntityId);

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
            return await ReadAddressAsync(connection, id, businessEntityId, transaction, false);
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
            WHERE AddressID = @Id
              AND (@BusinessEntityId IS NULL OR EXISTS (
                  SELECT 1 FROM [Person].[BusinessEntityAddress] bea
                  WHERE bea.AddressID = @Id AND bea.BusinessEntityID = @BusinessEntityId))";

        return await connection.QuerySingleOrDefaultAsync<Address>(sql, parameters, transaction);
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

    public async Task<bool> DeleteOwnedAddressAsync(int id, int businessEntityId)
    {
        using var connection = await CreateConnectionAsync();
        using var transaction = connection.BeginTransaction(IsolationLevel.Serializable);
        var parameters = new { AddressId = id, BusinessEntityId = businessEntityId };

        var addressId = await connection.ExecuteScalarAsync<int?>(@"
            SELECT AddressID FROM [Person].[Address] WITH (UPDLOCK, HOLDLOCK)
            WHERE AddressID = @AddressId", parameters, transaction);
        if (addressId is null)
        {
            transaction.Rollback();
            return false;
        }

        var removed = await connection.ExecuteAsync(@"
            DELETE FROM [Person].[BusinessEntityAddress]
            WHERE AddressID = @AddressId AND BusinessEntityID = @BusinessEntityId",
            parameters, transaction);
        if (removed == 0)
        {
            transaction.Rollback();
            return false;
        }

        await connection.ExecuteAsync(@"
            DELETE FROM [Person].[Address]
            WHERE AddressID = @AddressId
              AND NOT EXISTS (
                  SELECT 1 FROM [Person].[BusinessEntityAddress]
                  WHERE AddressID = @AddressId)
              AND NOT EXISTS (
                  SELECT 1 FROM [Sales].[SalesOrderHeader]
                  WHERE BillToAddressID = @AddressId OR ShipToAddressID = @AddressId)",
            parameters, transaction);
        transaction.Commit();
        return true;
    }

    /// <summary>
    /// Atomically changes how an address is linked to its owner. Setting Home (2) makes it the
    /// owner's only default, demoting any other default to Shipping (3). The current default cannot
    /// be changed to another type directly; make a different address the default instead.
    /// </summary>
    public async Task<SetAddressTypeResult> SetAddressTypeAsync(int businessEntityId, int addressId, int addressTypeId)
    {
        using var connection = await CreateConnectionAsync();
        using var transaction = connection.BeginTransaction();

        var links = await LockOwnerLinksAsync(connection, transaction, businessEntityId);
        var targetLinks = links.Where(l => l.AddressID == addressId).ToList();
        if (targetLinks.Count == 0)
        {
            transaction.Rollback();
            return SetAddressTypeResult.NotLinked;
        }

        var isDefault = targetLinks.Any(l => l.AddressTypeID == DefaultAddressTypeId);
        if (addressTypeId != DefaultAddressTypeId && isDefault)
        {
            transaction.Rollback();
            return SetAddressTypeResult.DefaultRequired;
        }

        if (addressTypeId == DefaultAddressTypeId)
        {
            await DemoteOtherDefaultsAsync(connection, transaction, businessEntityId, addressId);
        }

        // Replace the address's link(s) with a single link of the requested type.
        await connection.ExecuteAsync(@"
            DELETE FROM [Person].[BusinessEntityAddress]
            WHERE BusinessEntityID = @BusinessEntityId AND AddressID = @AddressId AND AddressTypeID <> @AddressTypeId;

            IF NOT EXISTS (
                SELECT 1 FROM [Person].[BusinessEntityAddress]
                WHERE BusinessEntityID = @BusinessEntityId AND AddressID = @AddressId AND AddressTypeID = @AddressTypeId)
            INSERT INTO [Person].[BusinessEntityAddress]
                (BusinessEntityID, AddressID, AddressTypeID, rowguid, ModifiedDate)
            VALUES (@BusinessEntityId, @AddressId, @AddressTypeId, NEWID(), GETDATE());",
            new { BusinessEntityId = businessEntityId, AddressId = addressId, AddressTypeId = addressTypeId },
            transaction);

        transaction.Commit();
        return SetAddressTypeResult.Updated;
    }

    private sealed class OwnerLink
    {
        public int AddressID { get; set; }
        public int AddressTypeID { get; set; }
    }

    /// <summary>
    /// Reads and range-locks an owner's address links for the rest of the transaction so concurrent
    /// requests cannot both create a default.
    /// </summary>
    private static async Task<IReadOnlyList<OwnerLink>> LockOwnerLinksAsync(
        DbConnection connection, DbTransaction transaction, int businessEntityId)
    {
        var links = await connection.QueryAsync<OwnerLink>(@"
            SELECT AddressID, AddressTypeID
            FROM [Person].[BusinessEntityAddress] WITH (UPDLOCK, HOLDLOCK)
            WHERE BusinessEntityID = @BusinessEntityId",
            new { BusinessEntityId = businessEntityId }, transaction);
        return links.ToList();
    }

    /// <summary>
    /// Changes every default (Home) link of an owner except <paramref name="keepAddressId"/> to
    /// Shipping. A Home link whose address already has a Shipping link is removed instead, because
    /// AddressTypeID is part of the primary key.
    /// </summary>
    private static Task DemoteOtherDefaultsAsync(
        DbConnection connection, DbTransaction transaction, int businessEntityId, int keepAddressId)
    {
        return connection.ExecuteAsync(@"
            DELETE d FROM [Person].[BusinessEntityAddress] d
            WHERE d.BusinessEntityID = @BusinessEntityId
              AND d.AddressTypeID = @DefaultType
              AND d.AddressID <> @KeepAddressId
              AND EXISTS (
                  SELECT 1 FROM [Person].[BusinessEntityAddress] s
                  WHERE s.BusinessEntityID = d.BusinessEntityID
                    AND s.AddressID = d.AddressID
                    AND s.AddressTypeID = @ShippingType);

            UPDATE [Person].[BusinessEntityAddress]
            SET AddressTypeID = @ShippingType, ModifiedDate = GETDATE()
            WHERE BusinessEntityID = @BusinessEntityId
              AND AddressTypeID = @DefaultType
              AND AddressID <> @KeepAddressId;",
            new
            {
                BusinessEntityId = businessEntityId,
                KeepAddressId = keepAddressId,
                DefaultType = DefaultAddressTypeId,
                ShippingType = ShippingAddressTypeId
            },
            transaction);
    }
}

public enum SetAddressTypeResult
{
    Updated,
    NotLinked,
    DefaultRequired
}

public enum OwnedAddressUpdateStatus
{
    Updated,
    NotOwned,
    Shared
}

public sealed record OwnedAddressUpdateResult(OwnedAddressUpdateStatus Status, Address? Address = null);
