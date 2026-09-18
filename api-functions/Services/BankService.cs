using System.Text.Json;
using Azure;
using Azure.Data.Tables;
using Azure.Identity;
using Dapper;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

// ── Data transfer types ──────────────────────────────────────────────────────

public record BankAccountBalance(
    string CurrencyCode,
    string CurrencyName,
    decimal Balance);

public record BankTransaction(
    string TransactionId,
    string CurrencyCode,
    decimal Amount,
    decimal BalanceAfter,
    string TransactionType,  // "initial" | "sale" | "purchase" | "payroll" | "deposit" | "withdrawal" | "other"
    string Description,
    string? ReferenceId,
    DateTimeOffset TransactedAtUtc);

public record BankStatusResponse(
    IReadOnlyList<BankAccountBalance> Accounts,
    decimal TotalUsd,
    DateTimeOffset ReportedAtUtc);

public record BankTransactionRequest(
    string CurrencyCode,
    decimal Amount,
    string Description,
    string? ReferenceId = null,
    string TransactionType = "other");

public record FinancialSummary(
    decimal TotalProcurementSpend,
    decimal TotalProcurementRefunds,
    decimal TotalManufacturingCost,
    decimal TotalPayroll,
    decimal TotalScrapWriteOffs,
    decimal TotalRevenue,
    int     ProcurementCount,
    int     ManufacturingCount,
    int     PayrollCount,
    int     ScrapCount,
    int     SalesCount,
    DateTimeOffset GeneratedAtUtc)
{
    public decimal TotalOperatingCost => TotalManufacturingCost + TotalPayroll + TotalScrapWriteOffs;
    public decimal NetProcurement     => TotalProcurementSpend - TotalProcurementRefunds;
}

// ── Table entity types ───────────────────────────────────────────────────────

internal class BankAccountEntity : ITableEntity
{
    public string PartitionKey { get; set; } = "accounts";
    public string RowKey { get; set; } = string.Empty;        // CurrencyCode
    public ETag ETag { get; set; } = ETag.All;
    public DateTimeOffset? Timestamp { get; set; }

    public double Balance { get; set; }       // double: Table Storage has no decimal type
    public string CurrencyName { get; set; } = string.Empty;
}

internal class BankTransactionEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty;  // CurrencyCode
    public string RowKey { get; set; } = string.Empty;        // reverse-tick~ + Guid
    public ETag ETag { get; set; } = ETag.All;
    public DateTimeOffset? Timestamp { get; set; }

    public double Amount { get; set; }        // double: Table Storage has no decimal type
    public double BalanceAfter { get; set; }  // double: Table Storage has no decimal type
    public string TransactionType { get; set; } = "other";
    public string Description { get; set; } = string.Empty;
    public string? ReferenceId { get; set; }
    public DateTimeOffset TransactedAtUtc { get; set; }
}

// ── Service ──────────────────────────────────────────────────────────────────

public class BankService
{
    private const string ACCOUNTS_TABLE      = "awBankAccounts";
    private const string TRANSACTIONS_TABLE  = "awBankTransactions";
    private const string ACCOUNTS_PARTITION  = "accounts";
    private const string USD_CODE            = "USD";

    private readonly string _connectionString;
    private readonly TableClient _accountsTable;
    private readonly TableClient _transactionsTable;
    private readonly ILogger<BankService> _logger;
    private readonly TelemetryClient _telemetry;

    // Initialization guard – ensures tables and seed run only once per process lifetime
    private int _initialized = 0;
    private readonly SemaphoreSlim _initLock = new(1, 1);

    private readonly WebPubSubService? _webPubSub;

    public BankService(
        string connectionString,
        string tableServiceUri,
        ILogger<BankService> logger,
        TelemetryClient telemetry,
        WebPubSubService? webPubSub = null)
    {
        _connectionString = connectionString;
        _logger           = logger;
        _telemetry        = telemetry;
        _webPubSub        = webPubSub;

        var svc = new TableServiceClient(new Uri(tableServiceUri), new DefaultAzureCredential());
        _accountsTable      = svc.GetTableClient(ACCOUNTS_TABLE);
        _transactionsTable  = svc.GetTableClient(TRANSACTIONS_TABLE);
    }

    // ── Initialization ───────────────────────────────────────────────────────

