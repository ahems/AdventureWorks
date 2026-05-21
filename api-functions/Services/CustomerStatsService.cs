using Microsoft.Data.SqlClient;
using AddressFunctions.Models;
using Dapper;

namespace AddressFunctions.Services;

public class CustomerStatsService
{
    private readonly string _connectionString;

    public CustomerStatsService(string connectionString)
    {
        _connectionString = connectionString;
    }

    private async Task<SqlConnection> CreateConnectionAsync()
    {
        var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        return connection;
    }

    /// <summary>
    /// Returns aggregate summary KPIs: total customers, total/avg revenue, countries served,
    /// and spending bucket distribution — all computed across the full dataset.
    /// </summary>
    public async Task<CustomerStatsSummary> GetSummaryAsync()
    {
        using var connection = await CreateConnectionAsync();

        // CTE: per-customer revenue (de-duplicates by CustomerID before joining addresses)
        // PrimaryCountry: takes the first country code per customer (avoids fanout from multiple addresses)
        const string summarySql = @"
            WITH CustomerSpend AS (
                SELECT c.CustomerID, p.BusinessEntityID,
                    COALESCE(SUM(soh.TotalDue), 0) AS TotalSpent
                FROM Sales.Customer c
                JOIN Person.Person p
                    ON c.PersonID = p.BusinessEntityID
                    AND p.PersonType = 'IN'
                LEFT JOIN Sales.SalesOrderHeader soh ON soh.CustomerID = c.CustomerID
                GROUP BY c.CustomerID, p.BusinessEntityID
            ),
            PrimaryCountry AS (
                SELECT cs.CustomerID,
                    MIN(cr.CountryRegionCode) AS CountryCode
                FROM CustomerSpend cs
                LEFT JOIN Person.BusinessEntityAddress bea
                    ON bea.BusinessEntityID = cs.BusinessEntityID
                LEFT JOIN Person.Address a ON a.AddressID = bea.AddressID
                LEFT JOIN Person.StateProvince sp ON sp.StateProvinceID = a.StateProvinceID
                LEFT JOIN Person.CountryRegion cr ON cr.CountryRegionCode = sp.CountryRegionCode
                GROUP BY cs.CustomerID
            )
            SELECT
                COUNT(*)                            AS TotalCustomers,
                SUM(cs.TotalSpent)                  AS TotalRevenue,
                AVG(cs.TotalSpent)                  AS AvgRevenue,
                COUNT(DISTINCT pc.CountryCode)      AS CountriesServed
            FROM CustomerSpend cs
            LEFT JOIN PrimaryCountry pc ON pc.CustomerID = cs.CustomerID";

        const string bucketSql = @"
            WITH CustomerSpend AS (
                SELECT c.CustomerID,
                    COALESCE(SUM(soh.TotalDue), 0) AS TotalSpent
                FROM Sales.Customer c
                JOIN Person.Person p
                    ON c.PersonID = p.BusinessEntityID
                    AND p.PersonType = 'IN'
                LEFT JOIN Sales.SalesOrderHeader soh ON soh.CustomerID = c.CustomerID
                GROUP BY c.CustomerID
            )
            SELECT
                CASE
                    WHEN TotalSpent = 0       THEN 'No Purchases'
                    WHEN TotalSpent < 1000    THEN 'Under $1K'
                    WHEN TotalSpent < 5000    THEN '$1K - $5K'
                    WHEN TotalSpent < 10000   THEN '$5K - $10K'
                    ELSE                           'Over $10K'
                END AS Bucket,
                COUNT(*) AS Count
            FROM CustomerSpend
            GROUP BY
                CASE
                    WHEN TotalSpent = 0       THEN 'No Purchases'
                    WHEN TotalSpent < 1000    THEN 'Under $1K'
                    WHEN TotalSpent < 5000    THEN '$1K - $5K'
                    WHEN TotalSpent < 10000   THEN '$5K - $10K'
                    ELSE                           'Over $10K'
                END
            ORDER BY MIN(TotalSpent)";

        var summary = await connection.QuerySingleAsync<CustomerStatsSummary>(summarySql);
        var buckets = await connection.QueryAsync<CustomerSpendingBucket>(bucketSql);
        summary.SpendingBuckets = buckets.ToList();
        return summary;
    }

