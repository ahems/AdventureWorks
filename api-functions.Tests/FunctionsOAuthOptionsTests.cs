using ApiFunctions.Auth;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace ApiFunctions.Tests;

/// <summary>
/// Unit tests for <see cref="FunctionsOAuthOptions.FromConfiguration"/>: the deployment-derived
/// issuer/audience/metadata resolution and the fail-open enforcement-mode policy.
/// </summary>
public class FunctionsOAuthOptionsTests
{
    // Every environment variable FromConfiguration consults. Env-sensitive tests clear these so the
    // result is deterministic even in a deployed/azd shell where API_MCP_URL etc. may be present.
    private static readonly string[] RelevantEnvKeys =
    {
        "FUNCTIONS_JWT_ISSUER", "FUNCTIONS_JWT_AUDIENCE", "FUNCTIONS_JWT_METADATA_ADDRESS",
        "FUNCTIONS_RESOURCE_IDENTIFIER", "API_MCP_URL", "MCP_PUBLIC_BASE_URL", "MCP_SERVICE_URL",
        "FUNCTIONS_OAUTH_MODE",
    };

    private static IConfiguration Config(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    [Fact]
    public void Stays_disabled_when_issuer_is_not_configured()
    {
        using var _ = new EnvScope(RelevantEnvKeys);

        // Even an explicit "enforced" request must fail open to Disabled when there is nothing to
        // validate against (no issuer/audience/metadata) — local + not-yet-wired deployments.
        var options = FunctionsOAuthOptions.FromConfiguration(
            Config(new() { ["FUNCTIONS_OAUTH_MODE"] = "enforced" }));

        Assert.Equal(OAuthEnforcementMode.Disabled, options.Mode);
        Assert.False(options.IsConfigured);
    }

    [Theory]
    [InlineData("enforced", OAuthEnforcementMode.Enforced)]
    [InlineData("enforce", OAuthEnforcementMode.Enforced)]
    [InlineData("audit", OAuthEnforcementMode.Audit)]
    [InlineData("shadow", OAuthEnforcementMode.Audit)]
    [InlineData("disabled", OAuthEnforcementMode.Disabled)]
    [InlineData("nonsense", OAuthEnforcementMode.Disabled)]
    public void Resolves_mode_when_fully_configured(string mode, OAuthEnforcementMode expected)
    {
        using var _ = new EnvScope(RelevantEnvKeys);

        var options = FunctionsOAuthOptions.FromConfiguration(Config(new()
        {
            ["FUNCTIONS_JWT_ISSUER"] = "https://mcp.example.test",
            ["FUNCTIONS_OAUTH_MODE"] = mode,
        }));

        Assert.Equal(expected, options.Mode);
        Assert.True(options.IsConfigured);
    }

    [Fact]
    public void Defaults_to_disabled_when_mode_unset_even_if_configured()
    {
        using var _ = new EnvScope(RelevantEnvKeys);

        var options = FunctionsOAuthOptions.FromConfiguration(
            Config(new() { ["FUNCTIONS_JWT_ISSUER"] = "https://mcp.example.test" }));

        Assert.Equal(OAuthEnforcementMode.Disabled, options.Mode);
    }

    [Fact]
    public void Derives_audience_and_metadata_from_issuer()
    {
        using var _ = new EnvScope(RelevantEnvKeys);

        var options = FunctionsOAuthOptions.FromConfiguration(Config(new()
        {
            ["FUNCTIONS_JWT_ISSUER"] = "https://mcp.example.test/",
            ["FUNCTIONS_OAUTH_MODE"] = "audit",
        }));

        Assert.Equal("https://mcp.example.test", options.Issuer);
        Assert.Equal("https://mcp.example.test/functions", options.Audience);
        Assert.Equal("https://mcp.example.test/.well-known/openid-configuration", options.MetadataAddress);
    }

    [Fact]
    public void Explicit_audience_overrides_the_derived_one()
    {
        using var _ = new EnvScope(RelevantEnvKeys);

        var options = FunctionsOAuthOptions.FromConfiguration(Config(new()
        {
            ["FUNCTIONS_JWT_ISSUER"] = "https://mcp.example.test",
            ["FUNCTIONS_JWT_AUDIENCE"] = "https://mcp.example.test/custom-functions",
            ["FUNCTIONS_OAUTH_MODE"] = "enforced",
        }));

        Assert.Equal("https://mcp.example.test/custom-functions", options.Audience);
        Assert.Equal(OAuthEnforcementMode.Enforced, options.Mode);
    }

    /// <summary>Saves, clears and restores a set of environment variables for deterministic tests.</summary>
    private sealed class EnvScope : IDisposable
    {
        private readonly Dictionary<string, string?> _saved = new(StringComparer.Ordinal);

        public EnvScope(params string[] keys)
        {
            foreach (var key in keys)
            {
                _saved[key] = Environment.GetEnvironmentVariable(key);
                Environment.SetEnvironmentVariable(key, null);
            }
        }

        public void Dispose()
        {
            foreach (var (key, value) in _saved)
            {
                Environment.SetEnvironmentVariable(key, value);
            }
        }
    }
}
