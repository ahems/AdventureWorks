using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.ApplicationInsights;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace AdventureWorks.Telemetry;

/// <summary>
/// Records which SQL server principal served this workload's connections on each trace.
/// The principal is read by SQL itself (SUSER_SNAME/SUSER_SID) over a dedicated connection built
/// from the same connection string, so it shares the pooled connections' credential. Only hashes
/// and categorical comparisons with the configured managed-identity client ID are exported.
/// This file is compiled into both api-mcp and api-functions.
/// </summary>
public sealed class SqlPrincipalTelemetry : IHostedService, IObserver<DiagnosticListener>, IDisposable
{
    public const string EventName = "Sql.SessionPrincipal";
    private const string ListenerName = "SqlClientDiagnosticListener";
    private const string OpenAfterEvent = "Microsoft.Data.SqlClient.WriteConnectionOpenAfter";
    private const int MaxTrackedKeys = 10_000;
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(30);
    private static readonly AsyncLocal<string?> CurrentScope = new();

    private readonly TelemetryClient _telemetry;
    private readonly ILogger _logger;
    private readonly string _service;
    private readonly string? _connectionString;
    private readonly SqlConnectionStringBuilder? _target;
    private readonly Guid? _expectedClientId;
    private readonly string _expectedClientHash;
    private readonly ConcurrentDictionary<string, byte> _seen = new(StringComparer.Ordinal);
    private readonly List<IDisposable> _subscriptions = new();
    private IDisposable? _allListeners;
    private CancellationTokenSource? _stopping;
    private Task? _refreshLoop;
    private volatile PrincipalState? _state;

    public SqlPrincipalTelemetry(TelemetryClient telemetry, ILogger<SqlPrincipalTelemetry> logger,
        string service, string? connectionString, string? expectedClientId)
    {
        _telemetry = telemetry;
        _logger = logger;
        _service = service;
        _connectionString = string.IsNullOrWhiteSpace(connectionString) ? null : connectionString;
        _target = _connectionString is null ? null : new SqlConnectionStringBuilder(_connectionString);
        _expectedClientId = Guid.TryParse(expectedClientId, out var parsed) ? parsed : null;
        _expectedClientHash = _expectedClientId is { } id ? Hash(id) : "unconfigured";
    }

    public sealed record PrincipalState(string Match, string ServerPrincipalHash, string Source, DateTimeOffset VerifiedAt);

    /// <summary>Labels SQL connections opened in the current async flow (for example an MCP tool or function).</summary>
    public static IDisposable EnterScope(string scope)
    {
        var previous = CurrentScope.Value;
        CurrentScope.Value = scope;
        return new ScopeReset(previous);
    }

