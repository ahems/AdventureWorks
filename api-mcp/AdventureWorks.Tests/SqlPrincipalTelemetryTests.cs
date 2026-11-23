using System.Diagnostics;
using AdventureWorks.Telemetry;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Channel;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace AdventureWorks.Tests;

public class SqlPrincipalTelemetryTests
{
    private const string ConnectionString =
        "Server=tcp:sql.example.invalid,1433;Database=aw;Authentication=Active Directory Default;User Id=11111111-1111-1111-1111-111111111111";
    private static readonly Guid ClientId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    [Fact]
    public void Classify_UsesEntraLoginNameClientId()
    {
        var state = SqlPrincipalTelemetry.Classify($"{ClientId}@22222222-2222-2222-2222-222222222222", null, ClientId, Now);

        Assert.Equal("match", state.Match);
        Assert.Equal("login-name", state.Source);
        Assert.Equal(SqlPrincipalTelemetry.Hash(ClientId), state.ServerPrincipalHash);
    }

    [Fact]
    public void Classify_FallsBackToExternalProviderSid()
    {
        var state = SqlPrincipalTelemetry.Classify("runtime-identity", ClientId.ToByteArray(), ClientId, Now);

        Assert.Equal("match", state.Match);
        Assert.Equal("sid", state.Source);
    }

    [Fact]
    public void Classify_ReportsMismatchUnconfiguredAndUnverified()
    {
        var other = Guid.Parse("33333333-3333-3333-3333-333333333333");

        Assert.Equal("mismatch", SqlPrincipalTelemetry.Classify(other.ToString(), null, ClientId, Now).Match);
        Assert.Equal("unconfigured", SqlPrincipalTelemetry.Classify(other.ToString(), null, null, Now).Match);
        var unverified = SqlPrincipalTelemetry.Classify("sqladmin", new byte[] { 1, 2, 3 }, ClientId, Now);
        Assert.Equal("unverified", unverified.Match);
        Assert.Equal("unknown", unverified.ServerPrincipalHash);
    }

    [Fact]
    public void Hash_IsLowercaseSha256OfCanonicalGuid()
    {
        Assert.Equal(SqlPrincipalTelemetry.Hash(ClientId), SqlPrincipalTelemetry.Hash(Guid.Parse(ClientId.ToString("N").ToUpperInvariant())));
        Assert.Matches("^[0-9a-f]{64}$", SqlPrincipalTelemetry.Hash(ClientId));
    }

    [Fact]
    public void TargetMatches_RequiresSameServerDatabaseAuthenticationAndIdentity()
    {
        using var sut = Create(new List<ITelemetry>());

        Assert.True(sut.TargetMatches(ConnectionString.Replace("Database=aw", "Initial Catalog=AW")));
        Assert.False(sut.TargetMatches(ConnectionString.Replace("Database=aw", "Database=other")));
        Assert.False(sut.TargetMatches(ConnectionString.Replace("User Id=11111111-1111-1111-1111-111111111111", "User Id=33333333-3333-3333-3333-333333333333")));
        Assert.False(sut.TargetMatches("Server=tcp:sql.example.invalid;Database=aw;User Id=sa;Password=x"));
        Assert.False(sut.TargetMatches("not a connection string"));
    }

    [Fact]
    public void EnterScope_RestoresPreviousScopeAndLabelsEvents()
    {
        var sent = new List<ITelemetry>();
        using var sut = Create(sent);
        using var activity = new Activity("test").SetIdFormat(ActivityIdFormat.W3C).Start();
        var payload = new { Connection = new SqlConnection(ConnectionString) };

        using (SqlPrincipalTelemetry.EnterScope("tool:outer"))
        {
            using (SqlPrincipalTelemetry.EnterScope("tool:inner"))
                sut.OnConnectionOpened(payload);
            sut.OnConnectionOpened(payload);
            sut.OnConnectionOpened(payload);
        }
        sut.OnConnectionOpened(payload);

        var events = sent.OfType<EventTelemetry>().ToList();
        Assert.Equal(new[] { "tool:inner", "tool:outer", "none" }, events.Select(e => e.Properties["Scope"]));
        Assert.All(events, e =>
        {
            Assert.Equal(SqlPrincipalTelemetry.EventName, e.Name);
            Assert.Equal("pending", e.Properties["PrincipalMatch"]);
            Assert.Equal(SqlPrincipalTelemetry.Hash(ClientId), e.Properties["ExpectedClientHash"]);
            Assert.Equal("true", e.Properties["ConnectionMatchesProbe"]);
            Assert.Equal("-1", e.Properties["VerifiedAgeSeconds"]);
            Assert.DoesNotContain(ClientId.ToString(), string.Join("|", e.Properties.Values));
        });
    }

    [Fact]
    public void OnConnectionOpened_IgnoresUntracedConnections()
    {
        var sent = new List<ITelemetry>();
        using var sut = Create(sent);
        Activity.Current = null;

        sut.OnConnectionOpened(new { Connection = new SqlConnection(ConnectionString) });

        Assert.Empty(sent);
    }

    private static SqlPrincipalTelemetry Create(List<ITelemetry> sent)
    {
        var capture = new ApiFunctions.Tests.TelemetryTestCapture();
        var configuration = capture.CreateConfiguration();
        capture.Target = sent;
        return new SqlPrincipalTelemetry(new TelemetryClient(configuration), NullLogger<SqlPrincipalTelemetry>.Instance,
            "api-mcp", ConnectionString, ClientId.ToString());
    }

}
