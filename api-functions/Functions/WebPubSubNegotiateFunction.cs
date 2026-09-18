using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Negotiate endpoint for Azure Web PubSub client connections.
///
/// GET /api/webpubsub/negotiate?groups=manufacturing-agent,warehouse,...
///
/// Returns a client access URL with a short-lived JWT token that the browser
/// uses to open a WebSocket connection to Web PubSub. The requested groups are
/// validated against an allow-list before being granted.
/// </summary>
public class WebPubSubNegotiateFunction
{
    private readonly ILogger<WebPubSubNegotiateFunction> _logger;
    private readonly WebPubSubService _webPubSubService;

    public WebPubSubNegotiateFunction(
        ILogger<WebPubSubNegotiateFunction> logger,
        WebPubSubService webPubSubService)
    {
        _logger = logger;
        _webPubSubService = webPubSubService;
    }

    [Function(nameof(NegotiateWebPubSub))]
    public async Task<HttpResponseData> NegotiateWebPubSub(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "webpubsub/negotiate")]
        HttpRequestData req)
    {
        if (!_webPubSubService.IsEnabled)
        {
            var err = req.CreateResponse(HttpStatusCode.ServiceUnavailable);
            await err.WriteAsJsonAsync(new { error = "Web PubSub is not configured." });
            return err;
        }

        var groupsParam = req.Query["groups"] ?? string.Empty;
        var requestedGroups = groupsParam
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(g => WebPubSubService.AllowedGroups.Contains(g))
            .ToArray();

        if (requestedGroups.Length == 0)
        {
            var err = req.CreateResponse(HttpStatusCode.BadRequest);
            await err.WriteAsJsonAsync(new
            {
                error = "No valid groups specified.",
                allowedGroups = WebPubSubService.AllowedGroups,
            });
            return err;
        }

        var uri = await _webPubSubService.GetClientAccessUriAsync(requestedGroups);
        if (uri == null)
        {
            var err = req.CreateResponse(HttpStatusCode.ServiceUnavailable);
            await err.WriteAsJsonAsync(new { error = "Failed to generate client access URL." });
            return err;
        }

        _logger.LogInformation("[WebPubSub] Negotiate: granted groups [{Groups}]", string.Join(", ", requestedGroups));

        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(new { url = uri.AbsoluteUri });
        return response;
    }
}
