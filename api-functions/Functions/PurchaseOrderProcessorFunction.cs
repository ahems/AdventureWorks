using System.Text.Json;
using api_functions.Models;
using api_functions.Services;
using Azure.Storage.Queues;
using Azure.Storage.Queues.Models;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

/// <summary>
/// Queue-triggered processor for supply chain order state transitions and vendor restock events.
/// Listens on supply-chain-orders-queue; driven by messages produced by SupplyChainControlFunction
/// and by itself (self-scheduling for future state transitions).
/// </summary>
public class PurchaseOrderProcessorFunction
{
    private readonly SupplyChainService _svc;
    private readonly ILogger<PurchaseOrderProcessorFunction> _logger;

    // Real-second delays between order states at the default SIMULATION_TIME_SCALE_FACTOR=60.
    // placed→confirmed : 5 sim-min  =  5 real sec
    // confirmed→picking: 15 sim-min = 15 real sec
    // picking→shipped  : 30 sim-min = 30 real sec (plus possible delay)
    // shipped→delivered: vendor.LeadTimeDays × 24 × 60 sim-min / scale → real sec
    private readonly Dictionary<string, (string NextStatus, int DelaySimMin)> _stateFlow = new()
    {
        ["confirmed"] = ("picking",   15),
        ["picking"]   = ("shipped",   30),
        ["shipped"]   = ("delivered", -1),  // -1 = read from vendor lead time
    };

    public PurchaseOrderProcessorFunction(
        SupplyChainService service,
        ILogger<PurchaseOrderProcessorFunction> logger)
    {
        _svc    = service;
        _logger = logger;
    }

