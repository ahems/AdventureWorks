using System.Net;
using System.Text.Json;
using ApiFunctions.Auth;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

/// <summary>
/// Storefront checkout. The signed-in consumer sends only product IDs, quantities, owned address
/// IDs, a ship method, an optional discount code and the display currency; the server prices the
/// order and writes the header and every line in one SQL transaction.
/// </summary>
public sealed class CheckoutFunctions(ILogger<CheckoutFunctions> logger, ICheckoutService checkout)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    [Function("PlaceCheckoutOrder")]
    public async Task<HttpResponseData> PlaceCheckoutOrder(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "orders/checkout")] HttpRequestData req,
        FunctionContext executionContext)
    {
        var user = FunctionUser.Current(executionContext);
        if (!user.IsAuthenticated || !user.IsConsumer ||
            user.CustomerId is not > 0 || user.BusinessEntityId is not > 0)
        {
            logger.LogWarning("Denied checkout request without a customer-bound consumer token");
            return await ErrorAsync(req, HttpStatusCode.Forbidden, "Order access is not allowed.", null);
        }

        var request = await ReadAsync(req);
        if (request is null)
            return await ErrorAsync(req, HttpStatusCode.BadRequest, "The checkout payload is invalid.", null);

        var outcome = await checkout.PlaceOrderAsync(user.CustomerId.Value, user.BusinessEntityId.Value, request);
        if (outcome.Result is not { SalesOrderId: int salesOrderId } result)
            return await FailureAsync(req, outcome);

        logger.LogInformation("Checkout created SalesOrderID={SalesOrderId} with {LineCount} line(s)",
            salesOrderId, result.Pricing.Lines.Count);
        var response = req.CreateResponse(HttpStatusCode.Created);
        await response.WriteAsJsonAsync(ToBody(result));
        return response;
    }

    [Function("QuoteCheckout")]
    public async Task<HttpResponseData> QuoteCheckout(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "orders/checkout/quote")] HttpRequestData req,
        FunctionContext executionContext)
    {
        var user = FunctionUser.Current(executionContext);
        if (!user.IsAuthenticated || !user.IsConsumer || user.BusinessEntityId is not > 0)
        {
            logger.LogWarning("Denied checkout quote without a person-bound consumer token");
            return await ErrorAsync(req, HttpStatusCode.Forbidden, "Order access is not allowed.", null);
        }

        var request = await ReadAsync(req);
        if (request is null)
            return await ErrorAsync(req, HttpStatusCode.BadRequest, "The checkout payload is invalid.", null);

        var outcome = await checkout.QuoteAsync(user.BusinessEntityId.Value, request);
        if (outcome.Result is not { } result)
            return await FailureAsync(req, outcome);

        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(ToBody(result));
        return response;
    }

    private static async Task<CheckoutRequest?> ReadAsync(HttpRequestData req)
    {
        try
        {
            return await JsonSerializer.DeserializeAsync<CheckoutRequest>(req.Body, JsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static Task<HttpResponseData> FailureAsync(HttpRequestData req, CheckoutOutcome outcome) =>
        outcome.Failure switch
        {
            CheckoutFailure.Forbidden => ErrorAsync(req, HttpStatusCode.Forbidden, "Order access is not allowed.", null),
            CheckoutFailure.InvalidDiscountCode => ErrorAsync(req, HttpStatusCode.BadRequest,
                outcome.Error ?? "The discount code is not valid.", "invalid-discount-code"),
            CheckoutFailure.UnavailableProduct => ErrorAsync(req, HttpStatusCode.BadRequest,
                outcome.Error ?? "One or more products are not available.", "unavailable-product"),
            _ => ErrorAsync(req, HttpStatusCode.BadRequest, outcome.Error ?? "The checkout payload is invalid.", null),
        };

    internal static object ToBody(CheckoutResult result) => new
    {
        salesOrderId = result.SalesOrderId,
        salesOrderNumber = result.SalesOrderId is int id ? $"SO{id}" : null,
        currency = "USD",
        listSubTotal = result.Pricing.ListSubTotal,
        saleDiscount = result.Pricing.SaleDiscount,
        codeDiscount = result.Pricing.CodeDiscount,
        subTotal = result.Pricing.SubTotal,
        taxRate = result.Pricing.TaxRate,
        taxAmt = result.Pricing.TaxAmt,
        freight = result.Pricing.Freight,
        totalDue = result.Pricing.TotalDue,
        discount = result.Discount is { } discount
            ? new
            {
                code = discount.Code,
                description = discount.Description,
                type = discount.Type == DiscountCodeType.Percent ? "percent" : "freeshipping",
                percent = discount.Percent * 100m,
            }
            : null,
        display = new
        {
            currency = result.Display.CurrencyCode,
            exchangeRate = result.Display.ExchangeRate,
            subTotal = result.Display.SubTotal,
            codeDiscount = result.Display.CodeDiscount,
            taxAmt = result.Display.TaxAmt,
            freight = result.Display.Freight,
            totalDue = result.Display.TotalDue,
        },
        lines = result.Pricing.Lines.Select(line => new
        {
            productId = line.ProductId,
            quantity = line.Quantity,
            unitPrice = line.UnitPrice,
            unitPriceDiscount = line.UnitPriceDiscount,
            specialOfferId = line.SpecialOfferId,
            lineTotal = line.LineTotal,
        }),
    };

    private static async Task<HttpResponseData> ErrorAsync(
        HttpRequestData req, HttpStatusCode status, string message, string? reason)
    {
        var response = req.CreateResponse(status);
        await response.WriteAsJsonAsync(new { error = message, reason });
        return response;
    }
}
