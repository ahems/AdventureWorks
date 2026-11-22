using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using api_functions.Functions;
using api_functions.Services;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.Identity;
using Azure.Storage.Queues;
using Microsoft.Azure.Functions.Worker.Extensions.Sql;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ApiFunctions.Tests;

public class OrderPlacedSqlTriggerTests
{
    private sealed class Credential : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            new("unit-test-token", DateTimeOffset.UtcNow.AddHours(1));
        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    private sealed class CapturingQueue : HttpMessageHandler
    {
        public List<string> MessageTexts { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = await request.Content!.ReadAsStringAsync(cancellationToken);
            MessageTexts.Add(XDocument.Parse(body).Descendants("MessageText").Single().Value);
            const string date = "Mon, 01 Jan 2024 00:00:00 GMT";
            return new HttpResponseMessage(System.Net.HttpStatusCode.Created)
            {
                Content = new StringContent(
                    $"<?xml version=\"1.0\" encoding=\"utf-8\"?><QueueMessagesList><QueueMessage><MessageId>id</MessageId>" +
                    $"<InsertionTime>{date}</InsertionTime><ExpirationTime>{date}</ExpirationTime>" +
                    $"<PopReceipt>pop</PopReceipt><TimeNextVisible>{date}</TimeNextVisible></QueueMessage></QueueMessagesList>",
                    Encoding.UTF8, "application/xml"),
            };
        }
    }

    private sealed class Publisher() : WebPubSubService(null, new DefaultAzureCredential(), NullLogger<WebPubSubService>.Instance)
    {
        public List<(string Group, JsonElement Payload)> Events { get; } = [];
        public override Task SendToGroupAsync(string group, object payload)
        {
            lock (Events) Events.Add((group,
                JsonSerializer.SerializeToElement(WebPubSubService.SanitizePayloadForGroup(group, payload))));
            return Task.CompletedTask;
        }
    }

    [Theory]
    [InlineData("consumer")]
    [InlineData("store")]
    public async Task Auto_promotion_message_is_encoded_once_and_deserializes_in_the_queue_trigger(string orderType)
    {
        var transport = new CapturingQueue();
        var options = new QueueClientOptions
        {
            MessageEncoding = QueueMessageEncoding.Base64,
            Transport = new HttpClientTransport(new HttpClient(transport)),
        };
        options.Retry.MaxRetries = 0;
        var queue = new QueueClient(new Uri("https://unit.queue.core.windows.net/auto-promotion-queue"), new Credential(), options);

        await OrderPlacedSqlTrigger.EnqueueAutoPromotionAsync(queue, orderType);

        // The Functions queue trigger removes exactly one Base64 layer before binding the string.
        var triggerInput = Encoding.UTF8.GetString(Convert.FromBase64String(Assert.Single(transport.MessageTexts)));
        var message = AutoPromotionQueueTrigger.DeserializeMessage(triggerInput);
        Assert.Equal(orderType, message?.OrderType);
    }

    [Fact]
    public async Task Order_placed_push_is_sent_even_when_the_manufacturing_agent_is_off()
    {
        // No storage settings are configured in unit tests, so the agent mode resolves to Off
        // and every enqueue path fails before any network call.
        var publisher = new Publisher();
        var trigger = new OrderPlacedSqlTrigger(
            NullLogger<OrderPlacedSqlTrigger>.Instance,
            new OrderService("Server=unit.invalid;Database=unit"),
            new ManufacturingAgentConfigService(NullLogger<ManufacturingAgentConfigService>.Instance, publisher),
            new ManufacturingAgentRunService(NullLogger<ManufacturingAgentRunService>.Instance,
                "https://unit.table.core.windows.net", "https://unit.queue.core.windows.net", publisher),
            new OrderPipelineConfigService(NullLogger<OrderPipelineConfigService>.Instance, publisher),
            publisher,
            new AutoPromotionConfigService(NullLogger<AutoPromotionConfigService>.Instance, publisher));

        await trigger.RunAsync([
            new SqlChange<SalesOrderHeaderRow>(SqlChangeOperation.Insert,
                new SalesOrderHeaderRow { SalesOrderID = 43659, CustomerID = 29825, OnlineOrderFlag = true }),
        ]);

        var orders = publisher.Events.Where(e => e.Group == "orders").ToList();
        Assert.Equal(2, orders.Count);
        Assert.All(orders, e => Assert.Equal("{\"event\":\"orders-changed\"}", e.Payload.GetRawText()));
        Assert.DoesNotContain(publisher.Events, e => e.Group == "manufacturing-agent");
    }
}
