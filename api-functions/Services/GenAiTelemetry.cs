using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text.Json;

namespace api_functions.Services;

/// <summary>Metadata-only model accounting. Provider token details are subsets, not additive totals.</summary>
public sealed class GenAiTelemetry : IDisposable
{
    public const string SourceName = "AdventureWorks.GenAI";
    private static readonly ActivitySource Source = new(SourceName);
    private static readonly Meter Meter = new(SourceName);
    private static readonly Counter<long> Outcomes = Meter.CreateCounter<long>("gen_ai.client.operation.count");
    private static readonly Histogram<double> Durations = Meter.CreateHistogram<double>("gen_ai.client.operation.duration", "s");
    private static readonly Histogram<long> Tokens = Meter.CreateHistogram<long>("gen_ai.client.token.usage", "{token}");
    private static readonly Histogram<long> TokenSubsets = Meter.CreateHistogram<long>("aw.gen_ai.token.subset.usage", "{token}");
    private static readonly Counter<long> UnknownUsage = Meter.CreateCounter<long>("gen_ai.client.usage.unknown");
    private static readonly Counter<long> Retries = Meter.CreateCounter<long>("gen_ai.client.retry.count");
    private static readonly Histogram<double> Backoff = Meter.CreateHistogram<double>("gen_ai.client.retry.backoff", "s");
    private readonly Activity? _activity;
    private readonly long _started = Stopwatch.GetTimestamp();
    private readonly string _operation;
    private string _model;
    private string? _agent;
    private string _outcome = "application-failure";
    private bool _disposed;
    private bool _responseSeen;
    private double? _responseSeconds;

    private GenAiTelemetry(string operation, string model)
    {
        _operation = operation;
        _model = model;
        _activity = Source.StartActivity($"{operation} {model}", ActivityKind.Internal);
        _activity?.SetTag("gen_ai.operation.name", operation);
        _activity?.SetTag("gen_ai.provider.name", operation is "embeddings" or "image_generation"
            ? "azure.ai.openai" : "azure.ai.foundry");
        _activity?.SetTag("gen_ai.request.model", model);
    }

    public static GenAiTelemetry Start(string operation, string model = "unknown") => new(operation, model);
    public string? SpanId => _activity?.SpanId.ToHexString();
    public void Tag(string key, object? value)
    {
        if (key == "gen_ai.request.model" && value is string model) _model = model;
        if (key == "gen_ai.agent.id" && value is string agent)
        {
            _agent = agent;
            if (_operation == "invoke_agent" && _activity is not null) _activity.DisplayName = $"invoke_agent {agent}";
        }
        _activity?.SetTag(key, value);
    }
    public void Complete(string outcome = "success") => _outcome = outcome;

    public void RecordResponse(string body, int statusCode, bool accountUsage = true)
    {
        _responseSeen = true;
        _responseSeconds = Stopwatch.GetElapsedTime(_started).TotalSeconds;
        _activity?.SetEndTime(DateTime.UtcNow);
        Tag("http.response.status_code", statusCode);
        Complete(statusCode is >= 200 and < 300 ? "success" :
            statusCode == 429 ? "throttled" : statusCode is 401 or 403 ? "unauthorized" : "upstream-failure");
        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                RecordUnknown();
                return;
            }
            if (root.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String)
                Tag("gen_ai.response.id", id.GetString());
            if (root.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.String
                && status.GetString() is "failed" or "incomplete")
                Complete(status.GetString() == "incomplete" ? "partial" : "upstream-failure");
            if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
                Complete("upstream-failure");
            if (root.TryGetProperty("output", out var output) && output.ValueKind == JsonValueKind.Array)
                foreach (var item in output.EnumerateArray())
                    if (item.ValueKind == JsonValueKind.Object && item.TryGetProperty("content", out var content)
                        && content.ValueKind == JsonValueKind.Array)
                        foreach (var part in content.EnumerateArray())
                            if (part.ValueKind == JsonValueKind.Object && part.TryGetProperty("type", out var type)
                                && type.ValueKind == JsonValueKind.String && type.GetString() == "refusal")
                            {
                                Complete("refused");
                                Tag("gen_ai.response.finish_reasons", new[] { "refusal" });
                            }
            if (!accountUsage)
            {
                Tag("aw.usage.status", "duplicate-response");
                return;
            }
            if (!root.TryGetProperty("usage", out var usage) || usage.ValueKind != JsonValueKind.Object)
            {
                RecordUnknown();
                return;
            }

