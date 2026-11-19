using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using api_functions.Functions;
using api_functions.Services;
using Azure.Core;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ApiFunctions.Tests;

public class AgentHttpClientSecurityTests
{
    [Fact]
    public async Task Managed_identity_assertions_and_delegated_tool_tokens_do_not_follow_redirects()
    {
        var redirectedRequests = 0;
        await using var destination = CreateServer();
        destination.MapPost("/capture", () =>
        {
            Interlocked.Increment(ref redirectedRequests);
            return Results.Ok();
        });
        await destination.StartAsync();
        var destinationUrl = Address(destination) + "/capture";

        string? assertionBody = null;
        string? foundryBody = null;
        string? hostedBody = null;
        string? hostedAuthorization = null;
        string mcpUrl = string.Empty;
        await using var origin = CreateServer();
        origin.MapPost("/token", async (HttpContext context) =>
        {
            assertionBody = await new StreamReader(context.Request.Body, Encoding.UTF8).ReadToEndAsync();
            context.Response.StatusCode = StatusCodes.Status307TemporaryRedirect;
            context.Response.Headers.Location = destinationUrl;
        });
        origin.MapGet("/agents/{agentId}", () => Results.Json(new
        {
            versions = new { latest = new { id = "agent:1", definition = new
            {
                kind = "prompt",
                model = "chat",
                instructions = "Test",
                tools = new[] { new { type = "mcp", server_label = "aw", server_url = mcpUrl } }
            } } }
        }));
        origin.MapPost("/mcp", () => Results.Unauthorized());
        origin.MapPost("/openai/v1/responses", async (HttpContext context) =>
        {
            foundryBody = await new StreamReader(context.Request.Body, Encoding.UTF8).ReadToEndAsync();
            context.Response.StatusCode = StatusCodes.Status307TemporaryRedirect;
            context.Response.Headers.Location = destinationUrl;
        });
        origin.MapPost("/api/projects/demo/agents/manufacturing-agent/endpoint/protocols/openai/responses",
            async (HttpContext context) =>
            {
                hostedBody = await new StreamReader(context.Request.Body, Encoding.UTF8).ReadToEndAsync();
                hostedAuthorization = context.Request.Headers.Authorization.ToString();
                context.Response.StatusCode = StatusCodes.Status307TemporaryRedirect;
                context.Response.Headers.Location = destinationUrl;
                await context.Response.WriteAsync("private-error-sentinel");
            });
        await origin.StartAsync();
        mcpUrl = Address(origin) + "/mcp";

        using var services = new ServiceCollection().AddLogging().AddAgentHttpClients().BuildServiceProvider();
        var factory = services.GetRequiredService<IHttpClientFactory>();
        var credential = new TestCredential();
        var tokenProvider = new McpServiceTokenProvider(
            credential, factory, NullLogger<McpServiceTokenProvider>.Instance, mcpUrl);
        Assert.Null(await tokenProvider.GetTokenAsync(
            [McpServiceTokenProvider.ProductsReadScope], CancellationToken.None));

        using var telemetry = new TelemetryConfiguration { DisableTelemetry = true };
        var client = new FoundryAgentClient(
            NullLogger<FoundryAgentClient>.Instance, new TelemetryClient(telemetry), credential,
            Address(origin), factory, mcpUrl, serviceTokenProvider: tokenProvider);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => client.InvokeAsync(
            "agent", "Use tools", toolChoice: "required", mcpAccessToken: "delegated-sentinel"));

        Assert.Contains("redirect", error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("assertion=assertion-sentinel", assertionBody);
        using var json = JsonDocument.Parse(foundryBody!);
        Assert.Equal("Bearer delegated-sentinel", json.RootElement.GetProperty("tools")[0]
            .GetProperty("headers").GetProperty("Authorization").GetString());
        var hostedError = await Record.ExceptionAsync(() => SendHosted(
            factory, credential, Address(origin) + "/api/projects/demo",
            Address(origin) + "/api/projects/demo/agents/manufacturing-agent/endpoint/protocols/openai/responses?api-version=v1",
            "private-order-sentinel"));
        Assert.NotNull(hostedError);
        Assert.Contains("HTTP 307", hostedError.Message);
        Assert.DoesNotContain("private-error-sentinel", hostedError.Message);
        Assert.Equal("Bearer assertion-sentinel", hostedAuthorization);
        Assert.Equal("private-order-sentinel", hostedBody);
        Assert.Equal(0, Volatile.Read(ref redirectedRequests));
    }

