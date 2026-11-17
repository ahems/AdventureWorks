using System.Net;
using System.Diagnostics.CodeAnalysis;
using System.Security.Claims;
using System.Text.Json;
using ApiFunctions.Auth;
using api_functions.Functions;
using api_functions.Services;
using Azure;
using Azure.Core;
using Azure.Core.Serialization;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Azure.Storage.Queues;
using Azure.Storage.Queues.Models;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class ReceiptOwnershipTests
{
    [Theory]
    [InlineData(71, false)]
    [InlineData(72, false)]
    [InlineData(71, true)]
    [InlineData(72, true)]
    public async Task Both_owners_read_only_their_own_receipt_before_any_blob_access(int owner, bool download)
    {
        var access = new Access();
        var blobs = new Container();
        var handler = new ReceiptCheckFunction(NullLogger<ReceiptCheckFunction>.Instance, access, blobs);
        using var context = new Context(owner);
        var request = new Request(context);
        request.Headers.Add("X-MS-API-ROLE", "executive-admin");
        request.Headers.Add("X-MS-CLIENT-PRINCIPAL-ID", "999");
        var other = owner == 71 ? 72 : 71;
        var denied = download ? await handler.DownloadOrderReceipt(request, 1000 + other)
            : await handler.CheckOrderReceipt(request, 1000 + other);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Equal(0, blobs.Reads);
        Assert.Equal(owner, access.LastOwner);

        var response = download ? await handler.DownloadOrderReceipt(request, 1000 + owner)
            : await handler.CheckOrderReceipt(request, 1000 + owner);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal($"CustomerReceipts/SO{1000 + owner}.pdf", blobs.LastBlob);
        Assert.Equal(1, blobs.Reads);
        response.Body.Position = 0;
        if (download)
            Assert.Equal("%PDF-fixture", await new StreamReader(response.Body).ReadToEndAsync());
        else
            Assert.True((await JsonDocument.ParseAsync(response.Body)).RootElement.GetProperty("exists").GetBoolean());
    }

    [Theory]
    [InlineData(null, "consumer", true)]
    [InlineData(0, "consumer", true)]
    [InlineData(-1, "consumer", true)]
    [InlineData(71, "unknown", true)]
    [InlineData(71, "consumer", false)]
    public async Task Untrusted_or_unbound_receipt_callers_reach_neither_SQL_nor_storage(
        int? owner, string category, bool authenticated)
    {
        using var context = new Context(owner, category, authenticated);
        var access = new Access();
        var blobs = new Container();
        var reads = new ReceiptCheckFunction(NullLogger<ReceiptCheckFunction>.Instance, access, blobs);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await reads.CheckOrderReceipt(new Request(context), 1071)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await reads.DownloadOrderReceipt(new Request(context), 1071)).StatusCode);
        var queue = new Queue();
        Assert.Equal(HttpStatusCode.Forbidden,
            (await Sender(access, queue).GenerateAndSendReceipt(new Request(context, Payload(71)))).StatusCode);
        Assert.Equal(0, access.Calls);
        Assert.Equal(0, blobs.Reads);
        Assert.Empty(queue.Messages);
    }

    [Theory]
    [InlineData(71)]
    [InlineData(72)]
    public async Task Email_generation_binds_signed_customer_order_and_recipient_before_enqueue(int owner)
    {
        using var context = new Context(owner);
        var access = new Access();
        var queue = new Queue();
        var sender = Sender(access, queue);
        var other = owner == 71 ? 72 : 71;
        foreach (var payload in new[] { Payload(other), Payload(owner, orderOwner: other),
                     Payload(owner, emailOwner: other) })
        {
            var response = await sender.GenerateAndSendReceipt(new Request(context, payload));
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Equal(owner, access.LastOwner);
            Assert.Empty(queue.Messages);
        }

        var accepted = await sender.GenerateAndSendReceipt(new Request(context, Payload(owner)));
        Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
        using var message = JsonDocument.Parse(Assert.Single(queue.Messages));
        Assert.Equal($"SO{1000 + owner}", message.RootElement.GetProperty("SalesOrderNumber").GetString());
        Assert.Equal(owner, message.RootElement.GetProperty("EmailMetadata").GetProperty("CustomerId").GetInt32());
    }

    [Fact]
    public async Task Internal_receipt_requests_still_bind_order_to_customer_and_recipient()
    {
        using var context = new Context(null, "employee");
        var access = new Access();
        var queue = new Queue();
        var sender = Sender(access, queue);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await sender.GenerateAndSendReceipt(new Request(context, Payload(71, orderOwner: 72)))).StatusCode);
        Assert.Empty(queue.Messages);
        Assert.Equal(HttpStatusCode.Accepted,
            (await sender.GenerateAndSendReceipt(new Request(context, Payload(72)))).StatusCode);
        Assert.Null(access.LastOwner);
    }

    [Fact]
    public async Task Queue_failure_never_returns_accepted_and_invalid_JSON_never_enqueues()
    {
        using var context = new Context(71);
        var queue = new Queue { Fail = true };
        var sender = Sender(new Access(), queue);
        Assert.Equal(HttpStatusCode.BadRequest,
            (await sender.GenerateAndSendReceipt(new Request(context, "{"))).StatusCode);
        Assert.Empty(queue.Messages);
        Assert.Equal(HttpStatusCode.InternalServerError,
            (await sender.GenerateAndSendReceipt(new Request(context, Payload(71)))).StatusCode);
    }

    [Theory]
    [InlineData(false, 404, HttpStatusCode.OK)]
    [InlineData(true, 404, HttpStatusCode.NotFound)]
    [InlineData(false, 503, HttpStatusCode.InternalServerError)]
    [InlineData(true, 503, HttpStatusCode.InternalServerError)]
    public async Task Authorized_missing_and_failed_storage_have_distinct_sanitized_responses(
        bool download, int storageStatus, HttpStatusCode expected)
    {
        using var context = new Context(71);
        var blobs = new Container { StorageStatus = storageStatus };
        var handler = new ReceiptCheckFunction(NullLogger<ReceiptCheckFunction>.Instance, new Access(), blobs);
        var response = download ? await handler.DownloadOrderReceipt(new Request(context), 1071)
            : await handler.CheckOrderReceipt(new Request(context), 1071);
        Assert.Equal(expected, response.StatusCode);
        Assert.Equal(1, blobs.Reads);
        response.Body.Position = 0;
        var body = await new StreamReader(response.Body).ReadToEndAsync();
        Assert.DoesNotContain("private-storage-diagnostic", body);
        if (!download && storageStatus == 404)
            Assert.False(JsonDocument.Parse(body).RootElement.GetProperty("exists").GetBoolean());
    }

    [Theory]
    [InlineData("SO1072", 71, 2071)]
    [InlineData("SO1071", 71, 2072)]
    [InlineData("SO01071", 71, 2071)]
    public async Task Worker_revalidates_queued_order_customer_and_email_before_receipt_or_email_access(
        string order, int customer, int email)
    {
        var sender = Sender(new Access(), new Queue());
        using var context = new Context(null, "service");
        var message = BinaryData.FromObjectAsJson(new
        {
            SalesOrderNumber = order, CustomerId = customer, EmailAddressId = email,
        });
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => sender.SendOrderEmail_QueueTrigger(message, context));
    }

    private static string Payload(int owner, int? orderOwner = null, int? emailOwner = null) =>
        JsonSerializer.Serialize(new { SalesOrderId = 1000 + (orderOwner ?? owner), CustomerId = owner,
            EmailAddressId = 2000 + (emailOwner ?? owner) });

    private static GenerateAndSendReceiptFunction Sender(Access access, Queue queue) => new(
        NullLogger<GenerateAndSendReceiptFunction>.Instance, new ReceiptService("unused"),
        new EmailService("unused", "https://email.example.invalid", "example.invalid", "unused",
            NullLogger<EmailService>.Instance), access, queue);

    private sealed class Access : IReceiptAccessService
    {
        public int Calls { get; private set; }
        public int? LastOwner { get; private set; }
        public Task<bool> CanReadAsync(int order, int? owner)
        {
            Calls++;
            LastOwner = owner;
            return Task.FromResult(order is 1071 or 1072 && (owner is null || order == 1000 + owner));
        }
        public Task<bool> CanSendAsync(int order, int customer, int email, int? owner)
        {
            Calls++;
            LastOwner = owner;
            return Task.FromResult(customer is 71 or 72 && order == 1000 + customer &&
                email == 2000 + customer && (owner is null || owner == customer));
        }
    }

    private sealed class Container : BlobContainerClient
    {
        public int Reads { get; set; }
        public int StorageStatus { get; init; }
        public string? LastBlob { get; private set; }
        public override BlobClient GetBlobClient(string blobName)
        {
            LastBlob = blobName;
            return new Blob(this);
        }
    }
    private sealed class Blob(Container container) : BlobClient
    {
        public override Task<Response<bool>> ExistsAsync(CancellationToken cancellationToken = default)
        {
            container.Reads++;
            if (container.StorageStatus is not (0 or 404))
                throw new RequestFailedException(container.StorageStatus, "private-storage-diagnostic");
            return Task.FromResult(Response.FromValue(container.StorageStatus != 404, new RawResponse()));
        }
        public override Task<Response<BlobDownloadResult>> DownloadContentAsync(CancellationToken cancellationToken = default)
        {
            container.Reads++;
            if (container.StorageStatus != 0)
                throw new RequestFailedException(container.StorageStatus, "private-storage-diagnostic");
            return Task.FromResult(Response.FromValue(
                BlobsModelFactory.BlobDownloadResult(BinaryData.FromString("%PDF-fixture")), new RawResponse()));
        }
    }
    private sealed class Queue : QueueClient
    {
        public List<string> Messages { get; } = [];
        public bool Fail { get; init; }
        public override Task<Response<SendReceipt>> SendMessageAsync(string messageText, CancellationToken cancellationToken = default)
        {
            if (Fail) throw new RequestFailedException(503, "Synthetic queue failure");
            Messages.Add(messageText);
            return Task.FromResult(Response.FromValue(
                QueuesModelFactory.SendReceipt("fixture", DateTimeOffset.UtcNow,
                    DateTimeOffset.UtcNow.AddDays(1), "fixture", DateTimeOffset.UtcNow),
                new RawResponse()));
        }
    }
    private sealed class RawResponse : Response
    {
        public override int Status => 200;
        public override string ReasonPhrase => "OK";
        public override Stream? ContentStream { get; set; }
        public override string ClientRequestId { get; set; } = "fixture";
        public override void Dispose() { }
        protected override bool ContainsHeader(string name) => false;
        protected override IEnumerable<HttpHeader> EnumerateHeaders() => [];
        protected override bool TryGetHeader(string name, [NotNullWhen(true)] out string? value) { value = null; return false; }
        protected override bool TryGetHeaderValues(string name, [NotNullWhen(true)] out IEnumerable<string>? values) { values = null; return false; }
    }
    private sealed class Context : FunctionContext, IDisposable
    {
        private readonly ServiceProvider _services = new ServiceCollection()
            .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions
            {
                Serializer = new JsonObjectSerializer(new JsonSerializerOptions(JsonSerializerDefaults.Web))
            })).BuildServiceProvider();
        public Context(int? owner, string category = "consumer", bool authenticated = true)
        {
            InstanceServices = _services;
            Items[FunctionUser.ContextKey] = new FunctionUser
                { CustomerId = owner, Category = category, IsAuthenticated = authenticated };
        }
        public override string InvocationId => "receipt-test";
        public override string FunctionId => "receipt-test";
        public override TraceContext TraceContext => throw new NotSupportedException();
        public override BindingContext BindingContext => throw new NotSupportedException();
        public override RetryContext RetryContext => null!;
        public override IServiceProvider InstanceServices { get; set; }
        public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();
        public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
        public override IInvocationFeatures Features => throw new NotSupportedException();
        public void Dispose() => _services.Dispose();
    }
    private sealed class Request(FunctionContext context, string body = "") : HttpRequestData(context)
    {
        public override Stream Body { get; } = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(body));
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url => new("https://functions.example.test/api/orders/1072/receipt?customerId=72");
        public override IEnumerable<ClaimsIdentity> Identities => [];
        public override string Method => "GET";
        public override HttpResponseData CreateResponse() => new HttpResponse(FunctionContext);
    }
    private sealed class HttpResponse(FunctionContext context) : HttpResponseData(context)
    {
        public override HttpStatusCode StatusCode { get; set; }
        public override HttpHeadersCollection Headers { get; set; } = new();
        public override Stream Body { get; set; } = new MemoryStream();
        public override HttpCookies Cookies => throw new NotSupportedException();
    }
}
