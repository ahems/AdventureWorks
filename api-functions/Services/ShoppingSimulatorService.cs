using Azure;
using Azure.Data.Tables;
using Azure.Storage.Queues;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;
using api_functions.Models;

namespace api_functions.Services;

/// <summary>
/// Manages Shopping Simulator state in Azure Table Storage and provides helpers for the
/// simulation-order-queue depth and a cached list of top customer IDs for existing-customer
/// order messages.
/// </summary>
public class ShoppingSimulatorService
{
    private const string TABLE_NAME = "shoppingSimulator";
    private const string QUEUE_NAME = "simulation-order-queue";
    private const string PARTITION_KEY = "shopping";
    private const string ROW_KEY = "state";

    // Top-spender cache — shared across DI scopes via static fields.
    private static readonly SemaphoreSlim _cacheLock = new(1, 1);
    private static int[]? _topSpenderCache;
    private static DateTimeOffset _cacheExpiry = DateTimeOffset.MinValue;
    private const int CACHE_TTL_MINUTES = 10;

    // No-order customer cache
    private static readonly SemaphoreSlim _noOrderCacheLock = new(1, 1);
    private static int[]? _noOrderCustomerCache;
    private static DateTimeOffset _noOrderCacheExpiry = DateTimeOffset.MinValue;

    // Abandoned-cart customer cache
    private static readonly SemaphoreSlim _abandonedCartCacheLock = new(1, 1);
    private static int[]? _abandonedCartCustomerCache;
    private static DateTimeOffset _abandonedCartCacheExpiry = DateTimeOffset.MinValue;

    // Store ID cache
    private static readonly SemaphoreSlim _storeCacheLock = new(1, 1);
    private static int[]? _storeIdCache;
    private static DateTimeOffset _storeCacheExpiry = DateTimeOffset.MinValue;

    private readonly TableClient _tableClient;
    private readonly QueueClient _queueClient;
    private readonly string _connectionString;
    private readonly ILogger<ShoppingSimulatorService> _logger;

