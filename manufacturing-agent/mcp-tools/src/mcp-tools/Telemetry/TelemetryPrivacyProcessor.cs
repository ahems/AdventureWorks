using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text.RegularExpressions;
using OpenTelemetry;
using OpenTelemetry.Logs;

namespace AdventureWorks.Telemetry;

/// <summary>Protect automatic instrumentation as well as application-owned metadata.</summary>
public sealed partial class TelemetryPrivacyProcessor : BaseProcessor<Activity>
{
    private static readonly Meter Meter = new("AdventureWorks.Telemetry");
    private static readonly Counter<long> WithheldSpans = Meter.CreateCounter<long>("aw.telemetry.redacted_span.count");

    public override void OnEnd(Activity activity)
    {
        if (activity.Status == ActivityStatusCode.Error && activity.StatusDescription is not null)
            activity.SetStatus(ActivityStatusCode.Error, "Operation failed; details omitted.");
        foreach (var (key, value) in activity.TagObjects.ToArray())
        {
            if (Remove(key))
                activity.SetTag(key, null);
            else if (value is string text)
                activity.SetTag(key, Clean(text));
        }
        foreach (var activityEvent in activity.Events)
        {
            foreach (var (key, value) in activityEvent.Tags)
            {
                if (Remove(key) || (activityEvent.Name.StartsWith("gen_ai.", StringComparison.Ordinal) &&
                    key is "content" or "body" or "arguments" or "result") ||
                    (value is string text && Clean(text) != text))
                {
                    // Activity event payloads are immutable. Fail closed before trace exporters.
                    activity.ActivityTraceFlags &= ~ActivityTraceFlags.Recorded;
                    WithheldSpans.Add(1, new KeyValuePair<string, object?>("reason", "unsafe-event"));
                    return;
                }
            }
        }
    }

    internal static bool Remove(string key) =>
        key.StartsWith("http.request.header.", StringComparison.OrdinalIgnoreCase) ||
        key.StartsWith("http.response.header.", StringComparison.OrdinalIgnoreCase) ||
        SecretKey().IsMatch(key) ||
        key is "url.query" or "db.statement" or "db.query.text" or "exception.message" or "exception.stacktrace" ||
        key.StartsWith("gen_ai.input.", StringComparison.Ordinal) ||
        key.StartsWith("gen_ai.output.", StringComparison.Ordinal) ||
        key.StartsWith("gen_ai.prompt", StringComparison.Ordinal) ||
        key.StartsWith("gen_ai.completion", StringComparison.Ordinal) ||
        key is "gen_ai.system_instructions" or "gen_ai.tool.definitions" or
            "gen_ai.tool.call.arguments" or "gen_ai.tool.call.result";

    internal static string Clean(string text)
    {
        text = Url().Replace(text, match =>
        {
            var url = match.Value;
            var index = url.IndexOfAny(['?', '#']);
            return index < 0 ? url : url[..index];
        });
        text = Bearer().Replace(text, "[redacted]");
        return Secret().Replace(text, "$1=[redacted]");
    }

    [GeneratedRegex(@"https?://[^\s""<>]+", RegexOptions.IgnoreCase)]
    private static partial Regex Url();
    [GeneratedRegex(@"\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", RegexOptions.IgnoreCase)]
    private static partial Regex Bearer();
    [GeneratedRegex("""\b(password|authorization|access_token|refresh_token|client_secret|client_assertion|id_token|code_verifier|code_challenge|api_key|reset_token|code|state)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,\s;]+)""", RegexOptions.IgnoreCase)]
    private static partial Regex Secret();
    [GeneratedRegex(@"^(password|authorization|access_token|refresh_token|client_secret|client_assertion|id_token|code_verifier|code_challenge|api_key|reset_token|token|code|state)$", RegexOptions.IgnoreCase)]
    private static partial Regex SecretKey();
}

public sealed class TelemetryLogPrivacyProcessor : BaseProcessor<LogRecord>
{
    public override void OnEnd(LogRecord record)
    {
        var failureType = record.Exception?.GetType().FullName;
        if (record.Exception is not null)
        {
            record.Exception = new InvalidOperationException("Operation failed; exception content omitted.");
            record.FormattedMessage = "Operation failed; exception content omitted.";
        }
        else if (record.FormattedMessage is { } message)
            record.FormattedMessage = TelemetryPrivacyProcessor.Clean(message);
        if (record.Body is { } body)
            record.Body = record.Exception is null ? TelemetryPrivacyProcessor.Clean(body)
                : "Operation failed; exception content omitted.";
        if (record.Attributes is { } attributes)
            record.Attributes = attributes.Where(pair => !TelemetryPrivacyProcessor.Remove(pair.Key))
                .Select(pair => new KeyValuePair<string, object?>(pair.Key, pair.Value is string text
                    ? TelemetryPrivacyProcessor.Clean(text)
                    : pair.Value is null or ValueType ? pair.Value : "[omitted]")).ToArray();
        if (failureType is not null)
            record.Attributes = (record.Attributes ?? []).Where(pair => pair.Key != "exception.type")
                .Append(new KeyValuePair<string, object?>("exception.type", failureType)).ToArray();
    }
}
