using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AddressFunctions.Services;
using Azure.Core.Serialization;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;
using Handler = AddressFunctions.Functions.PasswordResetFunctions;

namespace ApiFunctions.Tests;

public sealed class PasswordResetTests
{
    private const string AppUrl = "https://storefront.example.test";
    private const string Email = "reset-user@example.invalid";
    private readonly FakeStore _store = new();
    private readonly FakeNotifier _notifier = new();

    [Fact]
    public async Task Request_for_known_consumer_returns_generic_202_without_token_or_link()
    {
        _store.AddConsumer(7, Email, "current-password");
        using var context = new Context();

        var response = await Functions().RequestPasswordReset(new Request(context, Body(new { email = Email })));

        var body = await ReadBody(response);
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Equal(new[] { "message" }, body.RootElement.EnumerateObject().Select(p => p.Name));
        Assert.Equal(Handler.GenericRequestMessage, body.RootElement.GetProperty("message").GetString());
        var sent = Assert.Single(_notifier.Sent);
        Assert.DoesNotContain(TokenFrom(sent.Url), body.RootElement.GetRawText());
    }

    [Fact]
    public async Task Request_for_unknown_email_is_indistinguishable_and_sends_nothing()
    {
        _store.AddConsumer(7, Email, "current-password");
        using var context = new Context();

        var known = await ReadBody(await Functions().RequestPasswordReset(new Request(context, Body(new { email = Email }))));
        _notifier.Sent.Clear();
        var response = await Functions().RequestPasswordReset(
            new Request(context, Body(new { email = "nobody@example.invalid" })));

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Equal(known.RootElement.GetRawText(), (await ReadBody(response)).RootElement.GetRawText());
        Assert.Empty(_notifier.Sent);
    }

    [Fact]
    public async Task Store_failure_still_returns_generic_202()
    {
        _store.AddConsumer(7, Email, "current-password");
        _store.FailIssue = true;
        using var context = new Context();

        var response = await Functions().RequestPasswordReset(new Request(context, Body(new { email = Email })));

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Empty(_notifier.Sent);
    }

    [Fact]
    public async Task Reset_link_uses_APP_URL_and_ignores_Origin_and_Referer()
    {
        _store.AddConsumer(7, Email, "current-password");
        using var context = new Context();
        var request = new Request(context, Body(new { email = Email }));
        request.Headers.Add("Origin", "https://attacker.example.test");
        request.Headers.Add("Referer", "https://attacker.example.test/page");

        await Functions(AppUrl + "/").RequestPasswordReset(request);

        var url = new Uri(Assert.Single(_notifier.Sent).Url);
        Assert.Equal(AppUrl + "/reset-password", url.GetLeftPart(UriPartial.Path));
        Assert.Contains("&id=7", url.Query);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not a url")]
    [InlineData("javascript:alert(1)")]
    public async Task Missing_or_invalid_APP_URL_sends_no_email_and_issues_no_token(string? appUrl)
    {
        _store.AddConsumer(7, Email, "current-password");
        using var context = new Context();

        var response = await Functions(appUrl).RequestPasswordReset(new Request(context, Body(new { email = Email })));

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Empty(_notifier.Sent);
        Assert.Empty(_store.Tokens);
    }

    [Fact]
    public async Task Only_token_hash_is_stored_and_current_password_works_until_completion()
    {
        _store.AddConsumer(7, Email, "current-password");
        var service = Service();

        await service.RequestResetAsync(Email);

        var token = TokenFrom(Assert.Single(_notifier.Sent).Url);
        var stored = Assert.Single(_store.Tokens);
        Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes(token)), stored.Hash);
        Assert.DoesNotContain(token, Encoding.UTF8.GetString(stored.Hash));
        Assert.Equal("current-password", _store.Passwords[7]);
        Assert.True(await service.ValidateAsync(7, token));

