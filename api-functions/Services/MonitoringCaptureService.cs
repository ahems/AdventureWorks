#nullable enable
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Azure;
using Azure.Data.Tables;
using Azure.Identity;
using api_functions.DTOs;
using Microsoft.Extensions.Configuration;

namespace api_functions.Services;

public interface IMonitoringCaptureStore
{
    Task<CaptureGrant> CreateAsync(string scopeType, string scopeId, CancellationToken ct);
    Task<IReadOnlyList<CaptureGrant>> ListAsync(CancellationToken ct);
    async Task<CaptureGrant?> FindActiveAsync(string scopeType, string scopeId, CancellationToken ct) =>
        (await ListAsync(ct)).FirstOrDefault(g => g.ScopeType == scopeType && g.ScopeId == scopeId
            && (g.Status is "active" or "exhausted") && g.ExpiresAt > DateTimeOffset.UtcNow);
    Task<CaptureGrant?> StopAsync(string id, CancellationToken ct);
    Task<CaptureLease?> AcquireAsync(string id, string scopeType, string scopeId, string rootOperationId, CancellationToken ct);
    Task<bool> ActiveAsync(CaptureLease lease, CancellationToken ct);
    Task<bool> SpendAsync(CaptureLease lease, int bytes, CancellationToken ct);
}

public sealed class MonitoringCaptureService(IMonitoringCaptureStore store, WebPubSubService? updates = null)
{
    public const string Notice = "Capture is off unless a matching server-created grant is active. Stop/expiry prevents future application content; already ingested telemetry retains its normal retention. This does not control Foundry server-managed tracing.";
    public Task<CaptureGrant> StartAsync(CaptureStartRequest request, CancellationToken ct = default)
    {
        ValidateScope(request.ScopeType, request.ScopeId);
        return store.CreateAsync(request.ScopeType, request.ScopeId, ct);
    }
    public async Task<CaptureStatus> StatusAsync(CancellationToken ct = default) =>
        new(DateTimeOffset.UtcNow, await store.ListAsync(ct), Notice);
    public async Task<CaptureGrant?> FindActiveAsync(string scopeType, string scopeId, CancellationToken ct = default)
    {
        ValidateScope(scopeType, scopeId);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        try { return await store.FindActiveAsync(scopeType, scopeId, deadline.Token); }
        catch (Exception e) when (e is RequestFailedException or OperationCanceledException or AuthenticationFailedException)
        { return null; }
    }
    public Task<CaptureGrant?> StopAsync(string id, CancellationToken ct = default)
    {
        ValidateId(id);
        return store.StopAsync(id, ct);
    }
    public async Task<CaptureLease?> TryAcquireRootAsync(string? captureId, string scopeType, string scopeId,
        string rootOperationId, CancellationToken ct = default)
    {
        if (captureId is null) return null;
        try { ValidateId(captureId); ValidateScope(scopeType, scopeId); ValidateScope("job", rootOperationId); }
        catch (ArgumentException) { return null; }
        var lease = await FailClosedAsync(() => store.AcquireAsync(captureId, scopeType, scopeId, rootOperationId, ct));
        if (lease?.NewlyAdmitted == true && updates is not null)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(2));
            try
            {
                await updates.SendToGroupAsync("utilities", new { @event = "monitoring-capture-changed" })
                    .WaitAsync(deadline.Token);
            }
            catch (Exception)
            {
                // Persistence and capture admission do not depend on best-effort invalidation delivery.
            }
        }
        return lease;
    }
    public async Task<bool> IsActiveAsync(CaptureLease lease, CancellationToken ct = default)
    {
        try { return await store.ActiveAsync(lease, ct); }
        catch (Exception e) when (e is RequestFailedException or OperationCanceledException or AuthenticationFailedException) { return false; }
    }
    public async Task<IReadOnlyDictionary<string, CapturedField>> SanitizeFieldsAsync(CaptureLease lease,
        IReadOnlyDictionary<string, string?> fields, CancellationToken ct = default)
    {
        var result = new Dictionary<string, CapturedField>();
        if (!await IsActiveAsync(lease, ct)) return result;
        foreach (var (key, value) in fields.Take(16))
        {
            var field = MonitoringContent.Sanitize(key, value);
            if (!field.Omitted)
            {
                try
                {
                    if (!await store.SpendAsync(lease, Encoding.UTF8.GetByteCount(field.Text ?? ""), ct))
                        field = field with { Text = null, Omitted = true };
                }
                catch (Exception e) when (e is RequestFailedException or OperationCanceledException or AuthenticationFailedException)
                { field = field with { Text = null, Omitted = true }; }
            }
            result[key] = field;
        }
        return result;
    }
    public static void ValidateScope(string type, string id)
    {
        if (type is not ("session" or "job") || string.IsNullOrWhiteSpace(id)
            || !Regex.IsMatch(id, "^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$"))
            throw new ArgumentException("Select session or job with a valid stable identifier (1-128 characters).");
    }
    private static void ValidateId(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("Invalid capture ID.");
    }
    private static async Task<CaptureLease?> FailClosedAsync(Func<Task<CaptureLease?>> action)
    {
        try { return await action(); }
        catch (Exception e) when (e is RequestFailedException or OperationCanceledException or AuthenticationFailedException) { return null; }
    }
}

