using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text;
using System.Text.Json;
using System.Reflection;
using api_functions.Models;
using api_functions.Services;
using api_functions.Functions;
using api_functions.DTOs;
using Xunit;

namespace api_functions.Tests;

public class BackgroundWorkTelemetryTests
{
    [Fact]
    public void InvalidContextCannotInjectTraceIdentifiersOrCaptureReference()
    {
        var now = DateTimeOffset.UtcNow;
        var context = BackgroundWorkTelemetry.Validate(new(
            "00-" + new string('0', 32) + "-" + new string('0', 16) + "-01",
            "private-record", now.AddHours(1), double.NaN, "Bearer secret"), now)!;
        Assert.Null(context.TraceParent);
        Assert.Null(context.JobId);
        Assert.Null(context.CaptureId);
        Assert.Null(context.EnqueuedAt);
        Assert.Equal(0, context.VisibilityDelaySeconds);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void EnqueueAndRetryPreserveBusinessPayloadAndLogicalJob(bool encoded)
    {
        using var root = new Activity("test").SetIdFormat(ActivityIdFormat.W3C).Start();
        const string payload = """{"WorkOrderId":42,"LocationSlotClaimed":true,"MaterialRetryCount":3}""";
        var input = encoded ? Convert.ToBase64String(Encoding.UTF8.GetBytes(payload)) : payload;
        var stamped = BackgroundWorkTelemetry.Stamp(input, TimeSpan.FromSeconds(30));
        var json = encoded ? Encoding.UTF8.GetString(Convert.FromBase64String(stamped)) : stamped;
        var first = JsonSerializer.Deserialize<WorkOrderOperationMessage>(json)!;
        Assert.Equal(42, first.WorkOrderId);
        Assert.True(first.LocationSlotClaimed);
        Assert.Equal(3, first.MaterialRetryCount);
        Assert.Equal(root.Id, first.Telemetry!.TraceParent);
        Assert.Equal(30, first.Telemetry.VisibilityDelaySeconds);
        Assert.Null(first.Telemetry.CaptureId);
        using var attempt = BackgroundWorkTelemetry.Begin("test-retry", json);
        var retry = JsonSerializer.Deserialize<WorkOrderOperationMessage>(
            BackgroundWorkTelemetry.Stamp(JsonSerializer.Serialize(first with { MaterialRetryCount = 4 }), TimeSpan.FromSeconds(60)))!;
        Assert.Equal(first.Telemetry.JobId, retry.Telemetry!.JobId);
        Assert.Equal(4, retry.MaterialRetryCount);
        Assert.True(retry.LocationSlotClaimed);
        Assert.Equal(60, retry.Telemetry.VisibilityDelaySeconds);
        attempt.SetOutcome("retrying");
    }

    [Fact]
    public void ConsumerContinuesValidatedParentWithDistinctAttemptSpan()
    {
        Activity? recorded = null;
        using var listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name == BackgroundWorkTelemetry.SourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
            ActivityStopped = activity => { if (activity.OperationName == "test-parent") recorded = activity; }
        };
        ActivitySource.AddActivityListener(listener);
        var context = new QueueTelemetryContext("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
            Guid.NewGuid().ToString("N"), DateTimeOffset.UtcNow);
        using (var attempt = BackgroundWorkTelemetry.Begin("test-parent", context: context))
        {
            attempt.SetOutcome("partial");
            attempt.Complete();
        }
        Assert.NotNull(recorded);
        Assert.Equal("0af7651916cd43dd8448eb211c80319c", recorded.TraceId.ToHexString());
        Assert.Equal("b7ad6b7169203331", recorded.ParentSpanId.ToHexString());
        Assert.NotEqual("b7ad6b7169203331", recorded.SpanId.ToHexString());
        Assert.Equal("partial", recorded.GetTagItem("outcome"));
        Assert.Equal(ActivityStatusCode.Error, recorded.Status);
        Assert.Null(BackgroundWorkTelemetry.CurrentContext);
    }

