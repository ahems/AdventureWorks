using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AdventureWorks.Auth;
using AdventureWorks.Services;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.IdentityModel.Tokens;
using ModelContextProtocol.Protocol;
using Xunit;

namespace AdventureWorks.Tests;

[Collection(OAuthServerCollection.Name)]
public sealed class McpToolDispatchTests : IClassFixture<McpDispatchFixture>
{
    private readonly McpDispatchFixture _fixture;

    public McpToolDispatchTests(McpDispatchFixture fixture)
    {
        _fixture = fixture;
        _fixture.Reset();
    }

    public static IEnumerable<object[]> Denials => ToolAuthorizationRegistry.All.SelectMany(policy =>
        new[] { "anonymous", "missing-business-scope", "wrong-audience" }
            .Select(reason => new object[] { policy.Tool, reason }));

    public static IEnumerable<object[]> Tools => ToolAuthorizationRegistry.All
        .Select(policy => new object[] { policy.Tool });

    public static IEnumerable<object[]> Owners => ToolAuthorizationRegistry.All
        .Where(policy => policy.Mode == ToolAccessMode.SelfOrInternal)
        .SelectMany(policy => new[] { 71, 72 }.Select(owner => new object[] { policy.Tool, owner }));

    [Theory]
    [MemberData(nameof(Denials))]
    public async Task Every_tool_denial_stops_real_http_dispatch(string name, string reason)
    {
        var token = reason == "anonymous" ? null : await _fixture.TokenAsync(
            reason == "wrong-audience" ? OAuthTestFactory.DabResourceIdentifier :
                OAuthTestFactory.ResourceIdentifier, OAuthScopes.McpAccess, consumer: 71);
        using var response = await _fixture.CallAsync(name, token);
        if (reason == "missing-business-scope")
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            using var result = await McpDispatchFixture.ReadResultAsync(response);
            Assert.True(result.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
        }
        else
        {
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        }
        Assert.Empty(_fixture.Calls);
    }