public static class MonitoringContent
{
    private static readonly HashSet<string> Allowed = new(StringComparer.Ordinal)
        { "input", "output", "toolArguments", "toolResult", "reasoningSummary" };
    public static CapturedField Sanitize(string key, string? value)
    {
        var original = Encoding.UTF8.GetByteCount(value ?? "");
        if (!Allowed.Contains(key) || value is null || original > 256 * 1024
            || Regex.IsMatch(value, @"(?i)data:[^;]*;base64|[a-zA-Z0-9+/]{80,}={0,2}|\[\s*-?\d+(\.\d+)?(\s*,\s*-?\d+(\.\d+)?){15,}"))
            return new(null, original, false, true);
        var redacted = Redact(value, 4096);
        return new(redacted, original, Encoding.UTF8.GetByteCount(Redact(value, int.MaxValue)) > 4096, false);
    }
    public static string Redact(string text, int maxBytes)
    {
        text = Regex.Replace(text, @"(?i)\bBearer\s+[^\s""']+", "Bearer [redacted]");
        text = Regex.Replace(text, @"\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b", "[redacted]");
        text = Regex.Replace(text, """(?i)(["']?(?:password|passwd|secret|token|authorization|api[-_]?key|code_verifier|code|state|connectionstring|connection_string)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)""", "$1[redacted]");
        text = Regex.Replace(text, @"(?i)\b(password|passwd|secret|token|api[-_ ]key)\s+(?:is\s+)?[^\s,;&}]+", "$1 [redacted]");
        text = Regex.Replace(text, @"https?://[^\s""'<>]+", match =>
        {
            var value = match.Value;
            value = Regex.Replace(value, @"(?i)^(https?://)[^/@\s]+@", "$1[redacted]@");
            var boundary = value.IndexOfAny(['?', '#']);
            return boundary < 0 ? value : value[..boundary] + "?[redacted]";
        });
        text = Regex.Replace(text, @"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[email redacted]");
        text = Regex.Replace(text, @"\b(?:\d[ -]*?){13,19}\b", "[number redacted]");
        if (Encoding.UTF8.GetByteCount(text) <= maxBytes) return text;
        var builder = new StringBuilder();
        var count = 0;
        foreach (var rune in text.EnumerateRunes())
        {
            if (count + rune.Utf8SequenceLength > maxBytes) break;
            builder.Append(rune.ToString()); count += rune.Utf8SequenceLength;
        }
        return builder.ToString();
    }
}

/// <summary>Control metadata only. Transactional grant/root ETags enforce admission, Stop and the rich-byte budget across workers.</summary>
public sealed class TableMonitoringCaptureStore : IMonitoringCaptureStore
{
    private readonly TableClient _table;
    public TableMonitoringCaptureStore(IConfiguration configuration, DefaultAzureCredential credential)
    {
        var name = configuration["STORAGE_ACCOUNT_NAME"]
            ?? throw new InvalidOperationException("STORAGE_ACCOUNT_NAME is required.");
        _table = new TableClient(new Uri($"https://{name}.table.core.windows.net"), "awMonitoringCapture", credential);
    }
    public TableMonitoringCaptureStore(TableClient table) => _table = table;

