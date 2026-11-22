using System.Data;
using System.Data.Common;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.Data.SqlClient;

namespace api_functions.Services;

public sealed record CheckoutLineRequest(int ProductId, int Quantity);

/// <summary>
/// Storefront checkout request. Only product identities and quantities are accepted from the
/// browser; every price, discount, tax and freight amount is resolved server-side.
/// </summary>
public sealed record CheckoutRequest(
    IReadOnlyList<CheckoutLineRequest>? Lines,
    int? BillToAddressId = null,
    int? ShipToAddressId = null,
    int? ShipMethodId = null,
    string? DiscountCode = null,
    string? DisplayCurrency = null);

public enum DiscountCodeType { Percent, FreeShipping }

public sealed record DiscountCodeInfo(string Code, string Description, DiscountCodeType Type, decimal Percent);

public sealed record CheckoutProductPrice(int ProductId, decimal ListPrice, int SpecialOfferId, decimal SaleDiscountPct);

public sealed record CheckoutCurrencyRate(int? CurrencyRateId, string CurrencyCode, decimal Rate)
{
    public static CheckoutCurrencyRate Usd { get; } = new(null, "USD", 1m);
}

public sealed record PricedCheckoutLine(
    int ProductId,
    short Quantity,
    decimal UnitPrice,
    decimal UnitPriceDiscount,
    int SpecialOfferId,
    decimal LineTotal);

/// <summary>Authoritative order totals in USD (the currency stored on Sales.SalesOrderHeader).</summary>
public sealed record CheckoutPricing(
    IReadOnlyList<PricedCheckoutLine> Lines,
    decimal ListSubTotal,
    decimal SaleDiscount,
    decimal CodeDiscount,
    decimal SubTotal,
    decimal TaxRate,
    decimal TaxAmt,
    decimal Freight,
    decimal TotalDue);

public sealed record CheckoutDisplayTotals(
    string CurrencyCode,
    decimal ExchangeRate,
    decimal SubTotal,
    decimal CodeDiscount,
    decimal TaxAmt,
    decimal Freight,
    decimal TotalDue);

public sealed record CheckoutResult(
    int? SalesOrderId,
    CheckoutPricing Pricing,
    DiscountCodeInfo? Discount,
    CheckoutDisplayTotals Display);

public enum CheckoutFailure
{
    None,
    InvalidRequest,
    Forbidden,
    InvalidDiscountCode,
    UnavailableProduct,
}

public sealed record CheckoutOutcome(CheckoutFailure Failure, string? Error, CheckoutResult? Result)
{
    public static CheckoutOutcome Fail(CheckoutFailure failure, string error) => new(failure, error, null);
    public static CheckoutOutcome Ok(CheckoutResult result) => new(CheckoutFailure.None, null, result);
}

/// <summary>
/// Pure pricing rules for storefront checkout. Mirrors the storefront preview formula so the
/// figures a shopper sees match the persisted order, but runs on server-owned inputs only.
/// </summary>
public static class CheckoutPricingCalculator
{
    public const decimal FreeShippingThresholdUsd = 50m;
    public const decimal DefaultTaxRate = 0.08m;
    public const decimal DefaultShipBase = 9.99m;

