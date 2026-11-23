#nullable enable
namespace api_functions.Services;

/// <summary>Server-owned projections deliberately exclude URLs, SQL text, exception messages and arbitrary properties.</summary>
public static class MonitoringQueries
{
    public static readonly IReadOnlyDictionary<string, string> Summary = new Dictionary<string, string>
    {
        ["services"] = """
            union (AppRequests | where isnotempty(Url) and isempty(tostring(Properties["aw.internal_operation"]))
                and isempty(tostring(Properties["messaging.operation.type"]))),
                (AppPageViews | extend Success=bool(true), DurationMs=DurationMs)
            | summarize observedRequests=count(), estimatedRequests=sum(ItemCount),
                failures=countif(Success == false), p50Ms=percentile(DurationMs,50),
                p95Ms=percentile(DurationMs,95), p99Ms=percentile(DurationMs,99),
                lastSeen=max(TimeGenerated), sampled=countif(ItemCount > 1) by service=AppRoleName
            | take 30
            """,
        ["agents"] = """
            AppDependencies
            | where Type == "GenAI" or tostring(Properties["gen_ai.operation.name"]) != ""
            | summarize observedSpans=count(), failures=countif(Success == false),
                p95Ms=percentile(DurationMs,95), lastSeen=max(TimeGenerated),
                responsesWithUsage=countif(tostring(Properties["aw.usage.status"]) in ("available","partial")),
                observedInputTokens=sumif(tolong(Properties["gen_ai.usage.input_tokens"]), tostring(Properties["aw.usage.status"]) in ("available","partial")),
                observedOutputTokens=sumif(tolong(Properties["gen_ai.usage.output_tokens"]), tostring(Properties["aw.usage.status"]) in ("available","partial")),
                unknownUsage=countif(tostring(Properties["aw.usage.status"]) == "unknown")
                by service=AppRoleName, operation=tostring(Properties["gen_ai.operation.name"]),
                model=tostring(Properties["gen_ai.request.model"])
            | extend observedInputTokens=iff(responsesWithUsage > 0,observedInputTokens,long(null)),
                observedOutputTokens=iff(responsesWithUsage > 0,observedOutputTokens,long(null))
            | take 50
            """,
        ["workflows"] = """
            union (AppEvents | where Name startswith "Workflow." or Name startswith "BackgroundWork."),
                (AppDependencies | where tostring(Properties["messaging.operation.type"]) == "process"),
                (AppRequests | where tostring(Properties["messaging.operation.type"]) == "process")
            | summarize observedEvents=count(), estimatedEvents=sum(ItemCount),lastSeen=max(TimeGenerated)
                by service=AppRoleName, outcome=tostring(Properties["outcome"]),operation=Name
            | take 50
            """,
        ["ingestion"] = """
            union withsource=tableName AppRequests,AppDependencies,AppEvents,AppTraces,AppExceptions,AppMetrics,AppPageViews
            | summarize billableBytes=sumif(_BilledSize, _IsBillable == "true"),
                lastSeen=max(TimeGenerated), observedRows=count() by tableName, service=AppRoleName
            | take 50
            """,
        ["recentTraces"] = """
            AppRequests
            | where OperationId matches regex "^[a-f0-9]{32}$"
            | project traceId=OperationId,timestamp=TimeGenerated,service=AppRoleName,
                durationMs=DurationMs,success=Success,resultCode=ResultCode
            | top 30 by timestamp desc
            """,
        ["browser"] = """
            AppEvents
            | where Name in ("browser.web-vital","browser.http-outcome","browser.handled-outcome","browser.realtime-outcome")
            | summarize observedEvents=count(),lastSeen=max(TimeGenerated),
                p75=percentile(todouble(Properties["value"]),75)
                by service=AppRoleName,operation=Name,metric=tostring(Properties["metric"]),
                outcome=tostring(Properties["outcome"]),availability=tostring(Properties["availability"])
            | take 50
            """,
        ["monitoringHealth"] = """
            _LogOperation
            | where Category =~ "Ingestion" and Detail contains "OverQuota"
            | project timestamp=TimeGenerated,signal="daily-cap-reached",status="stale"
            | take 10
            """
    };

    public static string Trace(string traceId)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(traceId, "^[a-f0-9]{32}$") || traceId.All(c => c == '0'))
            throw new ArgumentException("A lower-case 32-character W3C trace ID is required.");
        return $$"""
            union (AppRequests | extend kind="request"),(AppDependencies | extend kind="dependency"),
                (AppEvents | where Name == "GenAI.Capture"
                    | extend kind="capture-content",Id=strcat("capture:",tostring(Properties["aw.capture.span_id"])),
                        DurationMs=real(null),Success=bool(null),ResultCode="")
            | where OperationId == "{{traceId}}"
            | project timestamp=TimeGenerated,spanId=Id,parentSpanId=ParentId,kind,
                service=AppRoleName,durationMs=DurationMs,success=Success,resultCode=ResultCode,
                operation=tostring(Properties["gen_ai.operation.name"]),
                model=tostring(Properties["gen_ai.request.model"]),
                sessionId=tostring(Properties["gen_ai.conversation.id"]),
                jobId=tostring(Properties["job.id"]),
                reasoningSummaryStatus=tostring(Properties["aw.reasoning.summary.status"]),
                captureId=tostring(Properties["aw.capture.id"]),
                captureInput=tostring(Properties["aw.capture.input"]),
                captureOutput=tostring(Properties["aw.capture.output"]),
                captureReasoningSummary=tostring(Properties["aw.capture.reasoningSummary"]),
                captureInputOriginalBytes=tolong(Properties["aw.capture.input.original_bytes"]),
                captureOutputOriginalBytes=tolong(Properties["aw.capture.output.original_bytes"]),
                captureReasoningSummaryOriginalBytes=tolong(Properties["aw.capture.reasoningSummary.original_bytes"]),
                captureInputTruncated=tobool(Properties["aw.capture.input.truncated"]),
                captureOutputTruncated=tobool(Properties["aw.capture.output.truncated"]),
                captureReasoningSummaryTruncated=tobool(Properties["aw.capture.reasoningSummary.truncated"]),
                captureInputOmitted=tobool(Properties["aw.capture.input.omitted"]),
                captureOutputOmitted=tobool(Properties["aw.capture.output.omitted"]),
                captureReasoningSummaryOmitted=tobool(Properties["aw.capture.reasoningSummary.omitted"])
            | order by timestamp asc
            | take 100
            """;
    }
}
