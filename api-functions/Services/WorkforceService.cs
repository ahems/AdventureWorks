using Azure.Data.Tables;
using Azure.Identity;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

// ── Data transfer types ──────────────────────────────────────────────────────

public record EmployeeRecord(
    int    BusinessEntityId,
    string FullName,
    string JobTitle,
    int    DepartmentId,
    string DepartmentName,
    int    ShiftId,
    string ShiftName,
    TimeSpan ShiftStart,
    TimeSpan ShiftEnd,
    double HourlyRate,
    DateTime HireDate,
    int    VacationHours,
    int    SickLeaveHours);

public record WorkerStatus(
    int     EmployeeId,
    string  Name,
    string  JobTitle,
    int     LocationId,
    string  LocationName,
    int     ShiftId,
    string  ShiftName,
    string  Status,              // "available" | "working" | "off-shift" | "unavailable"
    int?    CurrentWorkOrderId,
    string? CurrentOperation,
    double  HourlyRate,
    double  TenureYears,
    double  ScrapRateMultiplier); // < 1.0 for experienced workers

public record WorkerAssignment(
    int    EmployeeId,
    string Name,
    double HourlyRate,
    double TenureYears,
    double ScrapRateMultiplier);

public record WorkforceSnapshot(
    int TotalActiveWorkers,
    int CurrentlyWorking,
    int AvailableNow,
    int OffShift,
    int Unavailable,
    List<LocationWorkforce> ByLocation);

public record LocationWorkforce(
    int    LocationId,
    string LocationName,
    int    Headcount,
    int    Available,
    int    Working,
    int    OffShift);

// ── Service ──────────────────────────────────────────────────────────────────

public class WorkforceService
{
    private const string TABLE_NAME        = "awManufacturing";
    private const string PART_WORKFORCE    = "workforce";

    // Manufacturing-relevant department IDs in AdventureWorks
    private static readonly int[] ManufacturingDeptIds = { 7, 8 };  // Production, Production Control

    // Simulation location IDs (matches Production.Location rows used by manufacturing sim)
    private static readonly int[] ManufacturingLocationIds = { 10, 20, 30, 40, 45, 50, 60 };

    // Location name map (duplicates what DB has — avoids extra SQL round-trip per-worker)
    private static readonly Dictionary<int, string> LocationNames = new()
    {
        [10] = "Frame Forming",
        [20] = "Frame Welding",
        [30] = "Debur and Polish",
        [40] = "Paint",
        [45] = "Specialized Paint",
        [50] = "Subassembly",
        [60] = "Final Assembly",
    };

    private readonly string _connectionString;
    private readonly TableClient _tableClient;
    private readonly ILogger<WorkforceService> _logger;

    // Static initialization guard — ensures seeding runs only once per process
    // even when Dashboard and WorkforcePage fire concurrent requests on load.
    private static readonly SemaphoreSlim _initLock = new(1, 1);
    private static volatile bool _initComplete = false;

    public WorkforceService(
        string connectionString,
        string tableServiceUri,
        ILogger<WorkforceService> logger)
    {
        _connectionString = connectionString;
        _logger           = logger;

        var svc = new TableServiceClient(new Uri(tableServiceUri), new DefaultAzureCredential());
        _tableClient = svc.GetTableClient(TABLE_NAME);
    }

    // ── Initialisation ─────────────────────────────────────────────────────────

