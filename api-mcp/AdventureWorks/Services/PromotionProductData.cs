using System.Data;
using System.Text;
using Dapper;

namespace AdventureWorks.Shared;

/// <summary>Shared promotion data query for the MCP tool and managed-identity Functions workflows.</summary>
public static class PromotionProductData
{
    public static async Task<string> GetAsync(
        IDbConnection connection,
        string promotionType,
        int? categoryId = null,
        int? subcategoryId = null,
        int topN = 20)
    {
        var isExcessInventory = promotionType.Equals("Clearance", StringComparison.OrdinalIgnoreCase)
            || promotionType.Equals("Excess Inventory", StringComparison.OrdinalIgnoreCase);
        var isVolumeDiscount = promotionType.Equals("Volume Discount", StringComparison.OrdinalIgnoreCase);

        var categoryFilter = subcategoryId.HasValue
            ? "AND p.ProductSubcategoryID = @SubcategoryId"
            : categoryId.HasValue
                ? "AND ps.ProductCategoryID = @CategoryId"
                : "";

        var orderBy = isExcessInventory
            ? "ORDER BY TotalInventory DESC, RecentSalesCount ASC"
            : isVolumeDiscount
                ? "ORDER BY RecentSalesCount DESC, TotalInventory ASC"
                : "ORDER BY p.Name ASC";

        var sql = $@"
            SELECT TOP (@TopN)
                p.ProductID,
                p.Name AS ProductName,
                p.ListPrice,
                p.StandardCost,
                pc.Name AS CategoryName,
                ps.Name AS SubcategoryName,
                ISNULL(inv.TotalInventory, 0) AS TotalInventory,
                ISNULL(sales.RecentSalesCount, 0) AS RecentSalesCount,
                ISNULL(sales.RecentRevenue, 0) AS RecentRevenue,
                ISNULL(discounts.ActiveDiscounts, 0) AS ActiveDiscounts
            FROM Production.Product p
            LEFT JOIN Production.ProductSubcategory ps ON p.ProductSubcategoryID = ps.ProductSubcategoryID
            LEFT JOIN Production.ProductCategory pc ON ps.ProductCategoryID = pc.ProductCategoryID
            LEFT JOIN (
                SELECT pi.ProductID, SUM(pi.Quantity) AS TotalInventory
                FROM Production.ProductInventory pi
                INNER JOIN Production.Location l ON pi.LocationID = l.LocationID
                WHERE l.Name LIKE 'Finished Goods%'
                GROUP BY pi.ProductID
            ) inv ON p.ProductID = inv.ProductID
            LEFT JOIN (
                SELECT sod.ProductID,
                       COUNT(DISTINCT sod.SalesOrderID) AS RecentSalesCount,
                       SUM(sod.LineTotal) AS RecentRevenue
                FROM Sales.SalesOrderDetail sod
                INNER JOIN Sales.SalesOrderHeader soh ON sod.SalesOrderID = soh.SalesOrderID
                WHERE soh.OrderDate >= DATEADD(DAY, -90, GETDATE())
                GROUP BY sod.ProductID
            ) sales ON p.ProductID = sales.ProductID
            LEFT JOIN (
                SELECT sop.ProductID, COUNT(*) AS ActiveDiscounts
                FROM Sales.SpecialOfferProduct sop
                INNER JOIN Sales.SpecialOffer so ON sop.SpecialOfferID = so.SpecialOfferID
                WHERE so.EndDate >= GETDATE() AND so.DiscountPct > 0
                GROUP BY sop.ProductID
            ) discounts ON p.ProductID = discounts.ProductID
            WHERE p.FinishedGoodsFlag = 1
              AND p.ListPrice > 0
              {categoryFilter}
            {orderBy}";

        var products = (await connection.QueryAsync(sql, new
        {
            TopN = topN,
            CategoryId = categoryId,
            SubcategoryId = subcategoryId
        })).ToList();

        if (products.Count == 0)
        {
            return "No products found matching the specified criteria.";
        }

        var result = new StringBuilder();
        result.AppendLine($"Products suitable for '{promotionType}' promotion ({products.Count} results):");
        result.AppendLine();

        foreach (var p in products)
        {
            result.AppendLine($"ProductID: {p.ProductID} | {p.ProductName}");
            result.AppendLine($"  Category: {p.CategoryName ?? "N/A"} > {p.SubcategoryName ?? "N/A"}");
            result.AppendLine($"  List Price: ${p.ListPrice:N2}");
            result.AppendLine($"  Standard Cost: ${p.StandardCost:N2}");
            result.AppendLine($"  Gross Margin at List Price: {(p.ListPrice > 0 ? ((p.ListPrice - p.StandardCost) / p.ListPrice * 100) : 0):N1}%");
            result.AppendLine($"  Inventory (Finished Goods): {p.TotalInventory} units");
            result.AppendLine($"  Sales last 90 days: {p.RecentSalesCount} orders | Revenue: ${p.RecentRevenue:N2}");
            result.AppendLine($"  Active discounts: {p.ActiveDiscounts}");
            result.AppendLine();
        }

        return result.ToString();
    }
}
