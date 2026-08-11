using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Azure.Core;
using Azure.Identity;
using Microsoft.ApplicationInsights;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

/// <summary>
/// Thin client for Azure AI Foundry "kind: prompt" agents via the Responses API.
///
/// These are agents created through the new Foundry portal experience (named string IDs,
/// not classic asst_* IDs). They expose the "responses" protocol, which is an
/// OpenAI-compatible Responses API endpoint hosted by the Foundry project.
///
/// Features leveraged:
///   - store: true          → Foundry persists every response; enables memory / conversation history
///   - previous_response_id → links responses for multi-turn continuity (replaces threads)
///   - x-memory-user-id     → scopes Foundry memory to a specific user/entity
///   - structured_inputs    → resolves Handlebars {{variable}} templates in agent instructions
///                            at runtime without requiring separate agent versions
///   - tool_choice          → controls whether the model must call tools ("required" / "auto" / "none")
///   - output items         → captures MCP tool calls for telemetry / tracing
///   - usage                → input/output token counts sent to App Insights
/// </summary>
public class FoundryAgentClient
{
    private readonly ILogger<FoundryAgentClient> _logger;
    private readonly TelemetryClient _telemetryClient;
    private readonly TokenCredential _credential;
    private readonly string _projectEndpoint;
    private readonly string _responsesUrl;
    private readonly IHttpClientFactory _httpClientFactory;

    // Fallback tool configuration used when agent definition fetch fails (e.g. 401 permission error).
    // Populated from environment variables (MCP_SERVICE_URL, API_URL) injected via Program.cs.
    private readonly string _fallbackMcpServiceUrl;
    private readonly string _fallbackDabMcpUrl;
    private readonly string _fallbackModelDeployment;

    // Cache of agent definitions keyed by agent ID — fetched once, reused every call
    private readonly ConcurrentDictionary<string, CachedAgentDefinition> _agentDefCache = new();

    // Token scope for Azure AI Foundry
    private const string FoundryTokenScope = "https://ai.azure.com/.default";

    // JSON options: snake_case keys, null fields omitted (matches the Responses API wire format)
    private static readonly JsonSerializerOptions _serializeOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private static readonly JsonSerializerOptions _deserializeOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public FoundryAgentClient(
        ILogger<FoundryAgentClient> logger,
        TelemetryClient telemetryClient,
        TokenCredential credential,
        string projectEndpoint,
        IHttpClientFactory httpClientFactory,
        string fallbackMcpServiceUrl = "",
        string fallbackDabMcpUrl = "",
        string fallbackModelDeployment = "chat")
    {
        _logger = logger;
        _telemetryClient = telemetryClient;
        _credential = credential;
        _projectEndpoint = projectEndpoint.TrimEnd('/');
        _httpClientFactory = httpClientFactory;
        _fallbackMcpServiceUrl = fallbackMcpServiceUrl;
        _fallbackDabMcpUrl = fallbackDabMcpUrl;
        _fallbackModelDeployment = string.IsNullOrEmpty(fallbackModelDeployment) ? "chat" : fallbackModelDeployment;

        // The Responses API is project-scoped. Per the official docs the endpoint is:
        //   {projectEndpoint}/openai/v1/responses   (no ?api-version query parameter)
        // The old pattern of stripping /api/projects/... and adding ?api-version=v1
        // routes through the base Azure OpenAI compatibility layer, which rejects
        // Foundry-specific parameters such as structured_inputs.
        _responsesUrl = $"{_projectEndpoint}/openai/v1/responses";
    }

