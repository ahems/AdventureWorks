using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Azure.Core;
using Azure.Identity;
using Azure.Storage.Queues;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Queue-triggered processor for the manufacturing-agent-queue.
///
/// One message is processed at a time (batchSize=1 in host.json).
/// Each message represents a single sales order that requires AI-driven
/// manufacturing and supply chain analysis.
///
/// Lifecycle:
///   pending  → running  : message dequeued, hosted agent called
///   running  → completed: agent returned findings
///   running  → retrying : transient failure (rate limit / timeout); re-enqueued with exponential backoff
///   retrying → …        : next attempt after backoff window expires
///   retrying → failed   : after 8 attempts, written to poison queue
///
/// Backoff schedule (base 10s × 2^retry):
///   Attempt 1: immediate  (RetryCount=0)
///   Attempt 2: 10 s delay (RetryCount=1)
///   Attempt 3: 20 s
///   Attempt 4: 40 s
///   Attempt 5: 80 s (~1.3 min)
///   Attempt 6: 160 s (~2.7 min)
///   Attempt 7: 320 s (~5.3 min)
///   Attempt 8: 640 s (~10.7 min)  → poison queue on next failure
/// </summary>
public class ManufacturingAgentQueueTrigger
{
    internal const string QueueName  = ManufacturingAgentRunService.QueueName;
    private  const int    MaxRetries = 8;