    [Fact]
    public void OutcomeMetricsAreAttemptScopedAndVisibilityDelayIsSeparateFromWait()
    {
        var outcomes = new List<string>();
        var timing = new Dictionary<string, double>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meter) =>
        {
            if (instrument.Meter.Name == BackgroundWorkTelemetry.SourceName) meter.EnableMeasurementEvents(instrument);
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, tags, _) =>
        {
            if (instrument.Name != "background.attempt.outcomes") return;
            var operation = tags.ToArray().FirstOrDefault(t => t.Key == "operation").Value?.ToString();
            if (operation == "test-metrics") outcomes.Add(tags.ToArray().Single(t => t.Key == "outcome").Value!.ToString()!);
        });
        listener.SetMeasurementEventCallback<double>((instrument, measurement, tags, _) =>
        {
            if (tags.ToArray().Any(t => t.Key == "operation" && Equals(t.Value, "test-metrics")))
                timing[instrument.Name] = measurement;
        });
        listener.Start();
        var context = new QueueTelemetryContext(EnqueuedAt: DateTimeOffset.UtcNow.AddSeconds(-32), VisibilityDelaySeconds: 30);
        using (var attempt = BackgroundWorkTelemetry.Begin("test-metrics", context: context)) attempt.SetOutcome("rejected");
        Assert.Equal(["rejected"], outcomes);
        Assert.Equal(30, timing["background.queue.visibility_delay"]);
        Assert.InRange(timing["background.queue.wait"], 2, 4);
    }

    [Fact]
    public void LegacyOrMalformedPayloadDoesNotBecomeAContentEnvelope()
    {
        Assert.Equal("not-json", BackgroundWorkTelemetry.Stamp("not-json"));
        Assert.Equal("null", BackgroundWorkTelemetry.Stamp("null"));
        Assert.Equal("[1,2]", BackgroundWorkTelemetry.Stamp("[1,2]"));
        using var attempt = BackgroundWorkTelemetry.Begin("test-legacy", "not-json");
        Assert.Null(BackgroundWorkTelemetry.CurrentContext);
        attempt.SetOutcome("rejected");
    }

    [Fact]
    public async Task ManufacturingCaptureUsesPersistedRunGrantAndOneStableRootAcrossRetries()
    {
        var run = PersistedRun();
        var store = new JobCaptureStore(run.RunId);
        var capture = new MonitoringCaptureService(store);
        var message = new ManufacturingAgentQueueMessage(run.SalesOrderId, run.CustomerId, run.RunId,
            Telemetry: new QueueTelemetryContext(JobId: Guid.NewGuid().ToString("N"),
                CaptureId: Guid.NewGuid().ToString("N")));

        var first = await ClaimCapture(
            capture, message, (_, _) => Task.FromResult<ManufacturingAgentRunEntity?>(run));
        run.Status = "retrying";
        var retry = await ClaimCapture(
            capture, message with { RetryCount = 1 }, (_, _) => Task.FromResult<ManufacturingAgentRunEntity?>(run));

        Assert.NotNull(first);
        Assert.Equal(store.Grant.Id, first.CaptureId);
        Assert.NotEqual(message.Telemetry!.CaptureId, first.CaptureId);
        Assert.Equal(run.RunId, first.ScopeId);
        Assert.Equal(run.RunId, first.RootOperationId);
        Assert.Equal(first, retry);
        Assert.Single(store.Roots);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("different-order")]
    [InlineData("different-customer")]
    [InlineData("different-run")]
    [InlineData("completed")]
    [InlineData("failed")]
    [InlineData("finished-timestamp")]
    public async Task ManufacturingCaptureDeniesUnknownMismatchedOrTerminalRun(string mismatch)
    {
        var run = PersistedRun();
        var store = new JobCaptureStore(run.RunId);
        var capture = new MonitoringCaptureService(store);
        var message = new ManufacturingAgentQueueMessage(run.SalesOrderId, run.CustomerId, run.RunId,
            Telemetry: new QueueTelemetryContext(CaptureId: store.Grant.Id));
        switch (mismatch)
        {
            case "different-order": run.SalesOrderId++; break;
            case "different-customer": run.CustomerId++; break;
            case "different-run": run.RunId = Guid.NewGuid().ToString(); break;
            case "completed": run.Status = "completed"; break;
            case "failed": run.Status = "failed"; break;
            case "finished-timestamp": run.CompletedAt = DateTimeOffset.UtcNow; break;
        }

        var lease = await ClaimCapture(capture, message,
            (_, _) => Task.FromResult(mismatch == "missing" ? null : (ManufacturingAgentRunEntity?)run));

        Assert.Null(lease);
        Assert.Empty(store.Roots);
        Assert.Equal(0, store.Acquisitions);
    }

    [Theory]
    [InlineData("other-job")]
    [InlineData("expired")]
    [InlineData("stopped")]
    public async Task QueueCaptureReferenceCannotAuthorizeMissingExpiredOrStoppedJobGrant(string scenario)
    {
        var run = PersistedRun();
        var store = new JobCaptureStore(scenario == "other-job" ? Guid.NewGuid().ToString() : run.RunId);
        store.Grant = store.Grant with
        {
            Status = scenario == "stopped" ? "stopped" : "active",
            ExpiresAt = scenario == "expired" ? DateTimeOffset.UtcNow.AddMinutes(-1) : DateTimeOffset.UtcNow.AddMinutes(15)
        };
        var message = new ManufacturingAgentQueueMessage(run.SalesOrderId, run.CustomerId, run.RunId,
            Telemetry: new QueueTelemetryContext(CaptureId: store.Grant.Id));

        var lease = await ClaimCapture(
            new MonitoringCaptureService(store), message,
            (_, _) => Task.FromResult<ManufacturingAgentRunEntity?>(run));

        Assert.Null(lease);
        Assert.Empty(store.Roots);
    }

    [Fact]
    public async Task ManufacturingCaptureLookupFailureDoesNotChangeJobState()
    {
        var run = PersistedRun();
        var store = new JobCaptureStore(run.RunId);
        var lease = await ClaimCapture(
            new MonitoringCaptureService(store), new(run.SalesOrderId, run.CustomerId, run.RunId),
            (_, _) => throw new IOException("private connection details"));
        Assert.Null(lease);
        Assert.Equal("pending", run.Status);
        Assert.Empty(store.Roots);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ManufacturingRootCapDeniesNewRootsButPreservesAdmittedRetry(bool alreadyAdmitted)
    {
        var run = PersistedRun();
        var store = new JobCaptureStore(run.RunId);
        var service = new MonitoringCaptureService(store);
        var message = new ManufacturingAgentQueueMessage(run.SalesOrderId, run.CustomerId, run.RunId);
        if (alreadyAdmitted)
            Assert.NotNull(await ClaimCapture(
                service, message, (_, _) => Task.FromResult<ManufacturingAgentRunEntity?>(run)));
        for (var i = store.Roots.Count; i < 100; i++) store.Roots.Add("other-root-" + i);
        store.Grant = store.Grant with { RootOperations = 100, Status = "exhausted" };
        run.Status = "retrying";

        var retry = await ClaimCapture(
            service, message with { RetryCount = 1 }, (_, _) => Task.FromResult<ManufacturingAgentRunEntity?>(run));

        Assert.Equal(alreadyAdmitted, retry is not null);
        Assert.Equal(100, store.Roots.Count);
        if (retry is not null) Assert.Equal(run.RunId, retry.RootOperationId);
    }

    [Theory]
    [InlineData("stopped")]
    [InlineData("expired")]
    public async Task ManufacturingRetryCannotContinueCaptureAfterStopOrExpiry(string terminal)
    {
        var run = PersistedRun();
        var store = new JobCaptureStore(run.RunId);
        var service = new MonitoringCaptureService(store);
        var message = new ManufacturingAgentQueueMessage(run.SalesOrderId, run.CustomerId, run.RunId);
        Assert.NotNull(await ClaimCapture(
            service, message, (_, _) => Task.FromResult<ManufacturingAgentRunEntity?>(run)));
        store.Grant = store.Grant with
        {
            Status = terminal,
            ExpiresAt = terminal == "expired" ? DateTimeOffset.UtcNow.AddSeconds(-1) : store.Grant.ExpiresAt
        };
        run.Status = "retrying";

        Assert.Null(await ClaimCapture(
            service, message with { RetryCount = 1 }, (_, _) => Task.FromResult<ManufacturingAgentRunEntity?>(run)));
        Assert.Single(store.Roots);
    }

    private static ManufacturingAgentRunEntity PersistedRun() => new()
    {
        RunId = Guid.NewGuid().ToString(), SalesOrderId = 42, CustomerId = 7, Status = "pending"
    };

    private static Task<CaptureLease?> ClaimCapture(MonitoringCaptureService capture,
        ManufacturingAgentQueueMessage message,
        Func<string, CancellationToken, Task<ManufacturingAgentRunEntity?>> readRun) =>
        (Task<CaptureLease?>)typeof(ManufacturingAgentQueueTrigger)
            .GetMethod("ClaimManufacturingCaptureAsync", BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, [capture, message, readRun, CancellationToken.None])!;

    private sealed class JobCaptureStore : IMonitoringCaptureStore
    {
        public CaptureGrant Grant;
        public HashSet<string> Roots { get; } = [];
        public int Acquisitions { get; private set; }
        public JobCaptureStore(string runId) => Grant = new(Guid.NewGuid().ToString("N"), "job", runId,
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddMinutes(15), 100, 0, "active");
        public Task<CaptureGrant> CreateAsync(string scopeType, string scopeId, CancellationToken ct) => Task.FromResult(Grant);
        public Task<IReadOnlyList<CaptureGrant>> ListAsync(CancellationToken ct) =>
            Task.FromResult<IReadOnlyList<CaptureGrant>>([Grant]);
        public Task<CaptureGrant?> FindActiveAsync(string scopeType, string scopeId, CancellationToken ct) =>
            Task.FromResult<CaptureGrant?>(scopeType == Grant.ScopeType && scopeId == Grant.ScopeId &&
                Grant.Status is "active" or "exhausted" && Grant.ExpiresAt > DateTimeOffset.UtcNow ? Grant : null);
        public Task<CaptureGrant?> StopAsync(string id, CancellationToken ct) =>
            Task.FromResult<CaptureGrant?>(Grant = Grant with { Status = "stopped" });
        public Task<CaptureLease?> AcquireAsync(string id, string scopeType, string scopeId, string rootOperationId, CancellationToken ct)
        {
            Acquisitions++;
            if (id != Grant.Id || scopeType != Grant.ScopeType || scopeId != Grant.ScopeId
                || Grant.Status is not ("active" or "exhausted")
                || Grant.ExpiresAt <= DateTimeOffset.UtcNow) return Task.FromResult<CaptureLease?>(null);
            if (!Roots.Contains(rootOperationId) && Roots.Count >= Grant.MaxRootOperations)
                return Task.FromResult<CaptureLease?>(null);
            Roots.Add(rootOperationId);
            return Task.FromResult<CaptureLease?>(new(id, scopeType, scopeId, rootOperationId));
        }
        public Task<bool> ActiveAsync(CaptureLease lease, CancellationToken ct) =>
            Task.FromResult(Grant.Status == "active" && Grant.ExpiresAt > DateTimeOffset.UtcNow);
        public Task<bool> SpendAsync(CaptureLease lease, int bytes, CancellationToken ct) => Task.FromResult(true);
    }
}