    /// <summary>
    /// Seeds Table Storage with manufacturing employees from HumanResources tables.
    /// Idempotent — only writes rows that don't exist yet.
    /// </summary>
    public async Task InitializeAsync()
    {
        // Fast path: already initialized in this process — skip all work.
        if (_initComplete) return;

        await _initLock.WaitAsync();
        try
        {
            // Double-check after acquiring lock.
            if (_initComplete) return;

            // Check if already initialized
            bool alreadySeeded = false;
            await foreach (var _ in _tableClient.QueryAsync<TableEntity>(
                filter: $"PartitionKey eq '{PART_WORKFORCE}'",
                maxPerPage: 1,
                select: new[] { "RowKey" }))
            {
                alreadySeeded = true;
                break;
            }
            if (alreadySeeded)
            {
                _initComplete = true;
                return;
            }

            var employees = await LoadManufacturingEmployeesAsync();

            // Distribute employees evenly across manufacturing locations deterministically
            int locationCount = ManufacturingLocationIds.Length;
            for (int i = 0; i < employees.Count; i++)
            {
                var emp       = employees[i];
                int locationId= ManufacturingLocationIds[i % locationCount];
                string locName = LocationNames.GetValueOrDefault(locationId, locationId.ToString());
                double tenure = (DateTime.UtcNow - emp.HireDate).TotalDays / 365.25;
                double scrap  = Math.Max(0.5, 1.0 - tenure / 20.0);  // 0yr→1.0× 10yr→0.5×

                var entity = new TableEntity(PART_WORKFORCE, emp.BusinessEntityId.ToString())
                {
                    ["FullName"]            = emp.FullName,
                    ["JobTitle"]            = emp.JobTitle,
                    ["DepartmentId"]        = emp.DepartmentId,
                    ["DepartmentName"]      = emp.DepartmentName,
                    ["ShiftId"]             = emp.ShiftId,
                    ["ShiftName"]           = emp.ShiftName,
                    ["ShiftStartHour"]      = emp.ShiftStart.Hours,
                    ["ShiftEndHour"]        = emp.ShiftEnd.Hours,
                    ["LocationId"]          = locationId,
                    ["LocationName"]        = locName,
                    ["HourlyRate"]          = emp.HourlyRate,
                    ["TenureYears"]         = Math.Round(tenure, 1),
                    ["ScrapRateMultiplier"] = Math.Round(scrap, 3),
                    ["VacationHours"]       = emp.VacationHours,
                    ["SickLeaveHours"]      = emp.SickLeaveHours,
                    ["Status"]              = "available",
                    ["CurrentWorkOrderId"]  = (int?)null,
                    ["CurrentOperation"]    = (string?)null,
                    ["BusyUntilUtc"]        = (DateTimeOffset?)null,
                };
                await _tableClient.UpsertEntityAsync(entity);
            }

            _logger.LogInformation("Workforce initialized: {Count} manufacturing employees seeded", employees.Count);
            _initComplete = true;
        }
        finally
        {
            _initLock.Release();
        }
    }

    // ── Workforce queries ──────────────────────────────────────────────────────

    public async Task<WorkforceSnapshot> GetSnapshotAsync()
    {
        var byLocation = new Dictionary<int, (int total, int avail, int working, int offShift)>();
        int totalWorkers = 0, currentlyWorking = 0, availableNow = 0, offShift = 0, unavailable = 0;

        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_WORKFORCE}'"))
        {
            totalWorkers++;
            int locId   = e.GetInt32("LocationId") ?? 0;
            string status = GetEffectiveStatus(e);

            if (!byLocation.ContainsKey(locId))
                byLocation[locId] = (0, 0, 0, 0);
            var (t, a, w, o) = byLocation[locId];

            switch (status)
            {
                case "working":     currentlyWorking++;  w++; break;
                case "available":   availableNow++;      a++; break;
                case "off-shift":   offShift++;          o++; break;
                default:            unavailable++;        break;
            }
            byLocation[locId] = (t + 1, a, w, o);
        }

        var locationList = byLocation
            .OrderBy(kv => kv.Key)
            .Select(kv =>
            {
                int locId = kv.Key;
                var (total, avail, working, offS) = kv.Value;
                return new LocationWorkforce(
                    locId,
                    LocationNames.GetValueOrDefault(locId, locId.ToString()),
                    total, avail, working, offS);
            }).ToList();

