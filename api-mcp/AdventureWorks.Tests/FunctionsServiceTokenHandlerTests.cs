using System.Net;
using System.Net.Http.Headers;
using AdventureWorks.Auth;
using AdventureWorks.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using OpenIddict.Server;
using Xunit;

namespace AdventureWorks.Tests;

[Collection(OAuthServerCollection.Name)]
public sealed class FunctionsServiceTokenHandlerTests
{
    private static readonly string[] ClientNames =
    [
        nameof(ManufacturingService), nameof(SupplyChainService), nameof(BankService),
        nameof(ManufacturingAutonomyGuard), nameof(SimulatorService),
    ];

    [Fact]
    public void Functions_endpoint_accepts_only_canonical_https_or_loopback_origins()
    {
        foreach (var value in new[] { "https://functions.example.test", "https://FUNCTIONS.example.test:443/",
                     "http://localhost:9099", "http://127.0.0.1:9099/", "http://[::1]:9099" })
            Assert.NotNull(new FunctionsEndpoint(value).Address);
        foreach (var value in new[] { "", " https://functions.example.test", "https://functions.example.test/api",
                     "https://functions.example.test/../", "https://functions.example.test/?a=b",
                     "https://functions.example.test/#fragment", "https://user@functions.example.test",
                     "https://@functions.example.test", "https://functions.example.test\\other",
                     "https://functions.example.test/%2e%2e", "https://functions.example.test\n/path",
                     "https://functions.example.test\r\n", "https:example.test",
                     "http://functions.example.test", "file:///tmp/test" })
            Assert.Throws<InvalidOperationException>(() => new FunctionsEndpoint(value));
        Assert.False(new FunctionsEndpoint("https://functions.example.test")
            .Contains(new Uri("https://@functions.example.test/api/status")));
    }

    [Fact]
    public async Task Functions_service_token_is_sent_only_to_the_configured_origin()
    {
        var terminal = new RecordingHandler();
        using var oauth = new OAuthTestFactory();
        var endpoint = new Uri("https://functions.example.test/");
        using var server = CreateServer(oauth, endpoint, terminal);
        var targets = new[] { "https://untrusted.example.invalid/api/manufacturing/status",
            "https://functions.example.test.untrusted.invalid/api/status",
            "http://functions.example.test/api/status", "https://functions.example.test:444/api/status",
            "https://user@functions.example.test/api/status",
            "https://functions.example.test/api/status#fragment" };
        var signingKeys = server.Services.GetRequiredService<IOptionsMonitor<OpenIddictServerOptions>>()
            .CurrentValue.SigningCredentials.Select(credentials => credentials.Key).ToList();
        foreach (var name in ClientNames)
        {
            using var client = CreateClient(server, endpoint, name);
            using var allowed = await client.GetAsync("api/manufacturing/status?test=1");
            Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
            Assert.True(terminal.SawAuthorization);
            Assert.Equal(FunctionsServiceTokenHandler.Subject, terminal.Subject);
            Assert.Equal(OAuthTestFactory.FunctionsResourceIdentifier, terminal.Audience);
            Assert.Equal(UserCategories.Service, terminal.Category);
            Assert.Equal(string.Join(' ', FunctionsServiceTokenHandler.ServiceScopes), terminal.Scope);
            var validation = await new JsonWebTokenHandler().ValidateTokenAsync(terminal.Token!, new TokenValidationParameters
            {
                ValidateIssuerSigningKey = true,
                IssuerSigningKeys = signingKeys,
                ValidateIssuer = true,
                ValidIssuer = "https://mcp.example.test/",
                ValidateAudience = true,
                ValidAudience = OAuthTestFactory.FunctionsResourceIdentifier,
                ValidateLifetime = true,
                ValidTypes = ["at+jwt"],
            });
            Assert.True(validation.IsValid);
            var expectedCalls = terminal.Calls;
            for (var index = 0; index < targets.Length; index++)
            {
                var error = await Record.ExceptionAsync(() => client.GetAsync(targets[index]));
                Assert.True(error is InvalidOperationException, "Unexpected result for foreign target case " + index);
                Assert.Equal(expectedCalls, terminal.Calls);
            }
        }
    }