    public static CheckoutPricing Calculate(
        IReadOnlyList<(CheckoutProductPrice Product, short Quantity)> lines,
        DiscountCodeInfo? discount,
        decimal? taxRatePercent,
        decimal? shipBase)
    {
        ArgumentNullException.ThrowIfNull(lines);
        if (lines.Count == 0)
            throw new ArgumentException("At least one line is required.", nameof(lines));

        var codePct = discount?.Type == DiscountCodeType.Percent ? discount.Percent : 0m;
        var priced = new List<PricedCheckoutLine>(lines.Count);
        decimal listSubTotal = 0m, saleSubTotal = 0m, subTotal = 0m;

        foreach (var (product, quantity) in lines)
        {
            var salePct = SalePct(product);
            var combined = CombinedDiscount(salePct, codePct);
            var lineTotal = product.ListPrice * (1m - combined) * quantity;
            priced.Add(PriceLine(product, quantity, codePct));
            listSubTotal += product.ListPrice * quantity;
            saleSubTotal += product.ListPrice * (1m - salePct) * quantity;
            subTotal += lineTotal;
        }

        subTotal = Round(subTotal);
        listSubTotal = Round(listSubTotal);
        saleSubTotal = Round(saleSubTotal);

        var taxRate = taxRatePercent is > 0m ? taxRatePercent.Value / 100m : DefaultTaxRate;
        var effectiveShipBase = shipBase is > 0m ? shipBase.Value : DefaultShipBase;
        var freight = discount?.Type == DiscountCodeType.FreeShipping || subTotal > FreeShippingThresholdUsd
            ? 0m
            : Round(effectiveShipBase);
        var tax = Round(subTotal * taxRate);

        return new CheckoutPricing(
            priced,
            listSubTotal,
            listSubTotal - saleSubTotal,
            saleSubTotal - subTotal,
            subTotal,
            taxRate,
            tax,
            freight,
            subTotal + tax + freight);
    }

    /// <summary>
    /// Prices one line from server-owned catalogue data: list price, the best active offer and an
    /// optional percent discount code. Shared by storefront checkout and simulator/B2B orders.
    /// </summary>
    public static PricedCheckoutLine PriceLine(CheckoutProductPrice product, short quantity, decimal codePct = 0m)
    {
        ArgumentNullException.ThrowIfNull(product);
        var salePct = SalePct(product);
        var combined = CombinedDiscount(salePct, codePct);
        return new PricedCheckoutLine(
            product.ProductId,
            quantity,
            product.ListPrice,
            combined,
            salePct > 0m ? product.SpecialOfferId : 1,
            Math.Round(product.ListPrice * (1m - combined) * quantity, 2, MidpointRounding.AwayFromZero));
    }

    private static decimal SalePct(CheckoutProductPrice product) =>
        product.SaleDiscountPct is > 0m and < 1m ? product.SaleDiscountPct : 0m;

    private static decimal CombinedDiscount(decimal salePct, decimal codePct) =>
        Math.Round(1m - (1m - salePct) * (1m - codePct), 4, MidpointRounding.AwayFromZero);

    public static CheckoutDisplayTotals ToDisplay(CheckoutPricing pricing, CheckoutCurrencyRate currency)
    {
        var rate = currency.Rate > 0m ? currency.Rate : 1m;
        var subTotal = Round(pricing.SubTotal * rate);
        var tax = Round(pricing.TaxAmt * rate);
        var freight = Round(pricing.Freight * rate);
        return new CheckoutDisplayTotals(
            currency.CurrencyCode,
            rate,
            subTotal,
            Round(pricing.CodeDiscount * rate),
            tax,
            freight,
            subTotal + tax + freight);
    }

    private static decimal Round(decimal value) => Math.Round(value, 2, MidpointRounding.AwayFromZero);
}

public static partial class CheckoutRequestValidator
{
    public const int MaximumLines = 100;
    public const int MaximumQuantity = 999;

    [GeneratedRegex("^[A-Z0-9]{1,32}$")]
    private static partial Regex DiscountCodePattern();

    [GeneratedRegex("^[A-Z]{3}$")]
    private static partial Regex CurrencyPattern();

    public static string? NormalizeDiscountCode(string? code)
    {
        var normalized = code?.Trim().ToUpperInvariant();
        return string.IsNullOrEmpty(normalized) ? null : normalized;
    }

    public static string NormalizeCurrency(string? currency)
    {
        var normalized = currency?.Trim().ToUpperInvariant();
        return string.IsNullOrEmpty(normalized) ? "USD" : normalized;
    }