    /// <summary>
    /// Invoke a Foundry "kind: prompt" agent via the Responses API.
    ///
    /// Multi-turn works via <paramref name="previousResponseId"/>: pass back the
    /// <see cref="FoundryAgentResponse.ResponseId"/> from the previous call and Foundry
    /// will automatically resume the stored conversation.
    ///
    /// For the first turn (or when no previous response exists), pass
    /// <paramref name="conversationHistory"/> to seed the context, or leave it null
    /// for a stateless single-shot call.
    /// </summary>
    /// <param name="agentId">Named agent ID, e.g. "aw-help-me-choose-agent".</param>
    /// <param name="userMessage">The new user message.</param>
    /// <param name="conversationHistory">
    ///   Optional prior messages to include when starting a new conversation.
    ///   Ignored if <paramref name="previousResponseId"/> is set.
    /// </param>
    /// <param name="previousResponseId">
    ///   ID of the previous Foundry response to continue from.
    ///   When set, Foundry loads stored context automatically.
    /// </param>
    /// <param name="userId">
    ///   Scopes Foundry memory to a specific user/entity via the <c>x-memory-user-id</c> header.
    ///   Use a stable identifier such as a customer ID or persona key.
    /// </param>
    /// <param name="structuredInputs">
    ///   Runtime values that replace Handlebars <c>{{variable}}</c> placeholders declared in the
    ///   agent's <c>structured_inputs</c> schema in the Foundry portal. Sent on the first
    ///   round only; approval follow-up rounds are chained via <c>previous_response_id</c>.
    /// </param>
    /// <param name="toolChoice">
    ///   Controls when the model calls tools. Use <c>"required"</c> for agents whose output
    ///   depends entirely on MCP tool data (prevents hallucinated results). Defaults to
    ///   Foundry's <c>"auto"</c> when <c>null</c>.
    /// </param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public async Task<FoundryAgentResponse> InvokeAsync(
        string agentId,
        string userMessage,
        IList<FoundryMessage>? conversationHistory = null,
        string? previousResponseId = null,
        string? userId = null,
        Dictionary<string, object>? structuredInputs = null,
        string? toolChoice = null,
        CancellationToken cancellationToken = default)
    {
        // --- Fetch agent definition (cached) ------------------------------------
        var def = await GetOrFetchAgentDefinitionAsync(agentId, cancellationToken);

        // --- Build initial input -----------------------------------------------
        object input;
        if (!string.IsNullOrEmpty(previousResponseId))
        {
            input = userMessage;
        }
        else if (conversationHistory != null && conversationHistory.Count > 0)
        {
            var messages = new List<object>(conversationHistory.Count + 1);
            foreach (var h in conversationHistory)
                messages.Add(new { role = h.Role, content = h.Content });
            messages.Add(new { role = "user", content = userMessage });
            input = messages;
        }
        else
        {
            input = userMessage;
        }

        using var httpClient = _httpClientFactory.CreateClient();
        httpClient.Timeout = TimeSpan.FromMinutes(5);

        // Resolve instructions once before the loop so the same resolved system prompt
        // is re-sent in every approval round. The Responses API `instructions` field
        // acts as a per-call system message override and is NOT automatically carried
        // forward via `previous_response_id` when absent. Without re-sending instructions
        // in approval continuation rounds, the model loses its format requirements (e.g.
        // "Return ONLY a valid JSON object") and returns prose instead.
        var resolvedInstructions = ResolveHandlebarsTemplate(def.Instructions, structuredInputs);

        // --- Pre-warm MCP servers ------------------------------------------------
        // Foundry connects to MCP server URLs during tool enumeration. If the Container
        // App has scaled to zero, the first connection attempt may time out with
        // "TaskCanceledException encountered while enumerating tools". Sending a
        // lightweight request here wakes the server before Foundry's timeout applies.
        if (def.Tools.Count > 0)
        {
            await WarmupMcpServersAsync(def.Tools, cancellationToken);
        }

        // --- Approval loop -----------------------------------------------------
        // Foundry "kind: prompt" agents with MCP tools may require the client to
        // explicitly approve each tool call before the model can execute it.
        //
        // The loop:
        //   1. POST /responses with the current input (and optional previousResponseId)
        //   2. If any output items are "mcp_approval_request", auto-approve them
        //      by sending a follow-up POST with the approval items as input and
        //      previous_response_id pointing to the just-completed response.
        //   3. Repeat until there are no more pending approvals.
        //
        // The final response contains the model's answer in a "message" output item.
        const int maxApprovalRounds = 10; // safety guard
        const int maxToolRetries = 2; // retries for transient MCP tool enumeration failures
        string? currentPreviousId = string.IsNullOrEmpty(previousResponseId) ? null : previousResponseId;
        object currentInput = input;
        string lastResponseBody = string.Empty;

        for (int round = 0; round <= maxApprovalRounds; round++)
        {
            if (round == maxApprovalRounds)
                throw new InvalidOperationException($"Foundry agent '{agentId}' exceeded {maxApprovalRounds} approval rounds.");

            // Get fresh token each round (tokens may expire during long tool chains)
            var token = await _credential.GetTokenAsync(
                new TokenRequestContext([FoundryTokenScope]), cancellationToken);

            var activeTools = def.Tools;
            var usingFallbackTools = false;
            var hasTools = activeTools.Count > 0;

            // Guard: "required" tool_choice is only valid when the agent actually has tools
            // registered. If the agent definition has no tools fall back to "auto" to avoid
            // a Foundry 400: "Tool choice 'required' must be specified with 'tools' parameter."
            string? effectiveToolChoice = round == 0 ? toolChoice : null;
            if (effectiveToolChoice == "required" && !hasTools)
            {
                _logger.LogWarning(
                    "Agent '{AgentId}' has no tools; downgrading tool_choice from 'required' to 'auto'",
                    agentId);
                effectiveToolChoice = "auto";
            }

            var requestBody = new FoundryResponsesRequest
            {
                Model = def.Model,
                // Always include the resolved instructions so the model's format requirements
                // (e.g. "Return ONLY a valid JSON object") are preserved across all approval
                // rounds. The Responses API `instructions` field is a per-call system message
                // override and is NOT automatically carried forward via `previous_response_id`,
                // so omitting it in approval continuation rounds causes the model to lose its
                // format constraints and return prose rather than structured JSON.
                Instructions = resolvedInstructions,
                Input = currentInput,
                Stream = false,
                Store = true,
                PreviousResponseId = currentPreviousId,
                Tools = hasTools ? activeTools : null,
                // structured_inputs still sent for any future Foundry-native endpoint support,
                // but the resolved instructions are the primary mechanism.
                StructuredInputs = round == 0 && structuredInputs?.Count > 0 ? structuredInputs : null,
                ToolChoice = effectiveToolChoice
            };

            var json = JsonSerializer.Serialize(requestBody, _serializeOptions);

            _logger.LogInformation(
                "Invoking Foundry agent '{AgentId}' model='{Model}' round={Round} (previousResponseId={Prev}, toolChoice={ToolChoice}, structuredInputKeys={Keys})",
                agentId, def.Model, round, currentPreviousId ?? "none",
                toolChoice ?? "auto",
                structuredInputs?.Count > 0 ? string.Join(",", structuredInputs.Keys) : "none");

            // Retry loop for transient MCP tool enumeration failures (e.g. cold-start
            // timeouts returning 400 "TaskCanceledException encountered while enumerating tools")
            string responseBody = string.Empty;
            for (int retry = 0; retry <= maxToolRetries; retry++)
            {
                using var retryRequest = new HttpRequestMessage(HttpMethod.Post, _responsesUrl)
                {
                    Content = new StringContent(json, Encoding.UTF8, "application/json")
                };
                retryRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
                if (!string.IsNullOrEmpty(userId))
                    retryRequest.Headers.TryAddWithoutValidation("x-memory-user-id", userId);

                var httpResponse = await httpClient.SendAsync(retryRequest, cancellationToken);
                responseBody = await httpResponse.Content.ReadAsStringAsync(cancellationToken);

                if (httpResponse.IsSuccessStatusCode)
                    break;

                // Check if this is a retryable MCP tool enumeration error
                var isToolEnumError = (int)httpResponse.StatusCode == 400
                    && (responseBody.Contains("tool_user_error") || responseBody.Contains("enumerating tools"));

                if (isToolEnumError && retry < maxToolRetries)
                {
                    var delayMs = (retry + 1) * 3000; // 3s, 6s
                    _logger.LogWarning(
                        "Foundry agent '{AgentId}' MCP tool enumeration failed (attempt {Attempt}/{Max}). " +
                        "Retrying in {Delay}ms. Error: {Body}",
                        agentId, retry + 1, maxToolRetries + 1, delayMs,
                        responseBody.Length > 200 ? responseBody[..200] : responseBody);
                    await Task.Delay(delayMs, cancellationToken);
                    continue;
                }

                // If all retries failed while enumerating tools, switch to the fallback
                // MCP config (from MCP_SERVICE_URL) once and retry the round.
                // This recovers from stale/broken MCP URLs in the agent definition.
                if (isToolEnumError
                    && !usingFallbackTools
                    && !string.IsNullOrEmpty(_fallbackMcpServiceUrl))
                {
                    var fallbackTools = BuildFallbackDefinition().Tools;
                    if (fallbackTools.Count > 0)
                    {
                        usingFallbackTools = true;
                        activeTools = fallbackTools;
                        hasTools = true;

                        requestBody.Tools = activeTools;
                        json = JsonSerializer.Serialize(requestBody, _serializeOptions);

                        _logger.LogWarning(
                            "Foundry agent '{AgentId}' MCP tool enumeration still failing after retries. " +
                            "Switching to fallback MCP tool configuration and retrying.",
                            agentId);

                        await WarmupMcpServersAsync(activeTools, cancellationToken);
                        retry = -1; // reset retry counter for fallback tool config
                        continue;
                    }
                }

                _logger.LogError("Foundry Responses API returned {Status}: {Body}",
                    (int)httpResponse.StatusCode,
                    responseBody.Length > 500 ? responseBody[..500] : responseBody);
                throw new InvalidOperationException(
                    $"Foundry Responses API failed ({(int)httpResponse.StatusCode}): {responseBody[..Math.Min(300, responseBody.Length)]}");
            }

            lastResponseBody = responseBody;

            // Extract approval requests from this response
            using var doc = JsonDocument.Parse(responseBody);
            var root = doc.RootElement;
            var responseId = root.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;

            var approvalRequests = new List<(string Id, string Name, string Server)>();
            if (root.TryGetProperty("output", out var outputEl))
            {
                foreach (var item in outputEl.EnumerateArray())
                {
                    var itemType = item.TryGetProperty("type", out var tEl) ? tEl.GetString() : null;
                    if (itemType == "mcp_approval_request")
                    {
                        var approvalId = item.TryGetProperty("id", out var aId) ? aId.GetString() ?? "" : "";
                        var toolName = item.TryGetProperty("name", out var tn) ? tn.GetString() ?? "" : "";
                        var serverLabel = item.TryGetProperty("server_label", out var sl) ? sl.GetString() ?? "" : "";
                        approvalRequests.Add((approvalId, toolName, serverLabel));
                    }
                }
            }

            if (approvalRequests.Count == 0)
            {
                // No pending approvals — we have the final answer
                _logger.LogInformation(
                    "Foundry agent '{AgentId}' completed after {Rounds} round(s). ResponseId={Id}",
                    agentId, round + 1, responseId ?? "?");
                break;
            }

            // Auto-approve every pending tool call and continue
            _logger.LogInformation(
                "Foundry agent '{AgentId}' round {Round}: auto-approving {Count} tool call(s): {Tools}",
                agentId, round,
                approvalRequests.Count,
                string.Join(", ", approvalRequests.Select(a => $"{a.Server}/{a.Name}")));

            var approvals = approvalRequests
                .Select(a => (object)new { type = "mcp_approval_response", approve = true, approval_request_id = a.Id })
                .ToList();

            currentPreviousId = responseId;
            currentInput = approvals;
        }

        var parsedResponse = ParseResponse(lastResponseBody, agentId);

        // ── Empty-text recovery ────────────────────────────────────────────────
        // When tool_choice is "required", the model may consume all output tokens on
        // tool-call arguments and never produce a final "message" output item.
        // The response is valid (status=completed) but ResponseText is empty.
        // Fix: send one more request via previous_response_id with tool_choice="none"
        // to force the model to synthesise its text answer from the stored tool results.
        if (string.IsNullOrWhiteSpace(parsedResponse.ResponseText)
            && parsedResponse.ToolsUsed.Count > 0
            && !string.IsNullOrEmpty(parsedResponse.ResponseId))
        {
            _logger.LogWarning(
                "Foundry agent '{AgentId}' returned empty text after tool calls ({Tools}). " +
                "Sending continuation request with tool_choice=none to elicit the final answer.",
                agentId, string.Join(",", parsedResponse.ToolsUsed));

            var continuationToken = await _credential.GetTokenAsync(
                new TokenRequestContext([FoundryTokenScope]), cancellationToken);

            var continuationBody = new FoundryResponsesRequest
            {
                Model = def.Model,
                Instructions = resolvedInstructions,
                Input = "Now produce your final answer based on the tool results above.",
                Stream = false,
                Store = true,
                PreviousResponseId = parsedResponse.ResponseId,
                Tools = def.Tools.Count > 0 ? def.Tools : null,
                ToolChoice = "none"
            };

            var continuationJson = JsonSerializer.Serialize(continuationBody, _serializeOptions);
            using var continuationRequest = new HttpRequestMessage(HttpMethod.Post, _responsesUrl)
            {
                Content = new StringContent(continuationJson, Encoding.UTF8, "application/json")
            };
            continuationRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", continuationToken.Token);
            if (!string.IsNullOrEmpty(userId))
                continuationRequest.Headers.TryAddWithoutValidation("x-memory-user-id", userId);

            var continuationHttpResponse = await httpClient.SendAsync(continuationRequest, cancellationToken);
            var continuationResponseBody = await continuationHttpResponse.Content.ReadAsStringAsync(cancellationToken);

            if (continuationHttpResponse.IsSuccessStatusCode)
            {
                var continuationParsed = ParseResponse(continuationResponseBody, agentId);
                if (!string.IsNullOrWhiteSpace(continuationParsed.ResponseText))
                {
                    _logger.LogInformation(
                        "Continuation request produced text output ({Length} chars). ResponseId={Id}",
                        continuationParsed.ResponseText.Length, continuationParsed.ResponseId ?? "?");

                    // Merge: keep the original tools-used list, use continuation text & response ID
                    continuationParsed.ToolsUsed = parsedResponse.ToolsUsed
                        .Concat(continuationParsed.ToolsUsed)
                        .Distinct()
                        .ToList();
                    continuationParsed.InputTokens += parsedResponse.InputTokens;
                    continuationParsed.OutputTokens += parsedResponse.OutputTokens;
                    parsedResponse = continuationParsed;
                }
                else
                {
                    _logger.LogWarning(
                        "Continuation request also returned empty text for agent '{AgentId}'.", agentId);
                }
            }
            else
            {
                _logger.LogError(
                    "Continuation request failed for agent '{AgentId}': {Status} {Body}",
                    agentId, (int)continuationHttpResponse.StatusCode,
                    continuationResponseBody.Length > 300 ? continuationResponseBody[..300] : continuationResponseBody);
            }
        }

        return parsedResponse;
    }

    // ── Response parsing ───────────────────────────────────────────────────────

    private FoundryAgentResponse ParseResponse(string responseBody, string agentId)
    {
        using var doc = JsonDocument.Parse(responseBody);
        var root = doc.RootElement;

        var responseId = root.TryGetProperty("id", out var idProp)
            ? idProp.GetString() : null;
        var status = root.TryGetProperty("status", out var statusProp)
            ? statusProp.GetString() : "unknown";

        if (status != "completed")
        {
            _logger.LogWarning("Foundry agent '{AgentId}' response status was '{Status}' (expected 'completed'). ID={ResponseId}",
                agentId, status, responseId ?? "?");
            throw new InvalidOperationException(
                $"Foundry agent '{agentId}' ended with status '{status}'. Response ID: {responseId ?? "unknown"}");
        }

        var responseText = new StringBuilder();
        var toolsUsed = new List<string>();

        // Walk the output array to collect text and tool-call names.
        // Output item types seen in Foundry responses:
        //   "message"             → final assistant text
        //   "function_call"       → function / MCP tool invocation
        //   "function_call_output"→ result fed back to model
        //   "mcp_call"            → explicit MCP tool entry (some API versions)
        //   "reasoning"           → chain-of-thought (o-series models)
        if (root.TryGetProperty("output", out var output))
        {
            foreach (var item in output.EnumerateArray())
            {
                var itemType = item.TryGetProperty("type", out var t) ? t.GetString() : null;

                switch (itemType)
                {
                    case "message":
                        if (item.TryGetProperty("content", out var contentArray))
                        {
                            foreach (var c in contentArray.EnumerateArray())
                            {
                                // Foundry Responses API uses "output_text" (not the classic "text")
                                // Support both for forward/backward compatibility.
                                var contentType = c.TryGetProperty("type", out var ct) ? ct.GetString() : null;
                                if ((contentType == "text" || contentType == "output_text")
                                    && c.TryGetProperty("text", out var textVal))
                                {
                                    responseText.Append(textVal.GetString());
                                }
                            }
                        }
                        break;

                    case "function_call":
                    case "mcp_call":
                        // Collect distinct tool/function names for telemetry
                        var nameKey = itemType == "mcp_call" ? "name" : "name";
                        if (item.TryGetProperty(nameKey, out var toolName))
                            toolsUsed.Add(toolName.GetString() ?? itemType!);
                        break;
                }
            }
        }

        // Token usage → App Insights metrics
        int inputTokens = 0, outputTokens = 0;
        if (root.TryGetProperty("usage", out var usageProp))
        {
            if (usageProp.TryGetProperty("input_tokens", out var it)) inputTokens = it.GetInt32();
            if (usageProp.TryGetProperty("output_tokens", out var ot)) outputTokens = ot.GetInt32();
        }

        _telemetryClient.TrackMetric("Foundry.Responses.InputTokens", inputTokens,
            new Dictionary<string, string> { ["AgentId"] = agentId });
        _telemetryClient.TrackMetric("Foundry.Responses.OutputTokens", outputTokens,
            new Dictionary<string, string> { ["AgentId"] = agentId });
        _telemetryClient.TrackEvent("Foundry.Responses.Completed", new Dictionary<string, string>
        {
            ["AgentId"] = agentId,
            ["ResponseId"] = responseId ?? "unknown",
            ["ToolCallCount"] = toolsUsed.Count.ToString(),
            ["ToolsUsed"] = string.Join(",", toolsUsed.Distinct()),
            ["InputTokens"] = inputTokens.ToString(),
            ["OutputTokens"] = outputTokens.ToString()
        });

        _logger.LogInformation(
            "Foundry agent '{AgentId}' completed. ResponseId={ResponseId}, Tools={Tools}, Tokens={In}+{Out}",
            agentId, responseId ?? "?",
            toolsUsed.Count > 0 ? string.Join(",", toolsUsed.Distinct()) : "none",
            inputTokens, outputTokens);

        if (responseText.Length == 0)
            _logger.LogWarning(
                "Foundry agent '{AgentId}' returned no text output. ResponseId={ResponseId}, ToolsUsed={Tools}. Output may contain only reasoning or tool-call items.",
                agentId, responseId ?? "?",
                toolsUsed.Count > 0 ? string.Join(",", toolsUsed.Distinct()) : "none");

        return new FoundryAgentResponse
        {
            ResponseId = responseId,
            ResponseText = responseText.ToString(),
            ToolsUsed = toolsUsed.Distinct().ToList(),
            InputTokens = inputTokens,
            OutputTokens = outputTokens
        };
    }

    // ── Agent definition fetching ─────────────────────────────────────────────

    private async Task<CachedAgentDefinition> GetOrFetchAgentDefinitionAsync(
        string agentId,
        CancellationToken cancellationToken)
    {
        if (_agentDefCache.TryGetValue(agentId, out var cached))
            return cached;

        var url = $"{_projectEndpoint}/agents/{agentId}?api-version=v1";
        var token = await _credential.GetTokenAsync(
            new TokenRequestContext([FoundryTokenScope]), cancellationToken);

        using var httpClient = _httpClientFactory.CreateClient();
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);

        _logger.LogInformation("Fetching agent definition for '{AgentId}'", agentId);
        var resp = await httpClient.SendAsync(req, cancellationToken);
        var body = await resp.Content.ReadAsStringAsync(cancellationToken);

        if (!resp.IsSuccessStatusCode)
        {
            var isPermissionDenied = (int)resp.StatusCode is 401 or 403;
            _logger.LogError("Failed to fetch agent definition for '{AgentId}': {Status} {Body}",
                agentId, (int)resp.StatusCode, body.Length > 500 ? body[..500] : body);

            if (isPermissionDenied && !string.IsNullOrEmpty(_fallbackMcpServiceUrl))
            {
                // The managed identity lacks the 'AIServices/agents/read' data action.
                // Fall back to pre-configured tool URLs derived from environment variables.
                // Instructions are omitted — each service's user message contains the required context.
                _logger.LogWarning(
                    "Agent definition fetch denied for '{AgentId}'. Falling back to environment-derived tool config. " +
                    "To fix: grant the managed identity 'AIServices/agents/read' data action on the AI Services account.",
                    agentId);

                var fallbackDef = BuildFallbackDefinition();
                _agentDefCache.TryAdd(agentId, fallbackDef);
                return fallbackDef;
            }

            throw new InvalidOperationException(
                $"Failed to fetch agent definition for '{agentId}': {(int)resp.StatusCode}");
        }

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;

        // Navigate: versions.latest.definition
        var definition = root
            .GetProperty("versions")
            .GetProperty("latest")
            .GetProperty("definition");

        var model = definition.TryGetProperty("model", out var m) ? m.GetString() ?? "chat" : "chat";
        var instructions = definition.TryGetProperty("instructions", out var inst) ? inst.GetString() : null;

        // Clone tools so they outlive the JsonDocument lifetime
        var tools = new List<JsonElement>();
        if (definition.TryGetProperty("tools", out var toolsArr)
            && toolsArr.ValueKind == JsonValueKind.Array)
        {
            foreach (var tool in toolsArr.EnumerateArray())
                tools.Add(tool.Clone());
        }

        // If the agent definition has no MCP tools configured but fallback MCP URLs are
        // available via environment variables, inject them so the agent can reach live data.
        // This handles agents created in the Foundry portal without explicit MCP server setup.
        if (tools.Count == 0 && !string.IsNullOrEmpty(_fallbackMcpServiceUrl))
        {
            _logger.LogWarning(
                "Agent '{AgentId}' has no tools in its Foundry definition. " +
                "Augmenting with MCP tools from MCP_SERVICE_URL environment variable. " +
                "To silence this warning, configure the MCP server URL directly in the agent definition.",
                agentId);

            var augmented = BuildFallbackDefinition();

            // When the Foundry agent has no tools, its instructions may also be absent or
            // unsuitable for data queries.  Supply a concise fallback system prompt so the
            // model knows what it is and how to use the injected MCP tools.
            var effectiveInstructions = !string.IsNullOrWhiteSpace(instructions)
                ? instructions
                : "You are an AI data assistant for the AdventureWorks business. " +
                  "You have access to MCP tools that can query live product, order, customer, " +
                  "inventory, and sales data. Always use the available tools to answer " +
                  "data questions rather than asking the user to provide data. " +
                  "Respond concisely and in plain language suitable for a business analyst.";

            var def = new CachedAgentDefinition(model, effectiveInstructions, augmented.Tools);
            _agentDefCache.TryAdd(agentId, def);
            _logger.LogInformation(
                "Cached augmented agent definition for '{AgentId}': model={Model}, tools={ToolCount} (from MCP_SERVICE_URL)",
                agentId, model, def.Tools.Count);
            return def;
        }

        var cachedDef = new CachedAgentDefinition(model, instructions, tools);
        _agentDefCache.TryAdd(agentId, cachedDef);

        _logger.LogInformation(
            "Cached agent definition for '{AgentId}': model={Model}, tools={ToolCount}",
            agentId, model, cachedDef.Tools.Count);

        return cachedDef;
    }

    /// <summary>
    /// Resolves Handlebars-style templates in agent instructions at runtime so the
    /// OpenAI-compatible Responses API endpoint (which does not process structured_inputs
    /// server-side) receives the fully-resolved instruction text.
    ///
    /// Handles:
    ///   {{variableName}}                              → replaced with the value from inputs
    ///   {{#if variableName}}...{{/if}}                → inner content included if variable present
    ///   Nested conditionals are resolved via multiple passes (inner-most first).
    /// </summary>
    private static string? ResolveHandlebarsTemplate(
        string? template,
        Dictionary<string, object>? inputs)
    {
        if (string.IsNullOrEmpty(template) || inputs == null || inputs.Count == 0)
            return template;

        var result = template;

        // Multiple passes to resolve nested {{#if}} blocks (inner-most blocks first).
        // Pattern matches {{#if variable}}truthy{{else}}falsy{{/if}} where content has
        // no nested {{#if}} blocks. The {{else}} section is optional.
        const string innerIfPattern =
            @"\{\{#if\s+(\w+)\}\}((?:(?!\{\{#if)[\s\S])*?)(?:\{\{else\}\}((?:(?!\{\{#if)[\s\S])*?))?\{\{/if\}\}";

        for (var pass = 0; pass < 5; pass++)
        {
            var next = Regex.Replace(result, innerIfPattern, m =>
            {
                var varName = m.Groups[1].Value;
                var truthyBranch = m.Groups[2].Value;
                var falsyBranch = m.Groups[3].Success ? m.Groups[3].Value : string.Empty;

                return inputs.TryGetValue(varName, out var val) && IsTemplateTruthy(val)
                    ? truthyBranch
                    : falsyBranch;
            });

            if (next == result) break;   // converged — no more resolvable blocks
            result = next;
        }

        // Replace remaining {{variable}} placeholders
        foreach (var kvp in inputs)
            result = result.Replace($"{{{{{kvp.Key}}}}}", kvp.Value?.ToString() ?? string.Empty);

        return result;
    }

    private static bool IsTemplateTruthy(object? value)
    {
        return value switch
        {
            null => false,
            bool boolValue => boolValue,
            string stringValue => !string.IsNullOrWhiteSpace(stringValue)
                && !string.Equals(stringValue, "false", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(stringValue, "0", StringComparison.OrdinalIgnoreCase),
            sbyte signedByte => signedByte != 0,
            byte unsignedByte => unsignedByte != 0,
            short shortValue => shortValue != 0,
            ushort unsignedShort => unsignedShort != 0,
            int intValue => intValue != 0,
            uint unsignedInt => unsignedInt != 0,
            long longValue => longValue != 0,
            ulong unsignedLong => unsignedLong != 0,
            JsonElement jsonElement => jsonElement.ValueKind switch
            {
                JsonValueKind.False => false,
                JsonValueKind.True => true,
                JsonValueKind.Null => false,
                JsonValueKind.String => IsTemplateTruthy(jsonElement.GetString()),
                JsonValueKind.Number => jsonElement.TryGetInt64(out var numericValue) && numericValue != 0,
                _ => true,
            },
            _ => !string.IsNullOrWhiteSpace(value.ToString())
        };
    }

    /// <summary>
    /// Pre-warms MCP servers referenced in the agent's tool definitions by sending a
    /// lightweight HTTP POST. This ensures Container Apps are scaled up before Foundry
    /// attempts to enumerate tools (which has an internal timeout that triggers
    /// "TaskCanceledException encountered while enumerating tools" on cold starts).
    /// </summary>
    private async Task WarmupMcpServersAsync(IReadOnlyList<JsonElement> tools, CancellationToken cancellationToken)
    {
        var mcpUrls = new HashSet<string>();
        foreach (var tool in tools)
        {
            if (tool.TryGetProperty("type", out var typeProp) && typeProp.GetString() == "mcp"
                && tool.TryGetProperty("server_url", out var urlProp))
            {
                var url = urlProp.GetString();
                if (!string.IsNullOrEmpty(url))
                    mcpUrls.Add(url);
            }
        }

        if (mcpUrls.Count == 0) return;

        using var httpClient = _httpClientFactory.CreateClient();
        httpClient.Timeout = TimeSpan.FromSeconds(15);

        var warmupTasks = mcpUrls.Select(async url =>
        {
            try
            {
                // Send tools/list — lightweight JSON-RPC call that wakes the Container App
                var listPayload = """{"jsonrpc":"2.0","id":0,"method":"tools/list","params":{}}""";
                using var req = new HttpRequestMessage(HttpMethod.Post, url)
                {
                    Content = new StringContent(listPayload, Encoding.UTF8, "application/json")
                };
                var resp = await httpClient.SendAsync(req, cancellationToken);
                _logger.LogDebug("MCP warmup for {Url}: {Status}", url, (int)resp.StatusCode);
            }
            catch (Exception ex)
            {
                // Non-fatal: warmup is best-effort; the retry loop handles failures
                _logger.LogDebug(ex, "MCP warmup failed for {Url} (non-fatal)", url);
            }
        });

        await Task.WhenAll(warmupTasks);
    }

    /// <summary>
    /// Builds an MCP tool configuration from environment-provided URLs.
    /// Used as fallback when the managed identity lacks 'AIServices/agents/read'.
    /// </summary>
    private CachedAgentDefinition BuildFallbackDefinition()
    {
        var toolsJson = new System.Text.StringBuilder("[");
        var first = true;

        void AddTool(string label, string url)
        {
            if (string.IsNullOrEmpty(url)) return;
            if (!first) toolsJson.Append(',');
            first = false;
            toolsJson.Append($@"{{""type"":""mcp"",""server_label"":""{label}"",""server_url"":""{url}"",""allowed_tools"":[]}}");
        }

        // Only include the custom MCP server — DAB MCP uses session-based transport
        // that Foundry's MCP client cannot negotiate (returns 400 without Mcp-Session-Id).
        AddTool("adventureworks_mcp", _fallbackMcpServiceUrl);
        toolsJson.Append(']');

        var tools = new List<JsonElement>();
        using var doc = JsonDocument.Parse(toolsJson.ToString());
        foreach (var tool in doc.RootElement.EnumerateArray())
            tools.Add(tool.Clone());

        _logger.LogInformation(
            "Fallback agent definition: model={Model}, tools={ToolCount} (mcp={Mcp}, dab={Dab})",
            _fallbackModelDeployment, tools.Count, _fallbackMcpServiceUrl, _fallbackDabMcpUrl);

        return new CachedAgentDefinition(_fallbackModelDeployment, null, tools);
    }
}

