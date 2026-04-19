using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// Financial reporting endpoints that expose bank transaction history segmented by
/// simulator domain (procurement, manufacturing, payroll, scrap write-offs).
///
/// All data is sourced from the virtual BankService Table Storage — no additional
/// SQL queries are needed for these read-only aggregates.
/// </summary>
public class FinancialReportingFunction
{
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy        = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition      = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented               = false,
    };

    private readonly ILogger<FinancialReportingFunction> _logger;
    private readonly BankService _bank;

    public FinancialReportingFunction(
        ILogger<FinancialReportingFunction> logger,
        BankService bank)
    {
        _logger = logger;
        _bank   = bank;
    }

    // ── GET /api/financials/summary ───────────────────────────────────────────

    /// <summary>
    /// Returns an aggregated financial summary across all simulators:
    ///   - Procurement spend (total PO debits) and refunds
    ///   - Manufacturing material cost (WO completions)
    ///   - Payroll (per-operation labour charges)
    ///   - Scrap write-offs
    /// </summary>
    [Function("FinancialSummary")]
    public async Task<HttpResponseData> GetSummary(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "financials/summary")]
        HttpRequestData req)
    {
        try
        {
            await _bank.InitializeAsync();
            var summary = await _bank.GetFinancialSummaryAsync();

            var resp = req.CreateResponse(HttpStatusCode.OK);
            resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
            await resp.WriteStringAsync(JsonSerializer.Serialize(new
            {
                procurement = new
                {
                    totalSpend       = summary.TotalProcurementSpend,
                    totalRefunds     = summary.TotalProcurementRefunds,
                    netSpend         = summary.NetProcurement,
                    transactionCount = summary.ProcurementCount,
                },
                manufacturing = new
                {
                    totalCost        = summary.TotalManufacturingCost,
                    transactionCount = summary.ManufacturingCount,
                },
                payroll = new
                {
                    totalCost        = summary.TotalPayroll,
                    transactionCount = summary.PayrollCount,
                },
                scrap = new
                {
                    totalWriteOffs   = summary.TotalScrapWriteOffs,
                    transactionCount = summary.ScrapCount,
                },
                totals = new
                {
                    totalOperatingCost    = summary.TotalOperatingCost,
                    totalAllSpend         = summary.TotalProcurementSpend + summary.TotalOperatingCost,
                },
                generatedAtUtc = summary.GeneratedAtUtc,
            }, _json));
            return resp;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Financials] Error generating financial summary.");
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteStringAsync(JsonSerializer.Serialize(new { error = ex.Message }, _json));
            return err;
        }
    }

    // ── GET /api/financials/procurement ──────────────────────────────────────

    /// <summary>
    /// Returns recent procurement transactions (PO approvals and refunds).
    /// Query params: maxCount (default 50), vendorId (optional — filters by PO metadata in description).
    /// </summary>
    [Function("FinancialProcurement")]
    public async Task<HttpResponseData> GetProcurement(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "financials/procurement")]
        HttpRequestData req)
    {
        var qs        = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        int maxCount  = int.TryParse(qs["maxCount"], out var mc) ? Math.Clamp(mc, 1, 500) : 50;

        try
        {
            await _bank.InitializeAsync();
            var txns = await _bank.GetTransactionsByPrefixAsync("PO-", maxCount);

            var resp = req.CreateResponse(HttpStatusCode.OK);
            resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
            await resp.WriteStringAsync(JsonSerializer.Serialize(
                txns.Select(t => new
                {
                    transactionId   = t.TransactionId,
                    currencyCode    = t.CurrencyCode,
                    amount          = t.Amount,
                    balanceAfter    = t.BalanceAfter,
                    transactionType = t.TransactionType,
                    description     = t.Description,
                    referenceId     = t.ReferenceId,
                    transactedAtUtc = t.TransactedAtUtc,
                }),
                _json));
            return resp;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Financials] Error retrieving procurement transactions.");
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteStringAsync(JsonSerializer.Serialize(new { error = ex.Message }, _json));
            return err;
        }
    }

    // ── GET /api/financials/manufacturing ─────────────────────────────────────

    /// <summary>
    /// Returns recent manufacturing financial transactions:
    ///   - WO completions (material/overhead cost — reference WO-*)
    ///   - Payroll per routing operation (reference WO-*-OP-*)
    ///   - Scrap write-offs (reference SCRAP-WO-*)
    /// Query params: maxCount (default 50), type = "completions" | "payroll" | "scrap" | "all" (default all).
    /// </summary>
    [Function("FinancialManufacturing")]
    public async Task<HttpResponseData> GetManufacturing(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "financials/manufacturing")]
        HttpRequestData req)
    {
        var qs       = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
        int maxCount = int.TryParse(qs["maxCount"], out var mc) ? Math.Clamp(mc, 1, 500) : 50;
        var type     = qs["type"]?.ToLowerInvariant() ?? "all";

        try
        {
            await _bank.InitializeAsync();

            IReadOnlyList<BankTransaction> txns;
            if (type == "payroll")
                txns = await _bank.GetTransactionsByPrefixAsync(null, maxCount * 10);
            else if (type == "scrap")
                txns = await _bank.GetTransactionsByPrefixAsync("SCRAP-WO-", maxCount);
            else // "completions" or "all"
                txns = await _bank.GetTransactionsByPrefixAsync(null, maxCount * 10);

            var filtered = type switch
            {
                "completions" => txns.Where(t => t.ReferenceId?.StartsWith("WO-", StringComparison.OrdinalIgnoreCase) == true && t.TransactionType == "purchase" && !t.ReferenceId.Contains("-OP-", StringComparison.OrdinalIgnoreCase)).Take(maxCount).ToList(),
                "payroll"     => txns.Where(t => t.TransactionType == "payroll").Take(maxCount).ToList(),
                "scrap"       => txns.Where(t => t.ReferenceId?.StartsWith("SCRAP-WO-", StringComparison.OrdinalIgnoreCase) == true).Take(maxCount).ToList(),
                _             => txns.Where(t => (t.ReferenceId?.StartsWith("WO-", StringComparison.OrdinalIgnoreCase) == true) || t.TransactionType == "payroll" || (t.ReferenceId?.StartsWith("SCRAP-", StringComparison.OrdinalIgnoreCase) == true)).Take(maxCount).ToList(),
            };

            var resp = req.CreateResponse(HttpStatusCode.OK);
            resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
            await resp.WriteStringAsync(JsonSerializer.Serialize(
                filtered.Select(t => new
                {
                    transactionId   = t.TransactionId,
                    currencyCode    = t.CurrencyCode,
                    amount          = t.Amount,
                    balanceAfter    = t.BalanceAfter,
                    transactionType = t.TransactionType,
                    description     = t.Description,
                    referenceId     = t.ReferenceId,
                    transactedAtUtc = t.TransactedAtUtc,
                }),
                _json));
            return resp;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Financials] Error retrieving manufacturing transactions.");
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteStringAsync(JsonSerializer.Serialize(new { error = ex.Message }, _json));
            return err;
        }
    }
}