    /// <summary>
    /// Idempotently creates tables and seeds the USD account if not already initialised.
    /// Safe to call on every request.
    /// </summary>
    public async Task InitializeAsync()
    {
        if (Interlocked.CompareExchange(ref _initialized, 1, 0) == 1) return;

        await _initLock.WaitAsync();
        try
        {
            if (_initialized == 2) return; // already seeded

            // Only seed if the USD account does not yet exist
            try
            {
                await _accountsTable.GetEntityAsync<BankAccountEntity>(ACCOUNTS_PARTITION, USD_CODE);
                _logger.LogInformation("[Bank] USD account already exists — skipping seed.");
            }
            catch (RequestFailedException ex) when (ex.Status == 404)
            {
                await SeedInitialBalancesAsync();
            }

            _initialized = 2;
        }
        finally
        {
            _initLock.Release();
        }
    }

    private async Task SeedInitialBalancesAsync()
    {
        _logger.LogInformation("[Bank] Seeding initial bank balances from Sales.usp_GetTotalProfit…");

        decimal totalProfit;
        List<(string Code, string Name)> currencies;

        await using (var conn = new SqlConnection(_connectionString))
        {
            await conn.OpenAsync();

            // Get total historical profit as USD seed balance.
            // Use ExecuteScalar to avoid any Dapper type-mapping edge cases with money columns.
            using var profitCmd = conn.CreateCommand();
            profitCmd.CommandText = @"
                SELECT ISNULL(
                    SUM(sod.LineTotal - p.StandardCost * sod.OrderQty),
                    0)
                FROM Sales.SalesOrderDetail       AS sod
                INNER JOIN Sales.SalesOrderHeader AS soh ON sod.SalesOrderID = soh.SalesOrderID
                INNER JOIN Production.Product     AS p   ON sod.ProductID    = p.ProductID
                WHERE soh.Status NOT IN (4, 6)
                  AND p.FinishedGoodsFlag = 1";

            var rawResult = await profitCmd.ExecuteScalarAsync();
            totalProfit = rawResult == null || rawResult == DBNull.Value
                ? 0m
                : Convert.ToDecimal(rawResult);

            _logger.LogInformation("[Bank] Seed query result type={T} value={V}", rawResult?.GetType().Name ?? "null", totalProfit);

            // Verify row count for diagnostics
            using var countCmd = conn.CreateCommand();
            countCmd.CommandText = @"
                SELECT COUNT(*)
                FROM Sales.SalesOrderDetail       AS sod
                INNER JOIN Sales.SalesOrderHeader AS soh ON sod.SalesOrderID = soh.SalesOrderID
                INNER JOIN Production.Product     AS p   ON sod.ProductID    = p.ProductID
                WHERE soh.Status NOT IN (4, 6)
                  AND p.FinishedGoodsFlag = 1";
            var rowCount = (int)(await countCmd.ExecuteScalarAsync() ?? 0);
            _logger.LogInformation("[Bank] Matching SalesOrderDetail rows: {Count}", rowCount);

            // Get all currencies tracked by the website
            currencies = (await conn.QueryAsync<(string Code, string Name)>(
                "SELECT RTRIM(CurrencyCode) AS Code, Name FROM Sales.Currency ORDER BY CurrencyCode"))
                .ToList();
        }

        _logger.LogInformation("[Bank] Seeding USD account with TotalProfit = {TotalProfit:N2}", totalProfit);

        // Create USD account with seed balance
        var usdEntity = new BankAccountEntity
        {
            PartitionKey = ACCOUNTS_PARTITION,
            RowKey       = USD_CODE,
            Balance      = (double)totalProfit,
            CurrencyName = "US Dollar",
        };
        await _accountsTable.UpsertEntityAsync(usdEntity);

        // Log the opening transaction
        await AppendTransactionAsync(USD_CODE, totalProfit, totalProfit,
            "initial", "Opening balance seeded from Sales.usp_GetTotalProfit total profit", null);

        // Create zero-balance accounts for every other currency
        foreach (var (code, name) in currencies.Where(c => c.Code != USD_CODE))
        {
            var entity = new BankAccountEntity
            {
                PartitionKey = ACCOUNTS_PARTITION,
                RowKey       = code,
                Balance      = 0.0,
                CurrencyName = name,
            };
            await _accountsTable.UpsertEntityAsync(entity);
        }

        _logger.LogInformation("[Bank] Created {Count} currency accounts.", currencies.Count + 1);

        // Telemetry
        _telemetry.TrackEvent("BankSeeded", new Dictionary<string, string>
        {
            { "currencyCount", (currencies.Count + 1).ToString() },
            { "usdSeedAmount", totalProfit.ToString("N2") }
        });
    }

    // ── Accounts ─────────────────────────────────────────────────────────────