    public static string Hash(Guid clientId) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(clientId.ToString("D")))).ToLowerInvariant();

    /// <summary>
    /// Derives the Entra application (client) ID from the SQL login. Entra service principals report
    /// "clientId@tenantId" and contained users created FROM EXTERNAL PROVIDER carry the client ID as SID.
    /// </summary>
    public static PrincipalState Classify(string? loginName, byte[]? sid, Guid? expectedClientId, DateTimeOffset verifiedAt)
    {
        Guid? observed = null;
        var source = "none";
        if (!string.IsNullOrWhiteSpace(loginName))
        {
            var separator = loginName.IndexOf('@');
            var prefix = separator > 0 ? loginName[..separator] : loginName;
            if (Guid.TryParse(prefix, out var fromName))
            {
                observed = fromName;
                source = "login-name";
            }
        }
        if (observed is null && sid is { Length: 16 })
        {
            observed = new Guid(sid);
            source = "sid";
        }
        if (observed is null)
            return new PrincipalState("unverified", "unknown", source, verifiedAt);
        var match = expectedClientId is null ? "unconfigured" : observed == expectedClientId ? "match" : "mismatch";
        return new PrincipalState(match, Hash(observed.Value), source, verifiedAt);
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (_connectionString is null)
        {
            _logger.LogWarning("SQL principal telemetry is disabled because no SQL connection string is configured");
            return Task.CompletedTask;
        }
        _allListeners = DiagnosticListener.AllListeners.Subscribe(this);
        _stopping = new CancellationTokenSource();
        using (ExecutionContext.SuppressFlow())
            _refreshLoop = Task.Run(() => RefreshLoopAsync(_stopping.Token));
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _stopping?.Cancel();
        if (_refreshLoop is not null)
        {
            try { await _refreshLoop.WaitAsync(cancellationToken); }
            catch (OperationCanceledException) { }
        }
    }

    private async Task RefreshLoopAsync(CancellationToken stopping)
    {
        while (!stopping.IsCancellationRequested)
        {
            var delay = RefreshInterval;
            try
            {
                await using var connection = new SqlConnection(_connectionString);
                await connection.OpenAsync(stopping);
                await using var command = new SqlCommand("SELECT SUSER_SNAME(), SUSER_SID()", connection);
                await using var reader = await command.ExecuteReaderAsync(stopping);
                if (!await reader.ReadAsync(stopping))
                    throw new InvalidOperationException("SQL returned no principal row");
                var name = reader.IsDBNull(0) ? null : reader.GetString(0);
                var sid = reader.IsDBNull(1) ? null : (byte[])reader.GetValue(1);
                var state = Classify(name, sid, _expectedClientId, DateTimeOffset.UtcNow);
                _state = state;
                if (state.Match != "match")
                    _logger.LogWarning("SQL session principal comparison for {Service} is {Match}", _service, state.Match);
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                delay = RetryInterval;
                _logger.LogWarning("SQL principal verification for {Service} failed: {Error}", _service, ex.GetType().Name);
            }
            try { await Task.Delay(delay, stopping); }
            catch (OperationCanceledException) { return; }
        }
    }

    void IObserver<DiagnosticListener>.OnNext(DiagnosticListener listener)
    {
        if (listener.Name != ListenerName)
            return;
        lock (_subscriptions)
            _subscriptions.Add(listener.Subscribe(new OpenObserver(this), name => name == OpenAfterEvent));
    }

    void IObserver<DiagnosticListener>.OnCompleted() { }
    void IObserver<DiagnosticListener>.OnError(Exception error) { }

    internal void OnConnectionOpened(object? payload)
    {
        var activity = Activity.Current;
        if (activity is null || activity.TraceId == default)
            return;
        if (payload?.GetType().GetProperty("Connection")?.GetValue(payload) is not SqlConnection connection)
            return;
        var scope = CurrentScope.Value ?? "none";
        if (_seen.Count >= MaxTrackedKeys)
            _seen.Clear();
        if (!_seen.TryAdd(activity.TraceId.ToHexString() + "|" + scope, 0))
            return;
        var state = _state;
        _telemetry.TrackEvent(EventName, new Dictionary<string, string>
        {
            ["Service"] = _service,
            ["Scope"] = scope,
            ["PrincipalMatch"] = state?.Match ?? "pending",
            ["ServerPrincipalHash"] = state?.ServerPrincipalHash ?? "unknown",
            ["PrincipalSource"] = state?.Source ?? "none",
            ["ExpectedClientHash"] = _expectedClientHash,
            ["ConnectionMatchesProbe"] = TargetMatches(connection.ConnectionString) ? "true" : "false",
            ["VerifiedAgeSeconds"] = state is null ? "-1" :
                ((long)Math.Max(0, (DateTimeOffset.UtcNow - state.VerifiedAt).TotalSeconds)).ToString(),
        });
    }

    internal bool TargetMatches(string? connectionString)
    {
        if (_target is null || string.IsNullOrWhiteSpace(connectionString))
            return false;
        try
        {
            var opened = new SqlConnectionStringBuilder(connectionString);
            return string.Equals(opened.DataSource, _target.DataSource, StringComparison.OrdinalIgnoreCase) &&
                   string.Equals(opened.InitialCatalog, _target.InitialCatalog, StringComparison.OrdinalIgnoreCase) &&
                   opened.Authentication == _target.Authentication &&
                   string.Equals(opened.UserID, _target.UserID, StringComparison.OrdinalIgnoreCase);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    public void Dispose()
    {
        _allListeners?.Dispose();
        lock (_subscriptions)
        {
            foreach (var subscription in _subscriptions)
                subscription.Dispose();
            _subscriptions.Clear();
        }
        _stopping?.Dispose();
    }

    private sealed class OpenObserver(SqlPrincipalTelemetry owner) : IObserver<KeyValuePair<string, object?>>
    {
        public void OnNext(KeyValuePair<string, object?> value)
        {
            if (value.Key != OpenAfterEvent)
                return;
            try { owner.OnConnectionOpened(value.Value); }
            catch (Exception ex) { owner._logger.LogDebug("SQL principal event skipped: {Error}", ex.GetType().Name); }
        }

        public void OnCompleted() { }
        public void OnError(Exception error) { }
    }

    private sealed class ScopeReset(string? previous) : IDisposable
    {
        public void Dispose() => CurrentScope.Value = previous;
    }
}