    [Fact]
    public async Task Functions_proxy_rejects_supplied_authorization_and_host_headers()
    {
        var terminal = new RecordingHandler();
        using var oauth = new OAuthTestFactory();
        var endpoint = new Uri("https://functions.example.test/");
        using var server = CreateServer(oauth, endpoint, terminal);
        using var client = CreateClient(server, endpoint);
        using var supplied = new HttpRequestMessage(HttpMethod.Get, "api/manufacturing/status");
        supplied.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "supplied-test-token");
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.SendAsync(supplied));
        using var host = new HttpRequestMessage(HttpMethod.Get, "api/manufacturing/status");
        host.Headers.Host = "other.example.invalid";
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.SendAsync(host));
        using var malformedAuthorization = new HttpRequestMessage(HttpMethod.Get, "api/manufacturing/status");
        Assert.True(malformedAuthorization.Headers.TryAddWithoutValidation("Authorization", "invalid value with spaces"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.SendAsync(malformedAuthorization));
        using var malformedHost = new HttpRequestMessage(HttpMethod.Get, "api/manufacturing/status");
        Assert.True(malformedHost.Headers.TryAddWithoutValidation("Host", "invalid host with spaces"));
        using var normalized = await client.SendAsync(malformedHost);
        Assert.Equal(HttpStatusCode.OK, normalized.StatusCode);
        Assert.Equal(1, terminal.Calls);
        Assert.False(terminal.SawHost);
    }

    [Fact]
    public async Task Functions_proxy_fails_closed_without_a_remote_issuer_but_preserves_loopback_development()
    {
        var terminal = new RecordingHandler();
        using var oauth = new OAuthTestFactory();
        var endpoint = new Uri("https://functions.example.test/");
        using var server = CreateServer(oauth, endpoint, terminal, issuer: false);
        using var client = CreateClient(server, endpoint);
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.GetAsync("api/manufacturing/status"));
        Assert.Equal(0, terminal.Calls);

        var localTerminal = new RecordingHandler();
        using var localOauth = new OAuthTestFactory();
        var localEndpoint = new Uri("http://127.0.0.1:9099/");
        using var localServer = CreateServer(localOauth, localEndpoint, localTerminal, issuer: false);
        using var local = CreateClient(localServer, localEndpoint);
        using var response = await local.GetAsync("api/manufacturing/status");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.False(localTerminal.SawAuthorization);
    }

    [Fact]
    public async Task Functions_proxy_fails_closed_without_signing_credentials()
    {
        var terminal = new RecordingHandler();
        using var oauth = new OAuthTestFactory();
        var endpoint = new Uri("https://functions.example.test/");
        using var server = CreateServer(oauth, endpoint, terminal);
        server.Services.GetRequiredService<IOptionsMonitor<OpenIddictServerOptions>>()
            .CurrentValue.SigningCredentials.Clear();
        using var client = CreateClient(server, endpoint);
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.GetAsync("api/manufacturing/status"));
        Assert.Equal(0, terminal.Calls);
    }

    [Fact]
    public async Task Registered_functions_proxy_clients_do_not_follow_redirects()
    {
        var followed = 0;
        var originalRequests = 0;
        await using var destination = CreateLoopbackServer();
        destination.MapGet("/capture", () =>
        {
            Interlocked.Increment(ref followed);
            return Results.Ok();
        });
        await destination.StartAsync();
        await using var origin = CreateLoopbackServer();
        origin.MapGet("/capture", () =>
        {
            Interlocked.Increment(ref followed);
            return Results.Ok();
        });
        origin.MapGet("/api/redirect/{kind}", (HttpContext context, string kind) =>
        {
            if (context.Request.Headers.Authorization.ToString().StartsWith("Bearer ", StringComparison.Ordinal))
                Interlocked.Increment(ref originalRequests);
            context.Response.StatusCode = StatusCodes.Status307TemporaryRedirect;
            context.Response.Headers.Location = kind == "same" ? "/capture" : Address(destination) + "/capture";
            return Task.CompletedTask;
        });
        await origin.StartAsync();
        var endpoint = new Uri(Address(origin) + "/");
        using var oauth = new OAuthTestFactory();
        using var server = CreateServer(oauth, endpoint);
        foreach (var name in ClientNames)
        {
            using var client = CreateClient(server, endpoint, name);
            foreach (var kind in new[] { "same", "other" })
            {
                using var response = await client.GetAsync("api/redirect/" + kind);
                Assert.Equal(HttpStatusCode.TemporaryRedirect, response.StatusCode);
            }
        }
        Assert.Equal(2 * ClientNames.Length, Volatile.Read(ref originalRequests));
        Assert.Equal(0, Volatile.Read(ref followed));
    }

    private static WebApplicationFactory<Program> CreateServer(
        OAuthTestFactory oauth, Uri endpoint, HttpMessageHandler? terminal = null, bool issuer = true) =>
        oauth.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            var options = (AuthorizationServerOptions)services
                .Single(item => item.ServiceType == typeof(AuthorizationServerOptions)).ImplementationInstance!;
            options.PublicBaseUrl = issuer ? "https://mcp.example.test" : null;
            services.RemoveAll<FunctionsEndpoint>();
            services.AddSingleton(new FunctionsEndpoint(endpoint.AbsoluteUri));
            if (terminal is not null)
                foreach (var name in ClientNames)
                    services.AddHttpClient(name).ConfigurePrimaryHttpMessageHandler(() => terminal);
        }));

    private static HttpClient CreateClient(WebApplicationFactory<Program> server, Uri endpoint,
        string name = nameof(ManufacturingService))
    {
        var client = server.Services.GetRequiredService<IHttpClientFactory>().CreateClient(name);
        client.BaseAddress = endpoint;
        return client;
    }

    private static WebApplication CreateLoopbackServer()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        return builder.Build();
    }

    private static string Address(WebApplication application) =>
        application.Services.GetRequiredService<IServer>().Features
            .Get<IServerAddressesFeature>()!.Addresses.Single().TrimEnd('/');

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public int Calls { get; private set; }
        public bool SawAuthorization { get; private set; }
        public bool SawHost { get; private set; }
        public string? Subject { get; private set; }
        public string? Audience { get; private set; }
        public string? Category { get; private set; }
        public string? Scope { get; private set; }
        public string? Token { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            SawHost = request.Headers.NonValidated.Contains("Host");
            SawAuthorization = request.Headers.Authorization?.Scheme == "Bearer" &&
                               !string.IsNullOrWhiteSpace(request.Headers.Authorization.Parameter);
            if (SawAuthorization)
            {
                Token = request.Headers.Authorization!.Parameter!;
                var token = new JsonWebToken(Token);
                Subject = token.Subject;
                Audience = token.Audiences.Single();
                Category = token.GetClaim(AwClaims.Category).Value;
                Scope = token.GetClaim("scope").Value;
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }
    }
}