    public async Task<IReadOnlyList<BankAccountBalance>> GetAllAccountsAsync()
    {
        var results = new List<BankAccountBalance>();
        await foreach (var entity in _accountsTable.QueryAsync<BankAccountEntity>(
            e => e.PartitionKey == ACCOUNTS_PARTITION))
        {
            results.Add(new BankAccountBalance(entity.RowKey, entity.CurrencyName, (decimal)entity.Balance));
        }
        return results.OrderBy(a => a.CurrencyCode).ToList();
    }

    public async Task<BankAccountBalance?> GetAccountAsync(string currencyCode)
    {
        currencyCode = currencyCode.Trim().ToUpperInvariant();
        try
        {
            var entity = await _accountsTable.GetEntityAsync<BankAccountEntity>(ACCOUNTS_PARTITION, currencyCode);
            return new BankAccountBalance(entity.Value.RowKey, entity.Value.CurrencyName, (decimal)entity.Value.Balance);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }

    /// <summary>
    /// Gets the total balance across all accounts converted to USD using the latest exchange rates.
    /// CurrencyRate: FromCurrencyCode=USD → ToCurrencyCode=foreign, AverageRate = units of foreign per 1 USD.
    /// To convert foreign → USD: foreignAmount / AverageRate
    /// </summary>
    public async Task<decimal> GetTotalUsdAsync(IReadOnlyList<BankAccountBalance> accounts)
    {
        // Get latest exchange rates for all non-USD currencies
        var foreignCodes = accounts
            .Where(a => a.CurrencyCode != USD_CODE && a.Balance != 0m)
            .Select(a => a.CurrencyCode)
            .ToList();

        var rates = new Dictionary<string, decimal>(StringComparer.OrdinalIgnoreCase);

        if (foreignCodes.Any())
        {
            await using var conn = new SqlConnection(_connectionString);
            await conn.OpenAsync();

            // Latest rate for each foreign currency (most recent CurrencyRateDate)
            var rows = await conn.QueryAsync(@"
                SELECT RTRIM(cr.ToCurrencyCode) AS CurrencyCode,
                       cr.AverageRate
                FROM Sales.CurrencyRate cr
                INNER JOIN (
                    SELECT ToCurrencyCode, MAX(CurrencyRateDate) AS LatestDate
                    FROM Sales.CurrencyRate
                    WHERE RTRIM(FromCurrencyCode) = 'USD'
                    GROUP BY ToCurrencyCode
                ) latest ON cr.ToCurrencyCode = latest.ToCurrencyCode
                         AND cr.CurrencyRateDate = latest.LatestDate
                WHERE RTRIM(cr.FromCurrencyCode) = 'USD'");

            foreach (var row in rows)
            {
                string code = ((string)row.CurrencyCode).Trim();
                rates[code] = (decimal)(double)row.AverageRate;
            }
        }

        decimal total = 0m;
        foreach (var account in accounts)
        {
            if (account.CurrencyCode == USD_CODE)
            {
                total += account.Balance;
            }
            else if (rates.TryGetValue(account.CurrencyCode, out var rate) && rate != 0m)
            {
                // AverageRate = foreign units per 1 USD  →  USD = foreign / rate
                total += account.Balance / rate;
            }
            else
            {
                // No exchange rate available — include at face value (treat as USD equivalent)
                _logger.LogWarning("[Bank] No exchange rate found for {Code} — including at face value.", account.CurrencyCode);
                total += account.Balance;
            }
        }

        return Math.Round(total, 2);
    }

    // ── Transactions ─────────────────────────────────────────────────────────

    /// <summary>
    /// Credits (positive amount) or debits (negative amount) the named currency account, recording a transaction.
    /// Negative balances are permitted. Thread-safe via optimistic concurrency (ETag retry loop).
    /// </summary>
    public async Task<BankTransaction> PostTransactionAsync(BankTransactionRequest request)
    {
        var code = request.CurrencyCode.Trim().ToUpperInvariant();
        if (request.Amount == 0m)
            throw new ArgumentException("Transaction amount must be non-zero.", nameof(request));

        // Ensure the currency account exists (auto-create for supported currencies)
        await EnsureCurrencyAccountAsync(code);

        // Retry loop for optimistic concurrency
        const int maxRetries = 10;
        for (int attempt = 0; attempt < maxRetries; attempt++)
        {
            try
            {
                BankAccountEntity entity;
                try
                {
                    var resp = await _accountsTable.GetEntityAsync<BankAccountEntity>(ACCOUNTS_PARTITION, code);
                    entity = resp.Value;
                }
                catch (RequestFailedException ex) when (ex.Status == 404)
                {
                    throw new InvalidOperationException($"Currency account '{code}' does not exist.");
                }

                var newBalance = (decimal)entity.Balance + request.Amount;
                entity.Balance = (double)newBalance;

                await _accountsTable.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);

                // Record the transaction
                var txn = await AppendTransactionAsync(
                    code, request.Amount, newBalance,
                    request.TransactionType, request.Description, request.ReferenceId);

                _telemetry.TrackEvent("BankTransaction", new Dictionary<string, string>
                {
                    { "currency", code },
                    { "type", request.TransactionType },
                    { "amount", request.Amount.ToString("N4") },
                    { "balanceAfter", newBalance.ToString("N4") }
                });

                // Push real-time finance event to connected browser clients
                if (_webPubSub != null)
                {
                    _ = _webPubSub.SendToGroupAsync("finance", new
                    {
                        @event = "transaction",
                        currencyCode = code,
                        amount = request.Amount,
                        transactionType = request.TransactionType,
                        referenceId = request.ReferenceId,
                    });
                }

                return txn;
            }
            catch (RequestFailedException ex) when (ex.Status == 412) // Precondition Failed (ETag conflict)
            {
                if (attempt == maxRetries - 1) throw;
                await Task.Delay(50 * (attempt + 1));
            }
        }

        throw new InvalidOperationException("Failed to update bank account after maximum retries.");
    }

    private async Task<BankTransaction> AppendTransactionAsync(
        string currencyCode, decimal amount, decimal balanceAfter,
        string type, string description, string? referenceId)
    {
        var now    = DateTimeOffset.UtcNow;
        // Reverse-chronological row key: later entries sort first in Table Storage
        var rowKey = $"{long.MaxValue - now.UtcTicks:D20}~{Guid.NewGuid():N}";

        var entity = new BankTransactionEntity
        {
            PartitionKey    = currencyCode,
            RowKey          = rowKey,
            Amount          = (double)amount,
            BalanceAfter    = (double)balanceAfter,
            TransactionType = type,
            Description     = description,
            ReferenceId     = referenceId,
            TransactedAtUtc = now,
        };

        await _transactionsTable.AddEntityAsync(entity);

        return new BankTransaction(
            TransactionId:   rowKey,
            CurrencyCode:    currencyCode,
            Amount:          amount,
            BalanceAfter:    balanceAfter,
            TransactionType: type,
            Description:     description,
            ReferenceId:     referenceId,
            TransactedAtUtc: now);
    }

    public async Task<IReadOnlyList<BankTransaction>> GetTransactionsAsync(
        string? currencyCode = null, int maxCount = 50)
    {
        var results = new List<BankTransaction>();

        if (currencyCode != null)
        {
            var code = currencyCode.Trim().ToUpperInvariant();
            await foreach (var entity in _transactionsTable.QueryAsync<BankTransactionEntity>(
                e => e.PartitionKey == code,
                maxPerPage: Math.Min(maxCount, 1000)))
            {
                results.Add(ToTransaction(entity));
                if (results.Count >= maxCount) break;
            }
        }
        else
        {
            // Scan all partitions — less efficient but useful for a summary
            await foreach (var entity in _transactionsTable.QueryAsync<BankTransactionEntity>(
                maxPerPage: Math.Min(maxCount, 1000)))
            {
                results.Add(ToTransaction(entity));
                if (results.Count >= maxCount) break;
            }
            // Sort by descending time and cap
            results = results
                .OrderByDescending(t => t.TransactedAtUtc)
                .Take(maxCount)
                .ToList();
        }

        return results;
    }

    // ── Currencies from database ─────────────────────────────────────────────

    public async Task<IReadOnlyList<(string Code, string Name)>> GetSupportedCurrenciesAsync()
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();
        var rows = await conn.QueryAsync<(string Code, string Name)>(
            "SELECT RTRIM(CurrencyCode) AS Code, Name FROM Sales.Currency ORDER BY CurrencyCode");
        return rows.ToList();
    }

