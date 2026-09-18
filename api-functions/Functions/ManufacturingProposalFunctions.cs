using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using api_functions.Models;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// HTTP endpoints for managing manufacturing agent action proposals.
///
/// GET  /api/manufacturing/proposals?status=pending   – List proposals (defaults to pending).
/// POST /api/manufacturing/proposals                  – Create a proposal (called by MCP tools).
/// POST /api/manufacturing/proposals/{id}/approve     – Approve and execute a pending proposal.
/// POST /api/manufacturing/proposals/{id}/reject      – Reject a pending proposal.
/// </summary>
public class ManufacturingProposalFunctions
{
    private static readonly JsonSerializerOptions JsonOpts =
        new() { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private readonly ILogger<ManufacturingProposalFunctions> _logger;
    private readonly ManufacturingProposalService _proposalService;
    private readonly SupplyChainService           _supplyChain;
    private readonly IHttpClientFactory           _httpClientFactory;
    private readonly string                       _functionsBaseUrl;

    public ManufacturingProposalFunctions(
        ILogger<ManufacturingProposalFunctions> logger,
        ManufacturingProposalService proposalService,
        SupplyChainService supplyChain,
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration)
    {
        _logger            = logger;
        _proposalService   = proposalService;
        _supplyChain       = supplyChain;
        _httpClientFactory = httpClientFactory;
        _functionsBaseUrl  = (configuration["API_FUNCTIONS_URL"] ?? "http://localhost:7071").TrimEnd('/');
    }

    // ── GET /api/manufacturing/proposals ─────────────────────────────────────
    // Returns the most recent pending proposals (default 10), auto-rejecting any
    // that are older than the TTL or beyond the display cap.

    [Function(nameof(GetManufacturingProposals))]
    public async Task<HttpResponseData> GetManufacturingProposals(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "manufacturing/proposals")]
        HttpRequestData req)
    {
        var ttlStr    = req.Query["ttlMinutes"];
        var ttl       = int.TryParse(ttlStr, out var t) ? t : 5;
        var proposals = await _proposalService.ListPendingWithLimitAsync(limit: 10, ttlMinutes: ttl);
        var response  = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(proposals.Select(p => new
        {
            p.ProposalId,
            p.Type,
            p.ProductId,
            p.Qty,
            p.VendorId,
            p.Rationale,
            p.Status,
            p.SalesOrderId,
            p.RunId,
            p.CreatedAt,
            p.ActionedAt,
        }));
        return response;
    }

    // ── POST /api/manufacturing/proposals/reject-all ──────────────────────────

    [Function(nameof(RejectAllManufacturingProposals))]
    public async Task<HttpResponseData> RejectAllManufacturingProposals(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "manufacturing/proposals/reject-all")]
        HttpRequestData req)
    {
        var count    = await _proposalService.RejectAllPendingAsync();
        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(new { rejected = count });
        return response;
    }

    // ── POST /api/manufacturing/proposals/approve-all ─────────────────────────
    // Executes up to 20 pending proposals sequentially and returns a summary.

    [Function(nameof(ApproveAllManufacturingProposals))]
    public async Task<HttpResponseData> ApproveAllManufacturingProposals(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "manufacturing/proposals/approve-all")]
        HttpRequestData req)
    {
        // Fetch with generous TTL so nothing expires mid-approve
        var proposals = await _proposalService.ListPendingWithLimitAsync(limit: 20, ttlMinutes: 60);
        int succeeded = 0, failed = 0;
        var errors    = new List<string>();

        foreach (var p in proposals)
        {
            try
            {
                await _proposalService.ApproveAsync(p.ProposalId);
                var result = p.Type == "manufacturing"
                    ? await ExecuteManufacturingProposalAsync(p)
                    : await ExecuteSupplyProposalAsync(p);
                await _proposalService.MarkExecutedAsync(p.ProposalId);
                _logger.LogInformation("[Proposal] Bulk-approved {ProposalId}: {Result}", p.ProposalId, result);
                succeeded++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Proposal] Bulk-approve failed for {ProposalId}", p.ProposalId);
                errors.Add($"{p.Type} product {p.ProductId}: {ex.Message[..Math.Min(80, ex.Message.Length)]}");
                failed++;
            }
        }

        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(new { succeeded, failed, errors });
        return response;
    }

    // ── POST /api/manufacturing/proposals ─────────────────────────────────────

    [Function(nameof(CreateManufacturingProposal))]
    public async Task<HttpResponseData> CreateManufacturingProposal(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "manufacturing/proposals")]
        HttpRequestData req)
    {
        string body;
        try { body = await new StreamReader(req.Body).ReadToEndAsync(); }
        catch { return await BadRequestAsync(req, "Could not read request body."); }

        CreateProposalRequest? r;
        try { r = JsonSerializer.Deserialize<CreateProposalRequest>(body, JsonOpts); }
        catch { return await BadRequestAsync(req, "Invalid JSON body."); }

        if (r is null || r.ProductId <= 0 || r.Qty <= 0 ||
            (r.Type != "manufacturing" && r.Type != "supply"))
            return await BadRequestAsync(req, "type (manufacturing|supply), productId > 0, and qty > 0 are required.");

        if (r.Type == "supply" && string.IsNullOrWhiteSpace(r.VendorId))
            return await BadRequestAsync(req, "vendorId is required for type=supply.");

        var proposalId = await _proposalService.CreateProposalAsync(
            r.Type, r.ProductId, r.Qty, r.VendorId, r.Rationale ?? string.Empty,
            r.SalesOrderId, r.RunId ?? string.Empty);

        var response = req.CreateResponse(HttpStatusCode.Created);
        await response.WriteAsJsonAsync(new { proposalId });
        return response;
    }

    // ── POST /api/manufacturing/proposals/{id}/approve ────────────────────────

    [Function(nameof(ApproveManufacturingProposal))]
    public async Task<HttpResponseData> ApproveManufacturingProposal(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "manufacturing/proposals/{id}/approve")]
        HttpRequestData req,
        string id)
    {
        var proposal = await _proposalService.GetProposalAsync(id);
        if (proposal == null)
            return await NotFoundAsync(req, $"Proposal {id} not found.");

        if (proposal.Status != "pending")
        {
            // Idempotent: already approved/executed — treat as success so double-clicks
            // or retries don't show an error to the user.
            var alreadyDone = req.CreateResponse(HttpStatusCode.OK);
            await alreadyDone.WriteAsJsonAsync(new { proposalId = id, status = proposal.Status, note = $"Proposal was already {proposal.Status}" });
            return alreadyDone;
        }

        await _proposalService.ApproveAsync(id);

        // Execute the action
        string actionResult;
        try
        {
            actionResult = proposal.Type == "manufacturing"
                ? await ExecuteManufacturingProposalAsync(proposal)
                : await ExecuteSupplyProposalAsync(proposal);

            await _proposalService.MarkExecutedAsync(id);
            _logger.LogInformation("[Proposal] {ProposalId} approved and executed: {Result}", id, actionResult);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Proposal] Execution failed for proposal {ProposalId}", id);
            var errResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errResponse.WriteAsJsonAsync(new { error = $"Proposal approved but execution failed: {ex.Message}" });
            return errResponse;
        }

        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(new { proposalId = id, status = "executed", result = actionResult });
        return response;
    }

    // ── POST /api/manufacturing/proposals/{id}/reject ─────────────────────────

    [Function(nameof(RejectManufacturingProposal))]
    public async Task<HttpResponseData> RejectManufacturingProposal(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "manufacturing/proposals/{id}/reject")]
        HttpRequestData req,
        string id)
    {
        var proposal = await _proposalService.GetProposalAsync(id);
        if (proposal == null)
            return await NotFoundAsync(req, $"Proposal {id} not found.");

        if (proposal.Status != "pending")
        {
            var alreadyDone = req.CreateResponse(HttpStatusCode.OK);
            await alreadyDone.WriteAsJsonAsync(new { proposalId = id, status = proposal.Status, note = $"Proposal was already {proposal.Status}" });
            return alreadyDone;
        }

        await _proposalService.RejectAsync(id);

        var response = req.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(new { proposalId = id, status = "rejected" });
        return response;
    }

    // ── Execution helpers ─────────────────────────────────────────────────────

    private async Task<string> ExecuteManufacturingProposalAsync(ManufacturingProposalEntity proposal)
    {
        // Delegate to the existing /api/manufacturing/begin endpoint to avoid duplicating
        // the BOM explosion / work order creation logic embedded in ManufacturingControlFunction.
        using var http    = _httpClientFactory.CreateClient();
        var body          = JsonSerializer.Serialize(
            new { productId = proposal.ProductId, orderQty = proposal.Qty }, JsonOpts);
        var resp          = await http.PostAsync(
            $"{_functionsBaseUrl}/api/manufacturing/begin",
            new System.Net.Http.StringContent(body, System.Text.Encoding.UTF8, "application/json"));

        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync();
            throw new InvalidOperationException(
                $"Manufacturing begin failed ({(int)resp.StatusCode}): {err[..Math.Min(300, err.Length)]}");
        }

        var responseBody = await resp.Content.ReadAsStringAsync();
        using var doc    = JsonDocument.Parse(responseBody);
        var root         = doc.RootElement;
        var runId        = root.TryGetProperty("runId", out var ri) ? ri.GetString() : null;
        var woCount      = root.TryGetProperty("workOrderCount", out var wc) ? wc.GetInt32() : 0;
        return $"Manufacturing run started: RunId={runId}, {woCount} work orders created for ProductID={proposal.ProductId}, qty={proposal.Qty}.";
    }

    private async Task<string> ExecuteSupplyProposalAsync(ManufacturingProposalEntity proposal)
    {
        if (string.IsNullOrEmpty(proposal.VendorId))
            throw new InvalidOperationException("VendorId is required for supply proposals.");

        // Extract only digit characters — strips any non-numeric prefix/suffix the model
        // may have hallucinated (e.g. "V1492" → "1492", "vendor_3" → "3").
        var vendorId = new string(proposal.VendorId.Where(char.IsDigit).ToArray());
        if (string.IsNullOrEmpty(vendorId))
            throw new InvalidOperationException($"VendorId '{proposal.VendorId}' contains no numeric digits — cannot place supply order.");

        var order = await _supplyChain.PlaceOrderAsync(vendorId, proposal.ProductId, proposal.Qty);
        if (order == null)
            throw new InvalidOperationException(
                $"Vendor '{vendorId}' or product {proposal.ProductId} was not found in the supply catalog. " +
                $"Check that the vendor stocks this product before approving.");

        return $"Supply order placed: OrderID={order.OrderId} with VendorID={vendorId} for ProductID={proposal.ProductId}, qty={proposal.Qty}.";
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static async Task<HttpResponseData> BadRequestAsync(HttpRequestData req, string message)
    {
        var r = req.CreateResponse(HttpStatusCode.BadRequest);
        await r.WriteStringAsync(message);
        return r;
    }

    private static async Task<HttpResponseData> NotFoundAsync(HttpRequestData req, string message)
    {
        var r = req.CreateResponse(HttpStatusCode.NotFound);
        await r.WriteStringAsync(message);
        return r;
    }
}

// ── Request model ─────────────────────────────────────────────────────────────

internal record CreateProposalRequest(
    string Type,
    int ProductId,
    int Qty,
    string? VendorId,
    string? Rationale,
    int SalesOrderId,
    string? RunId);
