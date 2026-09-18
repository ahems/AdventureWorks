using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// HTTP endpoints for reading and updating the manufacturing agent autonomy mode.
///
/// GET /api/manufacturing/agent-config  – Returns the current mode.
/// PUT /api/manufacturing/agent-config  – Updates the mode.
/// </summary>
public class ManufacturingAgentConfigFunctions
{
    private static readonly JsonSerializerOptions JsonOpts =
        new() { PropertyNameCaseInsensitive = true };

    private readonly ILogger<ManufacturingAgentConfigFunctions> _logger;
    private readonly ManufacturingAgentConfigService _configService;
    private readonly WebPubSubService _webPubSub;

    public ManufacturingAgentConfigFunctions(
        ILogger<ManufacturingAgentConfigFunctions> logger,
        ManufacturingAgentConfigService configService,
        WebPubSubService webPubSub)
    {
        _logger        = logger;
        _configService = configService;
        _webPubSub     = webPubSub;
    }

    // ── GET /api/manufacturing/agent-config ───────────────────────────────────

    [Function(nameof(GetManufacturingAgentConfig))]
    public async Task<HttpResponseData> GetManufacturingAgentConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/agent-config")]
        HttpRequestData req)
    {
        var (mode, shutoffAt) = await _configService.GetConfigAsync();
        var response          = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(new
        {
            mode          = (int)mode,
            modeLabel     = mode.ToString(),
            isAgentActive = mode > ManufacturingAgentMode.Off,
            autoShutoffAt = shutoffAt?.ToString("O")   // ISO 8601 round-trip
        });
        return response;
    }

    // ── PUT /api/manufacturing/agent-config ───────────────────────────────────

    [Function(nameof(PutManufacturingAgentConfig))]
    public async Task<HttpResponseData> PutManufacturingAgentConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "manufacturing/agent-config")]
        HttpRequestData req)
    {
        string body;
        try { body = await new StreamReader(req.Body).ReadToEndAsync(); }
        catch { return await BadRequestAsync(req, "Could not read request body."); }

        int modeValue;
        int? autoShutoffHours = null;
        try
        {
            using var doc = JsonDocument.Parse(body);
            modeValue = doc.RootElement.GetProperty("mode").GetInt32();
            if (doc.RootElement.TryGetProperty("autoShutoffHours", out var sh) &&
                sh.ValueKind == JsonValueKind.Number)
            {
                var h = sh.GetInt32();
                autoShutoffHours = Math.Clamp(h, 1, 72);
            }
        }
        catch { return await BadRequestAsync(req, "Body must be JSON with a numeric 'mode' field."); }

        if (!Enum.IsDefined(typeof(ManufacturingAgentMode), modeValue))
            return await BadRequestAsync(req, $"Invalid mode '{modeValue}'. Valid values: 0 (Off), 1 (ReadOnly), 2 (ProposePending), 3 (FullyAutonomous).");

        var mode = (ManufacturingAgentMode)modeValue;
        await _configService.SaveModeAsync(mode, autoShutoffHours);
        _logger.LogInformation("[AgentConfig] Mode updated to {Mode}, auto-shutoff in {Hours}h",
            mode, autoShutoffHours?.ToString() ?? "none");

        var (savedMode, shutoffAt) = await _configService.GetConfigAsync();
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(new
        {
            mode          = (int)savedMode,
            modeLabel     = savedMode.ToString(),
            isAgentActive = savedMode > ManufacturingAgentMode.Off,
            autoShutoffAt = shutoffAt?.ToString("O")
        });

        await _webPubSub.SendToGroupAsync("manufacturing-agent", new
        {
            @event = "config-changed",
            mode = (int)savedMode,
            modeLabel = savedMode.ToString()
        });

        return response;
    }

    private static async Task<HttpResponseData> BadRequestAsync(HttpRequestData req, string message)
    {
        var r = req.CreateResponse(HttpStatusCode.BadRequest);
        await r.WriteStringAsync(message);
        return r;
    }
}