    // ── Financial reporting helpers ───────────────────────────────────────────

    /// <summary>
    /// Returns all transactions (up to maxCount) optionally filtered by reference prefix.
    /// Used by the financial reporting endpoints to bucket spending by simulator.
    /// </summary>
    public async Task<IReadOnlyList<BankTransaction>> GetTransactionsByPrefixAsync(
        string? referencePrefix, int maxCount = 500)
    {
        var all = await GetTransactionsAsync(currencyCode: null, maxCount: maxCount);
        if (string.IsNullOrEmpty(referencePrefix))
            return all;

        return all
            .Where(t => t.ReferenceId?.StartsWith(referencePrefix, StringComparison.OrdinalIgnoreCase) == true)
            .ToList();
    }

    /// <summary>
    /// Aggregates bank transactions into a simulator-level financial summary.
    /// </summary>
    public async Task<FinancialSummary> GetFinancialSummaryAsync(int maxTransactions = 1000)
    {
        var all = await GetTransactionsAsync(currencyCode: null, maxCount: maxTransactions);

        var procurementTxns    = all.Where(t => t.ReferenceId?.StartsWith("PO-",     StringComparison.OrdinalIgnoreCase) == true && !t.ReferenceId.EndsWith("-refund", StringComparison.OrdinalIgnoreCase)).ToList();
        var procurementRefunds = all.Where(t => t.ReferenceId?.EndsWith("-refund",   StringComparison.OrdinalIgnoreCase) == true).ToList();
        var manufacturingTxns  = all.Where(t => t.ReferenceId?.StartsWith("WO-",     StringComparison.OrdinalIgnoreCase) == true && t.TransactionType == "purchase").ToList();
        var payrollTxns        = all.Where(t => t.TransactionType == "payroll").ToList();
        var scrapTxns          = all.Where(t => t.ReferenceId?.StartsWith("SCRAP-",  StringComparison.OrdinalIgnoreCase) == true).ToList();
        var saleTxns           = all.Where(t => t.TransactionType == "sale" || (t.ReferenceId?.StartsWith("SO-", StringComparison.OrdinalIgnoreCase) == true && t.Amount > 0)).ToList();

        return new FinancialSummary(
            TotalProcurementSpend:  Math.Abs(procurementTxns.Sum(t => t.Amount)),
            TotalProcurementRefunds: procurementRefunds.Sum(t => t.Amount),
            TotalManufacturingCost: Math.Abs(manufacturingTxns.Sum(t => t.Amount)),
            TotalPayroll:           Math.Abs(payrollTxns.Sum(t => t.Amount)),
            TotalScrapWriteOffs:    Math.Abs(scrapTxns.Sum(t => t.Amount)),
            TotalRevenue:           saleTxns.Sum(t => t.Amount),
            ProcurementCount:       procurementTxns.Count,
            ManufacturingCount:     manufacturingTxns.Count,
            PayrollCount:           payrollTxns.Count,
            ScrapCount:             scrapTxns.Count,
            SalesCount:             saleTxns.Count,
            GeneratedAtUtc:         DateTimeOffset.UtcNow);
    }

