#nullable enable
using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Azure.Core;
using Azure.Identity;
using Azure.Storage.Queues;
using api_functions.DTOs;
using Microsoft.Extensions.Configuration;

namespace api_functions.Services;

public sealed class MonitoringQueryService(IConfiguration configuration, DefaultAzureCredential credential,
    IHttpClientFactory clients)
{
    private readonly SemaphoreSlim _sources = new(4, 4);
    private readonly ConcurrentDictionary<string, CacheEntry> _cache = new();
    private sealed record CacheEntry(DateTimeOffset Expires, Lazy<Task<object>> Value);
    public static TimeSpan Lookback(string range) => range switch
    {
        "1h" => TimeSpan.FromHours(1), "6h" => TimeSpan.FromHours(6),
        "24h" => TimeSpan.FromHours(24), _ => throw new ArgumentException("Range must be 1h, 6h or 24h.")
    };

    public Task<MonitoringSummary> SummaryAsync(string range, CancellationToken ct = default)
    {
        _ = Lookback(range);
        return CachedAsync("summary:" + range, async () =>
        {
            var queries = MonitoringQueries.Summary.Select(q => LogsAsync(q.Key, q.Value, q.Key == "monitoringHealth" ? "24h" : range));
            var sources = (await Task.WhenAll(queries.Append(ResourcesAsync(range)).Append(QueuesAsync()))).ToArray();
            var status = AggregateStatus(sources);
            var links = new Dictionary<string, string>();
            foreach (var key in new[] { "workbook", "grafana", "applicationInsights" })
                if (Uri.TryCreate(configuration["MONITORING_LINK_" + key.ToUpperInvariant()], UriKind.Absolute, out var uri)
                    && uri.Scheme == "https" && uri.Host == "portal.azure.com")
                    links[key] = uri.ToString();
            return new MonitoringSummary(DateTimeOffset.UtcNow, range, status,
                "Telemetry arrives asynchronously. Observed trace counts are samples; estimated counts use ItemCount. Missing telemetry is not health. Billable bytes are not invoice totals.",
                sources, links);
        }, ct);
    }

    public Task<MonitoringTrace> TraceAsync(string traceId, CancellationToken ct = default)
    {
        var query = MonitoringQueries.Trace(traceId);
        return CachedAsync("trace:" + traceId, async () =>
        {
            var source = await LogsAsync("trace", query, "24h");
            if (source.Rows.Count == 100 && source.Status == "available")
                source = source with { Status = "stale", Reason = "Detail limit reached; additional sampled spans/content events may exist." };
            var content = new Dictionary<string, Dictionary<string, CapturedField>>(StringComparer.Ordinal);
            var safeRows = new List<IReadOnlyDictionary<string, object?>>();
            var remaining = 32768;
            foreach (var row in source.Rows)
            {
                var fields = new Dictionary<string, CapturedField>();
                if (Guid.TryParse(row.GetValueOrDefault("captureId") as string, out _))
                foreach (var name in new[] { "input", "output", "reasoningSummary" })
                {
                    var key = "capture" + char.ToUpperInvariant(name[0]) + name[1..];
                    var text = row.GetValueOrDefault(key) as string;
                    if (string.IsNullOrEmpty(text) && row.GetValueOrDefault(key + "Omitted") is not true) continue;
                    var field = MonitoringContent.Sanitize(name, text);
                    var original = row.GetValueOrDefault(key + "OriginalBytes");
                    var bytes = System.Text.Encoding.UTF8.GetByteCount(field.Text ?? "");
                    field = field with
                    {
                        OriginalBytes = original is long size ? (int)Math.Clamp(size, 0, int.MaxValue) : field.OriginalBytes,
                        Truncated = field.Truncated || row.GetValueOrDefault(key + "Truncated") is true,
                        Omitted = field.Omitted || row.GetValueOrDefault(key + "Omitted") is true || bytes > remaining
                    };
                    if (field.Omitted) field = field with { Text = null };
                    else remaining -= bytes;
                    fields[name] = field;
                }
                if (fields.Count > 0)
                {
                    var spanId = row.GetValueOrDefault("spanId") as string ?? "";
                    if (!content.TryGetValue(spanId, out var captured)) content[spanId] = captured = new();
                    foreach (var field in fields) captured[field.Key] = field.Value;
                }
                safeRows.Add(row.Where(pair => !pair.Key.StartsWith("capture", StringComparison.Ordinal)
                    || pair.Key == "captureId").ToDictionary(pair => pair.Key, pair => pair.Value));
            }
            return new MonitoringTrace(DateTimeOffset.UtcNow, traceId, source.Status,
                source with { Rows = safeRows }, content.Select(pair =>
                    new MonitoringCapturedSpan(pair.Key, pair.Value)).ToArray());
        }, ct);
    }

    private async Task<T> CachedAsync<T>(string key, Func<Task<T>> query, CancellationToken ct) where T : class
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var entry in _cache.Where(e => e.Value.Expires <= now))
            _cache.TryRemove(entry);
        // Bound attacker-controlled unique trace IDs without evicting in-flight shared reads.
        if (_cache.Count >= 128 && !_cache.ContainsKey(key))
            throw new InvalidOperationException("Monitoring cache capacity reached; retry after 60 seconds.");
        var cached = _cache.GetOrAdd(key, _ => new CacheEntry(now.AddSeconds(60),
            new Lazy<Task<object>>(async () => (object)await query(), LazyThreadSafetyMode.ExecutionAndPublication)));
        try { return (T)await cached.Value.Value.WaitAsync(ct); }
        catch
        {
            if (cached.Value.IsValueCreated && cached.Value.Value.IsFaulted) _cache.TryRemove(key, out _);
            throw;
        }
    }

    private Task<MonitoringSource> LogsAsync(string id, string query, string range)
    {
        var workspace = configuration["MONITORING_WORKSPACE_ID"];
        if (!Guid.TryParse(workspace, out _)) return Task.FromResult(Failure(id, "unavailable", "Workspace is not configured."));
        return QueryAsync(id, "https://api.loganalytics.io/v1/workspaces/" + workspace + "/query",
            "https://api.loganalytics.io/.default", new { query, timespan = "PT" + (int)Lookback(range).TotalHours + "H" }, ParseLogs);
    }

    private async Task<MonitoringSource> ResourcesAsync(string range)
    {
        // This list is generated by IaC. Clients cannot supply resource IDs, metric names or aggregations.
        MonitoringMetric[] metrics;
        try { metrics = JsonSerializer.Deserialize<MonitoringMetric[]>(configuration["MONITORING_METRIC_RESOURCES"] ?? "[]",
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? []; }
        catch (JsonException) { return Failure("resources", "unavailable", "Metric resources are not configured."); }
        if (metrics.Length == 0) return Failure("resources", "unavailable", "Metric resources are not configured.");
        var results = await Task.WhenAll(metrics.Take(16).Select(async metric =>
        {
            if (!metric.ResourceId.StartsWith("/subscriptions/", StringComparison.Ordinal)
                || !System.Text.RegularExpressions.Regex.IsMatch(metric.Metric, "^[a-zA-Z][a-zA-Z0-9_]*$"))
                return Failure(metric.Id, "unavailable", "Invalid server metric configuration.");
            var end = DateTimeOffset.UtcNow;
            var url = "https://management.azure.com" + metric.ResourceId
                + "/providers/microsoft.insights/metrics?api-version=2023-10-01&metricnames="
                + Uri.EscapeDataString(metric.Metric) + "&timespan="
                + Uri.EscapeDataString($"{end - Lookback(range):O}/{end:O}") + "&interval=PT1H&aggregation="
                + Uri.EscapeDataString(metric.Aggregation is "Total" or "Average" or "Maximum" ? metric.Aggregation : "Average");
            var source = await QueryAsync(metric.Id, url, "https://management.azure.com/.default", null, ParseMetrics);
            return source with { Rows = source.Rows.Select(row => (IReadOnlyDictionary<string, object?>)
                new Dictionary<string, object?>(row) { ["unit"] = metric.Unit, ["configuredLimit"] = metric.Limit }).ToArray() };
        }));
        var rows = results.SelectMany(r => r.Rows.Count > 0
            ? r.Rows.Select(row => (IReadOnlyDictionary<string, object?>)new Dictionary<string, object?>(row)
                { ["resource"] = r.Id, ["status"] = r.Status })
            : new[] { (IReadOnlyDictionary<string, object?>)new Dictionary<string, object?>
                { ["resource"] = r.Id, ["status"] = r.Status, ["reason"] = r.Reason } }).Take(100).ToArray();
        return new MonitoringSource("resources", results.All(r => r.Status == "available") ? "available"
            : results.Any(r => r.Status == "available") ? "stale" : results[0].Status,
            DateTimeOffset.UtcNow, results.Any(r => r.Status != "available") ? "Some native metrics are unavailable or have no data; see rows." : null, rows);
    }

    private async Task<MonitoringSource> QueuesAsync()
    {
        var account = configuration["STORAGE_ACCOUNT_NAME"];
        if (string.IsNullOrWhiteSpace(account)) return Failure("queues", "unavailable", "Storage is not configured.");
        var rows = await Task.WhenAll(DependencyHealthService.ApplicationQueues
            .SelectMany(name => new[] { name, name + "-poison" }).Take(40).Select(async name =>
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var entered = false;
            var row = new Dictionary<string, object?> { ["queue"] = name, ["approximateMessages"] = null };
            try
            {
                await _sources.WaitAsync(deadline.Token); entered = true;
                var queue = new QueueClient(new Uri($"https://{account}.queue.core.windows.net/{name}"), credential);
                var properties = await queue.GetPropertiesAsync(deadline.Token);
                row["approximateMessages"] = properties.Value.ApproximateMessagesCount;
                row["status"] = "available";
            }
            catch (Azure.RequestFailedException e)
            {
                row["status"] = e.Status is 401 or 403 ? "forbidden" : e.Status == 429 ? "throttled" : "unavailable";
            }
            catch (Exception e) when (e is OperationCanceledException or AuthenticationFailedException)
            { row["status"] = "unavailable"; }
            finally { if (entered) _sources.Release(); }
            return (IReadOnlyDictionary<string, object?>)row;
        }));
        var outcomes = rows.Select(r => (string)r["status"]!).Distinct().ToArray();
        var status = outcomes.Length == 1 ? outcomes[0]
            : outcomes.Contains("available") ? "stale" : "unavailable";
        return new("queues", status,
            DateTimeOffset.UtcNow, "Approximate per-queue metadata read only. Poison transfer is observed, not inferred from attempt failures.", rows);
    }

    private async Task<MonitoringSource> QueryAsync(string id, string url, string audience, object? body,
        Func<JsonElement, IReadOnlyList<IReadOnlyDictionary<string, object?>>> parse)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var ct = deadline.Token;
        var entered = false;
        try
        {
            await _sources.WaitAsync(ct);
            entered = true;
            var token = await credential.GetTokenAsync(new TokenRequestContext([audience]), ct);
            using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
            if (body is not null) request.Content = JsonContent.Create(body);
            using var response = await clients.CreateClient("monitoring").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!response.IsSuccessStatusCode)
                return Failure(id, response.StatusCode switch
                {
                    HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized => "forbidden",
                    HttpStatusCode.TooManyRequests => "throttled", _ => "unavailable"
                }, $"Azure Monitor returned HTTP {(int)response.StatusCode}.");
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var bytes = new MemoryStream();
            var buffer = new byte[8192];
            int read;
            while ((read = await stream.ReadAsync(buffer, ct)) != 0)
            {
                if (bytes.Length + read > 1024 * 1024) return Failure(id, "unavailable", "Query response exceeds the safety limit.");
                bytes.Write(buffer, 0, read);
            }
            using var document = JsonDocument.Parse(bytes.ToArray());
            var rows = parse(document.RootElement);
            var partial = document.RootElement.TryGetProperty("error", out _);
            if (id == "monitoringHealth" && rows.Count > 0)
                return new(id, "stale", DateTimeOffset.UtcNow,
                    "Workspace reported OverQuota within 24 hours; coverage may be incomplete. Reset is workspace-specific.", rows);
            return new MonitoringSource(id, partial ? rows.Count > 0 ? "stale" : "unavailable"
                : rows.Count == 0 ? "no-data" : "available",
                DateTimeOffset.UtcNow, partial ? rows.Count > 0 ? "Azure Monitor returned partial data."
                    : "Azure Monitor returned an error without verified data." : null, rows);
        }
        catch (OperationCanceledException) { return Failure(id, "unavailable", "Azure Monitor query exceeded the 10-second budget."); }
        catch (Exception e) when (e is HttpRequestException or JsonException or Azure.RequestFailedException or AuthenticationFailedException
            or InvalidOperationException or KeyNotFoundException or FormatException)
        { return Failure(id, "unavailable", "Azure Monitor could not return verified data."); }
        finally { if (entered) _sources.Release(); }
    }

    public static string AggregateStatus(IEnumerable<MonitoringSource> sources)
    {
        var statuses = sources.Select(s => s.Status).ToArray();
        if (statuses.All(s => s == "no-data")) return "no-data";
        if (statuses.All(s => s is "available" or "no-data")) return "available";
        return statuses.Any(s => s is "available" or "stale" or "no-data") ? "partial" : "unavailable";
    }

    public static IReadOnlyList<IReadOnlyDictionary<string, object?>> ParseLogs(JsonElement root)
    {
        var rows = new List<IReadOnlyDictionary<string, object?>>();
        if (!root.TryGetProperty("tables", out var tables))
        {
            if (root.TryGetProperty("error", out _)) return rows;
            throw new JsonException("Query response lacks tables.");
        }
        foreach (var table in tables.EnumerateArray().Take(1))
        {
            var columns = table.GetProperty("columns").EnumerateArray().Select(c => c.GetProperty("name").GetString()!).ToArray();
            foreach (var row in table.GetProperty("rows").EnumerateArray().Take(100))
            {
                var values = row.EnumerateArray().ToArray();
                var result = new Dictionary<string, object?>();
                for (int i = 0; i < Math.Min(columns.Length, values.Length); i++)
                    result[columns[i]] = columns[i] is "captureInput" or "captureOutput" or "captureReasoningSummary"
                        && values[i].ValueKind == JsonValueKind.String
                        ? MonitoringContent.Redact(values[i].GetString() ?? "", 4096) : Scalar(values[i]);
                rows.Add(result);
            }
        }
        return rows;
    }

    private static object? Scalar(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Number => value.TryGetInt64(out var number) ? (object)number : value.GetDouble(),
        JsonValueKind.True => true, JsonValueKind.False => false,
        JsonValueKind.String => MonitoringContent.Redact(value.GetString() ?? "", 256),
        _ => null
    };

    private static IReadOnlyList<IReadOnlyDictionary<string, object?>> ParseMetrics(JsonElement root)
    {
        var rows = new List<IReadOnlyDictionary<string, object?>>();
        if (!root.TryGetProperty("value", out var metrics)) throw new JsonException("Metric response lacks values.");
        foreach (var metric in metrics.EnumerateArray())
        foreach (var series in metric.GetProperty("timeseries").EnumerateArray())
        {
            if (rows.Count == 100) return rows;
            var points = series.GetProperty("data").EnumerateArray().ToArray();
            var averages = points.Where(p => p.TryGetProperty("average", out var value) && value.ValueKind != JsonValueKind.Null)
                .Select(p => p.GetProperty("average").GetDouble()).ToArray();
            var maxima = points.Where(p => p.TryGetProperty("maximum", out var value) && value.ValueKind != JsonValueKind.Null)
                .Select(p => p.GetProperty("maximum").GetDouble()).ToArray();
            var totals = points.Where(p => p.TryGetProperty("total", out var value) && value.ValueKind != JsonValueKind.Null)
                .Select(p => p.GetProperty("total").GetDouble()).ToArray();
            if (averages.Length + maxima.Length + totals.Length == 0) continue;
            var row = new Dictionary<string, object?> { ["metric"] = metric.GetProperty("name").GetProperty("value").GetString() };
            row["averageOfReportedPoints"] = averages.Length == 0 ? null : averages.Average();
            row["maximum"] = maxima.Length == 0 ? null : maxima.Max();
            row["total"] = totals.Length == 0 ? null : totals.Sum();
            row["reportedPoints"] = averages.Length + maxima.Length + totals.Length;
            rows.Add(row);
        }
        return rows;
    }

    private static MonitoringSource Failure(string id, string status, string reason) =>
        new(id, status, DateTimeOffset.UtcNow, reason, []);
    private sealed record MonitoringMetric(string Id, string ResourceId, string Metric,
        string Aggregation = "Average", string Unit = "", double? Limit = null);
}