    /// <summary>Returns an error message, or null when the request shape is acceptable.</summary>
    public static string? Validate(CheckoutRequest? request, bool placingOrder)
    {
        if (request?.Lines is not { Count: > 0 and <= MaximumLines } lines)
            return $"Between 1 and {MaximumLines} order lines are required.";
        if (lines.Any(line => line is null || line.ProductId <= 0 ||
                line.Quantity is < 1 or > MaximumQuantity))
            return $"Each line needs a valid product and a quantity from 1 to {MaximumQuantity}.";
        if (lines.Select(line => line.ProductId).Distinct().Count() != lines.Count)
            return "Each product may appear only once.";

        if (placingOrder)
        {
            if (request.BillToAddressId is not > 0 || request.ShipToAddressId is not > 0 ||
                request.ShipMethodId is not > 0)
                return "Billing address, shipping address and ship method are required.";
        }
        else if (request.BillToAddressId is <= 0 || request.ShipToAddressId is <= 0 || request.ShipMethodId is <= 0)
        {
            return "Address and ship method identifiers must be positive.";
        }

        var code = NormalizeDiscountCode(request.DiscountCode);
        if (code is not null && !DiscountCodePattern().IsMatch(code))
            return "The discount code is not valid.";
        if (!CurrencyPattern().IsMatch(NormalizeCurrency(request.DisplayCurrency)))
            return "The display currency is not valid.";
        return null;
    }
}

public interface ICheckoutService
{
    Task<CheckoutOutcome> QuoteAsync(int businessEntityId, CheckoutRequest request);
    Task<CheckoutOutcome> PlaceOrderAsync(int customerId, int businessEntityId, CheckoutRequest request);
}

/// <summary>Data access used by <see cref="CheckoutService"/>; one session = one connection + transaction.</summary>
public interface ICheckoutStore
{
    Task<ICheckoutSession> BeginAsync(bool forWrite);
}

public interface ICheckoutSession : IAsyncDisposable
{
    Task<bool> CustomerBelongsToAsync(int customerId, int businessEntityId);
    Task<bool> AddressBelongsToAsync(int addressId, int businessEntityId);
    Task<decimal?> GetShipBaseAsync(int shipMethodId);
    Task<decimal?> GetTaxRatePercentAsync(int shipToAddressId);
    Task<IReadOnlyList<CheckoutProductPrice>> GetProductPricesAsync(IReadOnlyCollection<int> productIds);
    Task<DiscountCodeInfo?> GetDiscountCodeAsync(string code);
    Task<CheckoutCurrencyRate?> GetCurrencyRateAsync(string currencyCode);
    Task<int> InsertOrderAsync(
        int customerId, int billToAddressId, int shipToAddressId, int shipMethodId,
        int? currencyRateId, CheckoutPricing pricing);
    void Commit();
}

/// <summary>
/// Server-side storefront checkout: validates ownership, prices every line from the catalogue,
/// applies server-held discount codes and writes the header and all lines in one transaction.
/// </summary>
public sealed class CheckoutService(ICheckoutStore store) : ICheckoutService
{
    public Task<CheckoutOutcome> QuoteAsync(int businessEntityId, CheckoutRequest request) =>
        RunAsync(null, businessEntityId, request, placingOrder: false);

    public Task<CheckoutOutcome> PlaceOrderAsync(int customerId, int businessEntityId, CheckoutRequest request) =>
        RunAsync(customerId, businessEntityId, request, placingOrder: true);

