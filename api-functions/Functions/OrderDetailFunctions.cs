using System.Net;
using System.Globalization;
using System.Text.Json;
using ApiFunctions.Auth;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

public sealed class OrderDetailFunctions
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly ILogger<OrderDetailFunctions> _logger;
    private readonly IOrderDetailService _orderDetailService;

    public OrderDetailFunctions(
        ILogger<OrderDetailFunctions> logger,
        IOrderDetailService orderDetailService)
    {
        _logger = logger;
        _orderDetailService = orderDetailService;
    }

    [Function("GetOwnedOrderDetails")]
    public async Task<HttpResponseData> GetOwnedOrderDetails(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "orders/details")] HttpRequestData req,
        FunctionContext executionContext)
    {
        var user = FunctionUser.Current(executionContext);
        if (!TryResolveOwner(user, out var ownerCustomerId, out var error))
            return await ErrorAsync(req, HttpStatusCode.Forbidden, error);

        var values = System.Web.HttpUtility.ParseQueryString(req.Url.Query).GetValues("orderIds");
        if (values is not { Length: 1 } || values[0] is not string requested)
            return await ErrorAsync(req, HttpStatusCode.BadRequest, "A valid order ID batch is required.");

        var parts = requested.Split(',');
        if (parts.Length is 0 or > OrderDetailService.MaximumOrderIds)
            return await ErrorAsync(req, HttpStatusCode.BadRequest, "A valid order ID batch is required.");

        var ids = new List<int>(parts.Length);
        foreach (var part in parts)
        {
            if (!int.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id <= 0)
                return await ErrorAsync(req, HttpStatusCode.BadRequest, "A valid order ID batch is required.");
            ids.Add(id);
        }
        if (ids.Distinct().Count() != ids.Count)
            return await ErrorAsync(req, HttpStatusCode.BadRequest, "A valid order ID batch is required.");

        var details = await _orderDetailService.ReadAsync(ids, ownerCustomerId);
        if (details is null)
        {
            _logger.LogWarning("Denied order-detail batch containing an unavailable or foreign order");
            return await ErrorAsync(req, HttpStatusCode.Forbidden, "Order access is not allowed.");
        }

        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(details);
        return response;
    }

    private bool TryResolveOwner(FunctionUser user, out int? ownerCustomerId, out string error)
    {
        ownerCustomerId = null;
        error = "Order access is not allowed.";
        if (!user.IsAuthenticated)
        {
            _logger.LogWarning("Denied unauthenticated order-detail request");
            return false;
        }
        if (user.IsConsumer)
        {
            if (user.CustomerId is not int customerId || customerId <= 0)
            {
                _logger.LogWarning("Denied unbound consumer order-detail request");
                error = "This token has no customer id; cannot resolve owned orders.";
                return false;
            }
            ownerCustomerId = customerId;
            return true;
        }
        if (user.IsInternal)
            return true;

        _logger.LogWarning("Denied order-detail request for an unrecognized caller category");
        return false;
    }

    private static async Task<HttpResponseData> ErrorAsync(
        HttpRequestData req,
        HttpStatusCode status,
        string message)
    {
        var response = req.CreateResponse(status);
        await response.WriteAsJsonAsync(new { error = message });
        return response;
    }
}
