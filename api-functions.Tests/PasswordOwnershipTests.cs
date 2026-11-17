using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using AddressFunctions.Models;
using AddressFunctions.Services;
using ApiFunctions.Auth;
using Azure.Core.Serialization;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;
using Handler = AddressFunctions.Functions.PasswordFunctions;

namespace ApiFunctions.Tests;

public sealed class PasswordOwnershipTests
{
    private readonly Store _store = new();
    private Handler Functions => new(NullLogger<Handler>.Instance, _store);

    [Theory]
    [InlineData(7, "set")]
    [InlineData(8, "set")]
    [InlineData(7, "verify")]
    [InlineData(8, "verify")]
    public async Task Consumer_own_password_reaches_only_signed_owner(int owner, string operation)
    {
        using var context = new Context(owner);
        Assert.Equal(HttpStatusCode.OK, (await Invoke(context, owner, operation)).StatusCode);
        Assert.Equal(new[] { operation + ":" + owner }, _store.Calls);
    }

    [Theory]
    [InlineData(7, "set")]
    [InlineData(8, "set")]
    [InlineData(7, "verify")]
    [InlineData(8, "verify")]
    public async Task Other_consumer_password_denied_before_any_storage(int owner, string operation)
    {
        using var context = new Context(owner);
        Assert.Equal(HttpStatusCode.Forbidden, (await Invoke(context, owner == 7 ? 8 : 7, operation)).StatusCode);
        Assert.Empty(_store.Calls);
    }

    [Theory]
    [InlineData("set")]
    [InlineData("verify")]
    public async Task Missing_consumer_owner_denied_before_any_storage(string operation)
    {
        using var context = new Context(null);
        Assert.Equal(HttpStatusCode.Forbidden, (await Invoke(context, 7, operation)).StatusCode);
        Assert.Empty(_store.Calls);
    }

    [Theory]
    [InlineData("anonymous", "set")]
    [InlineData("anonymous", "verify")]
    [InlineData("unknown", "set")]
    [InlineData("unknown", "verify")]
    public async Task Untrusted_context_denied_before_any_storage(string category, string operation)
    {
        using var context = new Context(7, category);
        Assert.Equal(HttpStatusCode.Forbidden, (await Invoke(context, 7, operation)).StatusCode);
        Assert.Empty(_store.Calls);
    }

    [Theory]
    [InlineData("employee", true)]
    [InlineData("employee", false)]
    [InlineData("manufacturing", true)]
    [InlineData("manufacturing", false)]
    [InlineData("service", true)]
    [InlineData("service", false)]
    public async Task Internal_reset_requires_individual_customer_before_write(string category, bool customer)
    {
        using var context = new Context(99, category);
        _store.Customer = customer;
        var response = await Invoke(context, 7, "set");
        Assert.Equal(customer ? HttpStatusCode.OK : HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(customer ? new[] { "customer:7", "set:7" } : new[] { "customer:7" }, _store.Calls);
    }

    [Theory]
    [InlineData("employee", true)]
    [InlineData("employee", false)]
    [InlineData("manufacturing", true)]
    [InlineData("manufacturing", false)]
    [InlineData("service", true)]
    [InlineData("service", false)]
    public async Task Internal_verification_is_self_only(string category, bool own)
    {
        using var context = new Context(99, category);
        var response = await Invoke(context, own ? 99 : 7, "verify");
        Assert.Equal(own ? HttpStatusCode.OK : HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(own ? new[] { "verify:99" } : Array.Empty<string>(), _store.Calls);
    }

    [Theory]
    [InlineData("set", true)]
    [InlineData("set", false)]
    [InlineData("verify", true)]
    [InlineData("verify", false)]
    public async Task Persistence_result_is_not_replaced_with_success(string operation, bool result)
    {
        using var context = new Context(7);
        _store.Result = result;
        var response = await Invoke(context, 7, operation);
        Assert.Equal(operation == "set" && !result ? HttpStatusCode.InternalServerError : HttpStatusCode.OK,
            response.StatusCode);
        if (operation == "verify")
        {
            response.Body.Position = 0;
            using var body = await JsonDocument.ParseAsync(response.Body);
            Assert.Equal(result, body.RootElement.GetProperty("isValid").GetBoolean());
        }
        Assert.Equal(new[] { operation + ":7" }, _store.Calls);
    }

    private Task<HttpResponseData> Invoke(Context context, int target, string operation)
    {
        var request = new Request(context, JsonSerializer.Serialize(new
        {
            businessEntityID = target, password = "Unit-test-only-password"
        }));
        return operation == "set" ? Functions.SetPassword(request, context) : Functions.VerifyPassword(request, context);
    }

    private sealed class Store : IPasswordService
    {
        internal List<string> Calls { get; } = [];
        internal bool Customer { get; set; } = true;
        internal bool Result { get; set; } = true;
        public Task<CreatedCustomerAccount?> CreateCustomerAccountAsync(string email, string password, string firstName,
            string lastName) => throw new InvalidOperationException("Signup must not run in password ownership tests.");
        public Task<bool> IsIndividualCustomerAsync(int businessEntityId)
        {
            Calls.Add("customer:" + businessEntityId);
            return Task.FromResult(Customer);
        }
        public Task<bool> StorePasswordAsync(int businessEntityId, string password)
        {
            Calls.Add("set:" + businessEntityId);
            return Task.FromResult(Result);
        }
        public Task<bool> VerifyPasswordAsync(int businessEntityId, string password)
        {
            Calls.Add("verify:" + businessEntityId);
            return Task.FromResult(Result);
        }
    }

    private sealed class Context : FunctionContext, IDisposable
    {
        private readonly ServiceProvider _services = new ServiceCollection()
            .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions
            {
                Serializer = new JsonObjectSerializer(new JsonSerializerOptions(JsonSerializerDefaults.Web))
            })).BuildServiceProvider();
        public Context(int? owner, string category = "consumer")
        {
            InstanceServices = _services;
            Items[FunctionUser.ContextKey] = new FunctionUser
            {
                IsAuthenticated = category != "anonymous", Category = category, BusinessEntityId = owner,
            };
        }
        public override string InvocationId => "password-ownership-test";
        public override string FunctionId => "password-ownership-test";
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
        public override Uri Url { get; } = new("https://functions.example.test/api/password");
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