    [Theory]
    [MemberData(nameof(Tools))]
    public async Task Every_tool_with_issued_service_scope_reaches_dispatch_once(string name)
    {
        var policy = ToolAuthorizationRegistry.Find(name)!;
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            OAuthScopes.McpAccess + " " + policy.RequiredScope);
        using var response = await _fixture.CallAsync(name, token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var result = await McpDispatchFixture.ReadResultAsync(response);
        Assert.False(result.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
        Assert.Equal(name, Assert.Single(_fixture.Calls).Name);
    }

    [Theory]
    [MemberData(nameof(Tools))]
    public async Task Denied_task_opt_in_returns_authorization_error_not_a_background_task(string name)
    {
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier, OAuthScopes.McpAccess);
        using var response = await _fixture.CallAsync(name, token, task: true);
        Assert.True(response.StatusCode == HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        using var result = await McpDispatchFixture.ReadResultAsync(response);
        var body = result.RootElement.GetProperty("result");
        Assert.False(body.TryGetProperty("taskId", out _));
        Assert.True(body.GetProperty("isError").GetBoolean());
        Assert.Empty(_fixture.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Catalogue_only_service_cannot_dispatch_purchase_history_recommendations(bool task)
    {
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            OAuthScopes.McpAccess + " " + OAuthScopes.ProductsRead);
        using var response = await _fixture.CallAsync("get_personalized_recommendations", token,
            new() { ["customerId"] = 71 }, task: task);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var result = await McpDispatchFixture.ReadResultAsync(response);
        var body = result.RootElement.GetProperty("result");
        Assert.False(body.TryGetProperty("taskId", out _));
        Assert.True(body.GetProperty("isError").GetBoolean());
        Assert.Contains("orders.read", body.GetProperty("content")[0].GetProperty("text").GetString());
        Assert.Empty(_fixture.Calls);
    }

    [Fact]
    public async Task Authorized_task_opt_in_preserves_background_dispatch()
    {
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            OAuthScopes.McpAccess + " " + OAuthScopes.ProductsRead);
        using var response = await _fixture.CallAsync("get_categories_with_products", token, task: true);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var result = await McpDispatchFixture.ReadResultAsync(response);
        Assert.False(string.IsNullOrWhiteSpace(result.RootElement.GetProperty("result").GetProperty("taskId").GetString()));
        await _fixture.NextDispatch.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("get_categories_with_products", Assert.Single(_fixture.Calls).Name);
    }

    [Theory]
    [InlineData(71)]
    [InlineData(72)]
    public async Task Task_handlers_bind_owner_and_recheck_scope_before_reads_updates_or_cancellation(int owner)
    {
        var scope = OAuthScopes.McpAccess + " " + OAuthScopes.ProductsRead;
        var ownToken = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier, scope, owner);
        var otherToken = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier, scope, owner == 71 ? 72 : 71);
        var reducedToken = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier, OAuthScopes.McpAccess, owner);
        try
        {
            using var created = await _fixture.CallAsync("get_categories_with_products", ownToken,
                new() { ["blockForOwnershipTest"] = true }, task: true);
            using var creation = await McpDispatchFixture.ReadResultAsync(created);
            var taskId = creation.RootElement.GetProperty("result").GetProperty("taskId").GetString()!;
            await _fixture.NextDispatch.Task.WaitAsync(TimeSpan.FromSeconds(10));
            using var initial = await _fixture.TaskAsync("tasks/get", taskId, ownToken);
            using var initialResult = await McpDispatchFixture.ReadResultAsync(initial);
            Assert.False(initialResult.RootElement.TryGetProperty("error", out _));
            Assert.Equal(taskId, initialResult.RootElement.GetProperty("result").GetProperty("taskId").GetString());
            var status = initialResult.RootElement.GetProperty("result").GetProperty("status").GetRawText();

            foreach (var token in new[] { otherToken, reducedToken })
                foreach (var method in new[] { "tasks/get", "tasks/update", "tasks/cancel" })
                {
                    using var response = await _fixture.TaskAsync(method, taskId, token);
                    using var result = await McpDispatchFixture.ReadResultAsync(response);
                    Assert.Equal("Task is not available.",
                        result.RootElement.GetProperty("error").GetProperty("message").GetString());
                    Assert.False(result.RootElement.TryGetProperty("result", out _));
                }
            using var unchanged = await _fixture.TaskAsync("tasks/get", taskId, ownToken);
            using var unchangedResult = await McpDispatchFixture.ReadResultAsync(unchanged);
            Assert.Equal(status, unchangedResult.RootElement.GetProperty("result").GetProperty("status").GetRawText());
        }
        finally
        {
            _fixture.DispatchRelease.TrySetResult();
        }
    }

    [Theory]
    [MemberData(nameof(Owners))]
    public async Task Consumer_owner_is_injected_before_dispatch_and_foreign_owner_never_dispatches(
        string name, int owner)
    {
        var policy = ToolAuthorizationRegistry.Find(name)!;
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            OAuthScopes.McpAccess + " " + policy.RequiredScope, owner);
        foreach (var arguments in new Dictionary<string, object?>?[]
        {
            null,
            new() { [policy.OwnerArgument!] = null },
            new() { [policy.OwnerArgument!] = owner.ToString() },
        })
        {
            _fixture.Calls.Clear();
            using var own = await _fixture.CallAsync(name, token, arguments);
            Assert.Equal(HttpStatusCode.OK, own.StatusCode);
            using var ownResult = await McpDispatchFixture.ReadResultAsync(own);
            Assert.False(ownResult.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
            var dispatchedOwner = Assert.Single(_fixture.Calls).Arguments[policy.OwnerArgument!];
            if (arguments?.GetValueOrDefault(policy.OwnerArgument!) is string)
                Assert.Equal(owner.ToString(), dispatchedOwner.GetString());
            else
                Assert.Equal(owner, dispatchedOwner.GetInt32());
        }

        var other = owner == 71 ? 72 : 71;
        foreach (var value in new object[] { other, other.ToString(), "invalid", true, new[] { owner },
                     new { id = owner }, 0, -1 })
        {
            _fixture.Calls.Clear();
            using var foreign = await _fixture.CallAsync(name, token,
                new Dictionary<string, object?> { [policy.OwnerArgument!] = value });
            Assert.Equal(HttpStatusCode.OK, foreign.StatusCode);
            using var foreignResult = await McpDispatchFixture.ReadResultAsync(foreign);
            Assert.True(foreignResult.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
            Assert.Empty(_fixture.Calls);
        }
    }
}