    private static readonly JsonSerializerOptions JsonOpts =
        new() { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private readonly ILogger<ManufacturingAgentQueueTrigger> _logger;
    private readonly ManufacturingAgentConfigService         _configService;
    private readonly ManufacturingAgentRunService            _runService;
    private readonly IHttpClientFactory                      _httpClientFactory;
    private readonly TokenCredential                         _credential;
    private readonly WebPubSubService                        _webPubSub;
    private readonly string                                  _agentEndpoint;
    private readonly string                                  _functionsBaseUrl;
    private readonly string                                  _queueServiceUri;

    // Token scope for Azure AI Foundry hosted agents
    private const string FoundryTokenScope = "https://ai.azure.com/.default";

    public ManufacturingAgentQueueTrigger(
        ILogger<ManufacturingAgentQueueTrigger> logger,
        ManufacturingAgentConfigService configService,
        ManufacturingAgentRunService runService,
        IHttpClientFactory httpClientFactory,
        DefaultAzureCredential credential,
        WebPubSubService webPubSub,
        IConfiguration configuration)
    {
        _logger            = logger;
        _configService     = configService;
        _runService        = runService;
        _httpClientFactory = httpClientFactory;
        _credential        = credential;
        _webPubSub         = webPubSub;

        _agentEndpoint  = configuration["MANUFACTURING_AGENT_ENDPOINT"] ?? string.Empty;
        _functionsBaseUrl = (configuration["API_FUNCTIONS_URL"] ?? string.Empty).TrimEnd('/');

        var accountName = configuration["AzureWebJobsStorage:accountName"] ?? string.Empty;
        _queueServiceUri = configuration["AzureWebJobsStorage:queueServiceUri"]
            ?? $"https://{accountName}.queue.core.windows.net";
    }

    [Function(nameof(ManufacturingAgentQueue_QueueTrigger))]
    public async Task ManufacturingAgentQueue_QueueTrigger(
        [QueueTrigger(QueueName, Connection = "AzureWebJobsStorage")]
        BinaryData queueMessage)
    {
        ManufacturingAgentQueueMessage? msg;
        try
        {
            msg = JsonSerializer.Deserialize<ManufacturingAgentQueueMessage>(
                queueMessage.ToString(), JsonOpts);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[AgentQueue] Failed to deserialise message — dropping.");
            return;
        }

        if (msg == null || string.IsNullOrEmpty(msg.RunId))
        {
            _logger.LogWarning("[AgentQueue] Null or invalid message — discarding.");
            return;
        }

        if (string.IsNullOrEmpty(_agentEndpoint))
        {
            _logger.LogWarning(
                "[AgentQueue] MANUFACTURING_AGENT_ENDPOINT is not configured. " +
                "Skipping invocation for RunId={RunId}.", msg.RunId);
            return;
        }

        // Read current mode at dequeue time (may have changed since enqueue)
        var mode         = await _configService.GetModeAsync();

        // Safety net: if the agent was switched Off after this message was enqueued,
        // complete the run record (no tokens consumed) and discard the message.
        if (mode == ManufacturingAgentMode.Off)
        {
            _logger.LogInformation(
                "[AgentQueue] Agent is Off — discarding RunId={RunId} without invoking hosted agent.",
                msg.RunId);
            await _runService.CompleteRunAsync(
                msg.RunId,
                findingsSummary: "Agent was switched to Off — order skipped without analysis.",
                toolsUsed: null, proposalIds: null, actionsExecuted: null);
            return;
        }

        var stepCallback = string.IsNullOrEmpty(_functionsBaseUrl)
            ? null
            : $"{_functionsBaseUrl}/api/manufacturing/agent-runs/{msg.RunId}/step";

        await _runService.StartRunAsync(msg.RunId);

        await _webPubSub.SendToGroupAsync("manufacturing-agent", new
        {
            @event = "run-started",
            runId = msg.RunId,
            salesOrderId = msg.SalesOrderId
        });

        _logger.LogInformation(
            "[AgentQueue] Invoking hosted agent for RunId={RunId}, SalesOrderId={SalesOrderId}, Mode={Mode}, Attempt={Attempt}",
            msg.RunId, msg.SalesOrderId, mode, msg.RetryCount + 1);

        try
        {
            var result = await InvokeHostedAgentAsync(msg, mode, stepCallback);

            // In ProposePending mode: the agent returns recommendedActions (structured
            // list of what it thinks should be done). The trigger creates the actual
            // proposals here, keeping the model out of the write path entirely.
            List<string>? createdProposalIds = null;
            if (mode == ManufacturingAgentMode.ProposePending &&
                result.RecommendedActions?.Count > 0)
            {
                createdProposalIds = await CreateProposalsFromRecommendationsAsync(
                    result.RecommendedActions, msg.SalesOrderId, msg.RunId);
            }

            await _runService.CompleteRunAsync(
                msg.RunId,
                result.FindingsSummary,
                result.ToolsUsed,
                createdProposalIds,
                result.ActionsExecuted);

            _logger.LogInformation(
                "[AgentQueue] RunId={RunId} completed. Findings: {Summary}",
                msg.RunId,
                result.FindingsSummary?.Length > 120
                    ? result.FindingsSummary[..120] + "…"
                    : result.FindingsSummary ?? "(none)");

            await _webPubSub.SendToGroupAsync("manufacturing-agent", new
            {
                @event = "run-completed",
                runId = msg.RunId,
                salesOrderId = msg.SalesOrderId,
                status = "completed"
            });
        }
        catch (ManufacturingAgentThrottledException ex)
        {
            await HandleThrottleAsync(msg, ex.Message);
        }
        catch (Exception ex)
        {
            // Treat all other failures as throttle/transient for robustness
            _logger.LogWarning(ex,
                "[AgentQueue] Transient failure for RunId={RunId} (attempt {Attempt}). Will retry.",
                msg.RunId, msg.RetryCount + 1);
            await HandleThrottleAsync(msg, ex.Message);
        }
    }

    // ── Hosted agent invocation ───────────────────────────────────────────────
    // The hosted agent uses the AgentHost framework with the Responses protocol.
    // We send a user message containing all order context; the agent returns a
    // JSON object with findingsSummary, toolsUsed, proposalIds, actionsExecuted.

    private async Task<AgentInvocationResult> InvokeHostedAgentAsync(
        ManufacturingAgentQueueMessage msg,
        ManufacturingAgentMode mode,
        string? stepCallbackUrl)
    {
        // Format the user message. The agent's instructions explain how to interpret
        // these fields and which tools to call based on Mode.
        var userMessage =
            $"New sales order received.\n" +
            $"SalesOrderID={msg.SalesOrderId}\n" +
            $"CustomerID={msg.CustomerId}\n" +
            $"Mode={mode} ({(int)mode})\n" +
            $"RunID={msg.RunId}\n" +
            (stepCallbackUrl != null ? $"StepCallbackUrl={stepCallbackUrl}\n" : "") +
            "\nPlease analyse this order and respond according to the Mode instructions.";

        // Responses API request body — the AgentHost framework processes this via
        // its registered "responses" protocol handler.
        var requestBody = new
        {
            input  = userMessage,
            stream = false
        };

        using var http    = _httpClientFactory.CreateClient();
        http.Timeout      = TimeSpan.FromMinutes(5);
        var json          = JsonSerializer.Serialize(requestBody, JsonOpts);

        // Acquire a Foundry bearer token — hosted agent endpoints require auth
        var token = await _credential.GetTokenAsync(
            new TokenRequestContext([FoundryTokenScope]), CancellationToken.None);

        using var request = new HttpRequestMessage(HttpMethod.Post, _agentEndpoint)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);

        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(request);
        }
        catch (TaskCanceledException)
        {
            throw new ManufacturingAgentThrottledException("Hosted agent HTTP request timed out.");
        }

        var responseBody = await response.Content.ReadAsStringAsync();