    /// <summary>
    /// Returns customer count and revenue aggregated by country, ordered by customer count desc.
    /// Each customer is assigned to their primary (first) address country.
    /// </summary>
    public async Task<IEnumerable<CustomerCountryStat>> GetCountryBreakdownAsync()
    {
        using var connection = await CreateConnectionAsync();

        const string sql = @"
            WITH CustomerSpend AS (
                SELECT c.CustomerID, p.BusinessEntityID,
                    COALESCE(SUM(soh.TotalDue), 0) AS TotalSpent
                FROM Sales.Customer c
                JOIN Person.Person p
                    ON c.PersonID = p.BusinessEntityID
                    AND p.PersonType = 'IN'
                LEFT JOIN Sales.SalesOrderHeader soh ON soh.CustomerID = c.CustomerID
                GROUP BY c.CustomerID, p.BusinessEntityID
            ),
            PrimaryCountry AS (
                SELECT cs.CustomerID, cs.TotalSpent,
                    MIN(cr.CountryRegionCode) AS CountryCode,
                    MIN(cr.Name)              AS CountryName
                FROM CustomerSpend cs
                LEFT JOIN Person.BusinessEntityAddress bea
                    ON bea.BusinessEntityID = cs.BusinessEntityID
                LEFT JOIN Person.Address a ON a.AddressID = bea.AddressID
                LEFT JOIN Person.StateProvince sp ON sp.StateProvinceID = a.StateProvinceID
                LEFT JOIN Person.CountryRegion cr ON cr.CountryRegionCode = sp.CountryRegionCode
                GROUP BY cs.CustomerID, cs.TotalSpent
            )
            SELECT
                COALESCE(CountryCode, 'N/A')    AS CountryCode,
                COALESCE(CountryName, 'Unknown') AS CountryName,
                COUNT(*)                         AS CustomerCount,
                SUM(TotalSpent)                  AS TotalRevenue,
                AVG(TotalSpent)                  AS AvgRevenue
            FROM PrimaryCountry
            GROUP BY CountryCode, CountryName
            ORDER BY CustomerCount DESC";

        return await connection.QueryAsync<CustomerCountryStat>(sql);
    }

    /// <summary>
    /// Returns revenue and customer counts by sales territory group (North America / Europe / Pacific).
    /// Only customers who have placed at least one order are included (order-driven grouping).
    /// </summary>
    public async Task<IEnumerable<CustomerRegionStat>> GetRegionBreakdownAsync()
    {
        using var connection = await CreateConnectionAsync();

        const string sql = @"
            SELECT
                st.[Group]                      AS RegionGroup,
                COUNT(DISTINCT soh.CustomerID)  AS CustomerCount,
                SUM(soh.TotalDue)               AS TotalRevenue
            FROM Sales.SalesOrderHeader soh
            JOIN Sales.SalesTerritory st ON st.TerritoryID = soh.TerritoryID
            JOIN Sales.Customer c ON c.CustomerID = soh.CustomerID
            JOIN Person.Person p
                ON p.BusinessEntityID = c.PersonID
                AND p.PersonType = 'IN'
            GROUP BY st.[Group]
            ORDER BY TotalRevenue DESC";

        return await connection.QueryAsync<CustomerRegionStat>(sql);
    }

    /// <summary>
    /// Returns monthly revenue totals across all individual-customer orders,
    /// ordered chronologically. Cumulative revenue is computed client-side.
    /// </summary>
    public async Task<IEnumerable<CustomerMonthlyRevenue>> GetMonthlyRevenueAsync()
    {
        using var connection = await CreateConnectionAsync();

        const string sql = @"
            SELECT
                YEAR(soh.OrderDate)                         AS Year,
                MONTH(soh.OrderDate)                        AS Month,
                FORMAT(soh.OrderDate, 'MMM yyyy')           AS MonthLabel,
                SUM(soh.TotalDue)                           AS Revenue
            FROM Sales.SalesOrderHeader soh
            JOIN Sales.Customer c ON c.CustomerID = soh.CustomerID
            JOIN Person.Person p
                ON p.BusinessEntityID = c.PersonID
                AND p.PersonType = 'IN'
            GROUP BY
                YEAR(soh.OrderDate),
                MONTH(soh.OrderDate),
                FORMAT(soh.OrderDate, 'MMM yyyy')
            ORDER BY Year, Month";

        return await connection.QueryAsync<CustomerMonthlyRevenue>(sql);
    }
}
