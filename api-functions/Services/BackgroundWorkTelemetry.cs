using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Azure;
using Azure.Storage.Queues;
using Azure.Storage.Queues.Models;

namespace api_functions.Services;

public sealed record QueueTelemetryContext(
    string? TraceParent = null, string? JobId = null, DateTimeOffset? EnqueuedAt = null,
    double VisibilityDelaySeconds = 0, string? CaptureId = null);

/// <summary>Metadata only: a capture reference never authorizes content collection.</summary>
public static class BackgroundWorkTelemetry
{
    public const string SourceName = "AdventureWorks.BackgroundWork";
    private static readonly ActivitySource Source = new(SourceName);
    private static readonly Meter Meter = new(SourceName);
    private static readonly Counter<long> Outcomes = Meter.CreateCounter<long>("background.attempt.outcomes");
    private static readonly Counter<long> Retries = Meter.CreateCounter<long>("background.retry.count");
    private static readonly Histogram<double> Wait = Meter.CreateHistogram<double>("background.queue.wait", "s");
    private static readonly Histogram<double> Delay = Meter.CreateHistogram<double>("background.queue.visibility_delay", "s");
    private static readonly Histogram<double> Duration = Meter.CreateHistogram<double>("background.attempt.duration", "s");
    private static readonly AsyncLocal<QueueTelemetryContext?> Current = new();
    private static readonly AsyncLocal<Attempt?> CurrentAttempt = new();
    private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };
    public static QueueTelemetryContext? CurrentContext => Current.Value;
    private static readonly Histogram<double> NotificationAge = Meter.CreateHistogram<double>("background.sql.notification_age", "s");
    private static readonly Histogram<long> BatchSize = Meter.CreateHistogram<long>("background.sql.batch_size", "{notification}");

    public static void RecordNotificationBatch(int count) => BatchSize.Record(count);
    public static void RecordNotificationAge(DateTime createdAt)
    {
        if (createdAt == default) return;
        var age = (DateTime.UtcNow - DateTime.SpecifyKind(createdAt, DateTimeKind.Utc)).TotalSeconds;
        if (age >= 0) NotificationAge.Record(age);
    }

    public static QueueTelemetryContext? Validate(QueueTelemetryContext? value, DateTimeOffset now)
    {
        if (value is null) return null;
        var trace = value.TraceParent is { Length: 55 } &&
            ActivityContext.TryParse(value.TraceParent, null, out var parent) &&
            parent.TraceId != default && parent.SpanId != default ? value.TraceParent : null;
        var job = Guid.TryParse(value.JobId, out var jobId) ? jobId.ToString("N") : null;
        var capture = Guid.TryParse(value.CaptureId, out var captureId) ? captureId.ToString("N") : null;
        var timestamp = value.EnqueuedAt is { } time && time <= now && time >= now.AddDays(-7) ? value.EnqueuedAt : null;
        var delay = double.IsFinite(value.VisibilityDelaySeconds) && value.VisibilityDelaySeconds is >= 0 and <= 604800
            ? value.VisibilityDelaySeconds : 0;
        return new(trace, job, timestamp, delay, capture);
    }

    public static string Stamp(string message, TimeSpan? visibilityDelay = null)
    {
        var encoded = false;
        JsonObject? body;
        try { body = JsonNode.Parse(message) as JsonObject; }
        catch (JsonException)
        {
            try { body = JsonNode.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(message))) as JsonObject; encoded = true; }
            catch (Exception ex) when (ex is FormatException or JsonException) { return message; }
        }
        if (body is null) return message;
        var now = DateTimeOffset.UtcNow;
        QueueTelemetryContext? previous = null;
        try { previous = ReadContext(body); } catch (JsonException) { }
        var envelopeContext = Validate(previous, now);
        previous = envelopeContext ?? Validate(Current.Value, now);
        var workflowId = body.FirstOrDefault(p => p.Key.Equals("JobId", StringComparison.OrdinalIgnoreCase)
            || p.Key.Equals("RunId", StringComparison.OrdinalIgnoreCase)
            || p.Key.Equals("OperationId", StringComparison.OrdinalIgnoreCase)).Value;
        var stableId = workflowId is JsonValue id && id.TryGetValue<string>(out var text) && Guid.TryParse(text, out var guid)
            ? guid.ToString("N") : null;
        var context = new QueueTelemetryContext(
            Activity.Current?.Id ?? previous?.TraceParent,
            envelopeContext?.JobId ?? stableId ?? previous?.JobId ?? Guid.NewGuid().ToString("N"),
            now, Math.Max(0, visibilityDelay?.TotalSeconds ?? 0), previous?.CaptureId);
        foreach (var key in body.Select(p => p.Key).Where(k => k.Equals("Telemetry", StringComparison.OrdinalIgnoreCase)).ToArray())
            body.Remove(key);
        body["Telemetry"] = JsonSerializer.SerializeToNode(Validate(context, now));
        var result = body.ToJsonString();
        return encoded ? Convert.ToBase64String(Encoding.UTF8.GetBytes(result)) : result;
    }

    private static QueueTelemetryContext? ReadContext(JsonNode? body) =>
        (body as JsonObject)?.FirstOrDefault(p => p.Key.Equals("Telemetry", StringComparison.OrdinalIgnoreCase))
            .Value?.Deserialize<QueueTelemetryContext>(Options);

    public static Task<Response<SendReceipt>> SendObservedMessageAsync(this QueueClient queue, BinaryData message,
        TimeSpan? visibilityTimeout = null, TimeSpan? timeToLive = null, CancellationToken cancellationToken = default) =>
        queue.SendMessageAsync(BinaryData.FromString(Stamp(message.ToString(), visibilityTimeout)),
            visibilityTimeout, timeToLive, cancellationToken);

    public static Task<Response<SendReceipt>> SendObservedMessageAsync(this QueueClient queue, string message,
        TimeSpan? visibilityTimeout = null, TimeSpan? timeToLive = null, CancellationToken cancellationToken = default) =>
        queue.SendMessageAsync(Stamp(message, visibilityTimeout), visibilityTimeout, timeToLive, cancellationToken);

    public static Task<Response<SendReceipt>> SendObservedMessageAsync(this QueueClient queue, string message,
        CancellationToken cancellationToken) =>
        queue.SendMessageAsync(Stamp(message), cancellationToken);

    public static Attempt Begin(string operation, string? message = null, QueueTelemetryContext? context = null,
        ActivityKind kind = ActivityKind.Consumer, string failureOutcome = "retrying")
    {
        if (context is null && message is not null)
        {
            try
            {
                if (!message.TrimStart().StartsWith('{'))
                    message = Encoding.UTF8.GetString(Convert.FromBase64String(message));
                var body = JsonNode.Parse(message);
                context = ReadContext(body);
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException) { }
        }
        return new Attempt(operation, Validate(context, DateTimeOffset.UtcNow), kind, failureOutcome);
    }

    public static void Outcome(string outcome) => CurrentAttempt.Value?.SetOutcome(outcome);
    public static void Retry() => CurrentAttempt.Value?.RecordRetry();

    public sealed class Attempt : IDisposable
    {
        private readonly string operation;
        private readonly long started = Stopwatch.GetTimestamp();
        private readonly Activity? activity;
        private readonly QueueTelemetryContext? previous;
        private readonly Attempt? previousAttempt;
        private string outcome;
        private bool decided;
        private bool disposed;

        internal Attempt(string operation, QueueTelemetryContext? context, ActivityKind kind, string failureOutcome)
        {
            this.operation = operation;
            outcome = failureOutcome;
            previous = Current.Value;
            previousAttempt = CurrentAttempt.Value;
            Current.Value = context;
            CurrentAttempt.Value = this;
            var parent = default(ActivityContext);
            if (kind == ActivityKind.Internal && Activity.Current is { } native) parent = native.Context;
            else if (context?.TraceParent is { } trace) ActivityContext.TryParse(trace, null, isRemote: true, out parent);
            activity = Source.StartActivity(operation, kind, parent);
            activity?.SetTag("job.id", context?.JobId);
            activity?.SetTag("capture.reference", context?.CaptureId);
            if (kind == ActivityKind.Consumer) activity?.SetTag("messaging.operation.type", "process");
            if (kind == ActivityKind.Consumer && context?.EnqueuedAt is { } enqueued)
            {
                var age = Math.Max(0, (DateTimeOffset.UtcNow - enqueued).TotalSeconds);
                Wait.Record(Math.Max(0, age - context.VisibilityDelaySeconds), new KeyValuePair<string, object?>("operation", operation));
                Delay.Record(context.VisibilityDelaySeconds, new KeyValuePair<string, object?>("operation", operation));
            }
        }

        public void SetOutcome(string value)
        {
            if (value is not ("completed" or "rejected" or "skipped" or "partial" or "retrying" or "poisoned" or "failed" or "cancelled"))
                throw new ArgumentOutOfRangeException(nameof(value));
            outcome = value;
            decided = true;
        }

        public void Complete() { if (!decided) SetOutcome("completed"); }
        internal void RecordRetry() => Retries.Add(1, new KeyValuePair<string, object?>("operation", operation));

        public void Tag(string key, object? value) => activity?.SetTag(key, value);

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            activity?.SetTag("outcome", outcome);
            if (outcome is "failed" or "poisoned" or "partial") activity?.SetStatus(ActivityStatusCode.Error);
            var tags = new TagList { { "operation", operation }, { "outcome", outcome } };
            Outcomes.Add(1, tags);
            Duration.Record(Stopwatch.GetElapsedTime(started).TotalSeconds, tags);
            activity?.Dispose();
            Current.Value = previous;
            CurrentAttempt.Value = previousAttempt;
        }
    }
}