        if (response.StatusCode == HttpStatusCode.TooManyRequests ||
            response.StatusCode == HttpStatusCode.ServiceUnavailable)
        {
            var retryAfterHeader = response.Headers.RetryAfter?.Delta?.TotalSeconds;
            var msg429 = $"Rate limited ({(int)response.StatusCode}). RetryAfter={retryAfterHeader}s. Body={responseBody[..Math.Min(200, responseBody.Length)]}";
            throw new ManufacturingAgentThrottledException(msg429);
        }

        if (!response.IsSuccessStatusCode)
        {
            throw new ManufacturingAgentThrottledException(
                $"Hosted agent returned {(int)response.StatusCode}: {responseBody[..Math.Min(200, responseBody.Length)]}");
        }

        // The AgentHost responses endpoint returns the Responses API format.
        // The output[] array may contain intermediate tool-call message items followed
        // by the final summary message. Always use the LAST message item's text,
        // which is the agent's complete structured JSON response.
        try
        {
            using var doc = JsonDocument.Parse(responseBody);
            var root      = doc.RootElement;

            // Collect all message texts from output[], then use the last one
            string? agentText = null;
            if (root.TryGetProperty("output", out var outputEl) &&
                outputEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in outputEl.EnumerateArray())
                {
                    if (item.TryGetProperty("type", out var t) && t.GetString() == "message" &&
                        item.TryGetProperty("content", out var contentEl) &&
                        contentEl.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var part in contentEl.EnumerateArray())
                        {
                            if (part.TryGetProperty("text", out var textEl))
                            {
                                // Keep overwriting — last message wins
                                agentText = textEl.GetString();
                            }
                        }
                    }
                }
            }

            // If no output[] found, try top-level "text" (direct Responses API fallback)
            if (agentText == null && root.TryGetProperty("text", out var topText))
                agentText = topText.GetString();

            if (agentText == null)
                return new AgentInvocationResult(responseBody.Length > 2000 ? responseBody[..2000] : responseBody, null, null, null);

            // The agent returns a JSON object as its output text.
            // The new schema uses recommendedActions (ProposePending) instead of proposalIds.
            try
            {
                using var innerDoc      = JsonDocument.Parse(agentText);
                var inner               = innerDoc.RootElement;
                var findingsSummary     = inner.TryGetProperty("findingsSummary",    out var fs) ? fs.GetString() : null;
                var toolsUsed           = DeserializeStringArray(inner, "toolsUsed");
                var actionsExecuted     = DeserializeStringArray(inner, "actionsExecuted");
                var recommendedActions  = DeserializeRecommendedActions(inner);
                return new AgentInvocationResult(findingsSummary, toolsUsed, null, actionsExecuted, recommendedActions);
            }
            catch
            {
                // Agent returned prose instead of JSON — use it as the findings summary
                return new AgentInvocationResult(
                    agentText.Length > 2000 ? agentText[..2000] : agentText,
                    null, null, null);
            }
        }
        catch
        {
            // Fallback: treat raw response body as findings
            return new AgentInvocationResult(
                responseBody.Length > 2000 ? responseBody[..2000] : responseBody,
                null, null, null);
        }
    }

    private static List<string>? DeserializeStringArray(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out var el) || el.ValueKind != JsonValueKind.Array)
            return null;
        return el.EnumerateArray().Select(i => i.GetString() ?? string.Empty).ToList();
    }

    private static List<RecommendedAction>? DeserializeRecommendedActions(JsonElement root)
    {
        if (!root.TryGetProperty("recommendedActions", out var el) || el.ValueKind != JsonValueKind.Array)
            return null;
        var results = new List<RecommendedAction>();
        foreach (var item in el.EnumerateArray())
        {
            var type      = item.TryGetProperty("type",      out var t)  ? t.GetString()  ?? "manufacturing" : "manufacturing";
            var productId = item.TryGetProperty("productId", out var pid) ? pid.GetInt32() : 0;
            var qty       = item.TryGetProperty("qty",       out var q)   ? q.GetInt32()  : 0;
            var vendorId  = item.TryGetProperty("vendorId",  out var vid) ? vid.GetString() : null;
            var rationale = item.TryGetProperty("rationale", out var r)   ? r.GetString()  : null;
            if (productId > 0 && qty > 0)
                results.Add(new RecommendedAction(type, productId, qty, vendorId, rationale));
        }
        return results.Count > 0 ? results : null;
    }

    /// <summary>
    /// Creates proposals in Table Storage from the agent's recommendedActions list.
    /// Called by the queue trigger in ProposePending mode — keeps the model out of
    /// the write path to eliminate hallucinated proposal IDs.
    /// </summary>
    private async Task<List<string>?> CreateProposalsFromRecommendationsAsync(
        List<RecommendedAction> recommendations,
        int salesOrderId,
        string runId)
    {
        var proposalIds = new List<string>();
        var client = _httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);

        foreach (var rec in recommendations)
        {
                // Extract only digit characters — strips any non-numeric prefix/suffix the model
                // may have hallucinated (e.g. "V789" → "789", "vendor_3" → "3")
                var vendorId = rec.VendorId;
                if (!string.IsNullOrEmpty(vendorId))
                    vendorId = new string(vendorId.Where(char.IsDigit).ToArray());

                try
                {
                    var body = JsonSerializer.Serialize(new
                    {
                        type       = rec.Type,
                        productId  = rec.ProductId,
                        qty        = rec.Qty,
                        vendorId,
                    runId
                }, JsonOpts);

                var url = $"{_functionsBaseUrl}/api/manufacturing/proposals";
                var response = await client.PostAsync(url,
                    new StringContent(body, System.Text.Encoding.UTF8, "application/json"));

                if (response.IsSuccessStatusCode)
                {
                    var json = await response.Content.ReadAsStringAsync();
                    using var doc = JsonDocument.Parse(json);
                    var proposalId = doc.RootElement.TryGetProperty("proposalId", out var pid)
                        ? pid.GetString() : null;
                    if (!string.IsNullOrEmpty(proposalId))
                    {
                        proposalIds.Add(proposalId);
                        _logger.LogInformation(
                            "[AgentQueue] Created {Type} proposal {ProposalId} for product {ProductId}",
                            rec.Type, proposalId, rec.ProductId);
                    }
                }
                else
                {
                    var err = await response.Content.ReadAsStringAsync();
                    _logger.LogWarning(
                        "[AgentQueue] Proposal creation failed for product {ProductId}: {Status} {Error}",
                        rec.ProductId, (int)response.StatusCode, err[..Math.Min(200, err.Length)]);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[AgentQueue] Proposal creation threw for product {ProductId}", rec.ProductId);
            }
        }
        return proposalIds.Count > 0 ? proposalIds : null;
    }

    // ── Exponential backoff re-enqueue ────────────────────────────────────────

    private async Task HandleThrottleAsync(
        ManufacturingAgentQueueMessage msg,
        string errorMessage)
    {
        var retryCount = msg.RetryCount + 1;

        if (retryCount > MaxRetries)
        {
            _logger.LogError(
                "[AgentQueue] RunId={RunId} exceeded {Max} retries — marking as failed.",
                msg.RunId, MaxRetries);
            await _runService.FailRunAsync(msg.RunId,
                $"Max retries ({MaxRetries}) exceeded. Last error: {errorMessage}");
            // Do NOT re-enqueue; let the runtime route to poison queue via maxDequeueCount
            throw new InvalidOperationException($"Max retries exceeded for RunId={msg.RunId}");
        }

        // Exponential backoff: 10s × 2^retryCount
        var backoffSec   = (int)Math.Pow(2, retryCount) * 10;
        var backoffDelay = TimeSpan.FromSeconds(backoffSec);
        var retryAfter   = DateTimeOffset.UtcNow.Add(backoffDelay);

        _logger.LogWarning(
            "[AgentQueue] RunId={RunId} throttled (attempt {Attempt}/{Max}). " +
            "Re-enqueuing with {Delay}s backoff. Error: {Error}",
            msg.RunId, retryCount, MaxRetries, backoffSec, errorMessage);

        await _runService.RetryRunAsync(msg.RunId, retryCount, retryAfter, errorMessage);

        // Enqueue new message with backoff visibility timeout and incremented retry count
        var newMsg       = msg with { RetryCount = retryCount };
        var newMsgJson   = JsonSerializer.Serialize(newMsg, JsonOpts);
        var queueSvcClient = new QueueServiceClient(new Uri(_queueServiceUri), new DefaultAzureCredential(),
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });
        var queueClient    = queueSvcClient.GetQueueClient(QueueName);
        await queueClient.SendMessageAsync(
            BinaryData.FromString(newMsgJson),
            visibilityTimeout: backoffDelay);

        // Return normally so the current message is deleted by the runtime (not re-queued by Azure)
    }
}

// ── Supporting types ──────────────────────────────────────────────────────────

internal class ManufacturingAgentThrottledException(string message) : Exception(message);

internal record RecommendedAction(
    string Type,        // "manufacturing" | "supply"
    int ProductId,
    int Qty,
    string? VendorId,
    string? Rationale);

internal record AgentInvocationResult(
    string? FindingsSummary,
    List<string>? ToolsUsed,
    List<string>? ProposalIds,
    List<string>? ActionsExecuted,
    List<RecommendedAction>? RecommendedActions = null);