    private async Task<CheckoutOutcome> RunAsync(
        int? customerId, int businessEntityId, CheckoutRequest request, bool placingOrder)
    {
        var invalid = CheckoutRequestValidator.Validate(request, placingOrder);
        if (invalid is not null)
            return CheckoutOutcome.Fail(CheckoutFailure.InvalidRequest, invalid);
        if (businessEntityId <= 0 || (placingOrder && customerId is not > 0))
            return CheckoutOutcome.Fail(CheckoutFailure.Forbidden, "Order access is not allowed.");

        await using var session = await store.BeginAsync(placingOrder);

        if (customerId is int customer && !await session.CustomerBelongsToAsync(customer, businessEntityId))
            return CheckoutOutcome.Fail(CheckoutFailure.Forbidden, "Order access is not allowed.");
        foreach (var addressId in new[] { request.BillToAddressId, request.ShipToAddressId }.OfType<int>().Distinct())
        {
            if (!await session.AddressBelongsToAsync(addressId, businessEntityId))
                return CheckoutOutcome.Fail(CheckoutFailure.Forbidden, "Order access is not allowed.");
        }

        decimal? shipBase = null;
        if (request.ShipMethodId is int shipMethodId)
        {
            shipBase = await session.GetShipBaseAsync(shipMethodId);
            if (shipBase is null)
                return CheckoutOutcome.Fail(CheckoutFailure.InvalidRequest, "The ship method is not available.");
        }

        DiscountCodeInfo? discount = null;
        var code = CheckoutRequestValidator.NormalizeDiscountCode(request.DiscountCode);
        if (code is not null)
        {
            discount = await session.GetDiscountCodeAsync(code);
            if (discount is null)
                return CheckoutOutcome.Fail(CheckoutFailure.InvalidDiscountCode, "The discount code is not valid.");
        }

        var lines = request.Lines!;
        var products = (await session.GetProductPricesAsync(lines.Select(l => l.ProductId).ToArray()))
            .ToDictionary(p => p.ProductId);
        if (lines.Any(line => !products.ContainsKey(line.ProductId)))
            return CheckoutOutcome.Fail(CheckoutFailure.UnavailableProduct, "One or more products are not available.");

        var taxRate = request.ShipToAddressId is int shipTo ? await session.GetTaxRatePercentAsync(shipTo) : null;
        var pricing = CheckoutPricingCalculator.Calculate(
            lines.Select(line => (products[line.ProductId], (short)line.Quantity)).ToArray(),
            discount, taxRate, shipBase);

        var currencyCode = CheckoutRequestValidator.NormalizeCurrency(request.DisplayCurrency);
        var currency = currencyCode == "USD"
            ? CheckoutCurrencyRate.Usd
            : await session.GetCurrencyRateAsync(currencyCode) ?? CheckoutCurrencyRate.Usd;

        int? salesOrderId = null;
        if (placingOrder)
        {
            salesOrderId = await session.InsertOrderAsync(
                customerId!.Value, request.BillToAddressId!.Value, request.ShipToAddressId!.Value,
                request.ShipMethodId!.Value, currency.CurrencyRateId, pricing);
            session.Commit();
        }

        return CheckoutOutcome.Ok(new CheckoutResult(
            salesOrderId, pricing, discount, CheckoutPricingCalculator.ToDisplay(pricing, currency)));
    }
}

/// <summary>
/// The single catalogue price query: list price plus the best active offer of one SpecialOffer
/// category. Products without a positive list price are not returned (not for sale).
/// </summary>
public static class CatalogPriceQuery
{
    /// <summary>Consumer pricing (storefront checkout and simulated consumer orders).</summary>
    public const string CustomerOffers = "Customer";

    /// <summary>B2B store pricing (admin store orders and simulated store replenishment).</summary>
    public const string ResellerOffers = "Reseller";

    public static async Task<IReadOnlyList<CheckoutProductPrice>> GetAsync(
        IDbConnection connection, IDbTransaction? transaction, IReadOnlyCollection<int> productIds, string offerCategory) =>
        productIds.Count == 0
            ? []
            : (await connection.QueryAsync<CheckoutProductPrice>("""
                SELECT p.ProductID AS ProductId,
                       p.ListPrice,
                       ISNULL(offer.SpecialOfferID, 1) AS SpecialOfferId,
                       CONVERT(decimal(19, 4), ISNULL(offer.DiscountPct, 0)) AS SaleDiscountPct
                FROM Production.Product p
                OUTER APPLY (
                    SELECT TOP (1) so.SpecialOfferID, so.DiscountPct
                    FROM Sales.SpecialOfferProduct sop
                    INNER JOIN Sales.SpecialOffer so ON so.SpecialOfferID = sop.SpecialOfferID
                    WHERE sop.ProductID = p.ProductID
                      AND so.Category = @OfferCategory
                      AND so.DiscountPct > 0 AND so.DiscountPct < 1
                      AND so.StartDate <= GETDATE() AND so.EndDate >= GETDATE()
                    ORDER BY so.DiscountPct DESC, so.SpecialOfferID
                ) offer
                WHERE p.ProductID IN @ProductIds
                  AND p.ListPrice > 0
                """, new { ProductIds = productIds, OfferCategory = offerCategory }, transaction)).AsList();
}

