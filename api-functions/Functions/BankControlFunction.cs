using System.Net;
using System.Text.Json;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

/// <summary>
/// HTTP-triggered endpoints for the virtual bank simulator.
/// All routes are under /api/bank/*.
///
/// The bank maintains one virtual account per currency supported by the website.
/// The USD account is seeded on first use with the total historical profit from
/// Sales.usp_GetTotalProfit. Foreign-currency accounts start at zero.
/// All balances are persisted in Azure Table Storage (awBankAccounts /
/// awBankTransactions). Negative balances are permitted; no limits or charges apply.
/// </summary>
public class BankControlFunction
{
    private readonly BankService _bank;
    private readonly ILogger<BankControlFunction> _logger;

    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented        = true,
    };

    public BankControlFunction(BankService bank, ILogger<BankControlFunction> logger)
    {
        _bank   = bank;
        _logger = logger;
    }

    // ── Status ────────────────────────────────────────────────────────────────

    /// <summary>
    /// Returns all currency account balances plus a USD-equivalent total.
    /// </summary>
    [Function("BankGetStatus")]
    public async Task<HttpResponseData> GetStatus(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "bank/status")] HttpRequestData req)
    {
        await _bank.InitializeAsync();
        var accounts = await _bank.GetAllAccountsAsync();
        var totalUsd = await _bank.GetTotalUsdAsync(accounts);
        var result   = new
        {
            accounts      = accounts,
            totalUsd      = totalUsd,
            reportedAtUtc = DateTimeOffset.UtcNow,
        };
        return await OkAsync(req, result);
    }

    // ── Accounts ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Returns all currency accounts.
    /// </summary>
    [Function("BankGetAccounts")]
    public async Task<HttpResponseData> GetAccounts(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "bank/accounts")] HttpRequestData req)
    {
        await _bank.InitializeAsync();
        var accounts = await _bank.GetAllAccountsAsync();
        return await OkAsync(req, accounts);
    }

    /// <summary>
    /// Returns the account balance for a specific currency.
    /// </summary>
    [Function("BankGetAccount")]
    public async Task<HttpResponseData> GetAccount(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "bank/accounts/{currencyCode}")] HttpRequestData req,
        string currencyCode)
    {
        await _bank.InitializeAsync();
        var account = await _bank.GetAccountAsync(currencyCode);
        if (account == null)
            return await NotFoundAsync(req, $"No account found for currency '{currencyCode.ToUpperInvariant()}'.");
        return await OkAsync(req, account);
    }

    // ── Transactions ──────────────────────────────────────────────────────────

    /// <summary>
    /// Returns the most recent transactions across all currencies (default: last 50).
    /// Query param: ?maxCount=N (max 200).
    /// </summary>
    [Function("BankGetTransactions")]
    public async Task<HttpResponseData> GetTransactions(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "bank/transactions")] HttpRequestData req)
    {
        await _bank.InitializeAsync();
        var maxCount = ParseMaxCount(req.Query["maxCount"], 50);
        var txns     = await _bank.GetTransactionsAsync(null, maxCount);
        return await OkAsync(req, txns);
    }

    /// <summary>
    /// Returns recent transactions for a specific currency.
    /// Query param: ?maxCount=N (max 200).
    /// </summary>
    [Function("BankGetTransactionsByCurrency")]
    public async Task<HttpResponseData> GetTransactionsByCurrency(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "bank/transactions/{currencyCode}")] HttpRequestData req,
        string currencyCode)
    {
        await _bank.InitializeAsync();
        var maxCount = ParseMaxCount(req.Query["maxCount"], 50);
        var txns     = await _bank.GetTransactionsAsync(currencyCode, maxCount);
        return await OkAsync(req, txns);
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    /// <summary>
    /// Credits the specified amount to the named currency account.
    /// Body: { "currencyCode": "EUR", "amount": 1500.00, "description": "Sale #123", "referenceId": "SO-456", "transactionType": "sale" }
    /// </summary>
    [Function("BankDeposit")]
    public async Task<HttpResponseData> Deposit(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "bank/deposit")] HttpRequestData req)
    {
        await _bank.InitializeAsync();

        BankTransactionRequest? body;
        try
        {
            body = await JsonSerializer.DeserializeAsync<BankTransactionRequest>(
                req.Body, _json);
        }
        catch
        {
            return await BadRequestAsync(req, "Invalid JSON body.");
        }

        if (body == null || string.IsNullOrWhiteSpace(body.CurrencyCode))
            return await BadRequestAsync(req, "currencyCode is required.");
        if (body.Amount <= 0m)
            return await BadRequestAsync(req, "amount must be a positive number for deposits.");

        try
        {
            var txn = await _bank.PostTransactionAsync(body with { Amount = Math.Abs(body.Amount) });
            return await OkAsync(req, txn);
        }
        catch (InvalidOperationException ex)
        {
            return await BadRequestAsync(req, ex.Message);
        }
    }

    // ── Withdrawal ────────────────────────────────────────────────────────────

    /// <summary>
    /// Debits the specified amount from the named currency account. Negative balances are allowed.
    /// Body: { "currencyCode": "USD", "amount": 500.00, "description": "Vendor payment", "referenceId": "PO-789", "transactionType": "purchase" }
    /// </summary>
    [Function("BankWithdraw")]
    public async Task<HttpResponseData> Withdraw(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "bank/withdraw")] HttpRequestData req)
    {
        await _bank.InitializeAsync();

        BankTransactionRequest? body;
        try
        {
            body = await JsonSerializer.DeserializeAsync<BankTransactionRequest>(
                req.Body, _json);
        }
        catch
        {
            return await BadRequestAsync(req, "Invalid JSON body.");
        }

        if (body == null || string.IsNullOrWhiteSpace(body.CurrencyCode))
            return await BadRequestAsync(req, "currencyCode is required.");
        if (body.Amount <= 0m)
            return await BadRequestAsync(req, "amount must be a positive number for withdrawals (it will be debited).");

        try
        {
            // Store as negative amount (debit)
            var txn = await _bank.PostTransactionAsync(body with { Amount = -Math.Abs(body.Amount) });
            return await OkAsync(req, txn);
        }
        catch (InvalidOperationException ex)
        {
            return await BadRequestAsync(req, ex.Message);
        }
    }

    // ── Currencies ────────────────────────────────────────────────────────────

    /// <summary>
    /// Lists all currencies supported by the website (from Sales.Currency).
    /// </summary>
    [Function("BankGetCurrencies")]
    public async Task<HttpResponseData> GetCurrencies(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "bank/currencies")] HttpRequestData req)
    {
        await _bank.InitializeAsync();
        var currencies = await _bank.GetSupportedCurrenciesAsync();
        var result = currencies.Select(c => new { currencyCode = c.Code, name = c.Name });
        return await OkAsync(req, result);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static async Task<HttpResponseData> OkAsync(HttpRequestData req, object data)
    {
        var resp = req.CreateResponse(HttpStatusCode.OK);
        resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await resp.WriteStringAsync(JsonSerializer.Serialize(data, _json));
        return resp;
    }

    private static async Task<HttpResponseData> NotFoundAsync(HttpRequestData req, string message)
    {
        var resp = req.CreateResponse(HttpStatusCode.NotFound);
        resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await resp.WriteStringAsync(JsonSerializer.Serialize(new { error = message }, _json));
        return resp;
    }

    private static async Task<HttpResponseData> BadRequestAsync(HttpRequestData req, string message)
    {
        var resp = req.CreateResponse(HttpStatusCode.BadRequest);
        resp.Headers.Add("Content-Type", "application/json; charset=utf-8");
        await resp.WriteStringAsync(JsonSerializer.Serialize(new { error = message }, _json));
        return resp;
    }

    private static int ParseMaxCount(string? raw, int defaultVal)
    {
        if (int.TryParse(raw, out var n) && n > 0)
            return Math.Min(n, 200);
        return defaultVal;
    }
}
