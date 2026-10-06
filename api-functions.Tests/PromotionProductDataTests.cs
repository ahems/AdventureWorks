using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;
using AdventureWorks.Shared;
using Microsoft.Data.SqlClient;
using Xunit;

namespace ApiFunctions.Tests;

public class PromotionProductDataTests
{
    [Theory]
    [InlineData("Clearance", "ORDER BY TotalInventory DESC, RecentSalesCount ASC")]
    [InlineData("Excess Inventory", "ORDER BY TotalInventory DESC, RecentSalesCount ASC")]
    [InlineData("Volume Discount", "ORDER BY RecentSalesCount DESC, TotalInventory ASC")]
    [InlineData("percentage", "ORDER BY p.Name ASC")]
    public async Task Preserves_promotion_ranking_and_live_data(string promotionType, string ranking)
    {
        using var connection = new ProductConnection();
        var result = await PromotionProductData.GetAsync(connection, promotionType);

        Assert.Contains(ranking, connection.Command.CommandText);
        Assert.Contains("DATEADD(DAY, -90, GETDATE())", connection.Command.CommandText);
        Assert.Contains("WHERE l.Name LIKE 'Finished Goods%'", connection.Command.CommandText);
        Assert.Equal(20, connection.Command.CapturedParameters["TopN"]);
        Assert.Contains("ProductID: 680 | HL Road Frame", result);
        Assert.Contains("Inventory (Finished Goods): 50 units", result);
        Assert.Contains("Sales last 90 days: 12 orders", result);
        Assert.Contains("Active discounts: 2", result);
    }

    [Theory]
    [InlineData(1, null, "AND ps.ProductCategoryID = @CategoryId")]
    [InlineData(1, 2, "AND p.ProductSubcategoryID = @SubcategoryId")]
    public async Task Preserves_parameterized_filters_and_limit(int categoryId, int? subcategoryId, string filter)
    {
        using var connection = new ProductConnection();
        await PromotionProductData.GetAsync(connection, "Clearance", categoryId, subcategoryId, topN: 7);

        Assert.Contains(filter, connection.Command.CommandText);
        Assert.Equal(7, connection.Command.CapturedParameters["TopN"]);
        if (subcategoryId.HasValue)
        {
            Assert.Equal(subcategoryId.Value, connection.Command.CapturedParameters["SubcategoryId"]);
            Assert.DoesNotContain("CategoryId", connection.Command.CapturedParameters.Keys);
        }
        else
        {
            Assert.Equal(categoryId, connection.Command.CapturedParameters["CategoryId"]);
        }
    }

    [Fact]
    public async Task Empty_query_result_is_not_fabricated()
    {
        using var connection = new ProductConnection(includeProduct: false);
        Assert.Equal("No products found matching the specified criteria.",
            await PromotionProductData.GetAsync(connection, "Clearance"));
    }

    private sealed class ProductConnection : DbConnection
    {
        public ProductCommand Command { get; }
        public ProductConnection(bool includeProduct = true) => Command = new ProductCommand(this, includeProduct);
        [AllowNull]
        public override string ConnectionString { get; set; } = "";
        public override string Database => "test";
        public override string DataSource => "test";
        public override string ServerVersion => "test";
        public override ConnectionState State => ConnectionState.Open;
        public override void Open() { }
        public override void Close() { }
        public override void ChangeDatabase(string databaseName) => throw new NotSupportedException();
        protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel) => throw new NotSupportedException();
        protected override DbCommand CreateDbCommand() => Command;
    }

    private sealed class ProductCommand : DbCommand
    {
        private readonly SqlCommand _parameters = new();
        private readonly bool _includeProduct;
        public Dictionary<string, object?> CapturedParameters { get; } = [];

        public ProductCommand(ProductConnection connection, bool includeProduct)
        {
            DbConnection = connection;
            _includeProduct = includeProduct;
        }

        [AllowNull]
        public override string CommandText { get; set; } = "";
        public override int CommandTimeout { get; set; }
        public override CommandType CommandType { get; set; }
        public override bool DesignTimeVisible { get; set; }
        public override UpdateRowSource UpdatedRowSource { get; set; }
        protected override DbConnection? DbConnection { get; set; }
        protected override DbTransaction? DbTransaction { get; set; }
        protected override DbParameterCollection DbParameterCollection => _parameters.Parameters;
        protected override DbParameter CreateDbParameter() => new SqlParameter();
        public override void Cancel() { }
        public override void Prepare() { }
        public override int ExecuteNonQuery() => throw new NotSupportedException();
        public override object ExecuteScalar() => throw new NotSupportedException();

        protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior)
        {
            foreach (DbParameter parameter in Parameters)
            {
                CapturedParameters[parameter.ParameterName.TrimStart('@')] = parameter.Value;
            }
            var table = new DataTable();
            table.Columns.Add("ProductID", typeof(int));
            table.Columns.Add("ProductName", typeof(string));
            table.Columns.Add("ListPrice", typeof(decimal));
            table.Columns.Add("StandardCost", typeof(decimal));
            table.Columns.Add("CategoryName", typeof(string));
            table.Columns.Add("SubcategoryName", typeof(string));
            table.Columns.Add("TotalInventory", typeof(int));
            table.Columns.Add("RecentSalesCount", typeof(int));
            table.Columns.Add("RecentRevenue", typeof(decimal));
            table.Columns.Add("ActiveDiscounts", typeof(int));
            if (_includeProduct)
            {
                table.Rows.Add(680, "HL Road Frame", 1000m, 600m, "Components", "Road Frames", 50, 12, 12000m, 2);
            }
            return table.CreateDataReader();
        }
    }
}
