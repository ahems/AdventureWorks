using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AdventureWorks.Services;

/// <summary>
/// Calls the api-functions bank simulator endpoints on behalf of MCP tools.
/// Base URL is read from the API_FUNCTIONS_URL environment variable / configuration.
/// </summary>
public class BankService
{
    private readonly HttpClient _http;
    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public BankService(HttpClient http) => _http = http;

    // ── Status ────────────────────────────────────────────────────────────────

    public async Task<string> GetBankStatusAsync()
    {
        var resp = await _http.GetAsync("api/bank/status");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving bank status: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Virtual Bank Status");
        sb.AppendLine();

        if (root.TryGetProperty("accounts", out var accounts) && accounts.ValueKind == JsonValueKind.Array)
        {
            sb.AppendLine("### Account Balances");
            foreach (var a in accounts.EnumerateArray())
            {
                var code    = a.GetStringOrDefault("currencyCode") ?? "???";
                var name    = a.GetStringOrDefault("currencyName") ?? code;
                var balance = a.GetDecimalOrDefault("balance");
                sb.AppendLine($"  {code} ({name}): {balance:N2}");
            }
        }

        if (root.TryGetProperty("totalUsd", out var totalUsd))
        {
            sb.AppendLine();
            sb.AppendLine($"### Total (USD equivalent): ${totalUsd.GetDecimal():N2}");
        }

        if (root.TryGetProperty("reportedAtUtc", out var ts))
            sb.AppendLine($"As of: {ts.GetString()}");

        return sb.ToString();
    }

    // ── Specific account ──────────────────────────────────────────────────────

    public async Task<string> GetAccountAsync(string currencyCode)
    {
        var resp = await _http.GetAsync($"api/bank/accounts/{Uri.EscapeDataString(currencyCode.Trim().ToUpperInvariant())}");
        if (resp.StatusCode == System.Net.HttpStatusCode.NotFound)
            return $"No bank account found for currency '{currencyCode.ToUpperInvariant()}'.";
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving account: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine($"## Bank Account: {root.GetStringOrDefault("currencyCode")} — {root.GetStringOrDefault("currencyName")}");
        sb.AppendLine($"Balance: {root.GetDecimalOrDefault("balance"):N2}");
        return sb.ToString();
    }

    // ── Transactions ──────────────────────────────────────────────────────────

    public async Task<string> GetTransactionsAsync(string? currencyCode = null, int maxCount = 20)
    {
        var url = currencyCode != null
            ? $"api/bank/transactions/{Uri.EscapeDataString(currencyCode.Trim().ToUpperInvariant())}?maxCount={maxCount}"
            : $"api/bank/transactions?maxCount={maxCount}";

        var resp = await _http.GetAsync(url);
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving transactions: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        var header = currencyCode != null
            ? $"## Recent Bank Transactions ({currencyCode.ToUpperInvariant()})"
            : "## Recent Bank Transactions (All Currencies)";
        sb.AppendLine(header);
        sb.AppendLine();

        if (root.ValueKind != JsonValueKind.Array || root.GetArrayLength() == 0)
        {
            sb.AppendLine("No transactions found.");
            return sb.ToString();
        }

        foreach (var t in root.EnumerateArray())
        {
            var code       = t.GetStringOrDefault("currencyCode") ?? "???";
            var amount     = t.GetDecimalOrDefault("amount");
            var balance    = t.GetDecimalOrDefault("balanceAfter");
            var type       = t.GetStringOrDefault("transactionType") ?? "other";
            var desc       = t.GetStringOrDefault("description") ?? "";
            var refId      = t.GetStringOrDefault("referenceId");
            var timestamp  = t.GetStringOrDefault("transactedAtUtc") ?? "";
            var sign       = amount >= 0 ? "+" : "";
            sb.AppendLine($"  [{timestamp}] {code} {sign}{amount:N2} → balance {balance:N2} ({type})");
            sb.AppendLine($"    {desc}{(refId != null ? $" (ref: {refId})" : "")}");
        }

        return sb.ToString();
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    public async Task<string> DepositAsync(
        string currencyCode, decimal amount, string description,
        string? referenceId = null, string transactionType = "sale")
    {
        var body = new
        {
            currencyCode    = currencyCode.Trim().ToUpperInvariant(),
            amount          = amount,
            description     = description,
            referenceId     = referenceId,
            transactionType = transactionType,
        };
        var resp = await _http.PostAsJsonAsync("api/bank/deposit", body, _json);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync();
            return $"Deposit failed ({resp.StatusCode}): {err}";
        }

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var code    = root.GetStringOrDefault("currencyCode") ?? currencyCode;
        var amt     = root.GetDecimalOrDefault("amount");
        var bal     = root.GetDecimalOrDefault("balanceAfter");
        var txnId   = root.GetStringOrDefault("transactionId") ?? "";
        return $"Deposit recorded. {code} +{amt:N2} → new balance {bal:N2}. Transaction ID: {txnId}";
    }

    // ── Withdrawal ────────────────────────────────────────────────────────────