// ── Cached agent definition ──────────────────────────────────────────────────

/// <summary>Cached result of fetching an agent definition from Foundry.</summary>
internal sealed record CachedAgentDefinition(
    string Model,
    string? Instructions,
    IReadOnlyList<JsonElement> Tools
);

// ── Wire-format request DTO ──────────────────────────────────────────────────

/// <summary>
/// Serialises to the Foundry Responses API POST body.
/// snake_case applied via <see cref="JsonNamingPolicy.SnakeCaseLower"/> at the call site.
/// </summary>
internal sealed class FoundryResponsesRequest
{
    /// <summary>Model deployment name (e.g. "chat"), from the agent definition.</summary>
    public string Model { get; set; } = string.Empty;

    /// <summary>Agent system prompt, from the agent definition.</summary>
    public string? Instructions { get; set; }

    public object Input { get; set; } = string.Empty;
    public bool Stream { get; set; }
    public bool Store { get; set; } = true;
    public string? PreviousResponseId { get; set; }

    /// <summary>Tools (MCP servers) from the agent definition, serialised as-is.</summary>
    public IReadOnlyList<JsonElement>? Tools { get; set; }

    /// <summary>
    /// Runtime values that resolve Handlebars {{variable}} placeholders declared in the
    /// agent's structured_inputs schema. Null values are omitted from the serialised payload.
    /// </summary>
    public Dictionary<string, object>? StructuredInputs { get; set; }

