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
using api_functions.DTOs;
using Microsoft.ApplicationInsights;

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
    private readonly string                                  _projectEndpoint;
    private readonly string                                  _functionsBaseUrl;
    private readonly string                                  _queueServiceUri;
    private readonly MonitoringCaptureService?               _capture;
    private readonly TelemetryClient?                        _telemetry;

    // Token scope for Azure AI Foundry hosted agents
    private const string FoundryTokenScope = "https://ai.azure.com/.default";

    public ManufacturingAgentQueueTrigger(
        ILogger<ManufacturingAgentQueueTrigger> logger,
        ManufacturingAgentConfigService configService,
        ManufacturingAgentRunService runService,
        IHttpClientFactory httpClientFactory,
        DefaultAzureCredential credential,
        WebPubSubService webPubSub,
        IConfiguration configuration,
        MonitoringCaptureService? capture = null,
        TelemetryClient? telemetry = null)
    {
        _logger            = logger;
        _configService     = configService;
        _runService        = runService;
        _httpClientFactory = httpClientFactory;
        _credential        = credential;
        _webPubSub         = webPubSub;
        _capture           = capture;
        _telemetry         = telemetry;

        _agentEndpoint  = configuration["MANUFACTURING_AGENT_ENDPOINT"] ?? string.Empty;
        _projectEndpoint = configuration["AI_FOUNDRY_PROJECT_ENDPOINT"] ?? string.Empty;
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
        using var attempt = BackgroundWorkTelemetry.Begin("manufacturing-agent", queueMessage.ToString());
        ManufacturingAgentQueueMessage? msg;
        try
        {
            msg = JsonSerializer.Deserialize<ManufacturingAgentQueueMessage>(
                queueMessage.ToString(), JsonOpts);
        }
        catch (Exception ex)
        {
            attempt.SetOutcome("rejected");
            _logger.LogError(ex, "[AgentQueue] Failed to deserialise message — dropping.");
            return;
        }

        if (msg == null || string.IsNullOrEmpty(msg.RunId))
        {
            attempt.SetOutcome("rejected");
            _logger.LogWarning("[AgentQueue] Null or invalid message — discarding.");
            return;
        }
        attempt.Tag("run.id", msg.RunId);
        attempt.Tag("order.id", msg.SalesOrderId);
        if (Guid.TryParse(msg.RunId, out _)) attempt.Tag("job.id", msg.RunId);

        if (string.IsNullOrEmpty(_agentEndpoint))
        {
            attempt.SetOutcome("skipped");
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
            attempt.SetOutcome("skipped");
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

        var captureLease = await ClaimManufacturingCaptureAsync(_telemetry is null ? null : _capture, msg,
            (runId, cancellationToken) => _runService.GetRunAsync(runId, cancellationToken));
        attempt.Tag("aw.capture.status", captureLease is null ? "off" : "admitted");
        if (captureLease is not null) attempt.Tag("job.id", captureLease.ScopeId);

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
            var result = await InvokeHostedAgentAsync(msg, mode, stepCallback, captureLease);

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
                "[AgentQueue] RunId={RunId} completed.", msg.RunId);

            await _webPubSub.SendToGroupAsync("manufacturing-agent", new
            {
                @event = "run-completed",
                runId = msg.RunId,
                salesOrderId = msg.SalesOrderId,
                status = "completed"
            });
            attempt.Complete();
        }
        catch (ManufacturingAgentThrottledException ex)
        {
            await HandleThrottleAsync(msg, ex.Message);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                "[AgentQueue] Transient failure for RunId={RunId} (attempt {Attempt}, type {ErrorType}). Will retry.",
                msg.RunId, msg.RetryCount + 1, ex.GetType().Name);
            await HandleThrottleAsync(msg, "Unexpected hosted-agent processing failure.");
        }
    }

    // ── Hosted agent invocation ───────────────────────────────────────────────
    // The hosted agent uses the AgentHost framework with the Responses protocol.
    // We send a user message containing all order context; the agent returns a
    // JSON object with findingsSummary, toolsUsed, proposalIds, actionsExecuted.

    private async Task<AgentInvocationResult> InvokeHostedAgentAsync(
        ManufacturingAgentQueueMessage msg,
        ManufacturingAgentMode mode,
        string? stepCallbackUrl,
        CaptureLease? captureLease)
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

        var json = JsonSerializer.Serialize(requestBody, JsonOpts);
        await TryEmitCaptureAsync(captureLease, new Dictionary<string, string?> { ["input"] = userMessage });
        var result = await SendHostedResponseAsync(_httpClientFactory, _credential, _projectEndpoint,
            _agentEndpoint, json, CancellationToken.None);
        await TryEmitCaptureAsync(captureLease, new Dictionary<string, string?>
        {
            ["output"] = JsonSerializer.Serialize(new
            {
                result.FindingsSummary, result.ToolsUsed, result.ProposalIds,
                result.ActionsExecuted, result.RecommendedActions
            }, JsonOpts)
        });
        return result;
    }

    internal static async Task<CaptureLease?> ClaimManufacturingCaptureAsync(
        MonitoringCaptureService? capture, ManufacturingAgentQueueMessage message,
        Func<string, CancellationToken, Task<ManufacturingAgentRunEntity?>> readRun,
        CancellationToken cancellationToken = default)
    {
        if (capture is null || !Guid.TryParse(message.RunId, out _)) return null;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            var run = await readRun(message.RunId, deadline.Token);
            if (run is null || !string.Equals(run.RunId, message.RunId, StringComparison.Ordinal)
                || run.SalesOrderId != message.SalesOrderId || run.CustomerId != message.CustomerId
                || run.CompletedAt is not null || run.Status is not ("pending" or "running" or "retrying"))
                return null;

            // The queue's capture reference is never consulted. Scope comes from persisted server state.
            var grant = await capture.FindActiveAsync("job", run.RunId, deadline.Token);
            return grant is null ? null : await capture.TryAcquireRootAsync(
                grant.Id, "job", run.RunId, run.RunId, deadline.Token);
        }
        catch (Exception)
        {
            // Capture/read failures must not alter the existing job or its retry side effects.
            return null;
        }
    }

    private async Task TryEmitCaptureAsync(CaptureLease? lease, IReadOnlyDictionary<string, string?> fields)
    {
        if (_capture is null || _telemetry is null || lease is null) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try
        {
            await FoundryAgentClient.EmitCapturedFieldsAsync(_capture, _telemetry, lease, fields,
                spanId: System.Diagnostics.Activity.Current?.SpanId.ToHexString(),
                jobId: lease.ScopeId, reasoningSummaryStatus: "unsupported", cancellationToken: deadline.Token);
        }
        catch (Exception)
        {
            _logger.LogWarning("[AgentQueue] Optional job capture emission unavailable.");
        }
    }

    internal static async Task<AgentInvocationResult> SendHostedResponseAsync(
        IHttpClientFactory factory, TokenCredential credential, string projectEndpoint, string agentEndpoint,
        string json, CancellationToken cancellationToken)
    {
        var endpoint = ValidateHostedAgentEndpoint(projectEndpoint, agentEndpoint);
        using var http = factory.CreateClient(AgentHttpClients.HostedManufacturing);
        http.Timeout = TimeSpan.FromMinutes(5);

        // Acquire a Foundry bearer token — hosted agent endpoints require auth
        var token = await credential.GetTokenAsync(
            new TokenRequestContext([FoundryTokenScope]), cancellationToken);

        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);

        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ManufacturingAgentThrottledException("Hosted agent HTTP request timed out.");
        }

        using (response)
        {
            if (response.StatusCode == HttpStatusCode.TooManyRequests ||
                response.StatusCode == HttpStatusCode.ServiceUnavailable)
            {
                var retryAfterHeader = response.Headers.RetryAfter?.Delta?.TotalSeconds;
                throw new ManufacturingAgentThrottledException(
                    $"Hosted agent returned HTTP {(int)response.StatusCode}; RetryAfter={retryAfterHeader}s.");
            }

            if (!response.IsSuccessStatusCode)
                throw new ManufacturingAgentThrottledException($"Hosted agent returned HTTP {(int)response.StatusCode}.");

            var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            return ParseAgentResponse(responseBody);
        }
    }

    internal static Uri ValidateHostedAgentEndpoint(string projectEndpoint, string agentEndpoint)
    {
        const string query = "?api-version=v1";
        const string path = "/agents/manufacturing-agent/endpoint/protocols/openai/responses";
        if (!McpServiceTokenProvider.MatchesEndpoint(projectEndpoint, projectEndpoint) ||
            projectEndpoint.EndsWith("//", StringComparison.Ordinal) ||
            !agentEndpoint.EndsWith(query, StringComparison.Ordinal) ||
            !McpServiceTokenProvider.MatchesEndpoint(
                projectEndpoint.TrimEnd('/') + path, agentEndpoint[..^query.Length]))
            throw new InvalidOperationException("Hosted agent endpoint does not match the configured Foundry project.");
        return new Uri(agentEndpoint, UriKind.Absolute);
    }

    internal static AgentInvocationResult ParseAgentResponse(string responseBody)
    {
        try
        {
            using var doc = JsonDocument.Parse(responseBody);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException("Hosted agent response must be a JSON object.");
            if (root.TryGetProperty("object", out var responseObject) &&
                (responseObject.ValueKind != JsonValueKind.String || responseObject.GetString() != "response"))
                throw new InvalidOperationException("Hosted agent returned an unexpected response object.");

            // HTTP 200 is only transport success. Foundry can return failed/incomplete
            // Responses envelopes with HTTP 200, including MCP authentication failures.
            RejectResponseError(root);
            if (!root.TryGetProperty("status", out var status) ||
                status.ValueKind != JsonValueKind.String ||
                status.GetString() != "completed")
                throw new InvalidOperationException("Hosted agent response did not complete successfully.");

            if (!root.TryGetProperty("output", out var output) ||
                output.ValueKind != JsonValueKind.Array)
                throw new InvalidOperationException("Hosted agent response is missing its output array.");

            // Intermediate tool-call messages can precede the final assistant message.
            string? agentText = null;
            foreach (var item in output.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object)
                    throw new InvalidOperationException("Hosted agent output contains a malformed item.");
                RejectResponseError(item);
                if (!item.TryGetProperty("type", out var type) ||
                    type.ValueKind != JsonValueKind.String)
                    throw new InvalidOperationException("Hosted agent output item is missing its type.");
                if (item.TryGetProperty("status", out var itemStatus) &&
                    (itemStatus.ValueKind != JsonValueKind.String || itemStatus.GetString() != "completed"))
                    throw new InvalidOperationException("Hosted agent output item did not complete successfully.");

                if (type.GetString() != "message")
                    continue;
                if (item.TryGetProperty("role", out var role) &&
                    (role.ValueKind != JsonValueKind.String || role.GetString() != "assistant"))
                    continue;
                if (!item.TryGetProperty("content", out var content) ||
                    content.ValueKind != JsonValueKind.Array)
                    throw new InvalidOperationException("Hosted agent message is missing its content.");

                var text = new StringBuilder();
                foreach (var part in content.EnumerateArray())
                {
                    if (part.ValueKind != JsonValueKind.Object)
                        throw new InvalidOperationException("Hosted agent message contains malformed content.");
                    RejectResponseError(part);
                    if (!part.TryGetProperty("type", out var partType) ||
                        partType.ValueKind != JsonValueKind.String ||
                        partType.GetString() != "output_text" ||
                        !part.TryGetProperty("text", out var textValue) ||
                        textValue.ValueKind != JsonValueKind.String)
                        throw new InvalidOperationException("Hosted agent message did not return output text.");
                    text.Append(textValue.GetString());
                }
                agentText = text.ToString();
            }

            if (string.IsNullOrWhiteSpace(agentText))
                throw new InvalidOperationException("Hosted agent response contains no final assistant findings.");

            JsonDocument innerDoc;
            try
            {
                innerDoc = JsonDocument.Parse(agentText);
            }
            catch (JsonException)
            {
                // Retain genuine prose findings, but not truncated/malformed structured output.
                if (agentText.TrimStart().StartsWith('{') || agentText.TrimStart().StartsWith('[') ||
                    agentText.TrimStart().StartsWith("```", StringComparison.Ordinal))
                    throw new InvalidOperationException("Hosted agent returned malformed structured findings.");
                return new AgentInvocationResult(agentText.Length > 2000 ? agentText[..2000] : agentText, null, null, null);
            }

            using (innerDoc)
            {
                var inner = innerDoc.RootElement;
                if (inner.ValueKind != JsonValueKind.Object)
                    throw new InvalidOperationException("Hosted agent structured findings must be an object.");
                RejectResponseError(inner);
                // An embedded Responses/error envelope is not a findings payload.
                if (inner.TryGetProperty("object", out _) ||
                    inner.TryGetProperty("output", out _) ||
                    inner.TryGetProperty("status", out _))
                    throw new InvalidOperationException("Hosted agent returned an envelope instead of findings.");
                if (!inner.TryGetProperty("findingsSummary", out var summary) ||
                    summary.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(summary.GetString()))
                    throw new InvalidOperationException("Hosted agent structured findings are missing a summary.");
                return new AgentInvocationResult(summary.GetString(),
                    DeserializeStringArray(inner, "toolsUsed"), null,
                    DeserializeStringArray(inner, "actionsExecuted"), DeserializeRecommendedActions(inner));
            }
        }
        catch (InvalidOperationException ex)
        {
            throw new ManufacturingAgentThrottledException($"Hosted agent response rejected: {ex.Message}");
        }
        catch (Exception ex) when (ex is JsonException or FormatException or OverflowException)
        {
            throw new ManufacturingAgentThrottledException("Hosted agent response rejected: invalid response.");
        }
    }

    private static void RejectResponseError(JsonElement value)
    {
        if (value.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null)
        {
            // Do not store/log arbitrary upstream error content, which can include headers or tokens.
            var code = error.ValueKind == JsonValueKind.Object &&
                error.TryGetProperty("code", out var errorCode) && errorCode.ValueKind == JsonValueKind.String
                    ? errorCode.GetString() : "unspecified";
            if (code is not ("server_error" or "unauthorized" or "invalid_scope" or "tool_failure" or
                "rate_limit_exceeded" or "invalid_request_error" or "authentication_error" or "permission_denied"))
                code = "unrecognized";
            throw new InvalidOperationException($"Hosted agent reported an error ({code}).");
        }
        if (value.TryGetProperty("incomplete_details", out var details) && details.ValueKind != JsonValueKind.Null)
            throw new InvalidOperationException("Hosted agent returned incomplete output.");
        if (value.TryGetProperty("type", out var type) &&
            type.ValueKind == JsonValueKind.String &&
            type.GetString() is "error" or "mcp_error" or "refusal")
            throw new InvalidOperationException("Hosted agent output reports an error or refusal.");
    }

    private static List<string>? DeserializeStringArray(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out var el))
            return null;
        if (el.ValueKind != JsonValueKind.Array ||
            el.EnumerateArray().Any(i => i.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(i.GetString())))
            throw new InvalidOperationException($"Hosted agent findings contain an invalid {property} array.");
        return el.EnumerateArray().Select(i => i.GetString() ?? string.Empty).ToList();
    }

    private static List<RecommendedAction>? DeserializeRecommendedActions(JsonElement root)
    {
        if (!root.TryGetProperty("recommendedActions", out var el))
            return null;
        if (el.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("Hosted agent findings contain invalid recommendedActions.");
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
                    BackgroundWorkTelemetry.Outcome("partial");
                    _logger.LogWarning(
                        "[AgentQueue] Proposal creation failed for product {ProductId}: {Status}",
                        rec.ProductId, (int)response.StatusCode);
                }
            }
            catch (Exception ex)
            {
                BackgroundWorkTelemetry.Outcome("partial");
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
            BackgroundWorkTelemetry.Outcome("failed");
            _logger.LogError(
                "[AgentQueue] RunId={RunId} exceeded {Max} retries — marking as failed.",
                msg.RunId, MaxRetries);
            await _runService.FailRunAsync(msg.RunId,
                $"Max retries ({MaxRetries}) exceeded. Last error: {errorMessage}");
            // Runtime retries still apply; poison transfer is not confirmed here.
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
        await queueClient.SendObservedMessageAsync(
            BinaryData.FromString(newMsgJson),
            visibilityTimeout: backoffDelay);
        BackgroundWorkTelemetry.Outcome("retrying");

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