[Collection(OAuthServerCollection.Name)]
public sealed class McpSimulatorResetTests
{
    [Fact]
    public async Task Incomplete_simulator_reset_is_an_mcp_error_without_retry_or_private_details()
    {
        using var fixture = McpDispatchFixture.WithSimulatorFailure();
        var token = await fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            OAuthScopes.McpAccess + " " + OAuthScopes.McpAdmin);
        using var response = await fixture.CallAsync("reset_all_simulators", token,
            new() { ["confirmed"] = true });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var result = await McpDispatchFixture.ReadResultAsync(response);
        Assert.True(result.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
        Assert.DoesNotContain("private-reset-diagnostic", result.RootElement.GetRawText());
        Assert.Equal(1, fixture.SimulatorRequests);
    }
}

public sealed class McpDispatchFixture : IDisposable
{
    private readonly OAuthTestFactory _oauth = new();
    private readonly WebApplicationFactory<Program> _server;
    private readonly HttpClient _client;
    private readonly HttpClient? _simulatorHttp;
    private readonly Dictionary<(string Resource, string Scope, int? Consumer), string> _tokens = [];

    public List<(string Name, Dictionary<string, JsonElement> Arguments)> Calls { get; } = [];
    public int SimulatorRequests { get; private set; }
    public TaskCompletionSource NextDispatch { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource DispatchRelease { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public void Reset()
    {
        Calls.Clear();
        NextDispatch = new(TaskCreationOptions.RunContinuationsAsynchronously);
        DispatchRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    public McpDispatchFixture() : this(false) { }

    public static McpDispatchFixture WithSimulatorFailure() => new(true);

    private McpDispatchFixture(bool simulatorFailure)
    {
        if (simulatorFailure)
            _simulatorHttp = new HttpClient(new FailedSimulatorHandler(this))
                { BaseAddress = new Uri("https://functions.example.test/") };
        foreach (var owner in new[] { 71, 72 })
        {
            _oauth.Directory.Add($"dispatch{owner}@example.invalid", "dispatch-test-password", new ResolvedUser
            {
                Subject = $"dispatch-consumer-{owner}",
                Category = UserCategories.Consumer,
                Roles = [ApplicationRoles.Consumer],
                Scopes = [OAuthScopes.McpAccess, OAuthScopes.OrdersRead, OAuthScopes.ProductsRead],
                CustomerId = owner,
                BusinessEntityId = owner,
                DisplayName = "Dispatch test consumer",
            });
        }
        _server = _oauth.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            if (simulatorFailure)
            {
                services.RemoveAll<SimulatorService>();
                services.AddSingleton(new SimulatorService(_simulatorHttp!));
                return;
            }
            // An innermost sentinel replaces business execution, preserving the production filters.
            services.AddMcpServer().WithRequestFilters(filters => filters.AddCallToolFilter(_ =>
                async (context, _) =>
                {
                    Calls.Add((context.Params!.Name, new(context.Params.Arguments ??
                        new Dictionary<string, JsonElement>())));
                    NextDispatch.TrySetResult();
                    if (context.Params.Arguments?.TryGetValue("blockForOwnershipTest", out var block) is true &&
                        block.ValueKind == JsonValueKind.True)
                        await DispatchRelease.Task;
                    return new CallToolResult
                    {
                        IsError = false,
                        Content = [new TextContentBlock { Text = "isolated dispatch" }],
                    };
                }));
        }));
        _client = _server.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            HandleCookies = false,
        });
    }

    public async Task<string> TokenAsync(string resource, string scope, int? consumer = null)
    {
        var key = (resource, scope, consumer);
        if (_tokens.TryGetValue(key, out var cached)) return cached;
        Dictionary<string, string> form;
        if (consumer is int owner)
        {
            using var browser = _server.CreateClient(new WebApplicationFactoryClientOptions
            {
                AllowAutoRedirect = false,
                HandleCookies = true,
            });
            using var login = await browser.PostAsync("/login", new FormUrlEncodedContent(
                new Dictionary<string, string>
                {
                    ["username"] = $"dispatch{owner}@example.invalid",
                    ["password"] = "dispatch-test-password",
                    ["returnUrl"] = "/",
                }));
            Assert.Equal(HttpStatusCode.Found, login.StatusCode);
            var verifier = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            var challenge = Base64UrlEncoder.Encode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
            const string redirect = "http://localhost:5173/oauth/callback";
            using var authorize = await browser.GetAsync(
                "/authorize?client_id=adventureworks-eshop&response_type=code" +
                "&redirect_uri=" + Uri.EscapeDataString(redirect) +
                "&resource=" + Uri.EscapeDataString(resource) +
                "&scope=" + Uri.EscapeDataString(scope) +
                "&code_challenge_method=S256&code_challenge=" + challenge);
            Assert.Equal(HttpStatusCode.Found, authorize.StatusCode);
            var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(authorize.Headers.Location!.Query);
            Assert.True(query.ContainsKey("code"));
            form = new()
            {
                ["grant_type"] = "authorization_code",
                ["client_id"] = "adventureworks-eshop",
                ["redirect_uri"] = redirect,
                ["code_verifier"] = verifier,
                ["code"] = query["code"].ToString(),
            };
        }
        else
        {
            form = new()
            {
                ["grant_type"] = ManagedIdentityGrant.GrantType,
                ["client_id"] = AuthorizationServerOptions.ServiceClientId,
                ["resource"] = resource,
                ["scope"] = scope,
                ["assertion"] = OAuthTestFactory.ValidServiceAssertion,
            };
        }
        using var response = await _client.PostAsync("/token", new FormUrlEncodedContent(form));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var token = body.RootElement.GetProperty("access_token").GetString()!;
        _tokens.Add(key, token);
        return token;
    }

    public async Task<HttpResponseMessage> CallAsync(string name, string? token,
        Dictionary<string, object?>? arguments = null, bool task = false)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/mcp")
        {
            Content = JsonContent.Create(new
            {
                jsonrpc = "2.0", id = 1, method = "tools/call",
                @params = new
                {
                    name, arguments = arguments ?? [],
                    _meta = task ? TaskMetadata() : null,
                },
            }),
        };
        return await SendAsync(request, token, "tools/call", name, task);
    }

    private static Dictionary<string, object> TaskMetadata() => new()
    {
        ["io.modelcontextprotocol/protocolVersion"] = "2026-07-28",
        [MetaKeys.ClientCapabilities] = new
        {
            extensions = new Dictionary<string, object> { ["io.modelcontextprotocol/tasks"] = new { } },
        },
    };

    public async Task<HttpResponseMessage> TaskAsync(string method, string taskId, string token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/mcp")
        {
            Content = JsonContent.Create(new
            {
                jsonrpc = "2.0", id = 1, method,
                @params = new { taskId, inputResponses = new { }, _meta = TaskMetadata() },
            }),
        };
        return await SendAsync(request, token, method, taskId, true);
    }

    private Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, string? token,
        string method, string routingName, bool task)
    {
        request.Headers.Accept.ParseAdd("application/json, text/event-stream");
        request.Headers.Add("MCP-Protocol-Version", task ? "2026-07-28" : "2025-11-25");
        if (task)
        {
            request.Headers.Add("Mcp-Method", method);
            request.Headers.Add("Mcp-Name", routingName);
        }
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return _client.SendAsync(request);
    }

    public static async Task<JsonDocument> ReadResultAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        if (response.Content.Headers.ContentType?.MediaType == "text/event-stream")
            body = Assert.Single(body.Split('\n'), line => line.StartsWith("data: ")).Substring(6);
        return JsonDocument.Parse(body);
    }

    public void Dispose()
    {
        DispatchRelease.TrySetResult();
        _client.Dispose();
        _server.Dispose();
        _oauth.Dispose();
        _simulatorHttp?.Dispose();
    }

    private sealed class FailedSimulatorHandler(McpDispatchFixture fixture) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            fixture.SimulatorRequests++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError)
            {
                Content = new StringContent("private-reset-diagnostic")
            });
        }
    }
}