    /// <summary>
    /// Controls tool invocation: "required" forces at least one tool call,
    /// "auto" lets the model decide, "none" disables tool calls.
    /// Omitted from the request when null (Foundry defaults to "auto").
    /// </summary>
    public string? ToolChoice { get; set; }
}

// ── Public types ─────────────────────────────────────────────────────────────

/// <summary>A single message passed to the Foundry agent (history or seeded context).</summary>
public class FoundryMessage
{
    public string Role { get; set; } = "user";
    public string Content { get; set; } = string.Empty;
}

/// <summary>Parsed response from a Foundry Responses API call.</summary>
public class FoundryAgentResponse
{
    /// <summary>
    /// Returned by Foundry (format: "resp_…"). Pass back as
    /// <c>previousResponseId</c> in subsequent calls to continue the conversation.
    /// </summary>
    public string? ResponseId { get; set; }

    /// <summary>The assistant's final text reply.</summary>
    public string ResponseText { get; set; } = string.Empty;

    /// <summary>Names of MCP / function tools called during the run (for telemetry / UI display).</summary>
    public List<string> ToolsUsed { get; set; } = new();

    /// <summary>Prompt token count (App Insights).</summary>
    public int InputTokens { get; set; }

    /// <summary>Completion token count (App Insights).</summary>
    public int OutputTokens { get; set; }
}