    // ── Reset / Re-seed ──────────────────────────────────────────────────────
    /// <summary>Drops and re-seeds the bank. Use with care — all history is lost.</summary>
    public async Task ResetAsync()
    {
        _logger.LogWarning("[Bank] RESET requested — deleting all bank table rows.");

        // Delete all account rows
        await foreach (var entity in _accountsTable.QueryAsync<BankAccountEntity>())
            await _accountsTable.DeleteEntityAsync(entity.PartitionKey, entity.RowKey);

        // Delete all transaction rows
        await foreach (var entity in _transactionsTable.QueryAsync<BankTransactionEntity>())
            await _transactionsTable.DeleteEntityAsync(entity.PartitionKey, entity.RowKey);

        // Re-seed
        Interlocked.Exchange(ref _initialized, 0);
        await InitializeAsync();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private async Task EnsureCurrencyAccountAsync(string code)
    {
        try
        {
            await _accountsTable.GetEntityAsync<BankAccountEntity>(ACCOUNTS_PARTITION, code);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            // Auto-create accounts for currencies supported by the website
            var supported = await GetSupportedCurrenciesAsync();
            var match = supported.FirstOrDefault(c => c.Code == code);
            if (match == default)
                throw new InvalidOperationException($"Currency '{code}' is not supported. Only currencies listed in Sales.Currency are allowed.");

            var entity = new BankAccountEntity
            {
                PartitionKey = ACCOUNTS_PARTITION,
                RowKey       = code,
                Balance      = 0.0,
                CurrencyName = match.Name,
            };
            try
            {
                await _accountsTable.AddEntityAsync(entity);
            }
            catch (RequestFailedException addEx) when (addEx.Status == 409)
            {
                // Race condition — another request created it first, that's fine
            }
        }
    }

    private static BankTransaction ToTransaction(BankTransactionEntity e) =>
        new BankTransaction(
            TransactionId:   e.RowKey,
            CurrencyCode:    e.PartitionKey,
            Amount:          (decimal)e.Amount,
            BalanceAfter:    (decimal)e.BalanceAfter,
            TransactionType: e.TransactionType,
            Description:     e.Description,
            ReferenceId:     e.ReferenceId,
            TransactedAtUtc: e.TransactedAtUtc);
}
