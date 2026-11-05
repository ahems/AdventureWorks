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
            .Select(operation => new SqlChange<DatabaseChangeNotifications.Row>(operation, new() { ProductID = 123 }))
            .ToArray();
        await trigger.Cart(changes);
        var sent = Assert.Single(publisher.Events);
        Assert.Equal("orders", sent.Group);
        Assert.Equal("Sales.ShoppingCartItem", sent.Payload.GetProperty("entity").GetString());
        Assert.Equal(3, sent.Payload.GetProperty("changeTypes").GetArrayLength());
        Assert.DoesNotContain("123", sent.Payload.ToString());
        await trigger.Cart([]);
        Assert.Single(publisher.Events);
    }
}