    public async Task<string> WithdrawAsync(
        string currencyCode, decimal amount, string description,
        string? referenceId = null, string transactionType = "purchase")
    {
        var body = new
        {
            currencyCode    = currencyCode.Trim().ToUpperInvariant(),
            amount          = amount,
            description     = description,
            referenceId     = referenceId,
            transactionType = transactionType,
        };
        var resp = await _http.PostAsJsonAsync("api/bank/withdraw", body, _json);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync();
            return $"Withdrawal failed ({resp.StatusCode}): {err}";
        }

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var code    = root.GetStringOrDefault("currencyCode") ?? currencyCode;
        var amt     = root.GetDecimalOrDefault("amount");
        var bal     = root.GetDecimalOrDefault("balanceAfter");
        var txnId   = root.GetStringOrDefault("transactionId") ?? "";
        return $"Withdrawal recorded. {code} {amt:N2} → new balance {bal:N2}. Transaction ID: {txnId}";
    }

    // ── Currencies ────────────────────────────────────────────────────────────

    public async Task<string> GetCurrenciesAsync()
    {
        var resp = await _http.GetAsync("api/bank/currencies");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving currencies: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Supported Currencies");
        sb.AppendLine();
        if (root.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in root.EnumerateArray())
                sb.AppendLine($"  - {c.GetStringOrDefault("currencyCode")}: {c.GetStringOrDefault("name")}");
        }
        return sb.ToString();
    }

    // ── Financial summary ─────────────────────────────────────────────────────

    public async Task<string> GetFinancialSummaryAsync()
    {
        var resp = await _http.GetAsync("api/financials/summary");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving financial summary: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine("## Financial Summary — All Simulators");
        sb.AppendLine();

        if (root.TryGetProperty("procurement", out var proc))
        {
            sb.AppendLine("### Procurement");
            sb.AppendLine($"  Net spend: ${proc.GetDecimalOrDefault("netSpend"):N2}  (gross ${proc.GetDecimalOrDefault("totalSpend"):N2}, refunds ${proc.GetDecimalOrDefault("totalRefunds"):N2})");
            sb.AppendLine($"  Transactions: {proc.GetIntOrDefault("transactionCount")}");
        }

        if (root.TryGetProperty("manufacturing", out var mfg))
        {
            sb.AppendLine("### Manufacturing (WO overhead)");
            sb.AppendLine($"  Total cost: ${mfg.GetDecimalOrDefault("totalCost"):N2}");
            sb.AppendLine($"  Transactions: {mfg.GetIntOrDefault("transactionCount")}");
        }

        if (root.TryGetProperty("payroll", out var pay))
        {
            sb.AppendLine("### Payroll");
            sb.AppendLine($"  Total wages paid: ${pay.GetDecimalOrDefault("totalCost"):N2}");
            sb.AppendLine($"  Operations charged: {pay.GetIntOrDefault("transactionCount")}");
        }

        if (root.TryGetProperty("scrap", out var scrap))
        {
            sb.AppendLine("### Scrap Write-offs");
            sb.AppendLine($"  Total write-offs: ${scrap.GetDecimalOrDefault("totalWriteOffs"):N2}");
            sb.AppendLine($"  Events: {scrap.GetIntOrDefault("transactionCount")}");
        }

        if (root.TryGetProperty("totals", out var totals))
        {
            sb.AppendLine();
            sb.AppendLine($"**Total operating cost: ${totals.GetDecimalOrDefault("totalOperatingCost"):N2}**");
            sb.AppendLine($"**Total all spend: ${totals.GetDecimalOrDefault("totalAllSpend"):N2}**");
        }

        return sb.ToString();
    }

    public async Task<string> GetProcurementTransactionsAsync(int maxCount = 20)
    {
        var resp = await _http.GetAsync($"api/financials/procurement?maxCount={maxCount}");
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving procurement transactions: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        return FormatTransactionList(json, "## Procurement Transactions (PO Payments & Refunds)");
    }

    public async Task<string> GetManufacturingFinancialsAsync(string? type = null, int maxCount = 20)
    {
        var url = $"api/financials/manufacturing?maxCount={maxCount}";
        if (!string.IsNullOrEmpty(type)) url += $"&type={Uri.EscapeDataString(type)}";

        var resp = await _http.GetAsync(url);
        if (!resp.IsSuccessStatusCode)
            return $"Error retrieving manufacturing financials: {resp.StatusCode}";

        var json = await resp.Content.ReadAsStringAsync();
        var header = type switch
        {
            "payroll"     => "## Payroll Transactions",
            "scrap"       => "## Scrap Write-off Transactions",
            "completions" => "## Manufacturing WO Completion Costs",
            _             => "## Manufacturing Financial Transactions",
        };
        return FormatTransactionList(json, header);
    }

    private static string FormatTransactionList(string json, string header)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var sb = new StringBuilder();
        sb.AppendLine(header);
        sb.AppendLine();

        if (root.ValueKind != JsonValueKind.Array || root.GetArrayLength() == 0)
        {
            sb.AppendLine("No transactions found.");
            return sb.ToString();
        }

        foreach (var t in root.EnumerateArray())
        {
            var amount = t.GetDecimalOrDefault("amount");
            var sign   = amount >= 0 ? "+" : "";
            sb.AppendLine($"  {t.GetStringOrDefault("transactedAtUtc"):u}  {t.GetStringOrDefault("currencyCode")} {sign}{amount:N2}  [{t.GetStringOrDefault("transactionType")}]  {t.GetStringOrDefault("description")}");
            if (t.GetStringOrDefault("referenceId") is { } refId)
                sb.AppendLine($"    ref: {refId}");
        }
        return sb.ToString();
    }
}
