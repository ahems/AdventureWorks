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
using Microsoft.IdentityModel.JsonWebTokens;
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

    public static IEnumerable<object[]> ServiceProfiles => ToolAuthorizationRegistry.All
        .SelectMany(policy => new[] { "functions", "hosted" }
            .Select(profile => new object[] { policy.Tool, profile }));

    private static readonly IReadOnlySet<string> FunctionsTools = new HashSet<string>
    {
        "search_products", "get_product_details", "get_categories_with_products",
        "get_active_promotions", "find_complementary_products", "check_inventory_availability",
        "search_customers", "get_customer_orders", "get_order_details",
        "get_personalized_recommendations", "generate_random_customer", "generate_random_customer_for_locale",
    };

    private static readonly IReadOnlySet<string> HostedTools = new HashSet<string>
    {
        "get_manufacturing_status", "get_active_manufacturing_operations", "get_production_feasibility",
        "get_all_products_feasibility", "get_manufacturing_catalog_snapshot", "get_overstock_items",
        "get_thin_margin_products", "get_component_shortage_forecast", "get_reorder_recommendations",
        "get_supply_chain_vendors", "get_vendor_details", "get_supply_catalog", "get_supply_quote",
        "get_active_supply_orders", "get_supply_order_history", "get_order_details",
        "check_inventory_availability", "get_product_details", "begin_manufacturing_run", "place_supply_order",
    };

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
    public async Task Every_tool_with_issued_staff_scope_reaches_dispatch_once(string name)
    {
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            string.Join(' ', OAuthScopes.All), admin: true);
        using var response = await _fixture.CallAsync(name, token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var result = await McpDispatchFixture.ReadResultAsync(response);
        Assert.False(result.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
        Assert.Equal(name, Assert.Single(_fixture.Calls).Name);
    }

    [Theory]
    [MemberData(nameof(ServiceProfiles))]
    public async Task Each_service_profile_enforces_its_tool_boundary(string name, string profile)
    {
        var hosted = profile == "hosted";
        var scopes = hosted
            ? "mcp.access products.read orders.read inventory.read manufacturing.read manufacturing.write"
            : "mcp.access products.read inventory.read customers.read orders.read admin.write";
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier, scopes, hosted: hosted);
        using var response = await _fixture.CallAsync(name, token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var result = await McpDispatchFixture.ReadResultAsync(response);
        var allowed = (hosted ? HostedTools : FunctionsTools).Contains(name);
        Assert.Equal(!allowed, result.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
        Assert.Equal(allowed ? 1 : 0, _fixture.Calls.Count);
    }

    [Fact]
    public async Task Existing_service_token_stops_dispatching_when_principal_trust_is_removed()
    {
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier, "mcp.access products.read");
        var trusted = _fixture.AuthorizationOptions.TrustedServicePrincipalIds;
        Assert.True(trusted.Remove(OAuthTestFactory.TrustedServicePrincipalId));
        try
        {
            using var response = await _fixture.CallAsync("get_product_details", token);
            using var result = await McpDispatchFixture.ReadResultAsync(response);
            Assert.True(result.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
            Assert.Empty(_fixture.Calls);
        }
        finally
        {
            trusted.Add(OAuthTestFactory.TrustedServicePrincipalId);
        }
    }

    [Fact]
    public async Task Existing_hosted_token_stops_dispatching_when_the_instance_profile_rotates()
    {
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier, "mcp.access products.read",
            hosted: true);
        var options = _fixture.AuthorizationOptions;
        var original = options.HostedManufacturingServicePrincipalId;
        Assert.Contains(OAuthTestFactory.HostedServicePrincipalId, options.TrustedServicePrincipalIds);
        options.HostedManufacturingServicePrincipalId = OAuthTestFactory.UnprofiledServicePrincipalId;
        try
        {
            using var response = await _fixture.CallAsync("get_product_details", token);
            using var result = await McpDispatchFixture.ReadResultAsync(response);
            Assert.True(result.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
            Assert.Empty(_fixture.Calls);
        }
        finally
        {
            options.HostedManufacturingServicePrincipalId = original;
        }
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

    [Theory]
    [InlineData("begin_manufacturing_run", 0, false)]
    [InlineData("begin_manufacturing_run", 1, false)]
    [InlineData("begin_manufacturing_run", 2, false)]
    [InlineData("begin_manufacturing_run", 3, true)]
    [InlineData("place_supply_order", 0, false)]
    [InlineData("place_supply_order", 1, false)]
    [InlineData("place_supply_order", 2, false)]
    [InlineData("place_supply_order", 3, true)]
    public async Task Service_actions_require_the_persisted_autonomy_mode(
        string tool, int mode, bool allowed)
    {
        _fixture.SetAutonomy(mode);
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            OAuthScopes.McpAccess + " " + OAuthScopes.ManufacturingWrite, hosted: true);
        using var response = await _fixture.CallAsync(tool, token);
        using var result = await McpDispatchFixture.ReadResultAsync(response);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(!allowed, result.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
        Assert.Equal(allowed ? 1 : 0, _fixture.Calls.Count);
        Assert.Equal(allowed ? 2 : 1, _fixture.AutonomyRequests);
        Assert.True(_fixture.AutonomyRequestAuthenticated);
    }

    [Theory]
    [InlineData("expired")]
    [InlineData("inconsistent")]
    [InlineData("malformed")]
    [InlineData("unavailable")]
    public async Task Service_actions_fail_closed_when_autonomy_cannot_be_confirmed(string condition)
    {
        switch (condition)
        {
            case "expired":
                _fixture.SetAutonomy(3, DateTimeOffset.UtcNow.AddMinutes(-1));
                break;
            case "malformed":
                _fixture.AutonomyBody = """{"mode":"3","private":"do-not-return"}""";
                break;
            case "inconsistent":
                _fixture.AutonomyBody = """{"mode":3,"modeLabel":"ReadOnly","isAgentActive":true,"autoShutoffAt":null}""";
                break;
            case "unavailable":
                _fixture.AutonomyStatus = HttpStatusCode.ServiceUnavailable;
                _fixture.AutonomyBody = "do-not-return";
                break;
        }
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            OAuthScopes.McpAccess + " " + OAuthScopes.ManufacturingWrite, hosted: true);
        using var response = await _fixture.CallAsync("begin_manufacturing_run", token);
        using var result = await McpDispatchFixture.ReadResultAsync(response);

        Assert.True(result.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
        Assert.DoesNotContain("do-not-return", result.RootElement.GetRawText());
        Assert.Empty(_fixture.Calls);
        Assert.True(_fixture.AutonomyRequestAuthenticated);
    }

    [Fact]
    public async Task Future_autonomy_shutoff_permits_a_service_action()
    {
        _fixture.SetAutonomy(3, DateTimeOffset.UtcNow.AddMinutes(1));
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            OAuthScopes.McpAccess + " " + OAuthScopes.ManufacturingWrite, hosted: true);
        using var response = await _fixture.CallAsync("begin_manufacturing_run", token);
        using var result = await McpDispatchFixture.ReadResultAsync(response);

        Assert.False(result.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
        Assert.Single(_fixture.Calls);
        Assert.True(_fixture.AutonomyRequestAuthenticated);
    }

    [Theory]
    [InlineData("begin_manufacturing_run", false)]
    [InlineData("begin_manufacturing_run", true)]
    [InlineData("place_supply_order", false)]
    [InlineData("place_supply_order", true)]
    public async Task Service_action_rechecks_autonomy_before_tool_dispatch(string tool, bool task)
    {
        _fixture.SetAutonomy(3);
        _fixture.DisableAutonomyAfterFirstRequest = true;
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            OAuthScopes.McpAccess + " " + OAuthScopes.ManufacturingWrite, hosted: true);

        using var response = await _fixture.CallAsync(tool, token, task: task);
        using var result = await McpDispatchFixture.ReadResultAsync(response);
        var body = result.RootElement.GetProperty("result");
        if (task)
        {
            var taskId = body.GetProperty("taskId").GetString()!;
            using var completion = await WaitForTaskCompletionAsync(taskId, token);
            Assert.True(completion.RootElement.GetProperty("result").GetProperty("result")
                .GetProperty("isError").GetBoolean());
        }
        else
        {
            Assert.True(body.GetProperty("isError").GetBoolean());
        }

        Assert.Empty(_fixture.Calls);
        Assert.Equal(2, _fixture.AutonomyRequests);
    }

    [Theory]
    [InlineData("begin_manufacturing_run")]
    [InlineData("place_supply_order")]
    public async Task Autonomous_service_action_task_reaches_dispatch_when_mode_remains_enabled(string tool)
    {
        _fixture.SetAutonomy(3);
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            OAuthScopes.McpAccess + " " + OAuthScopes.ManufacturingWrite, hosted: true);

        using var response = await _fixture.CallAsync(tool, token, task: true);
        using var result = await McpDispatchFixture.ReadResultAsync(response);
        var taskId = result.RootElement.GetProperty("result").GetProperty("taskId").GetString()!;
        using var completion = await WaitForTaskCompletionAsync(taskId, token);
        Assert.False(completion.RootElement.GetProperty("result").GetProperty("result")
            .GetProperty("isError").GetBoolean());
        Assert.Equal(tool, Assert.Single(_fixture.Calls).Name);
        Assert.Equal(2, _fixture.AutonomyRequests);
    }

    private async Task<JsonDocument> WaitForTaskCompletionAsync(string taskId, string token)
    {
        for (var attempt = 0; attempt < 200; attempt++)
        {
            using var response = await _fixture.TaskAsync("tasks/get", taskId, token);
            var result = await McpDispatchFixture.ReadResultAsync(response);
            var status = result.RootElement.GetProperty("result").GetProperty("status").GetString();
            if (status != "working")
            {
                Assert.Equal("completed", status);
                return result;
            }
            result.Dispose();
            await Task.Delay(25);
        }

        throw new TimeoutException("The isolated MCP task did not complete.");
    }

    [Fact]
    public async Task Human_manufacturing_actions_are_not_bound_to_agent_autonomy()
    {
        _fixture.SetAutonomy(0);
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            OAuthScopes.McpAccess + " " + OAuthScopes.ManufacturingWrite, manufacturing: true);
        using var response = await _fixture.CallAsync("begin_manufacturing_run", token);
        using var result = await McpDispatchFixture.ReadResultAsync(response);

        Assert.False(result.RootElement.GetProperty("result").GetProperty("isError").GetBoolean());
        Assert.Single(_fixture.Calls);
        Assert.Equal(0, _fixture.AutonomyRequests);
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

    [Fact]
    public async Task Service_task_handlers_deny_an_existing_token_after_principal_trust_is_removed()
    {
        var token = await _fixture.TokenAsync(OAuthTestFactory.ResourceIdentifier,
            OAuthScopes.McpAccess + " " + OAuthScopes.ProductsRead);
        var trusted = _fixture.AuthorizationOptions.TrustedServicePrincipalIds;
        try
        {
            using var created = await _fixture.CallAsync("get_product_details", token,
                new() { ["blockForOwnershipTest"] = true }, task: true);
            using var creation = await McpDispatchFixture.ReadResultAsync(created);
            var taskId = creation.RootElement.GetProperty("result").GetProperty("taskId").GetString()!;
            await _fixture.NextDispatch.Task.WaitAsync(TimeSpan.FromSeconds(10));
            using var initial = await _fixture.TaskAsync("tasks/get", taskId, token);
            using var initialResult = await McpDispatchFixture.ReadResultAsync(initial);
            Assert.False(initialResult.RootElement.TryGetProperty("error", out _));
            Assert.True(trusted.Remove(OAuthTestFactory.TrustedServicePrincipalId));

            foreach (var method in new[] { "tasks/get", "tasks/update", "tasks/cancel" })
            {
                using var response = await _fixture.TaskAsync(method, taskId, token);
                using var result = await McpDispatchFixture.ReadResultAsync(response);
                Assert.Equal("Task is not available.",
                    result.RootElement.GetProperty("error").GetProperty("message").GetString());
                Assert.False(result.RootElement.TryGetProperty("result", out _));
            }
        }
        finally
        {
            trusted.Add(OAuthTestFactory.TrustedServicePrincipalId);
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
            OAuthScopes.McpAccess + " " + OAuthScopes.McpAdmin, admin: true);
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
    private readonly Dictionary<(string Resource, string Scope, int? Consumer, bool Manufacturing, bool Admin, bool Hosted), string> _tokens = [];

    public List<(string Name, Dictionary<string, JsonElement> Arguments)> Calls { get; } = [];
    public int SimulatorRequests { get; private set; }
    public int AutonomyRequests { get; private set; }
    public bool AutonomyRequestAuthenticated { get; private set; }
    public HttpStatusCode AutonomyStatus { get; set; }
    public string AutonomyBody { get; set; } = "";
    public bool DisableAutonomyAfterFirstRequest { get; set; }
    public TaskCompletionSource NextDispatch { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource DispatchRelease { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public AuthorizationServerOptions AuthorizationOptions => _server.Services.GetRequiredService<AuthorizationServerOptions>();

    public void Reset()
    {
        Calls.Clear();
        SetAutonomy(3);
        AutonomyRequests = 0;
        AutonomyRequestAuthenticated = false;
        DisableAutonomyAfterFirstRequest = false;
        NextDispatch = new(TaskCreationOptions.RunContinuationsAsynchronously);
        DispatchRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    public McpDispatchFixture() : this(false) { }

    public static McpDispatchFixture WithSimulatorFailure() => new(true);

    public void SetAutonomy(int mode, DateTimeOffset? expiresAt = null)
    {
        AutonomyStatus = HttpStatusCode.OK;
        AutonomyBody = JsonSerializer.Serialize(new
        {
            mode,
            modeLabel = mode switch { 0 => "Off", 1 => "ReadOnly", 2 => "ProposePending", 3 => "FullyAutonomous", _ => "invalid" },
            isAgentActive = mode != 0,
            autoShutoffAt = expiresAt?.ToString("O"),
        });
    }

    private McpDispatchFixture(bool simulatorFailure)
    {
        SetAutonomy(3);
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
        _oauth.Directory.Add("dispatchmanufacturing@example.invalid", "dispatch-test-password", new ResolvedUser
        {
            Subject = "dispatch-manufacturing",
            Category = UserCategories.Manufacturing,
            Roles = [ApplicationRoles.ManufacturingEngineer],
            Scopes = [OAuthScopes.McpAccess, OAuthScopes.ManufacturingWrite],
            BusinessEntityId = 73,
            DisplayName = "Dispatch test manufacturing user",
        });
        _oauth.Directory.Add("dispatchadmin@example.invalid", "dispatch-test-password", new ResolvedUser
        {
            Subject = "dispatch-admin",
            Category = UserCategories.Employee,
            Roles = [ApplicationRoles.ExecutiveAdmin],
            Scopes = OAuthScopes.All.ToArray(),
            BusinessEntityId = 74,
            DisplayName = "Dispatch test administrator",
        });
        _server = _oauth.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            var authorizationOptions = (AuthorizationServerOptions)services
                .Single(descriptor => descriptor.ServiceType == typeof(AuthorizationServerOptions)).ImplementationInstance!;
            authorizationOptions.PublicBaseUrl = "https://mcp.adventureworks.test";
            services.AddHttpClient<ManufacturingAutonomyGuard>()
                .ConfigurePrimaryHttpMessageHandler(() => new AutonomyHandler(this));
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

    public async Task<string> TokenAsync(string resource, string scope, int? consumer = null,
        bool manufacturing = false, bool admin = false, bool hosted = false)
    {
        if ((consumer.HasValue ? 1 : 0) + (manufacturing ? 1 : 0) + (admin ? 1 : 0) + (hosted ? 1 : 0) > 1)
            throw new ArgumentException("Only one test user category may be selected.");
        var key = (resource, scope, consumer, manufacturing, admin, hosted);
        if (_tokens.TryGetValue(key, out var cached)) return cached;
        Dictionary<string, string> form;
        if (consumer.HasValue || manufacturing || admin)
        {
            using var browser = _server.CreateClient(new WebApplicationFactoryClientOptions
            {
                AllowAutoRedirect = false,
                HandleCookies = true,
            });
            using var login = await browser.PostAsync("/login", new FormUrlEncodedContent(
                new Dictionary<string, string>
                {
                    ["username"] = manufacturing ? "dispatchmanufacturing@example.invalid"
                        : admin ? "dispatchadmin@example.invalid" : $"dispatch{consumer}@example.invalid",
                    ["password"] = "dispatch-test-password",
                    ["returnUrl"] = "/",
                }));
            Assert.Equal(HttpStatusCode.Found, login.StatusCode);
            var verifier = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            var challenge = Base64UrlEncoder.Encode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
            var clientId = manufacturing ? "adventureworks-manufacturing" : admin ? "adventureworks-admin" : "adventureworks-eshop";
            var redirect = manufacturing ? "http://localhost:5175/oauth/callback"
                : admin ? "http://localhost:5174/oauth/callback" : "http://localhost:5173/oauth/callback";
            using var authorize = await browser.GetAsync(
                "/authorize?client_id=" + clientId + "&response_type=code" +
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
                ["client_id"] = clientId,
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
                ["assertion"] = hosted ? OAuthTestFactory.ValidHostedAssertion : OAuthTestFactory.ValidServiceAssertion,
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

    private sealed class AutonomyHandler(McpDispatchFixture fixture) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Assert.Equal(HttpMethod.Get, request.Method);
            Assert.Equal("/api/manufacturing/agent-config", request.RequestUri!.AbsolutePath);
            fixture.AutonomyRequests++;
            var status = fixture.AutonomyStatus;
            var body = fixture.AutonomyBody;
            if (fixture.AutonomyRequests == 1 && fixture.DisableAutonomyAfterFirstRequest)
                fixture.SetAutonomy(0);
            var authorization = request.Headers.Authorization;
            if (authorization?.Scheme == "Bearer" && !string.IsNullOrWhiteSpace(authorization.Parameter))
            {
                var token = new JsonWebToken(authorization.Parameter);
                fixture.AutonomyRequestAuthenticated =
                    token.Subject == FunctionsServiceTokenHandler.Subject &&
                    token.Audiences.Contains(OAuthTestFactory.FunctionsResourceIdentifier) &&
                    token.TryGetClaim("scope", out var scope) &&
                    scope.Value.Split(' ').Contains(OAuthScopes.ManufacturingRead) &&
                    token.TryGetClaim("obo_sub", out var onBehalfOf) &&
                    onBehalfOf.Value == "service:" + OAuthTestFactory.HostedServicePrincipalId;
            }
            return Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
        }
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
