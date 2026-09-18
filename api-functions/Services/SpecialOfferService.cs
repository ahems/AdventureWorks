using Dapper;
using Microsoft.Data.SqlClient;
using System.Data;

namespace api_functions.Services;

public class SpecialOfferService
{
    private readonly string _connectionString;

    public SpecialOfferService(string connectionString)
    {
        _connectionString = connectionString;
    }

    private async Task<IDbConnection> GetConnectionAsync()
    {
        var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        return connection;
    }

    /// <summary>
    /// Inserts or updates a SpecialOffer row for the given SpecialOfferID + CultureID pair.
    /// On INSERT: sets rowguid = NEWID() and ModifiedDate = GETDATE().
    /// On UPDATE: updates all non-key columns and sets ModifiedDate = GETDATE().
    /// </summary>
    public async Task UpsertSpecialOfferAsync(
        int specialOfferID,
        string cultureID,
        string description,
        double discountPct,
        string type,
        string category,
        DateTime startDate,
        DateTime endDate,
        int minQty,
        int? maxQty)
    {
        using var connection = await GetConnectionAsync();

        var sql = @"
MERGE [Sales].[SpecialOffer] AS target
USING (SELECT @SpecialOfferID AS SpecialOfferID, @CultureID AS CultureID) AS source
ON target.SpecialOfferID = source.SpecialOfferID AND target.CultureID = source.CultureID
WHEN MATCHED THEN
    UPDATE SET
        Description   = @Description,
        DiscountPct   = @DiscountPct,
        Type          = @Type,
        Category      = @Category,
        StartDate     = @StartDate,
        EndDate       = @EndDate,
        MinQty        = @MinQty,
        MaxQty        = @MaxQty,
        ModifiedDate  = GETDATE()
WHEN NOT MATCHED THEN
    INSERT (SpecialOfferID, CultureID, Description, DiscountPct, Type, Category, StartDate, EndDate, MinQty, MaxQty, rowguid, ModifiedDate)
    VALUES (@SpecialOfferID, @CultureID, @Description, @DiscountPct, @Type, @Category, @StartDate, @EndDate, @MinQty, @MaxQty, NEWID(), GETDATE());
";

        await connection.ExecuteAsync(sql, new
        {
            SpecialOfferID = specialOfferID,
            CultureID = cultureID,
            Description = description,
            DiscountPct = (decimal)discountPct,
            Type = type,
            Category = category,
            StartDate = startDate,
            EndDate = endDate,
            MinQty = minQty,
            MaxQty = maxQty
        });
    }

    public async Task<int> GetNextSpecialOfferIdAsync()
    {
        using var connection = await GetConnectionAsync();
        var maxId = await connection.ExecuteScalarAsync<int?>(
            "SELECT MAX(SpecialOfferID) FROM [Sales].[SpecialOffer]");
        return (maxId ?? 1) + 1;
    }

    public async Task AssignProductsAsync(int specialOfferId, IEnumerable<int> productIds)
    {
        using var connection = await GetConnectionAsync();
        foreach (var productId in productIds)
        {
            await connection.ExecuteAsync(@"
IF NOT EXISTS (SELECT 1 FROM [Sales].[SpecialOfferProduct] WHERE SpecialOfferID = @OfferId AND ProductID = @ProductId)
    INSERT INTO [Sales].[SpecialOfferProduct] (SpecialOfferID, ProductID, rowguid, ModifiedDate)
    VALUES (@OfferId, @ProductId, NEWID(), GETDATE())",
                new { OfferId = specialOfferId, ProductId = productId });
        }
    }

    /// <summary>
    /// Expires any active promotion that has at least one assigned product with zero inventory.
    /// Returns the IDs of promotions that were expired.
    /// </summary>
    public async Task<List<int>> ExpireOutOfStockPromotionsAsync()
    {
        using var connection = await GetConnectionAsync();
        var expiredIds = await connection.QueryAsync<int>(@"
UPDATE so
SET so.EndDate = GETDATE(), so.ModifiedDate = GETDATE()
OUTPUT INSERTED.SpecialOfferID
FROM [Sales].[SpecialOffer] so
WHERE so.StartDate <= GETDATE()
  AND so.EndDate > GETDATE()
  AND so.SpecialOfferID != 1
  AND EXISTS (
      SELECT 1
      FROM [Sales].[SpecialOfferProduct] sop
      WHERE sop.SpecialOfferID = so.SpecialOfferID
        AND NOT EXISTS (
            SELECT 1 FROM Production.ProductInventory pi
            WHERE pi.ProductID = sop.ProductID AND pi.Quantity > 0
        )
  )");
        return expiredIds.ToList();
    }
}
