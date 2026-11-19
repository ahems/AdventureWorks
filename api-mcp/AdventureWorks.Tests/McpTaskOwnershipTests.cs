using System.Security.Claims;
using System.Text.Json;
using AdventureWorks.Auth;
using AdventureWorks.Services;
using Azure;
using Azure.Core;
using Azure.Data.Tables;
using Microsoft.Extensions.Logging.Abstractions;
using ModelContextProtocol;
using ModelContextProtocol.Extensions.Tasks;
using ModelContextProtocol.Protocol;
using Xunit;

namespace AdventureWorks.Tests;

public sealed class McpTaskOwnershipTests
{
    private static ClaimsPrincipal Caller(int owner, string application = "eshop",
        string scope = OAuthScopes.ProductsRead, string category = UserCategories.Consumer) => new(new ClaimsIdentity([
            new Claim("sub", $"owner-{owner}"),
            new Claim("app", application),
            new Claim("category", category),
            new Claim("scope", OAuthScopes.McpAccess + " " + scope),
        ], "test"));

    [Theory]
    [InlineData(71)]
    [InlineData(72)]
    public async Task Table_task_owner_and_scope_survive_recreation_and_block_all_foreign_operations(int owner)
    {
        var table = new MemoryTable();
        var creation = new McpTaskOwnership(new AuthorizationServerOptions());
        var store = new AzureTableMcpTaskStore(table, creation);
        McpTaskInfo task;
        using (creation.Bind(Caller(owner), "get_categories_with_products", NullLogger.Instance))
            task = await store.CreateTaskAsync();

        var ownership = new McpTaskOwnership(new AuthorizationServerOptions());
        store = new(table, ownership);
        var events = 0;
        store.InputResponseReceived += _ => events++;
        using (ownership.Bind(Caller(owner), null, NullLogger.Instance))
            Assert.Equal(task.TaskId, (await store.GetTaskAsync(task.TaskId))!.TaskId);

        var mutations = table.Mutations;
        using (ownership.Bind(Caller(owner == 71 ? 72 : 71), null, NullLogger.Instance))
        {
            await Assert.ThrowsAsync<McpProtocolException>(() => store.GetTaskAsync(task.TaskId));
            await Assert.ThrowsAsync<McpProtocolException>(() => store.SetCompletedAsync(task.TaskId, JsonSerializer.SerializeToElement("foreign")));
            await Assert.ThrowsAsync<McpProtocolException>(() => store.SetFailedAsync(task.TaskId, JsonSerializer.SerializeToElement("foreign")));
            await Assert.ThrowsAsync<McpProtocolException>(() => store.SetCancelledAsync(task.TaskId));
            await Assert.ThrowsAsync<McpProtocolException>(() => store.SetInputRequestsAsync(task.TaskId, new Dictionary<string, InputRequest>()));
            await Assert.ThrowsAsync<McpProtocolException>(() => store.ResolveInputRequestsAsync(task.TaskId, new Dictionary<string, InputResponse>()));
        }
        Assert.Equal(mutations, table.Mutations);
        Assert.Equal(0, events);
        using (ownership.Bind(Caller(owner), null, NullLogger.Instance))
        {
            await store.SetCompletedAsync(task.TaskId, JsonSerializer.SerializeToElement(new { owner }));
            var result = await new AzureTableMcpTaskStore(table, ownership).GetTaskAsync(task.TaskId);
            Assert.Equal(owner, result!.Result!.Value.GetProperty("owner").GetInt32());
        }
    }

    [Theory]
    [InlineData("application")]
    [InlineData("scope")]
    [InlineData("category")]
    [InlineData("policy")]
    [InlineData("unbound")]
    [InlineData("legacy")]
    public async Task Table_tasks_fail_closed_for_lost_authority_and_unowned_legacy_state(string scenario)
    {
        var table = new MemoryTable();
        var ownership = new McpTaskOwnership(new AuthorizationServerOptions());
        var store = new AzureTableMcpTaskStore(table, ownership);
        McpTaskInfo task;
        var originalScope = scenario == "category" ? OAuthScopes.CustomersRead : OAuthScopes.ProductsRead;
        using (ownership.Bind(Caller(71, scope: originalScope,
                   category: scenario == "category" ? UserCategories.Employee : UserCategories.Consumer),
                   scenario == "category" ? "search_customers" : "get_categories_with_products", NullLogger.Instance))
            task = await store.CreateTaskAsync();
        if (scenario == "legacy")
            table.RemoveOwner(task.TaskId);
        if (scenario == "policy")
            table.ChangeRequiredScope(task.TaskId, OAuthScopes.OrdersRead);
        using var binding = scenario == "unbound" ? null : ownership.Bind(
            Caller(71, scenario == "application" ? "different-client" : "eshop",
                scenario is "scope" or "policy" ? OAuthScopes.OrdersRead : originalScope), null, NullLogger.Instance);
        var mutations = table.Mutations;
        await Assert.ThrowsAsync<McpProtocolException>(() => store.GetTaskAsync(task.TaskId));
        await Assert.ThrowsAsync<McpProtocolException>(() => store.SetCancelledAsync(task.TaskId));
        Assert.Equal(mutations, table.Mutations);
    }

