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

    // ── Reset ─────────────────────────────────────────────────────────────────

    public async Task<string> ResetBankAsync()
    {
        var resp = await _http.PostAsync("api/bank/reset", null);
        if (!resp.IsSuccessStatusCode)
            return $"Bank reset failed ({resp.StatusCode}).";

        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var msg = root.GetStringOrDefault("message") ?? "Bank reset complete.";
        var total = root.GetDecimalOrDefault("totalUsd");
        return $"{msg} New USD total balance: ${total:N2}";
    }
}
