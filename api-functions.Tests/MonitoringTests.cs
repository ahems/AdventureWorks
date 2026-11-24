using System.Diagnostics.CodeAnalysis;
using System.Net;
using System.Text;
using System.Text.Json;
using ApiFunctions.Auth;
using api_functions.DTOs;
using api_functions.Functions;
using api_functions.Services;
using Azure;
using Azure.Core;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class MonitoringTests
{
    [Fact]
    public void CaptureStoreUsesConfiguredFunctionsStorageAccount()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AzureWebJobsStorage:accountName"] = "testaccount"
        }).Build();

        Assert.NotNull(new TableMonitoringCaptureStore(configuration, new DefaultAzureCredential()));
    }

    [Fact]
    public void Monitoring_requires_scope_internal_category_and_executive_role()
    {
        FunctionUser User(string category, string role, params string[] scopes) => new()
        {
            IsAuthenticated = true, Category = category, Roles = [role], Scopes = scopes.ToHashSet()
        };
        Assert.False(MonitoringFunctions.Authorized(FunctionUser.Anonymous, FunctionScopes.MonitoringRead));
        Assert.False(MonitoringFunctions.Authorized(User("employee", "executive-admin"), FunctionScopes.MonitoringRead));
        Assert.False(MonitoringFunctions.Authorized(User("employee", "operations-admin", FunctionScopes.MonitoringRead), FunctionScopes.MonitoringRead));
        Assert.False(MonitoringFunctions.Authorized(User("consumer", "executive-admin", FunctionScopes.MonitoringRead), FunctionScopes.MonitoringRead));
        var executive = User("employee", "executive-admin", FunctionScopes.MonitoringRead);
        Assert.True(MonitoringFunctions.Authorized(executive, FunctionScopes.MonitoringRead));
        Assert.False(MonitoringFunctions.Authorized(executive, FunctionScopes.MonitoringWrite));
    }

    [Fact]
    public async Task Identical_snapshots_coalesce_and_query_concurrency_is_bounded()
    {
        var handler = new MonitorHandler(HttpStatusCode.OK, """{"tables":[{"columns":[{"name":"observedRequests"}],"rows":[[12]]}]}""");
        var service = QueryService(handler);
        var results = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => service.SummaryAsync("1h")));
        Assert.All(results, result => Assert.Equal("partial", result.Status)); // Metric/queue config absent, never fabricated zeros.
        Assert.Equal(MonitoringQueries.Summary.Count, handler.Calls);
        Assert.InRange(handler.Peak, 1, 4);
        Assert.Same(results[0], await service.SummaryAsync("1h"));
        Assert.Equal(12L, results[0].Sources.Single(s => s.Id == "services").Rows[0]["observedRequests"]);
    }

    [Theory]
    [InlineData(403, "forbidden")]
    [InlineData(429, "throttled")]
    [InlineData(503, "unavailable")]
    public async Task Query_failure_is_not_success_shaped_empty_data(int code, string expected)
    {
        var result = await QueryService(new MonitorHandler((HttpStatusCode)code, "secret-error-body")).SummaryAsync("6h");
        var source = result.Sources.Single(s => s.Id == "services");
        Assert.Equal(expected, source.Status);
        Assert.Empty(source.Rows);
        Assert.DoesNotContain("secret", source.Reason);
        Assert.Equal("unavailable", result.Status);
    }

    [Fact]
    public async Task Query_errors_expose_only_safe_codes_not_provider_messages()
    {
        var result = await QueryService(new MonitorHandler(HttpStatusCode.BadRequest,
            """{"error":{"code":"BadArgumentError","message":"password=markerSecret","innererror":{"code":"SyntaxError","message":"query private content","innererror":{"code":"SYN0002"}}}}"""))
            .TraceAsync(new string('a', 32));
        Assert.Equal("unavailable", result.Status);
        Assert.Contains("HTTP 400 (BadArgumentError / SyntaxError / SYN0002)", result.Source.Reason);
        Assert.DoesNotContain("markerSecret", result.Source.Reason);
        Assert.DoesNotContain("private content", result.Source.Reason);
        Assert.Empty(result.Source.Rows);
    }

    [Theory]
    [InlineData("[1]")]
    [InlineData("""{"error":{"code":"markerCredential","message":"private payload"}}""")]
    public async Task Unexpected_error_metadata_keeps_http_failure_without_exposing_content(string body)
    {
        var result = await QueryService(new MonitorHandler(HttpStatusCode.Forbidden, body)).TraceAsync(new string('a', 32));
        Assert.Equal("forbidden", result.Status);
        Assert.Equal("Azure Monitor returned HTTP 403.", result.Source.Reason);
    }

    [Fact]
    public async Task Empty_self_diagnostics_are_explained_as_problem_signals_not_a_heartbeat()
    {
        var result = await QueryService(new MonitorHandler(HttpStatusCode.OK,
            """{"tables":[{"columns":[],"rows":[]}]}""")).SummaryAsync("1h");
        var source = result.Sources.Single(s => s.Id == "monitoringHealth");
        Assert.Equal("no-data", source.Status);
        Assert.Contains("not a heartbeat", source.Reason);
        Assert.Contains("24 hours", source.Reason);
        Assert.Empty(source.Rows);
    }

    [Fact]
    public async Task Partial_results_and_no_data_are_distinct()
    {
        var partial = await QueryService(new MonitorHandler(HttpStatusCode.OK,
            """{"tables":[{"columns":[{"name":"spanId"}],"rows":[["abc"]]}],"error":{"code":"PartialError"}}""")).TraceAsync(new string('a', 32));
        Assert.Equal("stale", partial.Status);
        Assert.Single(partial.Source.Rows);
        var empty = await QueryService(new MonitorHandler(HttpStatusCode.OK,
            """{"tables":[{"columns":[],"rows":[]}]}""")).TraceAsync(new string('b', 32));
        Assert.Equal("no-data", empty.Status);
        var failed = await QueryService(new MonitorHandler(HttpStatusCode.OK,
            """{"error":{"code":"QueryFailed"}}""")).TraceAsync(new string('d', 32));
        Assert.Equal("unavailable", failed.Status);
        Assert.Empty(failed.Source.Rows);
    }

    [Fact]
    public async Task Timeout_has_explicit_unavailable_reason()
    {
        var result = await QueryService(new MonitorHandler(HttpStatusCode.OK, "", timeout: true)).TraceAsync(new string('c', 32));
        Assert.Equal("unavailable", result.Status);
        Assert.Contains("10-second", result.Source.Reason);
    }

    [Fact]
    public async Task Trace_content_is_re_redacted_and_separate_from_safe_span_rows()
    {
        var payload = JsonSerializer.Serialize(new
        {
            tables = new[] { new
            {
                columns = new[] { "spanId", "captureId", "captureInput", "captureInputOriginalBytes", "captureInputTruncated", "captureInputOmitted" }
                    .Select(name => new { name }).ToArray(),
                rows = new[] { new object[] { "span-1", Guid.NewGuid().ToString("N"), "password=markerCredential useful trail", 5000, true, false } }
            } }
        });
        var trace = await QueryService(new MonitorHandler(HttpStatusCode.OK, payload)).TraceAsync(new string('e', 32));
        Assert.False(trace.Source.Rows[0].ContainsKey("captureInput"));
        var field = Assert.Single(trace.RichContent).Fields["input"];
        Assert.DoesNotContain("markerCredential", field.Text);
        Assert.Equal(5000, field.OriginalBytes);
        Assert.True(field.Truncated);
    }

    [Fact]
    public async Task Separate_capture_events_for_one_span_merge_their_fields()
    {
        var captureId = Guid.NewGuid().ToString("N");
        var payload = JsonSerializer.Serialize(new
        {
            tables = new[] { new
            {
                columns = new[] { "spanId", "captureId", "captureInput", "captureOutput" }
                    .Select(name => new { name }).ToArray(),
                rows = new[] {
                    new object?[] { "capture:span-1", captureId, "request", null },
                    new object?[] { "capture:span-1", captureId, null, "response" }
                }
            } }
        });
        var trace = await QueryService(new MonitorHandler(HttpStatusCode.OK, payload)).TraceAsync(new string('f', 32));
        var captured = Assert.Single(trace.RichContent);
        Assert.Equal("request", captured.Fields["input"].Text);
        Assert.Equal("response", captured.Fields["output"].Text);
        Assert.Equal(2, trace.Source.Rows.Count);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Native_metric_null_points_are_unknown_not_zero_or_query_failure(bool observed)
    {
        var metricPayload = JsonSerializer.Serialize(new
        {
            value = new[] { new
            {
                name = new { value = "cpu_percent" },
                timeseries = new[] { new { data = new[] {
                    new { average = (double?)null, maximum = (double?)null, total = (double?)null },
                    new { average = observed ? 12d : (double?)null, maximum = (double?)null, total = (double?)null }
                } } }
            } }
        });
        var metrics = JsonSerializer.Serialize(new[] { new
        {
            id = "sql-cpu", resourceId = "/subscriptions/offline/resourceGroups/demo/providers/Microsoft.Sql/servers/demo/databases/demo",
            metric = "cpu_percent"
        } });
        var summary = await QueryService(new MonitorHandler(HttpStatusCode.OK,
            """{"tables":[{"columns":[],"rows":[]}]}""", metricJson: metricPayload), metrics).SummaryAsync("24h");
        var source = summary.Sources.Single(s => s.Id == "resources");
        Assert.Equal(observed ? "available" : "no-data", source.Status);
        var row = Assert.Single(source.Rows);
        if (observed) Assert.Equal(12d, row["averageOfReportedPoints"]);
        else Assert.False(row.ContainsKey("averageOfReportedPoints"));
    }

    [Fact]
    public async Task Rejects_query_injection_and_oversized_lookbacks_without_network()
    {
        var handler = new MonitorHandler(HttpStatusCode.OK, "{}");
        var service = QueryService(handler);
        await Assert.ThrowsAsync<ArgumentException>(() => service.TraceAsync("\"; union AppTraces //"));
        await Assert.ThrowsAsync<ArgumentException>(() => service.SummaryAsync("7d"));
        Assert.Equal(0, handler.Calls);
        using var rows = JsonDocument.Parse(JsonSerializer.Serialize(new
        {
            tables = new[] { new { columns = new[] { new { name = "traceId" } }, rows = Enumerable.Range(0, 150).Select(i => new object[] { i }).ToArray() } }
        }));
        Assert.Equal(100, MonitoringQueryService.ParseLogs(rows.RootElement).Count);
    }

    [Fact]
    public async Task Capture_is_off_scoped_expiring_and_stoppable()
    {
        var table = new MemoryTable();
        var store = new TableMonitoringCaptureStore(table);
        var service = new MonitoringCaptureService(store);
        Assert.Null(await service.TryAcquireRootAsync(null, "job", "job-1", "root-1"));
        await Assert.ThrowsAsync<ArgumentException>(() => service.StartAsync(new("global", "*")));
        var grant = await service.StartAsync(new("job", "job-1"));
        Assert.Null(await service.TryAcquireRootAsync(grant.Id, "session", "job-1", "root-1"));
        Assert.Null(await service.TryAcquireRootAsync(grant.Id, "job", "job-2", "root-1"));
        var lease = await service.TryAcquireRootAsync(grant.Id, "job", "job-1", "root-1");
        Assert.NotNull(lease);
        Assert.True(await service.IsActiveAsync(lease!));
        await service.StopAsync(grant.Id);
        Assert.False(await service.IsActiveAsync(lease!));
        Assert.Empty(await service.SanitizeFieldsAsync(lease!, new Dictionary<string, string?> { ["input"] = "content" }));
        var next = await service.StartAsync(new("session", "session-1"));
        table.Expire(next.Id);
        Assert.Null(await service.TryAcquireRootAsync(next.Id, "session", "session-1", "root-1"));
    }

    [Fact]
    public async Task Root_admission_is_atomic_idempotent_and_capped_across_workers()
    {
        var table = new MemoryTable();
        var first = new TableMonitoringCaptureStore(table);
        var second = new TableMonitoringCaptureStore(table);
        var grant = await first.CreateAsync("job", "job-1", default);
        var leases = await Task.WhenAll(Enumerable.Range(0, 150).Select(i => Task.Run(() =>
            (i % 2 == 0 ? first : second).AcquireAsync(grant.Id, "job", "job-1", "root-" + i, default))));
        var admitted = leases.Where(l => l is not null).ToArray();
        Assert.InRange(admitted.Length, 1, 100);
        Assert.Equal(admitted.Length, table.RootCount(grant.Id));
        var lease = admitted[0]!;
        for (var i = admitted.Length; i < 100; i++)
            Assert.NotNull(await first.AcquireAsync(grant.Id, "job", "job-1", "fill-" + i, default));
        Assert.Equal(100, table.RootCount(grant.Id));
        Assert.Null(await second.AcquireAsync(grant.Id, "job", "job-1", "overflow", default));
        Assert.NotNull(await first.AcquireAsync(grant.Id, "job", "job-1", lease.RootOperationId, default));
        Assert.Equal(100, table.RootCount(grant.Id));
        Assert.True(await first.ActiveAsync(lease, default)); // Child spans still permitted at the root cap.
    }

    [Fact]
    public async Task Content_redaction_field_bounds_and_persistent_root_budget()
    {
        var table = new MemoryTable();
        var store = new TableMonitoringCaptureStore(table);
        var service = new MonitoringCaptureService(store);
        var retryService = new MonitoringCaptureService(new TableMonitoringCaptureStore(table));
        var grant = await service.StartAsync(new("job", "job-1"));
        var lease = (await service.TryAcquireRootAsync(grant.Id, "job", "job-1", "root-1"))!;
        var marker = MonitoringContent.Sanitize("toolArguments",
            """{"password":"markerPassword","token":"markerToken","email":"customer@example.test","url":"https://host.test/api?code=markerCode&state=markerState"}""");
        Assert.DoesNotContain("marker", marker.Text);
        Assert.DoesNotContain("customer@", marker.Text);
        Assert.True(MonitoringContent.Sanitize("encryptedReasoning", "anything").Omitted);
        Assert.True(MonitoringContent.Sanitize("output", "data:image/png;base64,abc").Omitted);
        var text = string.Concat(Enumerable.Repeat("🚲 trail ", 1000));
        var bounded = MonitoringContent.Sanitize("input", text);
        Assert.True(bounded.Truncated);
        Assert.InRange(Encoding.UTF8.GetByteCount(bounded.Text!), 1, 4096);
        var admittedBytes = 0;
        for (int i = 0; i < 20; i++)
        {
            var worker = i % 2 == 0 ? service : retryService;
            var retryLease = await worker.TryAcquireRootAsync(grant.Id, "job", "job-1", "root-1");
            Assert.NotNull(retryLease);
            var fields = await worker.SanitizeFieldsAsync(retryLease!, new Dictionary<string, string?> { ["output"] = text });
            var field = fields["output"];
            if (!field.Omitted) admittedBytes += Encoding.UTF8.GetByteCount(field.Text!);
        }
        Assert.InRange(admittedBytes, 1, 32768);
        Assert.Equal(1, table.RootCount(grant.Id));
        Assert.False(await store.SpendAsync(lease, 4096, default));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task New_root_admissions_push_metadata_after_persistence_but_retries_and_reads_do_not(bool pushFails)
    {
        var table = new MemoryTable();
        var store = new TableMonitoringCaptureStore(table);
        var grant = await store.CreateAsync("job", "job-1", default);
        var updates = new RecordingUpdates(() => table.RootCount(grant.Id), pushFails);
        var service = new MonitoringCaptureService(store, updates);
        Assert.Null(await service.TryAcquireRootAsync(null, "job", "job-1", "root-0"));
        Assert.Empty(updates.Counts);
        for (var i = 0; i < 100; i++)
        {
            var admitted = await service.TryAcquireRootAsync(grant.Id, "job", "job-1", "root-" + i);
            Assert.NotNull(admitted);
            Assert.True(admitted!.NewlyAdmitted);
        }
        Assert.Equal(Enumerable.Range(1, 100), updates.Counts);
        Assert.Equal("utilities", updates.Group);
        using var payload = JsonDocument.Parse(updates.Payload!);
        Assert.Single(payload.RootElement.EnumerateObject());
        Assert.Equal("monitoring-capture-changed", payload.RootElement.GetProperty("event").GetString());
        var status = Assert.Single((await service.StatusAsync()).Captures);
        Assert.Equal(100, status.RootOperations);
        Assert.Equal("exhausted", status.Status);
        var retry = await service.TryAcquireRootAsync(grant.Id, "job", "job-1", "root-0");
        Assert.NotNull(retry);
        Assert.False(retry!.NewlyAdmitted);
        Assert.True(await service.IsActiveAsync(retry));
        Assert.Null(await service.TryAcquireRootAsync(grant.Id, "job", "job-1", "overflow"));
        Assert.Equal(100, updates.Counts.Count);
        Assert.Equal(100, table.RootCount(grant.Id));
    }

    private static MonitoringQueryService QueryService(MonitorHandler handler, string? metrics = null) => new(
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["MONITORING_WORKSPACE_ID"] = Guid.NewGuid().ToString(), ["MONITORING_METRIC_RESOURCES"] = metrics }).Build(),
        new FakeCredential(), new ClientFactory(handler), NullLogger<MonitoringQueryService>.Instance);
    private sealed class FakeCredential : DefaultAzureCredential
    {
        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken ct = default) =>
            ValueTask.FromResult(new AccessToken("offline-token", DateTimeOffset.UtcNow.AddHours(1)));
    }
    private sealed class ClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
    private sealed class MonitorHandler(HttpStatusCode status, string json, bool timeout = false,
        string? metricJson = null) : HttpMessageHandler
    {
        private int _inflight;
        public int Calls;
        public int Peak;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Interlocked.Increment(ref Calls);
            var active = Interlocked.Increment(ref _inflight);
            int old;
            do { old = Peak; } while (active > old && Interlocked.CompareExchange(ref Peak, active, old) != old);
            try
            {
                var metric = request.RequestUri!.Host == "management.azure.com";
                Assert.Equal(metric ? "management.azure.com" : "api.loganalytics.io", request.RequestUri.Host);
                Assert.Equal(metric ? HttpMethod.Get : HttpMethod.Post, request.Method);
                if (metric)
                {
                    Assert.NotNull(metricJson);
                    var timespan = request.RequestUri.Query.TrimStart('?').Split('&')
                        .Single(part => part.StartsWith("timespan=", StringComparison.Ordinal));
                    var bounds = Uri.UnescapeDataString(timespan["timespan=".Length..]).Split('/');
                    Assert.Equal(2, bounds.Length);
                    Assert.All(bounds, bound => Assert.EndsWith("Z", bound));
                }
                await Task.Delay(10, ct);
                if (timeout) throw new TaskCanceledException();
                return new(status) { Content = new StringContent(metric ? metricJson! : json) };
            }
            finally { Interlocked.Decrement(ref _inflight); }
        }
    }
    private sealed class RecordingUpdates(Func<int> count, bool fails) : WebPubSubService(
        null, new FakeCredential(), NullLogger<WebPubSubService>.Instance)
    {
        public List<int> Counts { get; } = [];
        public string? Group;
        public string? Payload;
        public override Task SendToGroupAsync(string group, object payload)
        {
            Group = group;
            Payload = JsonSerializer.Serialize(payload);
            Counts.Add(count());
            return fails ? Task.FromException(new RequestFailedException(503, "offline push failed")) : Task.CompletedTask;
        }
    }
    private sealed class MemoryTable : TableClient
    {
        private readonly object _gate = new();
        private readonly Dictionary<(string, string), TableEntity> _rows = new();
        private static TableEntity Copy(TableEntity row) => new TableEntity(row.PartitionKey, row.RowKey)
        {
            ETag = row.ETag
        }.WithValues(row);
        public int RootCount(string id) { lock (_gate) return _rows[(id, "grant")].GetInt32("RootOperations")!.Value; }
        public void Expire(string id) { lock (_gate) _rows[(id, "grant")]["ExpiresAt"] = DateTimeOffset.UtcNow.AddMinutes(-1); }
        public override AsyncPageable<T> QueryAsync<T>(string? filter = null, int? maxPerPage = null,
            IEnumerable<string>? select = null, CancellationToken cancellationToken = default)
        {
            lock (_gate)
            {
                var grants = _rows.Values.Where(row => row.RowKey == "grant")
                    .Select(row => (T)(object)Copy(row)).Take(maxPerPage ?? 100).ToArray();
                return AsyncPageable<T>.FromPages([Page<T>.FromValues(grants, null, new FakeResponse())]);
            }
        }
        public override Task<Response> AddEntityAsync<T>(T entity, CancellationToken ct = default)
        {
            lock (_gate) { Save((TableEntity)(object)entity); return Task.FromResult<Response>(new FakeResponse()); }
        }
        public override async Task<NullableResponse<T>> GetEntityIfExistsAsync<T>(string partitionKey, string rowKey,
            IEnumerable<string>? select = null, CancellationToken cancellationToken = default)
        {
            await Task.Yield();
            lock (_gate) return _rows.TryGetValue((partitionKey, rowKey), out var row)
                ? Response.FromValue((T)(object)Copy(row), new FakeResponse()) : new Missing<T>();
        }
        public override Task<Response> UpdateEntityAsync<T>(T entity, ETag ifMatch,
            TableUpdateMode mode = TableUpdateMode.Merge, CancellationToken ct = default)
        {
            lock (_gate)
            {
                var row = (TableEntity)(object)entity;
                if (_rows[(row.PartitionKey, row.RowKey)].ETag != ifMatch) throw new RequestFailedException(412, "conflict");
                Save(row); return Task.FromResult<Response>(new FakeResponse());
            }
        }
        public override Task<Response<IReadOnlyList<Response>>> SubmitTransactionAsync(
            IEnumerable<TableTransactionAction> actions, CancellationToken ct = default)
        {
            lock (_gate)
            {
                var list = actions.ToArray();
                foreach (var action in list)
                {
                    var key = (action.Entity.PartitionKey, action.Entity.RowKey);
                    if (action.ActionType == TableTransactionActionType.Add && _rows.ContainsKey(key))
                        throw new RequestFailedException(409, "exists");
                    if (action.ActionType == TableTransactionActionType.UpdateReplace &&
                        (!_rows.TryGetValue(key, out var existing) || existing.ETag != action.ETag))
                        throw new RequestFailedException(412, "conflict");
                }
                foreach (var action in list) Save((TableEntity)action.Entity);
                return Task.FromResult(Response.FromValue<IReadOnlyList<Response>>(list.Select(_ => (Response)new FakeResponse()).ToArray(), new FakeResponse()));
            }
        }
        private void Save(TableEntity entity)
        {
            var row = Copy(entity); row.ETag = new ETag(Guid.NewGuid().ToString());
            _rows[(row.PartitionKey, row.RowKey)] = row;
        }
    }
    private sealed class Missing<T> : NullableResponse<T>
    {
        public override bool HasValue => false;
        public override T? Value => default;
        public override Response GetRawResponse() => new FakeResponse();
    }
    private sealed class FakeResponse : Response
    {
        public override int Status => 200;
        public override string ReasonPhrase => "";
        public override Stream? ContentStream { get; set; }
        public override string ClientRequestId { get; set; } = "";
        public override void Dispose() { }
        protected override bool ContainsHeader(string name) => false;
        protected override IEnumerable<HttpHeader> EnumerateHeaders() => [];
        protected override bool TryGetHeader(string name, [NotNullWhen(true)] out string? value) { value = null; return false; }
        protected override bool TryGetHeaderValues(string name, [NotNullWhen(true)] out IEnumerable<string>? value) { value = null; return false; }
    }
}

internal static class MonitoringTestTableExtensions
{
    public static TableEntity WithValues(this TableEntity destination, TableEntity source)
    {
        foreach (var value in source) destination[value.Key] = value.Value;
        return destination;
    }
}
