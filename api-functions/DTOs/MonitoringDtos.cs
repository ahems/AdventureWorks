#nullable enable
namespace api_functions.DTOs;

public sealed record MonitoringSource(string Id, string Status, DateTimeOffset AsOf,
    string? Reason, IReadOnlyList<IReadOnlyDictionary<string, object?>> Rows);
public sealed record MonitoringSummary(DateTimeOffset AsOf, string Range, string Status,
    string IngestionNote, IReadOnlyList<MonitoringSource> Sources, IReadOnlyDictionary<string, string> Links);
public sealed record MonitoringTrace(DateTimeOffset AsOf, string TraceId, string Status, MonitoringSource Source,
    IReadOnlyList<MonitoringCapturedSpan> RichContent);
public sealed record MonitoringCapturedSpan(string SpanId, IReadOnlyDictionary<string, CapturedField> Fields);
public sealed record CaptureStartRequest(string ScopeType, string ScopeId);
public sealed record CaptureGrant(string Id, string ScopeType, string ScopeId, DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt, int MaxRootOperations, int RootOperations, string Status);
public sealed record CaptureStatus(DateTimeOffset AsOf, IReadOnlyList<CaptureGrant> Captures, string Notice);
public sealed record CaptureLease(string CaptureId, string ScopeType, string ScopeId, string RootOperationId)
{
    [System.Text.Json.Serialization.JsonIgnore]
    public bool NewlyAdmitted { get; init; }
}
public sealed record CapturedField(string? Text, int OriginalBytes, bool Truncated, bool Omitted);
