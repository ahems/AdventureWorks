using System.Data;
using Azure.Core;
using Azure.Identity;
using Dapper;
using Microsoft.Data.SqlClient;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// Service for retrieving complete order receipt data from AdventureWorks database
/// </summary>
public class ReceiptService
{
    private readonly string _connectionString;

    public ReceiptService(string connectionString)
    {
        _connectionString = connectionString;
    }

    private async Task<IDbConnection> GetConnectionAsync()
    {
        var connection = new SqlConnection(_connectionString);
        var credential = new DefaultAzureCredential();
        var token = await credential.GetTokenAsync(new Azure.Core.TokenRequestContext(new[] { "https://database.windows.net/.default" }));
        connection.AccessToken = token.Token;
        await connection.OpenAsync();
        return connection;
    }

    /// <summary>
    /// Get complete receipt data for a sales order by SalesOrderNumber
    /// </summary>
    public async Task<ReceiptData?> GetReceiptDataBySalesOrderNumberAsync(string salesOrderNumber)
    {
        using var connection = await GetConnectionAsync();

        // Get order header with customer and address information
        var headerSql = @"
            SELECT 
                soh.SalesOrderID,
                soh.SalesOrderNumber,
                soh.OrderDate,
                soh.ShipDate,
                soh.Status,
                CASE 
                    WHEN soh.Status = 1 THEN 'In Process'
                    WHEN soh.Status = 2 THEN 'Approved'
                    WHEN soh.Status = 3 THEN 'Backordered'
                    WHEN soh.Status = 4 THEN 'Rejected'
                    WHEN soh.Status = 5 THEN 'Shipped'
                    WHEN soh.Status = 6 THEN 'Cancelled'
                    ELSE 'Unknown'
                END AS StatusText,
                soh.SubTotal,
                soh.TaxAmt,
                soh.Freight,
                soh.TotalDue,
                cust.CustomerID,
                p.FirstName + ' ' + p.LastName AS CustomerName,
                ea.EmailAddress AS CustomerEmail,
                sm.Name AS ShipMethod,
                -- Ship To Address
                shipAddr.AddressLine1 AS ShipToAddressLine1,
                shipAddr.AddressLine2 AS ShipToAddressLine2,
                shipAddr.City AS ShipToCity,
                shipSP.StateProvinceCode AS ShipToStateProvince,
                shipAddr.PostalCode AS ShipToPostalCode,
                shipCountry.Name AS ShipToCountry,
                -- Bill To Address
                billAddr.AddressLine1 AS BillToAddressLine1,
                billAddr.AddressLine2 AS BillToAddressLine2,
                billAddr.City AS BillToCity,
                billSP.StateProvinceCode AS BillToStateProvince,
                billAddr.PostalCode AS BillToPostalCode,
                billCountry.Name AS BillToCountry
            FROM Sales.SalesOrderHeader soh
            INNER JOIN Sales.Customer cust ON soh.CustomerID = cust.CustomerID
            INNER JOIN Person.Person p ON cust.PersonID = p.BusinessEntityID
            LEFT JOIN Person.EmailAddress ea ON p.BusinessEntityID = ea.BusinessEntityID
            LEFT JOIN Purchasing.ShipMethod sm ON soh.ShipMethodID = sm.ShipMethodID
            -- Ship To Address
            LEFT JOIN Person.Address shipAddr ON soh.ShipToAddressID = shipAddr.AddressID
            LEFT JOIN Person.StateProvince shipSP ON shipAddr.StateProvinceID = shipSP.StateProvinceID
            LEFT JOIN Person.CountryRegion shipCountry ON shipSP.CountryRegionCode = shipCountry.CountryRegionCode
            -- Bill To Address
            LEFT JOIN Person.Address billAddr ON soh.BillToAddressID = billAddr.AddressID
            LEFT JOIN Person.StateProvince billSP ON billAddr.StateProvinceID = billSP.StateProvinceID
            LEFT JOIN Person.CountryRegion billCountry ON billSP.CountryRegionCode = billCountry.CountryRegionCode
            WHERE soh.SalesOrderNumber = @SalesOrderNumber";

        var header = await connection.QuerySingleOrDefaultAsync(headerSql, new { SalesOrderNumber = salesOrderNumber });

        if (header == null)
        {
            return null;
        }

        // Get order line items with product details
        var detailsSql = @"
            SELECT 
                sod.SalesOrderDetailID AS LineNumber,
                p.Name AS ProductName,
                p.ProductNumber,
                sod.OrderQty AS Quantity,
                sod.UnitPrice,
                sod.UnitPriceDiscount,
                sod.LineTotal
            FROM Sales.SalesOrderDetail sod
            INNER JOIN Production.Product p ON sod.ProductID = p.ProductID
            WHERE sod.SalesOrderID = @SalesOrderID
            ORDER BY sod.SalesOrderDetailID";

        var lineItems = await connection.QueryAsync<ReceiptLineItem>(
            detailsSql,
            new { SalesOrderID = (int)header.SalesOrderID }
        );

        // Get applied special offers
        var offersSql = @"
            SELECT DISTINCT
                so.Description
            FROM Sales.SalesOrderDetail sod
            INNER JOIN Sales.SpecialOfferProduct sop ON sod.SpecialOfferID = sop.SpecialOfferID AND sod.ProductID = sop.ProductID
            INNER JOIN Sales.SpecialOffer so ON sop.SpecialOfferID = so.SpecialOfferID
            WHERE sod.SalesOrderID = @SalesOrderID
                AND so.SpecialOfferID > 1  -- Exclude 'No Discount' offer
            ORDER BY so.Description";

        var specialOffers = await connection.QueryAsync<string>(
            offersSql,
            new { SalesOrderID = (int)header.SalesOrderID }
        );

        // Calculate total discount amount
        decimal discountAmt = lineItems.Sum(item => item.UnitPrice * item.Quantity * item.UnitPriceDiscount);

        var receiptData = new ReceiptData
        {
            SalesOrderID = header.SalesOrderID,
            SalesOrderNumber = header.SalesOrderNumber ?? string.Empty,
            CustomerID = header.CustomerID,
            OrderDate = header.OrderDate,
            ShipDate = header.ShipDate,
            Status = header.Status.ToString(),
            StatusText = header.StatusText ?? string.Empty,
            CustomerName = header.CustomerName ?? string.Empty,
            CustomerEmail = header.CustomerEmail ?? string.Empty,
            ShipToAddressLine1 = header.ShipToAddressLine1 ?? string.Empty,
            ShipToAddressLine2 = header.ShipToAddressLine2,
            ShipToCity = header.ShipToCity ?? string.Empty,
            ShipToStateProvince = header.ShipToStateProvince ?? string.Empty,
            ShipToPostalCode = header.ShipToPostalCode ?? string.Empty,
            ShipToCountry = header.ShipToCountry ?? string.Empty,
            BillToAddressLine1 = header.BillToAddressLine1 ?? string.Empty,
            BillToAddressLine2 = header.BillToAddressLine2,
            BillToCity = header.BillToCity ?? string.Empty,
            BillToStateProvince = header.BillToStateProvince ?? string.Empty,
            BillToPostalCode = header.BillToPostalCode ?? string.Empty,
            BillToCountry = header.BillToCountry ?? string.Empty,
            ShipMethod = header.ShipMethod ?? string.Empty,
            LineItems = lineItems.ToList(),
            SubTotal = header.SubTotal,
            TaxAmt = header.TaxAmt,
            Freight = header.Freight,
            DiscountAmt = discountAmt,
            TotalDue = header.TotalDue,
            SpecialOffers = specialOffers.ToList()
        };

        return receiptData;
    }

    /// <summary>
    /// Get complete receipt data for a sales order by SalesOrderID
    /// </summary>
    public async Task<ReceiptData?> GetReceiptDataBySalesOrderIDAsync(int salesOrderID)
    {
        using var connection = await GetConnectionAsync();

        // First get the SalesOrderNumber
        var orderNumberSql = "SELECT SalesOrderNumber FROM Sales.SalesOrderHeader WHERE SalesOrderID = @SalesOrderID";
        var salesOrderNumber = await connection.QuerySingleOrDefaultAsync<string>(
            orderNumberSql,
            new { SalesOrderID = salesOrderID }
        );

        if (string.IsNullOrEmpty(salesOrderNumber))
        {
            return null;
        }

        return await GetReceiptDataBySalesOrderNumberAsync(salesOrderNumber);
    }
}
