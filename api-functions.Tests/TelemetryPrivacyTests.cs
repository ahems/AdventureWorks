using System.Diagnostics;
using AdventureWorks.Telemetry;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using Xunit;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using OpenTelemetry;

namespace ApiFunctions.Tests;

public class TelemetryPrivacyTests
{
    [Fact]
    public void Exported_sdk3_events_and_nested_exceptions_omit_credentials()
    {
        var capture = new TelemetryTestCapture();
        using var configuration = capture.CreateConfiguration(privacy: true);
        var telemetry = new TelemetryClient(configuration);
        telemetry.TrackEvent("Fixture", new Dictionary<string, string>
        {
            ["access_token"] = "private-marker",
            ["url"] = "https://example.invalid/oauth?code=private-marker&state=private-marker",
            ["outcome"] = "application-failure"
        });
        telemetry.TrackException(new InvalidOperationException("private-marker",
            new Exception("password=private-marker")));
        var item = Assert.Single(capture.Items.OfType<EventTelemetry>());
        Assert.False(item.Properties.ContainsKey("access_token"));
        Assert.DoesNotContain("private-marker", string.Join("|", item.Properties.Values));
        var error = Assert.Single(capture.Items.OfType<ExceptionTelemetry>());
        Assert.DoesNotContain("private-marker", error.Exception.ToString());
    }

    [Fact]
    public void Automatic_span_urls_headers_and_sql_text_are_sanitized()
    {
        using var activity = new Activity("fixture").Start();
        activity.ActivityTraceFlags = ActivityTraceFlags.Recorded;
        activity.SetTag("url.full", "https://example.invalid/api?token=private-marker");
        activity.SetTag("http.request.header.authorization", "Bearer private-marker");
        activity.SetTag("db.query.text", "select 'private-marker'");
        activity.SetTag("gen_ai.input.messages", "private-marker");
        new TelemetryPrivacyProcessor().OnEnd(activity);
        Assert.Equal("https://example.invalid/api", activity.GetTagItem("url.full"));
        Assert.Null(activity.GetTagItem("http.request.header.authorization"));
        Assert.Null(activity.GetTagItem("db.query.text"));
        Assert.Null(activity.GetTagItem("gen_ai.input.messages"));
        Assert.DoesNotContain("private-marker", string.Join("|", activity.TagObjects.Select(tag => tag.Value)));
    }

    [Fact]
    public void Native_exception_events_status_and_tool_payloads_cannot_bypass_redaction()
    {
        using var activity = new Activity("fixture").Start();
        activity.ActivityTraceFlags = ActivityTraceFlags.Recorded;
        activity.SetStatus(ActivityStatusCode.Error, "private-marker");
        activity.SetTag("gen_ai.tool.call.arguments", "private-marker");
        activity.AddEvent(new ActivityEvent("exception", tags: new ActivityTagsCollection
        {
            ["exception.type"] = "FixtureException",
            ["exception.message"] = "private-marker",
            ["exception.stacktrace"] = "private-marker",
            ["url.full"] = "https://example.invalid/api?code=private-marker"
        }));
        activity.AddEvent(new ActivityEvent("gen_ai.tool.message", tags: new ActivityTagsCollection
        {
            ["content"] = "private-marker",
            ["gen_ai.tool.name"] = "fixture"
        }));
        new TelemetryPrivacyProcessor().OnEnd(activity);
        Assert.Equal(ActivityStatusCode.Error, activity.Status);
        Assert.DoesNotContain("private-marker", activity.StatusDescription!);
        Assert.Null(activity.GetTagItem("gen_ai.tool.call.arguments"));
        Assert.False(activity.Recorded);
        var capture = new SpanCapture();
        using var exporter = new SimpleActivityExportProcessor(capture);
        exporter.OnEnd(activity);
        Assert.Empty(capture.Items);
    }

    [Fact]
    public void Console_logs_do_not_bypass_nested_exception_or_url_redaction()
    {
        var formatter = new SafeConsoleFormatter();
        using var writer = new StringWriter();
        var error = new LogEntry<string>(LogLevel.Error, "fixture", default, "raw private-marker",
            new Exception("private-marker", new Exception("private-marker")), (state, exception) => state);
        formatter.Write(error, null, writer);
        var url = new LogEntry<string>(LogLevel.Information, "fixture", default,
            "https://example.invalid/api?token=private-marker", null, (state, exception) => state);
        formatter.Write(url, null, writer);
        var oauth = new LogEntry<string>(LogLevel.Information, "fixture", default,
            """{"password":"private-marker","code":"private-marker","client_assertion":"private-marker"}""",
            null, (state, exception) => state);
        formatter.Write(oauth, null, writer);
        Assert.DoesNotContain("private-marker", writer.ToString());
        Assert.Contains("https://example.invalid/api", writer.ToString());
    }

    private sealed class SpanCapture : BaseExporter<Activity>
    {
        public List<Activity> Items { get; } = [];
        public override ExportResult Export(in Batch<Activity> batch)
        {
            foreach (var activity in batch) Items.Add(activity);
            return ExportResult.Success;
        }
    }
}
