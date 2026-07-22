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
///
/// Simplified two-step state machine driven by PurchaseOrderHeader.Status:
///   pending(1)  →  approved(2)   : 5 sim-min after placement
///   approved(2) →  complete(4)   : vendor lead time; reliability roll decides pass/fail
///   approved(2) →  rejected(3)   : reliability check failed (no requeue)
/// </summary>
public class PurchaseOrderProcessorFunction
{
    private readonly SupplyChainService _svc;
    private readonly ILogger<PurchaseOrderProcessorFunction> _logger;
    private readonly WebPubSubService _webPubSub;

    // Delay from pending → approved (sim minutes).
    private const int PendingToApprovedSimMin = 5;

    public PurchaseOrderProcessorFunction(
        SupplyChainService service,
        ILogger<PurchaseOrderProcessorFunction> logger,
        WebPubSubService webPubSub)
    {
        _svc    = service;
        _logger = logger;
        _webPubSub = webPubSub;
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

        // For the "complete" target, perform the reliability roll here so the queue processor —
        // not the service — decides pass/fail. This keeps TransitionOrderAsync deterministic.
        string resolvedTarget = msg.TargetStatus;
        if (msg.TargetStatus == "complete")
        {
            var order = await _svc.GetOrderAsync(msg.OrderId);
            if (order == null || order.Status != "approved")
            {
                _logger.LogWarning("Order {OrderId}: expected status 'approved' for delivery roll, got '{Status}'. Skipping.",
                    msg.OrderId, order?.Status ?? "not found");
                return;
            }

            var vendor      = await _svc.GetVendorAsync(order.VendorId);
            double relPct   = vendor?.ReliabilityPct ?? 0.85;
            bool passed     = Random.Shared.NextDouble() <= relPct;
            resolvedTarget  = passed ? "complete" : "rejected";

            if (!passed)
                _logger.LogInformation("Order {OrderId} reliability check failed ({Rel:P0}) — rejecting.",
                    msg.OrderId, relPct);
        }

        bool ok = await _svc.TransitionOrderAsync(msg.OrderId, resolvedTarget);
        if (!ok)
        {
            _logger.LogWarning("TransitionOrder({OrderId}, {Status}) failed — order may be cancelled or already completed.",
                msg.OrderId, resolvedTarget);
            return;
        }

        _logger.LogInformation("Order {OrderId} → {Status}", msg.OrderId, resolvedTarget);

        await _webPubSub.SendToGroupAsync("supply-chain", new { @event = "po-status-changed", purchaseOrderId = msg.OrderId, newStatus = resolvedTarget });

        // Schedule next step (only if we reached "approved" — complete/rejected are terminal)
        if (resolvedTarget == "approved")
            await ScheduleDeliveryAsync(msg.OrderId);

        // Schedule deferred vendor restock after successful delivery
        if (resolvedTarget == "complete")
        {
            var order = await _svc.GetOrderAsync(msg.OrderId);
            if (order != null)
            {
                var vendorInfo   = await _svc.GetVendorAsync(order.VendorId);
                int restockHrs   = vendorInfo?.RestockDelaySimHrs ?? 12;
                double effScale  = await _svc.GetEffectiveTimeScaleAsync();
                int restockSec   = Math.Max(1, (int)(restockHrs * 3600.0 / effScale));

                await EnqueueMessageAsync(new PurchaseOrderMessage
                {
                    MessageType    = "vendor-restock",
                    VendorId       = order.VendorId,
                    ProductId      = order.ProductId,
                    ScheduledAtUtc = DateTime.UtcNow.AddSeconds(restockSec),
                }, visibilityDelaySec: restockSec);

                _logger.LogDebug("Scheduled restock for vendor {VendorId} ProductID={ProductId} in {Sec}s",
                    order.VendorId, order.ProductId, restockSec);
            }
        }
    }

    /// <summary>
    /// Enqueues a "transition to complete" message for the given order after the vendor's
    /// simulated lead time has elapsed.
    /// </summary>
    private async Task ScheduleDeliveryAsync(string orderId)
    {
        var order = await _svc.GetOrderAsync(orderId);
        if (order == null || order.Status is "rejected" or "complete") return;

        var vendor      = await _svc.GetVendorAsync(order.VendorId);
        int leadDays    = vendor?.DefaultLeadTimeDays ?? 2;
        double effScale = await _svc.GetEffectiveTimeScaleAsync();
        int deliverySec = Math.Max(1, (int)(leadDays * 24 * 60 * 60.0 / effScale));

        await EnqueueMessageAsync(new PurchaseOrderMessage
        {
            MessageType    = "order-transition",
            OrderId        = orderId,
            TargetStatus   = "complete",   // processor will roll reliability before applying
            ScheduledAtUtc = DateTime.UtcNow.AddSeconds(deliverySec),
        }, visibilityDelaySec: deliverySec);

        _logger.LogDebug("Scheduled delivery for Order {OrderId} in {Sec}s ({LeadDays} sim-days)",
            orderId, deliverySec, leadDays);
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
}