            var inputKnown = RecordToken(usage, "input_tokens", "input", "gen_ai.usage.input_tokens") ||
                RecordToken(usage, "prompt_tokens", "input", "gen_ai.usage.input_tokens");
            var outputKnown = RecordToken(usage, "output_tokens", "output", "gen_ai.usage.output_tokens");
            if (!inputKnown || (!outputKnown && _operation != "embeddings")) RecordUnknown();
            Tag("aw.usage.status", inputKnown && (outputKnown || _operation == "embeddings") ? "available" : "partial");
            if (usage.TryGetProperty("input_tokens_details", out var inputDetails))
                RecordToken(inputDetails, "cached_tokens", "input_cached", "gen_ai.usage.cache_read.input_tokens");
            if (usage.TryGetProperty("output_tokens_details", out var outputDetails))
                RecordToken(outputDetails, "reasoning_tokens", "output_reasoning", "gen_ai.usage.reasoning.output_tokens");
            // Reasoning output/encrypted content is deliberately never read. Only documented token counts.
        }
        catch (JsonException)
        {
            RecordUnknown();
        }
    }

    public void RecordRetry(double backoffSeconds)
    {
        var tags = new TagList { { "gen_ai.operation.name", _operation }, { "gen_ai.request.model", _model } };
        if (_agent is not null) tags.Add("gen_ai.agent.name", _agent);
        Retries.Add(1, tags);
        Backoff.Record(backoffSeconds, tags);
    }

    public static bool AdmitResponse(string body, ISet<string> seen)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            return document.RootElement.ValueKind != JsonValueKind.Object ||
                !document.RootElement.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String
                || string.IsNullOrEmpty(id.GetString()) || seen.Add(id.GetString()!);
        }
        catch (JsonException) { return true; }
    }

    private bool RecordToken(JsonElement usage, string field, string type, string tag)
    {
        if (usage.ValueKind != JsonValueKind.Object || !usage.TryGetProperty(field, out var value)
            || value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var count) || count < 0)
            return false;
        Tag(tag, count);
        (type is "input" or "output" ? Tokens : TokenSubsets).Record(count, new TagList { { "gen_ai.operation.name", _operation },
            { "gen_ai.request.model", _model }, { "gen_ai.agent.name", _agent }, { "gen_ai.token.type", type } });
        return true;
    }

    private void RecordUnknown()
    {
        Tag("aw.usage.status", "unknown");
        UnknownUsage.Add(1, new TagList { { "gen_ai.operation.name", _operation }, { "gen_ai.request.model", _model },
            { "gen_ai.agent.name", _agent } });
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (!_responseSeen && _operation is "chat" or "embeddings" or "image_generation") RecordUnknown();
        Tag("aw.outcome", _outcome);
        if (_outcome is "application-failure" or "upstream-failure" or "throttled")
            _activity?.SetStatus(ActivityStatusCode.Error);
        var tags = new TagList { { "gen_ai.operation.name", _operation },
            { "gen_ai.request.model", _model }, { "gen_ai.agent.name", _agent }, { "aw.outcome", _outcome } };
        Outcomes.Add(1, tags);
        Durations.Record(_responseSeconds ?? Stopwatch.GetElapsedTime(_started).TotalSeconds, tags);
        _activity?.Dispose();
    }
}
