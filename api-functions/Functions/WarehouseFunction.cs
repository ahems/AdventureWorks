using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;

namespace api_functions.Functions;

/// <summary>
/// HTTP endpoints for monitoring and configuring the warehouse simulation.
///
/// The warehouse is always-on and event-driven — no start/stop endpoints.
/// Operations are triggered automatically by upstream simulators.
///
/// GET  /api/warehouse/status                          — Live metrics (queue depth, throughput, worker utilisation)
/// GET  /api/warehouse/active                          — In-progress operations with elapsed time
/// GET  /api/warehouse/workforce                       — Worker headcount summary by shift
/// GET  /api/warehouse/workforce/detail                — All workers with status, current op, pay rate
/// GET  /api/warehouse/metrics                         — Daily throughput counters
/// GET  /api/warehouse/damage-events                   — Recent damage events (?type=store|retrieve|receive)
/// GET  /api/warehouse/subcategory-config              — Handling time config for all subcategories
/// PUT  /api/warehouse/subcategory-config/{id}         — Update store/retrieve min/max minutes
/// GET  /api/warehouse/supplier-receive-config         — Receive duration config for all subcategories
/// PUT  /api/warehouse/supplier-receive-config/{id}    — Update receive/inspection durations
/// GET  /api/warehouse/damage-config                   — Damage rate config per operation type
/// PUT  /api/warehouse/damage-config/{operationType}   — Update damage rate and reason list
/// </summary>
public class WarehouseFunction
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly ILogger<WarehouseFunction> _logger;
    private readonly WarehouseService _warehouse;

    public WarehouseFunction(
        ILogger<WarehouseFunction> logger,
        WarehouseService warehouse)
    {
        _logger    = logger;
        _warehouse = warehouse;
    }

    // ── POST /api/warehouse/initialize ────────────────────────────────────────

    [Function(nameof(WarehouseInitialize))]
    public async Task<HttpResponseData> WarehouseInitialize(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "warehouse/initialize")]
        HttpRequestData req)
    {
        try
        {
            await _warehouse.InitializeAsync();
            var metrics = await _warehouse.GetStatusAsync();
            return await OkJsonAsync(req, new { message = "Warehouse initialized.", status = metrics });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error initializing warehouse");
            return await ErrorAsync(req, "Failed to initialize warehouse.");
        }
    }

    // ── GET /api/warehouse/status ─────────────────────────────────────────────

    [Function(nameof(WarehouseStatus))]
    public async Task<HttpResponseData> WarehouseStatus(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "warehouse/status")]
        HttpRequestData req)
    {
        try
        {
            await _warehouse.InitializeAsync();
            var metrics = await _warehouse.GetStatusAsync();
            return await OkJsonAsync(req, metrics);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching warehouse status");
            return await ErrorAsync(req, "Failed to retrieve warehouse status.");
        }
    }

    // ── GET /api/warehouse/active ─────────────────────────────────────────────

    [Function(nameof(WarehouseActiveOperations))]
    public async Task<HttpResponseData> WarehouseActiveOperations(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "warehouse/active")]
        HttpRequestData req)
    {
        try
        {
            var active = await _warehouse.GetActiveOperationsAsync();
            return await OkJsonAsync(req, active);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching active warehouse operations");
            return await ErrorAsync(req, "Failed to retrieve active operations.");
        }
    }

    // ── GET /api/warehouse/workforce ──────────────────────────────────────────

    [Function(nameof(WarehouseWorkforce))]
    public async Task<HttpResponseData> WarehouseWorkforce(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "warehouse/workforce")]
        HttpRequestData req)
    {
        try
        {
            await _warehouse.InitializeAsync();
            var snapshot = await _warehouse.GetWorkerSnapshotAsync();
            return await OkJsonAsync(req, snapshot);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching warehouse workforce");
            return await ErrorAsync(req, "Failed to retrieve workforce snapshot.");
        }
    }

    // ── GET /api/warehouse/workforce/detail ───────────────────────────────────

    [Function(nameof(WarehouseWorkforceDetail))]
    public async Task<HttpResponseData> WarehouseWorkforceDetail(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "warehouse/workforce/detail")]
        HttpRequestData req)
    {
        try
        {
            var workers = await _warehouse.GetWorkersDetailAsync();
            return await OkJsonAsync(req, workers);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching warehouse workforce detail");
            return await ErrorAsync(req, "Failed to retrieve workforce detail.");
        }
    }

    // ── GET /api/warehouse/metrics ────────────────────────────────────────────

    [Function(nameof(WarehouseMetrics))]
    public async Task<HttpResponseData> WarehouseMetrics(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "warehouse/metrics")]
        HttpRequestData req)
    {
        try
        {
            var metrics = await _warehouse.GetStatusAsync();
            return await OkJsonAsync(req, metrics);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching warehouse metrics");
            return await ErrorAsync(req, "Failed to retrieve metrics.");
        }
    }

    // ── GET /api/warehouse/damage-events ─────────────────────────────────────

    [Function(nameof(WarehouseDamageEvents))]
    public async Task<HttpResponseData> WarehouseDamageEvents(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "warehouse/damage-events")]
        HttpRequestData req)
    {
        try
        {
            string? opType = System.Web.HttpUtility.ParseQueryString(req.Url.Query)["type"];
            int maxCount   = int.TryParse(
                System.Web.HttpUtility.ParseQueryString(req.Url.Query)["maxCount"], out int mc) ? mc : 50;

            var events = await _warehouse.GetDamageEventsAsync(opType, maxCount);
            return await OkJsonAsync(req, events);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching damage events");
            return await ErrorAsync(req, "Failed to retrieve damage events.");
        }
    }

    // ── GET /api/warehouse/subcategory-config ─────────────────────────────────

    [Function(nameof(WarehouseGetSubcategoryConfig))]
    public async Task<HttpResponseData> WarehouseGetSubcategoryConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "warehouse/subcategory-config")]
        HttpRequestData req)
    {
        try
        {
            await _warehouse.InitializeAsync();
            var configs = await _warehouse.GetSubcategoryConfigsAsync();
            return await OkJsonAsync(req, configs);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching subcategory config");
            return await ErrorAsync(req, "Failed to retrieve subcategory config.");
        }
    }

    // ── PUT /api/warehouse/subcategory-config/{id} ────────────────────────────

    [Function(nameof(WarehouseUpdateSubcategoryConfig))]
    public async Task<HttpResponseData> WarehouseUpdateSubcategoryConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "warehouse/subcategory-config/{id}")]
        HttpRequestData req,
        int id)
    {
        UpdateSubcategoryRequest? body;
        try
        {
            body = JsonSerializer.Deserialize<UpdateSubcategoryRequest>(
                await new StreamReader(req.Body).ReadToEndAsync(), JsonOpts);
        }
        catch
        {
            return await BadRequestAsync(req, "Invalid JSON body.");
        }

        if (body == null)
            return await BadRequestAsync(req, "Request body is required.");
        if (body.StoreMinMinutes <= 0 || body.StoreMaxMinutes < body.StoreMinMinutes)
            return await BadRequestAsync(req, "storeMinMinutes must be > 0 and <= storeMaxMinutes.");
        if (body.RetrieveMinMinutes <= 0 || body.RetrieveMaxMinutes < body.RetrieveMinMinutes)
            return await BadRequestAsync(req, "retrieveMinMinutes must be > 0 and <= retrieveMaxMinutes.");

        try
        {
            var updated = await _warehouse.UpdateSubcategoryConfigAsync(
                id, body.StoreMinMinutes, body.StoreMaxMinutes,
                body.RetrieveMinMinutes, body.RetrieveMaxMinutes,
                body.BaseWeightKgThreshold > 0 ? body.BaseWeightKgThreshold : 5.0,
                body.Note);
            return await OkJsonAsync(req, updated);
        }
        catch (ArgumentException ex)
        {
            return await BadRequestAsync(req, ex.Message);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating subcategory config {Id}", id);
            return await ErrorAsync(req, "Failed to update subcategory config.");
        }
    }

    // ── GET /api/warehouse/supplier-receive-config ────────────────────────────

    [Function(nameof(WarehouseGetSupplierReceiveConfig))]
    public async Task<HttpResponseData> WarehouseGetSupplierReceiveConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "warehouse/supplier-receive-config")]
        HttpRequestData req)
    {
        try
        {
            await _warehouse.InitializeAsync();
            var configs = await _warehouse.GetSupplierReceiveConfigsAsync();
            return await OkJsonAsync(req, configs);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching supplier receive config");
            return await ErrorAsync(req, "Failed to retrieve supplier receive config.");
        }
    }

    // ── PUT /api/warehouse/supplier-receive-config/{id} ───────────────────────

    [Function(nameof(WarehouseUpdateSupplierReceiveConfig))]
    public async Task<HttpResponseData> WarehouseUpdateSupplierReceiveConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "warehouse/supplier-receive-config/{id}")]
        HttpRequestData req,
        int id)
    {
        UpdateSupplierReceiveRequest? body;
        try
        {
            body = JsonSerializer.Deserialize<UpdateSupplierReceiveRequest>(
                await new StreamReader(req.Body).ReadToEndAsync(), JsonOpts);
        }
        catch
        {
            return await BadRequestAsync(req, "Invalid JSON body.");
        }

        if (body == null)
            return await BadRequestAsync(req, "Request body is required.");
        if (body.ReceiveMinMinutes <= 0 || body.ReceiveMaxMinutes < body.ReceiveMinMinutes)
            return await BadRequestAsync(req, "receiveMinMinutes must be > 0 and <= receiveMaxMinutes.");

        try
        {
            var updated = await _warehouse.UpdateSupplierReceiveConfigAsync(
                id, body.ReceiveMinMinutes, body.ReceiveMaxMinutes,
                body.InspectionMinMinutes, body.InspectionMaxMinutes,
                body.AdditionalMinutesPerUnit, body.Note);
            return await OkJsonAsync(req, updated);
        }
        catch (ArgumentException ex)
        {
            return await BadRequestAsync(req, ex.Message);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating supplier receive config {Id}", id);
            return await ErrorAsync(req, "Failed to update supplier receive config.");
        }
    }

    // ── GET /api/warehouse/damage-config ─────────────────────────────────────

    [Function(nameof(WarehouseGetDamageConfig))]
    public async Task<HttpResponseData> WarehouseGetDamageConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "warehouse/damage-config")]
        HttpRequestData req)
    {
        try
        {
            await _warehouse.InitializeAsync();
            var configs = await _warehouse.GetDamageConfigsAsync();
            // Also return the available damage reason names so UI can display them
            var response = new
            {
                Configs = configs,
                DamageReasons = WarehouseService.DamageReasonNames
                    .Select(kv => new { Id = kv.Key, Name = kv.Value })
                    .OrderBy(r => r.Id)
                    .ToList(),
            };
            return await OkJsonAsync(req, response);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error fetching damage config");
            return await ErrorAsync(req, "Failed to retrieve damage config.");
        }
    }

    // ── PUT /api/warehouse/damage-config/{operationType} ─────────────────────

    [Function(nameof(WarehouseUpdateDamageConfig))]
    public async Task<HttpResponseData> WarehouseUpdateDamageConfig(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "warehouse/damage-config/{operationType}")]
        HttpRequestData req,
        string operationType)
    {
        UpdateDamageConfigRequest? body;
        try
        {
            body = JsonSerializer.Deserialize<UpdateDamageConfigRequest>(
                await new StreamReader(req.Body).ReadToEndAsync(), JsonOpts);
        }
        catch
        {
            return await BadRequestAsync(req, "Invalid JSON body.");
        }

        if (body == null)
            return await BadRequestAsync(req, "Request body is required.");
        if (body.DamageRatePct < 0 || body.DamageRatePct > 1)
            return await BadRequestAsync(req, "damageRatePct must be between 0.0 and 1.0.");

        string opLower = operationType.ToLowerInvariant();
        if (opLower != "store" && opLower != "retrieve" && opLower != "receive")
            return await BadRequestAsync(req, "operationType must be 'store', 'retrieve', or 'receive'.");

        try
        {
            var updated = await _warehouse.UpdateDamageConfigAsync(
                opLower, body.DamageRatePct, body.DamageReasonIds ?? Array.Empty<int>(), body.Note);
            return await OkJsonAsync(req, updated);
        }
        catch (ArgumentException ex)
        {
            return await BadRequestAsync(req, ex.Message);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating damage config for {OperationType}", operationType);
            return await ErrorAsync(req, "Failed to update damage config.");
        }
    }

    // ── Request DTOs ──────────────────────────────────────────────────────────

    private record UpdateSubcategoryRequest(
        int StoreMinMinutes, int StoreMaxMinutes,
        int RetrieveMinMinutes, int RetrieveMaxMinutes,
        double BaseWeightKgThreshold,
        string? Note);

    private record UpdateSupplierReceiveRequest(
        int ReceiveMinMinutes, int ReceiveMaxMinutes,
        int InspectionMinMinutes, int InspectionMaxMinutes,
        double AdditionalMinutesPerUnit,
        string? Note);

    private record UpdateDamageConfigRequest(
        double DamageRatePct,
        int[]? DamageReasonIds,
        string? Note);

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static async Task<HttpResponseData> OkJsonAsync(HttpRequestData req, object data)
    {
        var resp = req.CreateResponse(HttpStatusCode.OK);
        resp.Headers.Add("Content-Type", "application/json");
        resp.Headers.Add("Access-Control-Allow-Origin", "*");
        await resp.WriteStringAsync(JsonSerializer.Serialize(data, JsonOpts));
        return resp;
    }

    private static async Task<HttpResponseData> BadRequestAsync(HttpRequestData req, string message)
    {
        var resp = req.CreateResponse(HttpStatusCode.BadRequest);
        resp.Headers.Add("Content-Type", "application/json");
        await resp.WriteStringAsync(JsonSerializer.Serialize(new { error = message }));
        return resp;
    }

    private static async Task<HttpResponseData> ErrorAsync(HttpRequestData req, string message)
    {
        var resp = req.CreateResponse(HttpStatusCode.InternalServerError);
        resp.Headers.Add("Content-Type", "application/json");
        await resp.WriteStringAsync(JsonSerializer.Serialize(new { error = message }));
        return resp;
    }
}