        Assert.Equal(PasswordResetOutcome.Completed, await service.CompleteAsync(7, token, "brand-new-password"));
        Assert.NotEqual("current-password", _store.Passwords[7]);
        Assert.False(await service.ValidateAsync(7, token));
        Assert.Equal(PasswordResetOutcome.InvalidToken, await service.CompleteAsync(7, token, "another-password"));
    }

    [Fact]
    public async Task New_request_invalidates_previous_token()
    {
        _store.AddConsumer(7, Email, "current-password");
        var service = Service();

        await service.RequestResetAsync(Email);
        await service.RequestResetAsync(Email);

        var first = TokenFrom(_notifier.Sent[0].Url);
        var second = TokenFrom(_notifier.Sent[1].Url);
        Assert.NotEqual(first, second);
        Assert.False(await service.ValidateAsync(7, first));
        Assert.True(await service.ValidateAsync(7, second));
    }

    [Fact]
    public async Task Token_is_bound_to_its_person()
    {
        _store.AddConsumer(7, Email, "current-password");
        _store.AddConsumer(8, "other@example.invalid", "other-password");
        var service = Service();

        await service.RequestResetAsync(Email);
        var token = TokenFrom(Assert.Single(_notifier.Sent).Url);

        Assert.False(await service.ValidateAsync(8, token));
        Assert.Equal(PasswordResetOutcome.InvalidToken, await service.CompleteAsync(8, token, "brand-new-password"));
        Assert.Equal("other-password", _store.Passwords[8]);
    }

    [Fact]
    public async Task Invalid_token_completion_returns_401_and_keeps_password()
    {
        _store.AddConsumer(7, Email, "current-password");
        using var context = new Context();

        var response = await Functions().ResetPassword(new Request(context,
            Body(new { businessEntityID = 7, token = "not-a-real-token", newPassword = "brand-new-password" })));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("current-password", _store.Passwords[7]);
    }

    [Fact]
    public async Task Admin_request_reports_sent_for_the_customers_login()
    {
        _store.AddConsumer(7, Email, "current-password");
        using var context = new Context();

        var response = await Functions().AdminRequestPasswordReset(
            new Request(context, Body(new { businessEntityID = 7, email = Email })));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("sent", (await ReadBody(response)).RootElement.GetProperty("result").GetString());
        Assert.Single(_notifier.Sent);
    }

    [Theory]
    [InlineData(7, "nobody@example.invalid")]
    [InlineData(8, Email)]
    public async Task Admin_request_reports_not_eligible_without_issuing_a_token(int businessEntityId, string email)
    {
        _store.AddConsumer(7, Email, "current-password");
        using var context = new Context();

        var response = await Functions().AdminRequestPasswordReset(
            new Request(context, Body(new { businessEntityID = businessEntityId, email })));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("not-eligible", (await ReadBody(response)).RootElement.GetProperty("result").GetString());
        Assert.Empty(_notifier.Sent);
        Assert.Empty(_store.Tokens);
    }

    [Fact]
    public async Task Admin_request_reports_undelivered_email()
    {
        _store.AddConsumer(7, Email, "current-password");
        _notifier.Deliver = false;
        using var context = new Context();

        var response = await Functions().AdminRequestPasswordReset(
            new Request(context, Body(new { businessEntityID = 7, email = Email })));

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        Assert.Equal("email-not-sent", (await ReadBody(response)).RootElement.GetProperty("result").GetString());
    }

    private Handler Functions(string? appUrl = AppUrl) => new(NullLogger<Handler>.Instance, Service(appUrl));

    private PasswordResetService Service(string? appUrl = AppUrl) =>
        new(_store, _notifier, appUrl, NullLogger<PasswordResetService>.Instance);

    private static string Body(object value) => JsonSerializer.Serialize(value);

    private static string TokenFrom(string url)
    {
        var query = new Uri(url).Query.TrimStart('?').Split('&')
            .Select(part => part.Split('=', 2))
            .ToDictionary(part => part[0], part => Uri.UnescapeDataString(part[1]));
        return query["token"];
    }

    private static async Task<JsonDocument> ReadBody(HttpResponseData response)
    {
        response.Body.Position = 0;
        return await JsonDocument.ParseAsync(response.Body);
    }

    private sealed class FakeNotifier : IPasswordResetNotifier
    {
        internal List<(string Email, string Url)> Sent { get; } = [];
        internal bool Deliver { get; set; } = true;
        public Task<bool> SendAsync(string email, string firstName, string resetUrl)
        {
            if (Deliver) Sent.Add((email, resetUrl));
            return Task.FromResult(Deliver);
        }
    }

    private sealed class FakeStore : IPasswordResetStore
    {
        private readonly Dictionary<string, int> _emails = new(StringComparer.OrdinalIgnoreCase);
        internal Dictionary<int, string> Passwords { get; } = [];
        internal List<(int Person, byte[] Hash, bool Used)> Tokens { get; } = [];
        internal bool FailIssue { get; set; }

        internal void AddConsumer(int id, string email, string password)
        {
            _emails[email] = id;
            Passwords[id] = password;
        }

        public Task<PasswordResetCandidate?> FindConsumerByEmailAsync(string email) =>
            Task.FromResult(_emails.TryGetValue(email, out var id)
                ? new PasswordResetCandidate(id, "Test", email)
                : null);

        public Task IssueTokenAsync(int businessEntityId, byte[] tokenHash, TimeSpan lifetime)
        {
            if (FailIssue) throw new InvalidOperationException("Simulated store failure");
            Tokens.RemoveAll(t => t.Person == businessEntityId && !t.Used);
            Tokens.Add((businessEntityId, tokenHash, false));
            return Task.CompletedTask;
        }

        public Task<bool> IsTokenActiveAsync(int businessEntityId, byte[] tokenHash) =>
            Task.FromResult(Find(businessEntityId, tokenHash) >= 0);

        public Task<bool> CompleteResetAsync(int businessEntityId, byte[] tokenHash, string passwordHash, string passwordSalt)
        {
            var index = Find(businessEntityId, tokenHash);
            if (index < 0) return Task.FromResult(false);
            Tokens[index] = Tokens[index] with { Used = true };
            Passwords[businessEntityId] = passwordHash + ":" + passwordSalt;
            return Task.FromResult(true);
        }

        private int Find(int person, byte[] hash) =>
            Tokens.FindIndex(t => t.Person == person && !t.Used && t.Hash.SequenceEqual(hash));
    }

    private sealed class Context : FunctionContext, IDisposable
    {
        private readonly ServiceProvider _services = new ServiceCollection()
            .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions
            {
                Serializer = new JsonObjectSerializer(new JsonSerializerOptions(JsonSerializerDefaults.Web))
            })).BuildServiceProvider();
        public Context() => InstanceServices = _services;
        public override string InvocationId => "password-reset-test";
        public override string FunctionId => "password-reset-test";
        public override TraceContext TraceContext => throw new NotSupportedException();
        public override BindingContext BindingContext => throw new NotSupportedException();
        public override RetryContext RetryContext => null!;
        public override IServiceProvider InstanceServices { get; set; }
        public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();
        public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
        public override IInvocationFeatures Features => throw new NotSupportedException();
        public void Dispose() => _services.Dispose();
    }

    private sealed class Request(FunctionContext context, string body) : HttpRequestData(context)
    {
        public override Stream Body { get; } = new MemoryStream(Encoding.UTF8.GetBytes(body));
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url { get; } = new("https://functions.example.test/api/password/reset");
        public override IEnumerable<ClaimsIdentity> Identities => [];
        public override string Method => "POST";
        public override HttpResponseData CreateResponse() => new Response(FunctionContext);
    }

    private sealed class Response(FunctionContext context) : HttpResponseData(context)
    {
        public override HttpStatusCode StatusCode { get; set; }
        public override HttpHeadersCollection Headers { get; set; } = new();
        public override Stream Body { get; set; } = new MemoryStream();
        public override HttpCookies Cookies => throw new NotSupportedException();
    }
}
