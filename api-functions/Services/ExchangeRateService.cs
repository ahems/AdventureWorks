using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

// ── DTOs ─────────────────────────────────────────────────────────────────────

public record ExchangeRateResult(
    int Updated,
    int Skipped,
    string RateDate,
    DateTimeOffset RefreshedAt);

internal class FrankfurterResponse
{
    [JsonPropertyName("base")]
    public string Base { get; set; } = string.Empty;

    [JsonPropertyName("date")]
    public string Date { get; set; } = string.Empty;

    [JsonPropertyName("rates")]
    public Dictionary<string, decimal> Rates { get; set; } = new();
}

// ── Service ───────────────────────────────────────────────────────────────────

/// <summary>
/// Fetches the latest USD-based exchange rates from the Frankfurter API
/// (European Central Bank daily data, no API key required) and upserts them
/// into Sales.CurrencyRate for every currency present in Sales.Currency.
/// </summary>
public class ExchangeRateService
{
    private const string FrankfurterUrl = "https://api.frankfurter.app/latest?from=USD";

    private readonly string _connectionString;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<ExchangeRateService> _logger;

    public ExchangeRateService(
        string connectionString,
        IHttpClientFactory httpClientFactory,
        ILogger<ExchangeRateService> logger)
    {
        _connectionString   = connectionString;
        _httpClientFactory  = httpClientFactory;
        _logger             = logger;
    }

    /// <summary>
    /// Fetches rates from the Frankfurter API and upserts a row per currency
    /// into Sales.CurrencyRate for today's date. Currencies not present in
    /// Sales.Currency are silently skipped.
    /// </summary>
    public async Task<ExchangeRateResult> RefreshExchangeRatesAsync()
    {
        // 1. Call Frankfurter API
        var client = _httpClientFactory.CreateClient();
        FrankfurterResponse? apiResponse;
        try
        {
            apiResponse = await client.GetFromJsonAsync<FrankfurterResponse>(FrankfurterUrl);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch exchange rates from Frankfurter API");
            throw;
        }

        if (apiResponse == null || apiResponse.Rates.Count == 0)
            throw new InvalidOperationException("Frankfurter API returned no rates.");

        _logger.LogInformation(
            "Fetched {Count} rates for {Date} from Frankfurter API",
            apiResponse.Rates.Count, apiResponse.Date);

        // 2. Load supported currencies from the database
        HashSet<string> supportedCurrencies;
        await using (var conn = new SqlConnection(_connectionString))
        {
            await conn.OpenAsync();
            var codes = await conn.QueryAsync<string>(
                "SELECT RTRIM(CurrencyCode) FROM Sales.Currency");
            supportedCurrencies = codes.ToHashSet(StringComparer.OrdinalIgnoreCase);
        }

        // 3. Upsert a rate row per supported currency
        int updated = 0, skipped = 0;
        var rateDate = DateTime.Parse(apiResponse.Date).Date;

        await using (var conn = new SqlConnection(_connectionString))
        {
            await conn.OpenAsync();
            foreach (var (toCurrency, rate) in apiResponse.Rates)
            {
                if (!supportedCurrencies.Contains(toCurrency))
                {
                    skipped++;
                    continue;
                }

                // MERGE on (date, FromCurrencyCode, ToCurrencyCode) so re-running
                // the same day updates the existing row rather than inserting a duplicate.
                await conn.ExecuteAsync(@"
                    MERGE Sales.CurrencyRate AS target
                    USING (SELECT @rateDate AS d, @fromCode AS f, @toCode AS t) AS src
                    ON  CAST(target.CurrencyRateDate AS DATE) = src.d
                    AND RTRIM(target.FromCurrencyCode)        = src.f
                    AND RTRIM(target.ToCurrencyCode)          = src.t
                    WHEN MATCHED THEN
                        UPDATE SET
                            AverageRate  = @avg,
                            EndOfDayRate = @eod,
                            ModifiedDate = GETDATE()
                    WHEN NOT MATCHED THEN
                        INSERT (CurrencyRateDate, FromCurrencyCode, ToCurrencyCode,
                                AverageRate, EndOfDayRate, ModifiedDate)
                        VALUES (@rateDate, @fromCode, @toCode,
                                @avg, @eod, GETDATE());",
                    new
                    {
                        rateDate = rateDate,
                        fromCode = "USD",
                        toCode   = toCurrency,
                        avg      = rate,
                        eod      = rate,
                    });

                updated++;
            }
        }

        _logger.LogInformation(
            "Exchange rate refresh complete: {Updated} upserted, {Skipped} skipped for {Date}",
            updated, skipped, apiResponse.Date);

        return new ExchangeRateResult(updated, skipped, apiResponse.Date, DateTimeOffset.UtcNow);
    }
}
