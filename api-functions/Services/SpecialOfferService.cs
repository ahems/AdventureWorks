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
}
