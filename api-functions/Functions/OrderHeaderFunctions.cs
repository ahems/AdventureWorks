using System.Net;
using System.Text.Json;
using ApiFunctions.Auth;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

public sealed class OrderHeaderFunctions(
    ILogger<OrderHeaderFunctions> logger,
    IOrderHeaderService orderHeaders)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private const decimal MaximumMoney = 922337203685477.5807m;

    [Function("CreateOrderHeader")]
    public async Task<HttpResponseData> CreateOrderHeader(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "orders")] HttpRequestData req,
        FunctionContext executionContext)
    {
        var user = FunctionUser.Current(executionContext);
        if (!user.IsAuthenticated || (!user.IsConsumer && !user.IsInternal) ||
            (user.IsConsumer && (user.CustomerId is not > 0 || user.BusinessEntityId is not > 0)))
        {
            logger.LogWarning("Denied unbound order-header request");
            return await ErrorAsync(req, HttpStatusCode.Forbidden, "Order access is not allowed.");
        }

        CreateOrderHeaderRequest? request;
        try
        {
            request = await JsonSerializer.DeserializeAsync<CreateOrderHeaderRequest>(req.Body, JsonOptions);
        }
        catch (JsonException)
        {
            return await ErrorAsync(req, HttpStatusCode.BadRequest, "The order header payload is invalid.");
        }

        if (request is null || request.BillToAddressId <= 0 || request.ShipToAddressId <= 0 ||
            request.ShipMethodId <= 0 || request.SubTotal < 0 || request.TaxAmt < 0 || request.Freight < 0 ||
            request.SubTotal > MaximumMoney || request.TaxAmt > MaximumMoney || request.Freight > MaximumMoney ||
            request.SubTotal + request.TaxAmt + request.Freight > MaximumMoney)
        {
            return await ErrorAsync(req, HttpStatusCode.BadRequest, "The order header payload is invalid.");
        }

        var customerId = user.IsConsumer ? user.CustomerId : request.CustomerId;
        var businessEntityId = user.IsConsumer ? user.BusinessEntityId : request.BusinessEntityId;
        if (customerId is not > 0 || businessEntityId is not > 0)
        {
            logger.LogWarning("Denied order-header request without customer/person binding");
            return await ErrorAsync(req, HttpStatusCode.Forbidden, "Order access is not allowed.");
        }

        var orderId = await orderHeaders.CreateAsync(customerId.Value, businessEntityId.Value, request);
        if (orderId is null)
        {
            logger.LogWarning("Denied order-header request with an invalid customer, address or ship method");
            return await ErrorAsync(req, HttpStatusCode.Forbidden, "Order access is not allowed.");
        }

        var response = req.CreateResponse(HttpStatusCode.Created);
        await response.WriteAsJsonAsync(new { salesOrderId = orderId.Value });
        return response;
    }

    private static async Task<HttpResponseData> ErrorAsync(
        HttpRequestData req, HttpStatusCode status, string message)
    {
        var response = req.CreateResponse(status);
        await response.WriteAsJsonAsync(new { error = message });
        return response;
    }
}