public class SqlCheckoutStore(string connectionString) : ICheckoutStore
{
    protected virtual DbConnection CreateConnection() => new SqlConnection(connectionString);

    public async Task<ICheckoutSession> BeginAsync(bool forWrite)
    {
        var connection = CreateConnection();
        try
        {
            await connection.OpenAsync();
            var transaction = connection.BeginTransaction(
                forWrite ? IsolationLevel.Serializable : IsolationLevel.ReadCommitted);
            return new SqlCheckoutSession(connection, transaction, forWrite);
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    private sealed class SqlCheckoutSession(DbConnection connection, DbTransaction transaction, bool forWrite)
        : ICheckoutSession
    {
        private bool _committed;
        private string Lock => forWrite ? "WITH (UPDLOCK, HOLDLOCK)" : "";

        public Task<bool> CustomerBelongsToAsync(int customerId, int businessEntityId) =>
            connection.ExecuteScalarAsync<bool>($"""
                SELECT CONVERT(bit, CASE WHEN EXISTS (
                    SELECT 1 FROM Sales.Customer c {Lock}
                    WHERE c.CustomerID = @CustomerId AND c.PersonID = @BusinessEntityId
                ) THEN 1 ELSE 0 END)
                """, new { CustomerId = customerId, BusinessEntityId = businessEntityId }, transaction);

        public Task<bool> AddressBelongsToAsync(int addressId, int businessEntityId) =>
            connection.ExecuteScalarAsync<bool>($"""
                SELECT CONVERT(bit, CASE WHEN EXISTS (
                    SELECT 1 FROM Person.Address a {Lock}
                    INNER JOIN Person.BusinessEntityAddress bea {Lock} ON bea.AddressID = a.AddressID
                    WHERE a.AddressID = @AddressId AND bea.BusinessEntityID = @BusinessEntityId
                ) THEN 1 ELSE 0 END)
                """, new { AddressId = addressId, BusinessEntityId = businessEntityId }, transaction);

        public Task<decimal?> GetShipBaseAsync(int shipMethodId) =>
            connection.QuerySingleOrDefaultAsync<decimal?>(
                "SELECT ShipBase FROM Purchasing.ShipMethod WHERE ShipMethodID = @ShipMethodId",
                new { ShipMethodId = shipMethodId }, transaction);

        public Task<decimal?> GetTaxRatePercentAsync(int shipToAddressId) =>
            connection.QueryFirstOrDefaultAsync<decimal?>("""
                SELECT TOP (1) str.TaxRate
                FROM Person.Address a
                INNER JOIN Sales.SalesTaxRate str ON str.StateProvinceID = a.StateProvinceID
                WHERE a.AddressID = @AddressId
                ORDER BY str.SalesTaxRateID
                """, new { AddressId = shipToAddressId }, transaction);

        public Task<IReadOnlyList<CheckoutProductPrice>> GetProductPricesAsync(IReadOnlyCollection<int> productIds) =>
            CatalogPriceQuery.GetAsync(connection, transaction, productIds, CatalogPriceQuery.CustomerOffers);

        public async Task<DiscountCodeInfo?> GetDiscountCodeAsync(string code)
        {
            var row = await connection.QuerySingleOrDefaultAsync<(string Code, string Description, string DiscountType, decimal DiscountPct)>("""
                SELECT Code, Description, DiscountType, DiscountPct
                FROM Sales.DiscountCode
                WHERE Code = @Code
                  AND IsActive = 1
                  AND StartDate <= SYSUTCDATETIME()
                  AND (EndDate IS NULL OR EndDate > SYSUTCDATETIME())
                """, new { Code = code }, transaction);
            if (row.Code is null)
                return null;
            return row.DiscountType switch
            {
                "percent" when row.DiscountPct is > 0m and < 1m =>
                    new DiscountCodeInfo(row.Code, row.Description, DiscountCodeType.Percent, row.DiscountPct),
                "freeshipping" => new DiscountCodeInfo(row.Code, row.Description, DiscountCodeType.FreeShipping, 0m),
                _ => null,
            };
        }

        public async Task<CheckoutCurrencyRate?> GetCurrencyRateAsync(string currencyCode)
        {
            var row = await connection.QueryFirstOrDefaultAsync<(int CurrencyRateId, string ToCurrencyCode, decimal AverageRate)>("""
                SELECT TOP (1) CurrencyRateID, RTRIM(ToCurrencyCode), CONVERT(decimal(19, 6), AverageRate)
                FROM Sales.CurrencyRate
                WHERE RTRIM(FromCurrencyCode) = 'USD' AND RTRIM(ToCurrencyCode) = @CurrencyCode
                  AND AverageRate > 0
                ORDER BY CurrencyRateDate DESC, CurrencyRateID DESC
                """, new { CurrencyCode = currencyCode }, transaction);
            return row.CurrencyRateId > 0
                ? new CheckoutCurrencyRate(row.CurrencyRateId, row.ToCurrencyCode, row.AverageRate)
                : null;
        }

        public async Task<int> InsertOrderAsync(
            int customerId, int billToAddressId, int shipToAddressId, int shipMethodId,
            int? currencyRateId, CheckoutPricing pricing)
        {
            var salesOrderId = await connection.ExecuteScalarAsync<int>("""
                INSERT INTO Sales.SalesOrderHeader
                    (RevisionNumber, OrderDate, DueDate, Status, OnlineOrderFlag, CustomerID,
                     BillToAddressID, ShipToAddressID, ShipMethodID, CurrencyRateID, SubTotal, TaxAmt, Freight)
                OUTPUT INSERTED.SalesOrderID
                VALUES
                    (1, GETUTCDATE(), DATEADD(day, 7, GETUTCDATE()), 1, 1, @CustomerId,
                     @BillToAddressId, @ShipToAddressId, @ShipMethodId, @CurrencyRateId, @SubTotal, @TaxAmt, @Freight)
                """, new
            {
                CustomerId = customerId,
                BillToAddressId = billToAddressId,
                ShipToAddressId = shipToAddressId,
                ShipMethodId = shipMethodId,
                CurrencyRateId = currencyRateId,
                pricing.SubTotal,
                pricing.TaxAmt,
                pricing.Freight,
            }, transaction);

            foreach (var line in pricing.Lines)
            {
                await connection.ExecuteAsync("""
                    INSERT INTO Sales.SalesOrderDetail
                        (SalesOrderID, OrderQty, ProductID, SpecialOfferID, UnitPrice, UnitPriceDiscount, ModifiedDate)
                    VALUES
                        (@SalesOrderId, @Quantity, @ProductId, @SpecialOfferId, @UnitPrice, @UnitPriceDiscount, GETDATE())
                    """, new
                {
                    SalesOrderId = salesOrderId,
                    line.Quantity,
                    line.ProductId,
                    line.SpecialOfferId,
                    line.UnitPrice,
                    line.UnitPriceDiscount,
                }, transaction);
            }
            return salesOrderId;
        }

        public void Commit()
        {
            transaction.Commit();
            _committed = true;
        }

        public async ValueTask DisposeAsync()
        {
            if (!_committed)
            {
                try { await transaction.RollbackAsync(); }
                catch (InvalidOperationException) { }
            }
            await transaction.DisposeAsync();
            await connection.DisposeAsync();
        }
    }
}
