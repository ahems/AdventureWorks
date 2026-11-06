using System.Net;
using System.Text.Json;
using api_functions.Functions;
using api_functions.Models;
using api_functions.Services;
using Azure;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Extensions.Sql;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ApiFunctions.Tests;

public class RealtimePublisherTests
{
    private sealed class Publisher() : WebPubSubService(null, new DefaultAzureCredential(), NullLogger<WebPubSubService>.Instance)
    {
        public List<(string Group, JsonElement Payload)> Events { get; } = [];
        public override Task SendToGroupAsync(string group, object payload)
        {
            Events.Add((group, JsonSerializer.SerializeToElement(payload)));
            return Task.CompletedTask;
        }
    }

    private sealed class Credential : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            new("unit-test-token", DateTimeOffset.UtcNow.AddHours(1));
        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    private sealed class Transport(HttpStatusCode status, List<string> calls) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            calls.Add("persist");
            var response = new HttpResponseMessage(status);
            response.Headers.TryAddWithoutValidation("ETag", "\"test-etag\"");
            response.Content = new StringContent(status == HttpStatusCode.NoContent ? "" :
                "{\"odata.error\":{\"code\":\"UpdateConditionNotSatisfied\",\"message\":{\"lang\":\"en-US\",\"value\":\"conflict\"}}}");
            return Task.FromResult(response);
        }
    }

    [Theory]
    [InlineData("upsert")]
    [InlineData("update")]
    [InlineData("add")]
    [InlineData("delete")]
    public async Task Table_mutations_publish_after_success_without_row_contents(string operation)
    {
        var publisher = new Publisher();
        var calls = new List<string>();
        using var http = new HttpClient(new Transport(HttpStatusCode.NoContent, calls));
        var options = new TableClientOptions { Transport = new HttpClientTransport(http) };
        options.Retry.MaxRetries = 0;
        var client = new NotifyingTableClient(new Uri("https://unit.table.core.windows.net"), "shoppingSimulator",
            new Credential(), publisher, "shopping-simulator", options);
        var entity = new TableEntity("private-partition", "private-row") { ["CustomerName"] = "private-name" };
        switch (operation)
        {
            case "upsert": await client.UpsertEntityAsync(entity); break;
            case "update": await client.UpdateEntityAsync(entity, ETag.All); break;
            case "add": await client.AddEntityAsync(entity); break;
            case "delete": await client.DeleteEntityAsync(entity.PartitionKey, entity.RowKey); break;
        }
        Assert.Single(calls);
        var sent = Assert.Single(publisher.Events);
        Assert.Equal("shopping-simulator", sent.Group);
        Assert.Equal(operation, sent.Payload.GetProperty("changeType").GetString());
        Assert.Equal("state-changed", sent.Payload.GetProperty("event").GetString());
        Assert.DoesNotContain("private", sent.Payload.ToString());
    }

    [Fact]
    public async Task Failed_persistence_does_not_publish()
    {
        var publisher = new Publisher();
        using var http = new HttpClient(new Transport(HttpStatusCode.PreconditionFailed, []));
        var options = new TableClientOptions { Transport = new HttpClientTransport(http) };
        options.Retry.MaxRetries = 0;
        var client = new NotifyingTableClient(new Uri("https://unit.table.core.windows.net"), "awManufacturing",
            new Credential(), publisher, "manufacturing-ops", options);
        await Assert.ThrowsAsync<RequestFailedException>(() =>
            client.UpdateEntityAsync(new TableEntity("p", "r"), ETag.All));
        Assert.Empty(publisher.Events);
    }

    [Theory]
    [InlineData(true, 0, "started")]
    [InlineData(true, 1, "progress")]
    [InlineData(false, 1, "terminal")]
    public async Task Review_generation_and_moderation_publish_after_persisted_lifecycle_changes(
        bool running, int processed, string changeType)
    {
        var publisher = new Publisher();
        var calls = new List<string>();
        using var http = new HttpClient(new Transport(HttpStatusCode.NoContent, calls));
        var options = new TableClientOptions { Transport = new HttpClientTransport(http) };
        options.Retry.MaxRetries = 0;
        var table = new TableClient(new Uri("https://unit.table.core.windows.net"), "reviewJobs", new Credential(), options);
        var reviews = new ReviewService("unused", "unused", publisher, table, table);
        await reviews.SaveVerifiedReviewsJobStateAsync(new VerifiedReviewsJobState
        {
            IsRunning = running,
            ProcessedCount = processed,
            ProductId = 123,
            ProductName = "private-name",
            LastError = "private-error"
        });
        await reviews.SaveReviewModerationJobStateAsync(new ReviewModerationJobState
        {
            IsRunning = running,
            ProcessedCount = processed,
            JobId = "job-id",
            LastError = "private-error"
        });
        Assert.Equal(2, calls.Count);
        Assert.Equal(2, publisher.Events.Count);
        Assert.Equal("generation-state-changed", publisher.Events[0].Payload.GetProperty("event").GetString());
        Assert.Equal("moderation-state-changed", publisher.Events[1].Payload.GetProperty("event").GetString());
        Assert.All(publisher.Events, sent =>
        {
            Assert.Equal("reviews", sent.Group);
            Assert.Equal(changeType, sent.Payload.GetProperty("changeType").GetString());
            Assert.DoesNotContain("private", sent.Payload.ToString());
        });
    }

    [Theory]
    [InlineData("Completed")]
    [InlineData("Failed")]
    [InlineData("Canceled")]
    [InlineData("Terminated")]
    public async Task Durable_terminal_state_publishes_once_and_stops_observation(string status)
    {
        var publisher = new Publisher();
        var notifications = new UtilityLifecycleNotifications(publisher);
        var metadata = new OrchestrationMetadata("TranslateLanguageFile_Orchestrator", "instance-id")
        {
            RuntimeStatus = Enum.Parse<OrchestrationRuntimeStatus>(status),
            LastUpdatedAt = DateTimeOffset.UtcNow,
            SerializedInput = "private-input",
            SerializedOutput = "private-output"
        };
        await notifications.NotifyAndContinueAsync(new("instance-id", "translate-language-file", "Running"),
            metadata, _ => throw new InvalidOperationException("Terminal instances must not be requeued."));
        var sent = Assert.Single(publisher.Events);
        Assert.Equal("utilities", sent.Group);
        Assert.Equal(status, sent.Payload.GetProperty("changeType").GetString());
        Assert.Equal("instance-id", sent.Payload.GetProperty("instanceId").GetString());
        Assert.DoesNotContain("private", sent.Payload.ToString());
    }

    [Fact]
    public async Task Durable_start_publishes_after_observer_registration_and_not_on_registration_failure()
    {
        var publisher = new Publisher();
        var notifications = new UtilityLifecycleNotifications(publisher);
        var registered = false;
        await notifications.RegisterAndNotifyAsync(new("instance-id", "translate-language-file"),
            _ => { registered = true; Assert.Empty(publisher.Events); return Task.CompletedTask; });
        Assert.True(registered);
        Assert.Equal("Started", Assert.Single(publisher.Events).Payload.GetProperty("changeType").GetString());
        publisher.Events.Clear();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            notifications.RegisterAndNotifyAsync(new("instance-id", "translate-language-file"),
                _ => throw new InvalidOperationException("Registration failed")));
        Assert.Empty(publisher.Events);
    }

    [Fact]
    public async Task Durable_progress_requeues_and_unchanged_state_does_not_publish_again()
    {
        var publisher = new Publisher();
        var notifications = new UtilityLifecycleNotifications(publisher);
        var metadata = new OrchestrationMetadata("GenerateProductEmbeddings_Orchestrator", "instance-id")
        {
            RuntimeStatus = OrchestrationRuntimeStatus.Running,
            LastUpdatedAt = DateTimeOffset.UtcNow
        };
        UtilityLifecycleNotifications.Notification? next = null;
        await notifications.NotifyAndContinueAsync(new("instance-id", "product-embeddings"), metadata,
            item => { next = item; return Task.CompletedTask; });
        Assert.Single(publisher.Events);
        await notifications.NotifyAndContinueAsync(next!, metadata, _ => Task.CompletedTask);
        Assert.Single(publisher.Events);
        var progressed = new OrchestrationMetadata(metadata.Name, metadata.InstanceId)
        {
            RuntimeStatus = metadata.RuntimeStatus,
            LastUpdatedAt = metadata.LastUpdatedAt.AddSeconds(1)
        };
        await notifications.NotifyAndContinueAsync(next!, progressed, _ => Task.CompletedTask);
        Assert.Equal(2, publisher.Events.Count);
    }

    [Fact]
    public async Task Direct_cart_insert_update_delete_publish_anonymous_invalidation()
    {
        var publisher = new Publisher();
        var trigger = new DatabaseChangeNotifications(publisher);
        var changes = new[] { SqlChangeOperation.Insert, SqlChangeOperation.Update, SqlChangeOperation.Delete }
            .Select(operation => new SqlChange<DatabaseChangeNotifications.Row>(SqlChangeOperation.Insert,
                new() { NotificationID = 123, Entity = "Sales.ShoppingCartItem", ChangeType = operation.ToString() }))
            .ToArray();
        await trigger.Run(changes);
        var sent = Assert.Single(publisher.Events);
        Assert.Equal("orders", sent.Group);
        Assert.Equal("Sales.ShoppingCartItem", sent.Payload.GetProperty("entity").GetString());
        Assert.Equal(3, sent.Payload.GetProperty("changeTypes").GetArrayLength());
        Assert.DoesNotContain("123", sent.Payload.ToString());
        await trigger.Run([]);
        Assert.Single(publisher.Events);
    }

    [Theory]
    [InlineData("Production.ProductInventory", "manufacturing-ops,warehouse,supply-chain")]
    [InlineData("Production.ProductCostHistory", "manufacturing-ops,finance")]
    [InlineData("Production.ProductReview", "reviews")]
    [InlineData("Purchasing.Vendor", "supply-chain,warehouse")]
    [InlineData("Sales.SpecialOffer", "promotions")]
    public async Task Outbox_preserves_domain_groups(string entity, string groups)
    {
        var publisher = new Publisher();
        await new DatabaseChangeNotifications(publisher).Run([
            new(SqlChangeOperation.Insert, new() { Entity = entity, ChangeType = "Update" })
        ]);
        Assert.Equal(groups.Split(','), publisher.Events.Select(e => e.Group));
    }

    [Fact]
    public async Task Outbox_cleanup_does_not_emit_changes_and_invalid_signals_fail_explicitly()
    {
        var publisher = new Publisher();
        var trigger = new DatabaseChangeNotifications(publisher);
        await trigger.Run([new(SqlChangeOperation.Delete, new())]);
        Assert.Empty(publisher.Events);
        await Assert.ThrowsAsync<InvalidOperationException>(() => trigger.Run([
            new(SqlChangeOperation.Insert, new() { Entity = "Private.Unknown", ChangeType = "Insert" })
        ]));
        await Assert.ThrowsAsync<InvalidOperationException>(() => trigger.Run([
            new(SqlChangeOperation.Insert, new() { Entity = "Sales.ShoppingCartItem", ChangeType = "Invalid" })
        ]));
        Assert.Empty(publisher.Events);
    }

    [Fact]
    public void Deployed_worker_and_sql_listener_configuration_matches_the_runtime_contract()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "azure.yaml")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var root = directory!.FullName;
        using var host = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "api-functions/host.json")));
        var durable = host.RootElement.GetProperty("extensions").GetProperty("durableTask");
        Assert.Equal("push-v1", durable.GetProperty("defaultVersion").GetString());
        Assert.Equal("CurrentOrOlder", durable.GetProperty("versionMatchStrategy").GetString());
        var infrastructure = File.ReadAllText(Path.Combine(root, "infra/modules/flex-api-functions.bicep"));
        var sqlFunctions = typeof(DatabaseChangeNotifications).Assembly.GetTypes()
            .SelectMany(t => t.GetMethods())
            .Where(m => m.GetParameters().Any(p => p.GetCustomAttributes(typeof(SqlTriggerAttribute), false).Length > 0));
        var names = sqlFunctions.Select(m =>
            ((FunctionAttribute)m.GetCustomAttributes(typeof(FunctionAttribute), false).Single()).Name).Order().ToArray();
        Assert.Equal(new[] { "DatabaseChanges", "OrderPlacedSqlTrigger" }, names);
        Assert.All(names, name => Assert.Contains($"name: 'function:{name}'", infrastructure));
        var migration = File.ReadAllText(Path.Combine(root, "seed-job/sql/realtime-notification-outbox.sql"));
        Assert.Contains("CREATE OR ALTER TRIGGER", migration);
        Assert.Contains("BEGIN TRANSACTION", migration);
        Assert.Contains("AFTER INSERT, UPDATE, DELETE", migration);
        Assert.DoesNotContain("ShoppingCartID", migration);
        var mappedEntities = (IReadOnlyDictionary<string, string[]>)typeof(DatabaseChangeNotifications)
            .GetField("Groups", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.GetValue(null)!;
        var migratedEntities = System.Text.RegularExpressions.Regex.Matches(migration, @"\('([A-Za-z]+\.[A-Za-z]+)'\)")
            .Select(match => match.Groups[1].Value).Order().ToArray();
        Assert.Equal(mappedEntities.Keys.Order(), migratedEntities);
    }

    [Theory]
    [InlineData("OrderGenerationService.cs", "SalesOrderDetailID", "InsertedIds")]
    [InlineData("ReviewService.cs", "ProductReviewID", "InsertedIds")]
    [InlineData("WorkOrderSimulationService.cs", "WorkOrderID", "InsertedIds")]
    [InlineData("SpecialOfferService.cs", "SpecialOfferID", "ExpiredIds")]
    public void Identity_and_updated_row_results_are_compatible_with_notification_triggers(
        string service, string key, string results)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "azure.yaml")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var source = File.ReadAllText(Path.Combine(directory!.FullName, "api-functions", "Services", service));
        Assert.Contains($"DECLARE @{results} TABLE ({key} int);", source);
        Assert.Contains($"OUTPUT INSERTED.{key} INTO @{results}", source);
        Assert.Contains($"SELECT {key} FROM @{results};", source);
        Assert.DoesNotMatch($@"OUTPUT INSERTED\.{key}\s*\r?\n\s*(VALUES|FROM)", source);
    }

    [Fact]
    public void Supply_bootstrap_batches_stock_and_avoids_per_order_speed_reads()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "azure.yaml")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var source = File.ReadAllText(Path.Combine(directory.FullName, "api-functions/Services/SupplyChainService.cs"));
        var initialization = source.Split("public async Task InitializeAsync()", 2)[1]
            .Split("public async Task Force", 2)[0];
        Assert.Contains("stockBatch.Count == 100", initialization);
        Assert.Contains("stockBatch.Count > 0", initialization);
        Assert.Contains("SubmitTransactionAsync(stockBatch)", initialization);
        var pending = source.Split("private async Task ProcessHistoricalPendingOrdersAsync(", 2)[1]
            .Split("private async Task ProcessHistoricalApprovedOrdersAsync()", 2)[0];
        Assert.True(pending.IndexOf("GetEffectiveTimeScaleAsync()") < pending.IndexOf("for (int i = 0;"));
        var summaries = source.Split("public async Task<List<VendorSummary>> GetVendorSummariesAsync()", 2)[1]
            .Split("// ── Catalog", 2)[0];
        Assert.DoesNotContain("and VendorId eq", summaries);
        Assert.Contains("counts.Total, counts.InStock", summaries);
    }
}
