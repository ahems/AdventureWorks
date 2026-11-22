using System.Net;
using ApiFunctions.Auth;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

/// <summary>
/// Admin order cancellation. Enforces the allowed status transitions server-side instead of
/// letting the admin app write <c>Status = 6</c> directly through DAB.
/// </summary>
public sealed class OrderCancelFunctions(
    ILogger<OrderCancelFunctions> logger,
    IOrderCancellationService cancellation,
    WebPubSubService webPubSub)
{
    [Function("CancelOrder")]
    public async Task<HttpResponseData> CancelOrder(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "orders/{salesOrderId:int}/cancel")]
        HttpRequestData req,
        int salesOrderId,
        FunctionContext executionContext)
    {
        var user = FunctionUser.Current(executionContext);
        if (!user.IsAuthenticated || !user.IsInternal)
        {
            logger.LogWarning("Denied order cancellation for a non-internal caller");
            return await JsonAsync(req, HttpStatusCode.Forbidden, new { error = "Order access is not allowed." });
        }
        if (salesOrderId <= 0)
            return await JsonAsync(req, HttpStatusCode.BadRequest, new { error = "A valid sales order id is required." });

        var (result, status) = await cancellation.CancelAsync(salesOrderId);
        switch (result)
        {
            case OrderCancelResult.NotFound:
                return await JsonAsync(req, HttpStatusCode.NotFound, new { error = "Order not found." });
            case OrderCancelResult.NotCancellable:
                return await JsonAsync(req, HttpStatusCode.Conflict, new
                {
                    error = "Only In process, Approved or Backordered orders can be cancelled.",
                    status,
                });
        }

        logger.LogInformation("Cancelled SalesOrderID={SalesOrderId}", salesOrderId);
        // The orders group payload is reduced to a generic invalidation signal by WebPubSubService.
        await webPubSub.SendToGroupAsync("orders", new { @event = "order-status-changed" });
        return await JsonAsync(req, HttpStatusCode.OK, new { salesOrderId, status = 6 });
    }

    private static async Task<HttpResponseData> JsonAsync(HttpRequestData req, HttpStatusCode status, object body)
    {
        var response = req.CreateResponse(status);
        await response.WriteAsJsonAsync(body);
        return response;
    }
}