    public ShoppingSimulatorService(
        string connectionString,
        string tableServiceUri,
        string queueServiceUri,
        ILogger<ShoppingSimulatorService> logger)
    {
        _connectionString = connectionString;
        _logger = logger;

        var credential = new Azure.Identity.DefaultAzureCredential();

        var tableService = new TableServiceClient(new Uri(tableServiceUri), credential);
        _tableClient = tableService.GetTableClient(TABLE_NAME);

        var queueService = new QueueServiceClient(
            new Uri(queueServiceUri),
            credential,
            new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 });
        _queueClient = queueService.GetQueueClient(QUEUE_NAME);
    }

    // ── State CRUD ───────────────────────────────────────────────────────────

    /// <summary>
    /// Returns current simulator state. Returns a default (stopped) state if no row has
    /// been persisted yet.
    /// </summary>
    public async Task<ShoppingSimulatorState> GetStateAsync()
    {
        try
        {
            await _tableClient.CreateIfNotExistsAsync();
            var response = await _tableClient.GetEntityAsync<ShoppingSimulatorState>(PARTITION_KEY, ROW_KEY);
            return response.Value;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return new ShoppingSimulatorState();
        }
    }

    /// <summary>Persists simulator state to Table Storage (upsert / replace).</summary>
    public async Task SaveStateAsync(ShoppingSimulatorState state)
    {
        await _tableClient.CreateIfNotExistsAsync();
        await _tableClient.UpsertEntityAsync(state, TableUpdateMode.Replace);
    }

    // ── Queue helpers ────────────────────────────────────────────────────────

    /// <summary>Returns the approximate message count in the simulation-order-queue.</summary>
    public async Task<long> GetQueueDepthAsync()
    {
        try
        {
            var props = await _queueClient.GetPropertiesAsync();
            return props.Value.ApproximateMessagesCount;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ShoppingSimulator] Could not read queue depth for {Queue}", QUEUE_NAME);
            return -1;
        }
    }

    /// <summary>Returns the underlying queue client for message enqueue operations.</summary>
    public Task<QueueClient> GetQueueClientAsync()
    {
        return Task.FromResult(_queueClient);
    }

    /// <summary>Clears all pending messages from the simulation-order-queue.</summary>
    public async Task ClearQueueAsync()
    {
        await _queueClient.ClearMessagesAsync();
    }

    // ── Counter increment ────────────────────────────────────────────────────

    /// <summary>
    /// Increments the persona breakdown counters (read-modify-write).
    /// Non-critical stats — failures are logged and swallowed.
    /// </summary>
    public async Task IncrementCountersAsync(long newCustomerCount, long existingCustomerCount, long storeOrderCount = 0)
    {
        try
        {
            var state = await GetStateAsync();
            state.TotalQueued += newCustomerCount + existingCustomerCount + storeOrderCount;
            state.NewCustomerQueued += newCustomerCount;
            state.ExistingCustomerQueued += existingCustomerCount;
            state.StoreOrderQueued += storeOrderCount;
            await SaveStateAsync(state);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ShoppingSimulator] Failed to increment counters — stats may be slightly stale");
        }
    }

    /// <summary>
    /// Resets all queued counters to zero and clears StartedAt.
    /// Called by the global simulators reset endpoint.
    /// </summary>
    public async Task ResetStateAsync()
    {
        var state = await GetStateAsync();
        state.IsRunning = false;
        state.TotalQueued = 0;
        state.NewCustomerQueued = 0;
        state.ExistingCustomerQueued = 0;
        state.StartedAt = null;
        await SaveStateAsync(state);
        await ClearQueueAsync();
    }

    // ── Results log ─────────────────────────────────────────────────────────

    /// <summary>Persists a completed order result so the frontend can display it.</summary>
    public async Task SaveResultAsync(SimulationOrderResultEntity entity)
    {
        try
        {
            await _tableClient.CreateIfNotExistsAsync();
            await _tableClient.UpsertEntityAsync(entity, TableUpdateMode.Replace);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ShoppingSimulator] Failed to persist order result — non-critical");
        }
    }

    /// <summary>Returns the most recent simulation order results (up to <paramref name="limit"/>).</summary>
    public async Task<List<SimulationOrderResultEntity>> GetRecentResultsAsync(int limit = 50)
    {
        var results = new List<SimulationOrderResultEntity>();
        try
        {
            await _tableClient.CreateIfNotExistsAsync();
            var query = _tableClient.QueryAsync<SimulationOrderResultEntity>(
                filter: $"PartitionKey eq 'results'",
                maxPerPage: limit);

            await foreach (var page in query.AsPages(pageSizeHint: limit))
            {
                results.AddRange(page.Values);
                if (results.Count >= limit) break;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ShoppingSimulator] Failed to query recent results");
        }
        return results.Take(limit).ToList();
    }

    /// <summary>Deletes all result entities from the table (used on reset).</summary>
    public async Task ClearResultsAsync()
    {
        try
        {
            await _tableClient.CreateIfNotExistsAsync();
            var entities = new List<SimulationOrderResultEntity>();
            await foreach (var entity in _tableClient.QueryAsync<SimulationOrderResultEntity>(
                filter: $"PartitionKey eq 'results'"))
            {
                entities.Add(entity);
            }
            foreach (var entity in entities)
            {
                await _tableClient.DeleteEntityAsync(entity.PartitionKey, entity.RowKey);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ShoppingSimulator] Failed to clear results — non-critical");
        }
    }

    // ── Top spender cache ────────────────────────────────────────────────────

    /// <summary>
    /// Returns up to 50 customer IDs of high-value repeat buyers, cached for
    /// <see cref="CACHE_TTL_MINUTES"/> minutes to avoid per-tick database round-trips.
    /// Returns an empty array if no qualifying customers are found.
    /// </summary>
    public async Task<int[]> GetCachedTopSpenderIdsAsync()
    {
        if (_topSpenderCache != null && DateTimeOffset.UtcNow < _cacheExpiry)
            return _topSpenderCache;

        await _cacheLock.WaitAsync();
        try
        {
            // Double-check inside the lock
            if (_topSpenderCache != null && DateTimeOffset.UtcNow < _cacheExpiry)
                return _topSpenderCache;

            const string sql = @"
                SELECT TOP 50 c.CustomerID
                FROM Sales.Customer c
                JOIN (
                    SELECT CustomerID, SUM(TotalDue) AS TotalSpend
                    FROM Sales.SalesOrderHeader
                    WHERE Status = 5 AND OnlineOrderFlag = 1
                    GROUP BY CustomerID
                    HAVING COUNT(*) >= 2
                ) s ON c.CustomerID = s.CustomerID
                ORDER BY s.TotalSpend DESC";

            await using var conn = new SqlConnection(_connectionString);
            var ids = (await conn.QueryAsync<int>(sql)).ToArray();
            _topSpenderCache = ids.Length > 0 ? ids : Array.Empty<int>();
            _cacheExpiry = DateTimeOffset.UtcNow.AddMinutes(CACHE_TTL_MINUTES);

            _logger.LogInformation("[ShoppingSimulator] Top-spender cache refreshed — {Count} customers cached", _topSpenderCache.Length);
            return _topSpenderCache;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ShoppingSimulator] Failed to refresh top-spender cache — existing customer messages will use new-customer path");
            _topSpenderCache ??= Array.Empty<int>();
            _cacheExpiry = DateTimeOffset.UtcNow.AddMinutes(1); // Short retry window on error
            return _topSpenderCache;
        }
        finally
        {
            _cacheLock.Release();
        }
    }

    // ── No-order customer cache ──────────────────────────────────────────────

    /// <summary>
    /// Returns customer IDs of registered individual customers who have zero orders.
    /// These represent browsing users who registered but never purchased — ideal targets
    /// for marketing re-engagement simulation. Cached for 10 minutes.
    /// </summary>
    public async Task<int[]> GetCachedNoOrderCustomerIdsAsync()
    {
        if (_noOrderCustomerCache != null && DateTimeOffset.UtcNow < _noOrderCacheExpiry)
            return _noOrderCustomerCache;

        await _noOrderCacheLock.WaitAsync();
        try
        {
            if (_noOrderCustomerCache != null && DateTimeOffset.UtcNow < _noOrderCacheExpiry)
                return _noOrderCustomerCache;

            const string sql = @"
                SELECT TOP 100 c.CustomerID
                FROM Sales.Customer c
                INNER JOIN Person.Person p ON c.PersonID = p.BusinessEntityID
                WHERE c.StoreID IS NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM Sales.SalesOrderHeader soh
                      WHERE soh.CustomerID = c.CustomerID
                  )
                ORDER BY NEWID()";

            await using var conn = new SqlConnection(_connectionString);
            var ids = (await conn.QueryAsync<int>(sql)).ToArray();
            _noOrderCustomerCache = ids.Length > 0 ? ids : Array.Empty<int>();
            _noOrderCacheExpiry = DateTimeOffset.UtcNow.AddMinutes(CACHE_TTL_MINUTES);

            _logger.LogInformation("[ShoppingSimulator] No-order customer cache refreshed — {Count} customers cached", _noOrderCustomerCache.Length);
            return _noOrderCustomerCache;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ShoppingSimulator] Failed to refresh no-order customer cache");
            _noOrderCustomerCache ??= Array.Empty<int>();
            _noOrderCacheExpiry = DateTimeOffset.UtcNow.AddMinutes(1);
            return _noOrderCustomerCache;
        }
        finally
        {
            _noOrderCacheLock.Release();
        }
    }

    // ── Abandoned-cart customer cache ────────────────────────────────────────

    /// <summary>
    /// Returns customer IDs who have items in their shopping cart that are older than 24 hours.
    /// These simulate cart abandoners who may return after a Smart Cart Recovery email.
    /// Cached for 10 minutes.
    /// </summary>
    public async Task<int[]> GetCachedAbandonedCartCustomerIdsAsync()
    {
        if (_abandonedCartCustomerCache != null && DateTimeOffset.UtcNow < _abandonedCartCacheExpiry)
            return _abandonedCartCustomerCache;

        await _abandonedCartCacheLock.WaitAsync();
        try
        {
            if (_abandonedCartCustomerCache != null && DateTimeOffset.UtcNow < _abandonedCartCacheExpiry)
                return _abandonedCartCustomerCache;

            const string sql = @"
                SELECT DISTINCT c.CustomerID
                FROM Sales.ShoppingCartItem sci
                INNER JOIN Sales.Customer c ON c.PersonID = CAST(sci.ShoppingCartID AS INT)
                WHERE sci.DateCreated < DATEADD(HOUR, -24, GETDATE())
                  AND c.StoreID IS NULL";

            await using var conn = new SqlConnection(_connectionString);
            var ids = (await conn.QueryAsync<int>(sql)).ToArray();
            _abandonedCartCustomerCache = ids.Length > 0 ? ids : Array.Empty<int>();
            _abandonedCartCacheExpiry = DateTimeOffset.UtcNow.AddMinutes(CACHE_TTL_MINUTES);

            _logger.LogInformation("[ShoppingSimulator] Abandoned-cart customer cache refreshed — {Count} customers cached", _abandonedCartCustomerCache.Length);
            return _abandonedCartCustomerCache;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ShoppingSimulator] Failed to refresh abandoned-cart customer cache");
            _abandonedCartCustomerCache ??= Array.Empty<int>();
            _abandonedCartCacheExpiry = DateTimeOffset.UtcNow.AddMinutes(1);
            return _abandonedCartCustomerCache;
        }
        finally
        {
            _abandonedCartCacheLock.Release();
        }
    }

    // ── Store ID cache ───────────────────────────────────────────────────────

    /// <summary>
    /// Returns BusinessEntityIDs of all B2B stores that have at least one linked Sales.Customer record.
    /// Cached for 10 minutes.
    /// </summary>
    public async Task<int[]> GetCachedStoreIdsAsync()
    {
        if (_storeIdCache != null && DateTimeOffset.UtcNow < _storeCacheExpiry)
            return _storeIdCache;

        await _storeCacheLock.WaitAsync();
        try
        {
            if (_storeIdCache != null && DateTimeOffset.UtcNow < _storeCacheExpiry)
                return _storeIdCache;

            const string sql = @"
                SELECT DISTINCT s.BusinessEntityID
                FROM Sales.Store s
                INNER JOIN Sales.Customer c ON c.StoreID = s.BusinessEntityID";

            await using var conn = new SqlConnection(_connectionString);
            var ids = (await conn.QueryAsync<int>(sql)).ToArray();
            _storeIdCache = ids.Length > 0 ? ids : Array.Empty<int>();
            _storeCacheExpiry = DateTimeOffset.UtcNow.AddMinutes(CACHE_TTL_MINUTES);

            _logger.LogInformation("[ShoppingSimulator] Store ID cache refreshed — {Count} stores cached", _storeIdCache.Length);
            return _storeIdCache;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ShoppingSimulator] Failed to refresh store ID cache");
            _storeIdCache ??= Array.Empty<int>();
            _storeCacheExpiry = DateTimeOffset.UtcNow.AddMinutes(1);
            return _storeIdCache;
        }
        finally
        {
            _storeCacheLock.Release();
        }
    }
}