    [Fact]
    public async Task Creation_without_tool_authority_never_writes_a_table_entity()
    {
        var table = new MemoryTable();
        var ownership = new McpTaskOwnership(new AuthorizationServerOptions());
        var store = new AzureTableMcpTaskStore(table, ownership);
        using var binding = ownership.Bind(Caller(71), null, NullLogger.Instance);
        await Assert.ThrowsAsync<McpProtocolException>(() => store.CreateTaskAsync());
        Assert.Equal(0, table.Mutations);
    }

    [Fact]
    public async Task Service_tasks_recheck_current_principal_trust_and_tool_profile()
    {
        var principal = OAuthTestFactory.TrustedServicePrincipalId;
        var options = new AuthorizationServerOptions { FunctionsServicePrincipalId = principal };
        options.TrustedServicePrincipalIds.Add(principal);
        var caller = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim("sub", "service:" + principal),
            new Claim("app", AuthorizationServerOptions.ServiceClientId),
            new Claim("category", UserCategories.Service),
            new Claim("scope", OAuthScopes.McpAccess + " " + OAuthScopes.ProductsRead),
        ], "test"));
        var ownership = new McpTaskOwnership(options);
        var table = new MemoryTable();
        var store = new AzureTableMcpTaskStore(table, ownership);
        McpTaskInfo task;
        using (ownership.Bind(caller, "get_product_details", NullLogger.Instance))
            task = await store.CreateTaskAsync();
        using (ownership.Bind(caller, "get_product_availability", NullLogger.Instance))
            await Assert.ThrowsAsync<McpProtocolException>(() => store.CreateTaskAsync());

        using var binding = ownership.Bind(caller, null, NullLogger.Instance);
        Assert.NotNull(await store.GetTaskAsync(task.TaskId));
        var mutations = table.Mutations;
        options.TrustedServicePrincipalIds.Remove(principal);
        await Assert.ThrowsAsync<McpProtocolException>(() => store.GetTaskAsync(task.TaskId));
        await Assert.ThrowsAsync<McpProtocolException>(() => store.SetCompletedAsync(task.TaskId, JsonSerializer.SerializeToElement("private")));
        await Assert.ThrowsAsync<McpProtocolException>(() => store.SetFailedAsync(task.TaskId, JsonSerializer.SerializeToElement("private")));
        await Assert.ThrowsAsync<McpProtocolException>(() => store.SetCancelledAsync(task.TaskId));
        await Assert.ThrowsAsync<McpProtocolException>(() => store.SetInputRequestsAsync(task.TaskId, new Dictionary<string, InputRequest>()));
        await Assert.ThrowsAsync<McpProtocolException>(() => store.ResolveInputRequestsAsync(task.TaskId, new Dictionary<string, InputResponse>()));
        Assert.Equal(mutations, table.Mutations);

        options.TrustedServicePrincipalIds.Add(principal);
        options.FunctionsServicePrincipalId = OAuthTestFactory.HostedServicePrincipalId;
        await Assert.ThrowsAsync<McpProtocolException>(() => store.GetTaskAsync(task.TaskId));
        options.FunctionsServicePrincipalId = principal;
        table.ChangeTool(task.TaskId, "get_product_availability");
        await Assert.ThrowsAsync<McpProtocolException>(() => store.GetTaskAsync(task.TaskId));
        await Assert.ThrowsAsync<McpProtocolException>(() => store.SetCancelledAsync(task.TaskId));
        Assert.Equal(mutations, table.Mutations);
    }

    [Fact]
    public async Task In_memory_tasks_enforce_the_same_owner_and_scope_boundary()
    {
        var ownership = new McpTaskOwnership(new AuthorizationServerOptions());
        var store = new OwnedInMemoryMcpTaskStore(new InMemoryMcpTaskStore(), ownership);
        McpTaskInfo task;
        using (ownership.Bind(Caller(71), "get_categories_with_products", NullLogger.Instance))
            task = await store.CreateTaskAsync();
        using (ownership.Bind(Caller(72), null, NullLogger.Instance))
        {
            await Assert.ThrowsAsync<McpProtocolException>(() => store.GetTaskAsync(task.TaskId));
            await Assert.ThrowsAsync<McpProtocolException>(() => store.SetCancelledAsync(task.TaskId));
        }
        using (ownership.Bind(Caller(71), null, NullLogger.Instance))
        {
            Assert.Equal(McpTaskStatus.Working, (await store.GetTaskAsync(task.TaskId))!.Status);
            await store.SetCompletedAsync(task.TaskId, JsonSerializer.SerializeToElement("private"));
            Assert.Equal("private", (await store.GetTaskAsync(task.TaskId))!.Result!.Value.GetString());
        }
        using (ownership.Bind(Caller(71, scope: OAuthScopes.CustomersRead, category: UserCategories.Employee),
                   "search_customers", NullLogger.Instance))
            task = await store.CreateTaskAsync();
        using (ownership.Bind(Caller(71, scope: OAuthScopes.CustomersRead), null, NullLogger.Instance))
        {
            await Assert.ThrowsAsync<McpProtocolException>(() => store.GetTaskAsync(task.TaskId));
            await Assert.ThrowsAsync<McpProtocolException>(() => store.SetCancelledAsync(task.TaskId));
        }
    }

    private sealed class MemoryTable : TableClient
    {
        private readonly Dictionary<string, TableEntity> _rows = [];
        public int Mutations { get; private set; }

        public void RemoveOwner(string taskId)
        {
            _rows[taskId].Remove("OwnerSubject");
            _rows[taskId].Remove("OwnerApplication");
            _rows[taskId].Remove("OwnerCategory");
            _rows[taskId].Remove("OwnerTool");
            _rows[taskId].Remove("RequiredScope");
        }

        public void ChangeRequiredScope(string taskId, string scope) => _rows[taskId]["RequiredScope"] = scope;

        public void ChangeTool(string taskId, string tool) => _rows[taskId]["OwnerTool"] = tool;

        public override Task<Response> AddEntityAsync<T>(T entity, CancellationToken cancellationToken = default)
        {
            if (entity is not TableEntity row) throw new InvalidOperationException("Unexpected table entity.");
            _rows.Add(row.RowKey, new TableEntity(row));
            Mutations++;
            return Task.FromResult<Response>(new TableResponse());
        }

        public override Task<Response<T>> GetEntityAsync<T>(string partitionKey, string rowKey,
            IEnumerable<string>? select = null, CancellationToken cancellationToken = default)
        {
            if (!_rows.TryGetValue(rowKey, out var row))
                throw new RequestFailedException(404, "Missing fixture task.");
            if (new TableEntity(row) is not T entity) throw new InvalidOperationException("Unexpected entity type.");
            return Task.FromResult(Response.FromValue(entity, new TableResponse()));
        }

        public override Task<Response> UpdateEntityAsync<T>(T entity, ETag ifMatch,
            TableUpdateMode mode = TableUpdateMode.Merge, CancellationToken cancellationToken = default)
        {
            if (entity is not TableEntity row) throw new InvalidOperationException("Unexpected table entity.");
            foreach (var (key, value) in row)
                _rows[row.RowKey][key] = value;
            Mutations++;
            return Task.FromResult<Response>(new TableResponse());
        }
    }

    private sealed class TableResponse : Response
    {
        public override int Status => 200;
        public override string ReasonPhrase => "OK";
        public override Stream? ContentStream { get; set; }
        public override string ClientRequestId { get; set; } = "";
        public override void Dispose() { }
        protected override bool ContainsHeader(string name) => false;
        protected override IEnumerable<HttpHeader> EnumerateHeaders() => [];
        protected override bool TryGetHeader(string name, out string value) { value = ""; return false; }
        protected override bool TryGetHeaderValues(string name, out IEnumerable<string> values) { values = []; return false; }
    }
}