    [Theory]
    [InlineData("foreign-host")]
    [InlineData("lookalike-host")]
    [InlineData("wrong-project")]
    [InlineData("wrong-path")]
    [InlineData("extra-query")]
    [InlineData("fragment")]
    [InlineData("userinfo")]
    [InlineData("dot-segment")]
    [InlineData("encoded-dot-segment")]
    [InlineData("insecure")]
    [InlineData("invalid-project")]
    public async Task Hosted_agent_rejects_untrusted_endpoint_before_acquiring_a_token(string defect)
    {
        const string project = "https://foundry.example.test/api/projects/demo";
        const string suffix = "/agents/manufacturing-agent/endpoint/protocols/openai/responses?api-version=v1";
        var configured = defect == "invalid-project" ? project + "?unexpected=1" : project;
        var target = defect switch
        {
            "foreign-host" => "https://foreign.example.test/api/projects/demo" + suffix,
            "lookalike-host" => "https://foundry.example.test.attacker.test/api/projects/demo" + suffix,
            "wrong-project" => "https://foundry.example.test/api/projects/other" + suffix,
            "wrong-path" => project + "/other" + suffix,
            "extra-query" => project + suffix + "&other=1",
            "fragment" => project + suffix + "#fragment",
            "userinfo" => "https://user@foundry.example.test/api/projects/demo" + suffix,
            "dot-segment" => "https://foundry.example.test/api/projects/x/../demo" + suffix,
            "encoded-dot-segment" => "https://foundry.example.test/api/projects/x/%2e%2e/demo" + suffix,
            "insecure" => "http://foundry.example.test/api/projects/demo" + suffix,
            _ => project + suffix,
        };
        using var services = new ServiceCollection().AddLogging().AddAgentHttpClients().BuildServiceProvider();
        var credential = new TestCredential();
        var error = await Record.ExceptionAsync(() => SendHosted(
            services.GetRequiredService<IHttpClientFactory>(), credential, configured, target, "{}"));
        Assert.IsType<InvalidOperationException>(error);
        Assert.Equal(0, credential.Requests);
    }

    [Fact]
    public async Task Hosted_agent_sends_to_the_validated_endpoint_and_returns_completed_findings()
    {
        const string project = "https://foundry.example.test/api/projects/demo";
        const string endpoint = project + "/agents/manufacturing-agent/endpoint/protocols/openai/responses?api-version=v1";
        var responseBody = JsonSerializer.Serialize(new
        {
            @object = "response",
            status = "completed",
            output = new[]
            {
                new
                {
                    type = "message",
                    role = "assistant",
                    content = new[] { new { type = "output_text", text = """{"findingsSummary":"Healthy"}""" } }
                }
            }
        });
        using var content = new StringContent(responseBody, Encoding.UTF8, "application/json");
        using var handler = new StatusHandler(HttpStatusCode.OK, content);
        var factory = new TestFactory(handler);
        var credential = new TestCredential();

        var result = await SendHosted(factory, credential, project, endpoint, "{}");

        Assert.Equal("Healthy", result.GetType().GetProperty("FindingsSummary")!.GetValue(result));
        Assert.Equal(1, credential.Requests);
        Assert.Equal(new Uri(endpoint), handler.RequestUri);
        Assert.Equal("Bearer assertion-sentinel", handler.Authorization);
        Assert.Equal(AgentHttpClients.HostedManufacturing, factory.Name);
    }

    [Theory]
    [InlineData(HttpStatusCode.Redirect)]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task Hosted_agent_http_errors_do_not_read_or_expose_untrusted_bodies(HttpStatusCode status)
    {
        const string project = "https://foundry.example.test/api/projects/demo";
        const string endpoint = project + "/agents/manufacturing-agent/endpoint/protocols/openai/responses?api-version=v1";
        using var content = new UnreadableContent();
        using var handler = new StatusHandler(status, content);
        var factory = new TestFactory(handler);
        var error = await Record.ExceptionAsync(() => SendHosted(factory, new TestCredential(), project, endpoint, "{}"));
        Assert.NotNull(error);
        Assert.Equal("ManufacturingAgentThrottledException", error.GetType().Name);
        Assert.Contains($"HTTP {(int)status}", error.Message);
        Assert.DoesNotContain("private-error-sentinel", error.Message);
        Assert.False(content.ReadAttempted);
        Assert.Equal(AgentHttpClients.HostedManufacturing, factory.Name);
    }

    private static async Task<object> SendHosted(IHttpClientFactory factory, TokenCredential credential,
        string project, string endpoint, string body)
    {
        var task = (Task)typeof(ManufacturingAgentQueueTrigger)
            .GetMethod("SendHostedResponseAsync", BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, [factory, credential, project, endpoint, body, CancellationToken.None])!;
        await task;
        return task.GetType().GetProperty("Result")!.GetValue(task)!;
    }

    private static WebApplication CreateServer()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        return builder.Build();
    }

    private static string Address(WebApplication application) =>
        application.Services.GetRequiredService<IServer>().Features
            .Get<IServerAddressesFeature>()!.Addresses.Single().TrimEnd('/');

    private sealed class TestCredential : TokenCredential
    {
        public int Requests { get; private set; }

        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken)
        {
            Requests++;
            return new("assertion-sentinel", DateTimeOffset.UtcNow.AddMinutes(10));
        }

        public override ValueTask<AccessToken> GetTokenAsync(
            TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    private sealed class TestFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public string? Name { get; private set; }

        public HttpClient CreateClient(string name)
        {
            Name = name;
            return new HttpClient(handler, disposeHandler: false);
        }
    }

    private sealed class StatusHandler(HttpStatusCode status, HttpContent content) : HttpMessageHandler
    {
        public Uri? RequestUri { get; private set; }
        public string? Authorization { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            RequestUri = request.RequestUri;
            Authorization = request.Headers.Authorization?.ToString();
            return Task.FromResult(new HttpResponseMessage(status) { Content = content });
        }
    }

    private sealed class UnreadableContent : HttpContent
    {
        public bool ReadAttempted { get; private set; }

        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context)
        {
            ReadAttempted = true;
            throw new InvalidOperationException("private-error-sentinel");
        }

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }
}
