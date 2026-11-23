using System.Diagnostics;
using System.Diagnostics.Metrics;
using api_functions.Services;
using Xunit;

namespace ApiFunctions.Tests;

public class GenAiTelemetryTests
{
    [Fact]
    public void Responses_count_all_rounds_and_retries_once_with_token_subsets()
    {
        using var root = new Activity("usage-fixture").SetIdFormat(ActivityIdFormat.W3C).Start();
        var readings = new List<(string Type, long Count)>();
        var subsets = new List<(string Type, long Count)>();
        var unknown = 0L;
        using var activities = Listen();
        using var meter = new MeterListener();
        meter.InstrumentPublished = (instrument, listener) =>
        {
            if (instrument.Meter.Name == GenAiTelemetry.SourceName) listener.EnableMeasurementEvents(instrument);
        };
        meter.SetMeasurementEventCallback<long>((instrument, value, tags, _) =>
        {
            if (Activity.Current?.TraceId != root.TraceId) return;
            if (instrument.Name == "gen_ai.client.usage.unknown") unknown += value;
            if (instrument.Name is "gen_ai.client.token.usage" or "aw.gen_ai.token.subset.usage")
            {
                foreach (var tag in tags)
                    if (tag.Key == "gen_ai.token.type")
                        (instrument.Name == "gen_ai.client.token.usage" ? readings : subsets).Add((tag.Value!.ToString()!, value));
            }
        });
        meter.Start();
        var seen = new HashSet<string>();
        var responses = new[]
        {
            """{"id":"approval","usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}}}""",
            """{"id":"retry","status":"failed","usage":{"input_tokens":7,"output_tokens":1}}""",
            """{"id":"final","usage":{"input_tokens":12,"output_tokens":6}}""",
            """{"id":"final","usage":{"input_tokens":12,"output_tokens":6}}""",
            """{"id":"no-usage"}"""
        };
        foreach (var response in responses)
        {
            using var span = GenAiTelemetry.Start("chat", "fixture-model");
            span.RecordResponse(response, response.Contains("\"failed\"") ? 503 : 200,
                GenAiTelemetry.AdmitResponse(response, seen));
        }
        Assert.Equal(29, readings.Where(x => x.Type == "input").Sum(x => x.Count));
        Assert.Equal(11, readings.Where(x => x.Type == "output").Sum(x => x.Count));
        Assert.Equal(40, readings.Sum(x => x.Count));
        Assert.Contains(("input_cached", 3L), subsets);
        Assert.Contains(("output_reasoning", 2L), subsets);
        Assert.Equal(1, unknown);
    }

    [Theory]
    [InlineData("""{"usage":{"input_tokens":"private-marker","output_tokens":null}}""")]
    [InlineData("""{"usage":{"input_tokens":-1}}""")]
    [InlineData("not-json")]
    public void Malformed_or_missing_usage_never_invents_zero_or_leaks_response(string response)
    {
        var ended = new List<Activity>();
        using var listener = Listen(ended);
        using (var span = GenAiTelemetry.Start("chat", "fixture-model")) span.RecordResponse(response, 200);
        var activity = Assert.Single(ended, x => x.GetTagItem("gen_ai.request.model")?.ToString() == "fixture-model");
        Assert.Null(activity.GetTagItem("gen_ai.usage.input_tokens"));
        Assert.DoesNotContain("private-marker", string.Join("|", activity.TagObjects.Select(x => x.Value)));
    }

    private static ActivityListener Listen(List<Activity>? ended = null)
    {
        var listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name == GenAiTelemetry.SourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
            ActivityStopped = activity =>
            {
                if (activity.GetTagItem("gen_ai.request.model")?.ToString() == "fixture-model") ended?.Add(activity);
            }
        };
        ActivitySource.AddActivityListener(listener);
        return listener;
    }
}
