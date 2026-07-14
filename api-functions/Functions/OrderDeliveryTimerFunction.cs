using System.Net;
using Microsoft.ApplicationInsights;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Promotes Shipped (Status=5) orders to Delivered (Status=7) once the configured
/// delivery window has elapsed since the order was shipped.
///
/// B2C orders (OnlineOrderFlag=1) and B2B store orders (OnlineOrderFlag=0) use
/// separate, independently configurable minimum-day thresholds.
///
/// Timer fires every hour.  An HTTP GET endpoint is also exposed for manual
/// triggering during development or testing:
///   GET /api/orders/delivery/trigger
///
/// Order notification emails are gated behind the ORDER_NOTIFICATIONS_EMAIL_ENABLED
/// environment variable.  When unset or set to any value other than "true", emails
/// are suppressed and the intended content is logged at Information level instead.
/// </summary>
public class OrderDeliveryTimerFunction
{
    private readonly ILogger<OrderDeliveryTimerFunction> _logger;
    private readonly OrderService _orderService;
    private readonly EmailService _emailService;
    private readonly OrderPipelineConfigService _pipelineConfig;
    private readonly TelemetryClient _telemetry;
    private readonly bool _emailEnabled;

    public OrderDeliveryTimerFunction(
        ILogger<OrderDeliveryTimerFunction> logger,
        OrderService orderService,
        EmailService emailService,
        OrderPipelineConfigService pipelineConfig,
        TelemetryClient telemetry)
    {
        _logger        = logger;
        _orderService  = orderService;
        _emailService  = emailService;
        _pipelineConfig = pipelineConfig;
        _telemetry     = telemetry;
        _emailEnabled  = string.Equals(
            Environment.GetEnvironmentVariable("ORDER_NOTIFICATIONS_EMAIL_ENABLED"),
            "true", StringComparison.OrdinalIgnoreCase);
    }

    // ── Timer trigger: every hour at :00 ─────────────────────────────────────

    [Function("OrderDelivery_Timer")]
    public async Task RunTimer(
        [TimerTrigger("0 0 * * * *")] TimerInfo timer)
    {
        _logger.LogInformation("[OrderDelivery] Timer fired.");
        await ProcessDeliveriesAsync();
    }

    // ── HTTP trigger: manual / test ───────────────────────────────────────────

    [Function("OrderDelivery_HttpTrigger")]
    public async Task<HttpResponseData> RunHttp(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "orders/delivery/trigger")]
        HttpRequestData req)
    {
        _logger.LogInformation("[OrderDelivery] Manual HTTP trigger fired.");
        var count = await ProcessDeliveriesAsync();

        var resp = req.CreateResponse(HttpStatusCode.OK);
        resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await resp.WriteStringAsync($"{{\"delivered\":{count},\"message\":\"{count} order(s) marked as Delivered.\"}}");
        return resp;
    }

    // ── Core processing ───────────────────────────────────────────────────────

    private async Task<int> ProcessDeliveriesAsync()
    {
        var cfg = await _pipelineConfig.GetConfigAsync();

        var deliveredIds = await _orderService.MarkOrdersAsDeliveredAsync(
            cfg.ShippedToDeliveredMinDaysB2C,
            cfg.ShippedToDeliveredMinDaysB2B);

        if (deliveredIds.Count == 0)
        {
            _logger.LogDebug("[OrderDelivery] No orders eligible for delivery promotion.");
            return 0;
        }

        _logger.LogInformation("[OrderDelivery] Promoted {Count} order(s) to Delivered (Status=7).", deliveredIds.Count);

        _telemetry.TrackEvent("OrderDelivery.BatchProcessed", new Dictionary<string, string>
        {
            ["Count"]              = deliveredIds.Count.ToString(),
            ["MinDaysB2C"]         = cfg.ShippedToDeliveredMinDaysB2C.ToString(),
            ["MinDaysB2B"]         = cfg.ShippedToDeliveredMinDaysB2B.ToString(),
            ["EmailEnabled"]       = _emailEnabled.ToString(),
        });

        foreach (var salesOrderId in deliveredIds)
        {
            await SendDeliveredEmailAsync(salesOrderId);
        }

        return deliveredIds.Count;
    }

    private async Task SendDeliveredEmailAsync(int salesOrderId)
    {
        const string subject = "Your order has been delivered – demo";
        const string body    = "This is a demo. Your Adventure Works order has been delivered. Thank you for shopping with us!";

        if (!_emailEnabled)
        {
            _logger.LogInformation(
                "[EmailNotifications disabled] Delivered email suppressed for SalesOrderID={SalesOrderId}. Subject: '{Subject}' Body: '{Body}'",
                salesOrderId, subject, body);
            return;
        }

        try
        {
            var emailInfo = await _orderService.GetCustomerEmailInfoBySalesOrderIdAsync(salesOrderId);
            if (emailInfo == null)
            {
                _logger.LogWarning("[OrderDelivery] Could not find customer email for SalesOrderID={SalesOrderId}. Skipping delivered email.", salesOrderId);
                return;
            }

            var sent = await _emailService.SendCustomerEmailAsync(
                emailInfo.Value.CustomerId,
                emailInfo.Value.EmailAddressId,
                subject,
                body,
                attachmentUrl: null);

            if (sent)
                _logger.LogInformation("[OrderDelivery] Delivered email sent for SalesOrderID={SalesOrderId}", salesOrderId);
            else
                _logger.LogWarning("[OrderDelivery] Delivered email failed for SalesOrderID={SalesOrderId}", salesOrderId);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[OrderDelivery] Non-fatal: failed to send delivered email for SalesOrderID={SalesOrderId}", salesOrderId);
        }
    }
}