    public async Task<CaptureGrant> CreateAsync(string scopeType, string scopeId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var entity = new TableEntity(Guid.NewGuid().ToString("N"), "grant")
        {
            ["ScopeType"] = scopeType, ["ScopeId"] = scopeId, ["CreatedAt"] = now,
            ["ExpiresAt"] = now.AddMinutes(15), ["RootOperations"] = 0, ["Stopped"] = false
        };
        await _table.AddEntityAsync(entity, ct);
        return Project(entity);
    }
    public async Task<IReadOnlyList<CaptureGrant>> ListAsync(CancellationToken ct)
    {
        var rows = new List<CaptureGrant>();
        var filter = TableClient.CreateQueryFilter($"RowKey eq {"grant"} and ExpiresAt gt {DateTimeOffset.UtcNow.AddHours(-24)}");
        await foreach (var row in _table.QueryAsync<TableEntity>(filter, maxPerPage: 100, cancellationToken: ct))
        {
            rows.Add(Project(row)); if (rows.Count == 100) break;
        }
        return rows.OrderByDescending(r => r.CreatedAt).ToArray();
    }
    public async Task<CaptureGrant?> StopAsync(string id, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 8; attempt++)
        {
            var grant = await GetAsync(id, "grant", ct);
            if (grant is null) return null;
            if (grant.GetBoolean("Stopped") == true) return Project(grant);
            grant["Stopped"] = true;
            try { await _table.UpdateEntityAsync(grant, grant.ETag, TableUpdateMode.Replace, ct); return Project(grant); }
            catch (RequestFailedException e) when (e.Status == 412) { }
        }
        throw new RequestFailedException(409, "Concurrent capture update; retry Stop.");
    }
    public async Task<CaptureGrant?> FindActiveAsync(string scopeType, string scopeId, CancellationToken ct)
    {
        var filter = TableClient.CreateQueryFilter($"RowKey eq {"grant"} and ScopeType eq {scopeType} and ScopeId eq {scopeId} and Stopped eq {false} and ExpiresAt gt {DateTimeOffset.UtcNow}");
        await foreach (var row in _table.QueryAsync<TableEntity>(filter, maxPerPage: 1, cancellationToken: ct))
            return Project(row);
        return null;
    }
    public async Task<CaptureLease?> AcquireAsync(string id, string scopeType, string scopeId, string rootOperationId, CancellationToken ct)
    {
        var lease = new CaptureLease(id, scopeType, scopeId, rootOperationId);
        for (var attempt = 0; attempt < 8; attempt++)
        {
            var grant = await GetAsync(id, "grant", ct);
            if (!Matches(grant, lease)) return null;
            var key = RootKey(rootOperationId);
            if (await GetAsync(id, key, ct) is not null) return lease;
            var count = grant!.GetInt32("RootOperations") ?? 0;
            if (count >= 100) return null;
            grant["RootOperations"] = count + 1;
            var root = new TableEntity(id, key) { ["Bytes"] = 0 };
            try
            {
                await _table.SubmitTransactionAsync([
                    new(TableTransactionActionType.UpdateReplace, grant, grant.ETag),
                    new(TableTransactionActionType.Add, root)
                ], ct);
                return lease with { NewlyAdmitted = true };
            }
            catch (RequestFailedException e) when (e.Status is 409 or 412) { }
        }
        return null;
    }
    public async Task<bool> ActiveAsync(CaptureLease lease, CancellationToken ct) =>
        Matches(await GetAsync(lease.CaptureId, "grant", ct), lease)
        && await GetAsync(lease.CaptureId, RootKey(lease.RootOperationId), ct) is not null;
    public async Task<bool> SpendAsync(CaptureLease lease, int bytes, CancellationToken ct)
    {
        if (bytes < 0 || bytes > 4096) return false;
        for (var attempt = 0; attempt < 8; attempt++)
        {
            var grant = await GetAsync(lease.CaptureId, "grant", ct);
            if (!Matches(grant, lease)) return false;
            var root = await GetAsync(lease.CaptureId, RootKey(lease.RootOperationId), ct);
            if (root is null || (root.GetInt32("Bytes") ?? 0) + bytes > 32768) return false;
            root["Bytes"] = (root.GetInt32("Bytes") ?? 0) + bytes;
            try
            {
                await _table.SubmitTransactionAsync([
                    new(TableTransactionActionType.UpdateReplace, grant!, grant!.ETag),
                    new(TableTransactionActionType.UpdateReplace, root, root.ETag)
                ], ct);
                return true;
            }
            catch (RequestFailedException e) when (e.Status is 409 or 412) { }
        }
        return false;
    }
    private async Task<TableEntity?> GetAsync(string id, string row, CancellationToken ct) =>
        await GetExistingAsync(id, row, ct);
    private async Task<TableEntity?> GetExistingAsync(string id, string row, CancellationToken ct)
    {
        var response = await _table.GetEntityIfExistsAsync<TableEntity>(id, row, cancellationToken: ct);
        return response.HasValue ? response.Value : null;
    }
    private static bool Matches(TableEntity? grant, CaptureLease lease) => grant is not null
        && grant.GetBoolean("Stopped") != true && grant.GetDateTimeOffset("ExpiresAt") > DateTimeOffset.UtcNow
        && grant.GetString("ScopeType") == lease.ScopeType && grant.GetString("ScopeId") == lease.ScopeId;
    private static string RootKey(string root) => "root-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(root)));
    private static CaptureGrant Project(TableEntity row)
    {
        var expires = row.GetDateTimeOffset("ExpiresAt")!.Value;
        var count = row.GetInt32("RootOperations") ?? 0;
        return new(row.PartitionKey, row.GetString("ScopeType")!, row.GetString("ScopeId")!,
            row.GetDateTimeOffset("CreatedAt")!.Value, expires, 100, count,
            row.GetBoolean("Stopped") == true ? "stopped" : expires <= DateTimeOffset.UtcNow ? "expired" : count >= 100 ? "exhausted" : "active");
    }
}