        return new WorkforceSnapshot(
            totalWorkers, currentlyWorking, availableNow, offShift, unavailable, locationList);
    }

    public async Task<List<WorkerStatus>> GetDetailAsync()
    {
        var result = new List<WorkerStatus>();

        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_WORKFORCE}'"))
        {
            result.Add(EntityToWorkerStatus(e));
        }

        return result
            .OrderBy(w => w.LocationId)
            .ThenBy(w => w.ShiftId)
            .ThenByDescending(w => w.TenureYears)
            .ToList();
    }

    // ── Operator assignment ────────────────────────────────────────────────────

    /// <summary>
    /// Finds the most experienced available worker at the given location for the current shift,
    /// marks them as "working", and returns their assignment details for labor cost calculation.
    /// Returns null if no workers are available (operation proceeds without assigned operator).
    /// </summary>
    public async Task<WorkerAssignment?> AssignOperatorAsync(int locationId, int workOrderId, string operationDescription)
    {
        var candidates = new List<TableEntity>();
        await foreach (var e in _tableClient.QueryAsync<TableEntity>(
            filter: $"PartitionKey eq '{PART_WORKFORCE}' and LocationId eq {locationId}"))
        {
            if (GetEffectiveStatus(e) == "available")
                candidates.Add(e);
        }

        if (!candidates.Any()) return null;

        // Prefer most experienced (highest tenure = lowest scrap risk)
        var worker = candidates.OrderByDescending(e => e.GetDouble("TenureYears") ?? 0).First();

        worker["Status"]           = "working";
        worker["CurrentWorkOrderId"] = workOrderId;
        worker["CurrentOperation"] = operationDescription;
        worker["BusyUntilUtc"]     = (DateTimeOffset)DateTimeOffset.UtcNow.AddHours(8); // safety fallback

        try { await _tableClient.UpdateEntityAsync(worker, worker.ETag); }
        catch { /* concurrent assignment — still proceed, just without tracking */ }

        double tenure = worker.GetDouble("TenureYears") ?? 0;
        double scrap  = worker.GetDouble("ScrapRateMultiplier") ?? 1.0;

        _logger.LogDebug("Assigned operator {Name} (WO {WorkOrderId}, tenure {Tenure:.1f}yr, scrap×{Scrap:.2f})",
            worker.GetString("FullName"), workOrderId, tenure, scrap);

        return new WorkerAssignment(
            EmployeeId:          int.Parse(worker.RowKey),
            Name:                worker.GetString("FullName") ?? "Unknown",
            HourlyRate:          worker.GetDouble("HourlyRate") ?? 12.0,
            TenureYears:         tenure,
            ScrapRateMultiplier: scrap);
    }

    /// <summary>Marks the assigned operator as available again after operation completes.</summary>
    public async Task ReleaseOperatorAsync(int employeeId)
    {
        var resp = await _tableClient.GetEntityIfExistsAsync<TableEntity>(
            PART_WORKFORCE, employeeId.ToString());
        if (!resp.HasValue) return;

        var worker = resp.Value!;
        worker["Status"]             = "available";
        worker["CurrentWorkOrderId"] = (int?)null;
        worker["CurrentOperation"]   = (string?)null;
        worker["BusyUntilUtc"]       = (DateTimeOffset?)null;

        try { await _tableClient.UpdateEntityAsync(worker, worker.ETag); }
        catch { /* ignore concurrent modification */ }
    }

    // ── Internal helpers ────────────────────────────────────────────────────────

    /// <summary>
    /// Determines effective status, considering shift hours.
    /// Workers marked "available" are "off-shift" if outside their shift window.
    /// </summary>
    private static string GetEffectiveStatus(TableEntity e)
    {
        string stored = e.GetString("Status") ?? "available";
        if (stored == "working") return "working";

        // Auto-release stuck "working" status (shouldn't happen but guards against crashes)
        var busyUntil = e.GetDateTimeOffset("BusyUntilUtc");
        if (stored == "working" && busyUntil.HasValue && busyUntil.Value < DateTimeOffset.UtcNow)
            return "available";

        // Check if within shift hours (UTC approximate — AdventureWorks times are local but we treat as UTC for sim)
        int shiftStart = e.GetInt32("ShiftStartHour") ?? 7;
        int shiftEnd   = e.GetInt32("ShiftEndHour") ?? 15;
        int currentHour = DateTime.UtcNow.Hour;

        bool onShift = shiftStart < shiftEnd
            ? currentHour >= shiftStart && currentHour < shiftEnd   // day/evening
            : currentHour >= shiftStart || currentHour < shiftEnd;  // night shift wraps midnight

        if (!onShift) return "off-shift";

        // Unavailable if very low vacation hours (over-worked employees)
        int vacHours = e.GetInt32("VacationHours") ?? 40;
        if (vacHours <= 0)
            return "unavailable";

        return "available";
    }

    private static WorkerStatus EntityToWorkerStatus(TableEntity e)
    {
        int empId        = int.TryParse(e.RowKey, out int id) ? id : 0;
        string status    = GetEffectiveStatus(e);
        double tenure    = e.GetDouble("TenureYears") ?? 0;
        double scrap     = e.GetDouble("ScrapRateMultiplier") ?? 1.0;
        int?   currentWo = e.GetInt32("CurrentWorkOrderId");

        return new WorkerStatus(
            EmployeeId:          empId,
            Name:                e.GetString("FullName") ?? "",
            JobTitle:            e.GetString("JobTitle") ?? "",
            LocationId:          e.GetInt32("LocationId") ?? 0,
            LocationName:        e.GetString("LocationName") ?? "",
            ShiftId:             e.GetInt32("ShiftId") ?? 1,
            ShiftName:           e.GetString("ShiftName") ?? "Day",
            Status:              status,
            CurrentWorkOrderId:  status == "working" ? currentWo : null,
            CurrentOperation:    status == "working" ? e.GetString("CurrentOperation") : null,
            HourlyRate:          e.GetDouble("HourlyRate") ?? 12.0,
            TenureYears:         tenure,
            ScrapRateMultiplier: scrap);
    }

    // ── SQL loading ─────────────────────────────────────────────────────────────

    private async Task<List<EmployeeRecord>> LoadManufacturingEmployeesAsync()
    {
        await using var conn = new SqlConnection(_connectionString);
        await conn.OpenAsync();

        // Load all currently-active employees in Manufacturing group departments,
        // joining to their current shift and most-recent pay rate.
        var rows = await conn.QueryAsync(@"
            SELECT
                e.BusinessEntityID,
                p.FirstName + ' ' + p.LastName AS FullName,
                e.JobTitle,
                e.HireDate,
                e.VacationHours,
                e.SickLeaveHours,
                edh.DepartmentID,
                d.Name                                           AS DepartmentName,
                edh.ShiftID,
                s.Name                                           AS ShiftName,
                s.StartTime,
                s.EndTime,
                ISNULL(eph.Rate, 12.00)                          AS HourlyRate
            FROM HumanResources.Employee e
            INNER JOIN Person.Person p
                ON e.BusinessEntityID = p.BusinessEntityID
            INNER JOIN HumanResources.EmployeeDepartmentHistory edh
                ON e.BusinessEntityID = edh.BusinessEntityID
               AND edh.EndDate IS NULL
            INNER JOIN HumanResources.Department d
                ON edh.DepartmentID = d.DepartmentID
            INNER JOIN HumanResources.Shift s
                ON edh.ShiftID = s.ShiftID
            OUTER APPLY (
                SELECT TOP 1 Rate
                FROM HumanResources.EmployeePayHistory
                WHERE BusinessEntityID = e.BusinessEntityID
                ORDER BY RateChangeDate DESC
            ) eph
            WHERE e.CurrentFlag = 1
              AND d.GroupName = 'Manufacturing'
            ORDER BY edh.DepartmentID, edh.ShiftID, e.BusinessEntityID");

        return rows.Select(r => new EmployeeRecord(
            BusinessEntityId: (int)r.BusinessEntityID,
            FullName:         (string)r.FullName,
            JobTitle:         (string)r.JobTitle,
            DepartmentId:     Convert.ToInt32(r.DepartmentID),   // SQL smallint → short
            DepartmentName:   (string)r.DepartmentName,
            ShiftId:          Convert.ToInt32(r.ShiftID),        // SQL tinyint → byte
            ShiftName:        (string)r.ShiftName,
            ShiftStart:       (TimeSpan)r.StartTime,             // SQL time → TimeSpan
            ShiftEnd:         (TimeSpan)r.EndTime,
            HourlyRate:       Convert.ToDouble(r.HourlyRate),    // SQL money → decimal
            HireDate:         (DateTime)r.HireDate,
            VacationHours:    Convert.ToInt32(r.VacationHours),  // SQL smallint → short
            SickLeaveHours:   Convert.ToInt32(r.SickLeaveHours)  // SQL smallint → short
        )).ToList();
    }
}