    [Function("PurchaseOrderProcessor")]
    public async Task Run(
        [QueueTrigger(SupplyChainService.QUEUE_NAME, Connection = "AzureWebJobsStorage")]
        string messageText,
        FunctionContext context)
    {
        PurchaseOrderMessage? msg;
        try
        {
            // Message may arrive base64-encoded by the Functions queue binding
            string json = messageText;
            try
            {
                byte[] decoded = Convert.FromBase64String(messageText);
                json = System.Text.Encoding.UTF8.GetString(decoded);
            }
            catch { /* was plain JSON already */ }

            msg = JsonSerializer.Deserialize<PurchaseOrderMessage>(json,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to deserialise queue message: {Raw}", messageText);
            return; // dead-letter via retry policy rather than throwing
        }

        if (msg == null)
        {
            _logger.LogWarning("Received null or empty supply-chain queue message.");
            return;
        }

        switch (msg.MessageType)
        {
            case "order-transition":
                await ProcessOrderTransitionAsync(msg);
                break;

            case "vendor-restock":
                await ProcessVendorRestockAsync(msg);
                break;

            default:
                _logger.LogWarning("Unknown MessageType '{Type}' on supply-chain queue.", msg.MessageType);
                break;
        }
    }

    // ── Order state machine ───────────────────────────────────────────────────

    private async Task ProcessOrderTransitionAsync(PurchaseOrderMessage msg)
    {
        // Self-scheduling: if the message arrived early (clock drift / retry), requeue
        if (msg.ScheduledAtUtc > DateTime.UtcNow.AddSeconds(2))
        {
            int waitSec = (int)(msg.ScheduledAtUtc - DateTime.UtcNow).TotalSeconds;
            _logger.LogDebug("Order {OrderId} transition to '{Status}' not yet due; requeuing with {Wait}s visibility.",
                msg.OrderId, msg.TargetStatus, waitSec);
            await EnqueueMessageAsync(msg, visibilityDelaySec: waitSec);
            return;
        }

        bool ok = await _svc.TransitionOrderAsync(msg.OrderId, msg.TargetStatus);
        if (!ok)
        {
            _logger.LogWarning("TransitionOrder({OrderId}, {Status}) failed — order may be cancelled or already advanced.",
                msg.OrderId, msg.TargetStatus);
            return;
        }

        _logger.LogInformation("Order {OrderId} → {Status}", msg.OrderId, msg.TargetStatus);

        // Schedule the next state in the chain
        await ScheduleNextTransitionAsync(msg.OrderId, msg.TargetStatus);
    }

    private async Task ScheduleNextTransitionAsync(string orderId, string justReached)
    {
        if (!_stateFlow.TryGetValue(justReached, out var next)) return;

        var order = await _svc.GetOrderAsync(orderId);
        if (order == null || order.Status is "cancelled" or "delivered" or "out_of_stock") return;

        // Reliability roll on picking→shipped: may redirect to "delayed" first
        if (justReached == "picking")
        {
            var vendor = await _svc.GetVendorAsync(order.VendorId);
            double reliability = vendor?.ReliabilityPct ?? 0.9;
            double simScale    = GetSimTimeScale();

            if (Random.Shared.NextDouble() > reliability)
            {
                // Transition to "delayed" with 30s delay then reschedule shipped from there
                int delaySec = (int)(next.DelaySimMin * 60.0 / simScale);
                await EnqueueMessageAsync(new PurchaseOrderMessage
                {
                    MessageType    = "order-transition",
                    OrderId        = orderId,
                    TargetStatus   = "delayed",
                    ScheduledAtUtc = DateTime.UtcNow.AddSeconds(delaySec),
                }, visibilityDelaySec: delaySec);

                // After delay, then ship (extra 24 sim-hrs for the delay)
                int extraSec = (int)(24 * 3600.0 / simScale);
                await EnqueueMessageAsync(new PurchaseOrderMessage
                {
                    MessageType    = "order-transition",
                    OrderId        = orderId,
                    TargetStatus   = "shipped",
                    ScheduledAtUtc = DateTime.UtcNow.AddSeconds(delaySec + extraSec),
                }, visibilityDelaySec: delaySec + extraSec);
                return;
            }
        }

        int nextDelaySec;
        if (next.DelaySimMin < 0)
        {
            // "shipped→delivered": delay = vendor.DefaultLeadTimeDays × 24 × 60 sim-min / simScale
            var vendor     = await _svc.GetVendorAsync(order.VendorId);
            int lead       = vendor?.DefaultLeadTimeDays ?? 2;
            double simScale = GetSimTimeScale();
            nextDelaySec   = (int)(lead * 24 * 60 * 60.0 / simScale);
        }
        else
        {
            double simScale = GetSimTimeScale();
            nextDelaySec    = (int)(next.DelaySimMin * 60.0 / simScale);
        }

        await EnqueueMessageAsync(new PurchaseOrderMessage
        {
            MessageType    = "order-transition",
            OrderId        = orderId,
            TargetStatus   = next.NextStatus,
            ScheduledAtUtc = DateTime.UtcNow.AddSeconds(nextDelaySec),
        }, visibilityDelaySec: nextDelaySec);

        _logger.LogDebug("Scheduled {OrderId} → {Next} in {Sec}s", orderId, next.NextStatus, nextDelaySec);

        // Schedule deferred vendor restock after delivered
        if (next.NextStatus == "delivered")
        {
            var vendorInfo  = await _svc.GetVendorAsync(order.VendorId);
            int restockSimHrs = vendorInfo?.RestockDelaySimHrs ?? 12;
            double simScale2 = GetSimTimeScale();
            int restockSec   = (int)(restockSimHrs * 3600.0 / simScale2);
            // Add 5s buffer after expected delivery
            int restockVisibility = nextDelaySec + 5 + restockSec;

            await EnqueueMessageAsync(new PurchaseOrderMessage
            {
                MessageType = "vendor-restock",
                VendorId    = order.VendorId,
                ProductId   = order.ProductId,
                ScheduledAtUtc = DateTime.UtcNow.AddSeconds(restockVisibility),
            }, visibilityDelaySec: restockVisibility);

            _logger.LogDebug("Scheduled restock for vendor {VendorId} ProductID={ProductId} in {Sec}s",
                order.VendorId, order.ProductId, restockVisibility);
        }
    }

    // ── Vendor restock ────────────────────────────────────────────────────────

    private async Task ProcessVendorRestockAsync(PurchaseOrderMessage msg)
    {
        if (string.IsNullOrEmpty(msg.VendorId))
        {
            _logger.LogWarning("vendor-restock message missing VendorId.");
            return;
        }

        if (msg.ScheduledAtUtc > DateTime.UtcNow.AddSeconds(2))
        {
            int waitSec = (int)(msg.ScheduledAtUtc - DateTime.UtcNow).TotalSeconds;
            await EnqueueMessageAsync(msg, visibilityDelaySec: waitSec);
            return;
        }

        await _svc.RestockVendorAsync(msg.VendorId, msg.ProductId);
        _logger.LogInformation("Restocked vendor {VendorId} productId={ProductId}", msg.VendorId, msg.ProductId);
    }

    // ── Queue helper ──────────────────────────────────────────────────────────

    private static async Task EnqueueMessageAsync(PurchaseOrderMessage msg, int visibilityDelaySec = 0)
    {
        var queueClient = await GetQueueClientAsync();
        string json     = JsonSerializer.Serialize(msg);
        string encoded  = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(json));
        await queueClient.SendMessageAsync(
            encoded,
            visibilityTimeout: TimeSpan.FromSeconds(Math.Max(0, visibilityDelaySec)));
    }

    private static async Task<QueueClient> GetQueueClientAsync()
    {
        string? queueUri = Environment.GetEnvironmentVariable("AzureWebJobsStorage__queueServiceUri");
        QueueClient client;
        if (!string.IsNullOrEmpty(queueUri))
        {
            var svc = new QueueServiceClient(
                new Uri(queueUri),
                new Azure.Identity.DefaultAzureCredential());
            client = svc.GetQueueClient(SupplyChainService.QUEUE_NAME);
        }
        else
        {
            string connStr = Environment.GetEnvironmentVariable("AzureWebJobsStorage") ?? "UseDevelopmentStorage=true";
            client = new QueueClient(connStr, SupplyChainService.QUEUE_NAME,
                new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });
        }
        await client.CreateIfNotExistsAsync();
        return client;
    }

    private static double GetSimTimeScale()
    {
        if (double.TryParse(
                Environment.GetEnvironmentVariable("SIMULATION_TIME_SCALE_FACTOR"),
                out double f) && f > 0) return f;
        return 60.0; // default: 1 sim-min = 1 real sec
    }
}
