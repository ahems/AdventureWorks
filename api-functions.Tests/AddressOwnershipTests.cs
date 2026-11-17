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
using Handler = AddressFunctions.Functions.AddressFunctions;

namespace ApiFunctions.Tests;

public sealed class AddressOwnershipTests
{
    private readonly Store _store = new();
    private Handler Functions => new(NullLogger<Handler>.Instance, _store);

    [Theory]
    [InlineData(7, 101)]
    [InlineData(8, 102)]
    public async Task Consumer_listing_scopes_sql_before_pagination(int owner, int expectedAddress)
    {
        using var context = new Context(owner);
        var request = new Request(context, "GET", "?limit=1&offset=0&businessEntityId=999");
        var response = await Functions.GetAddresses(request, context);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var addresses = await Body<Address[]>(response);
        Assert.Equal(expectedAddress, Assert.Single(addresses).AddressID);
        Assert.Equal(owner, _store.ListOwner);
        Assert.Equal(1, _store.ListLimit);
        Assert.Equal(0, _store.ListOffset);
    }

    [Fact]
    public async Task Missing_consumer_owner_never_reads_global_addresses()
    {
        using var context = new Context(null);
        var response = await Functions.GetAddresses(new Request(context, "GET"), context);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(0, _store.DataCalls);
    }

    [Fact]
    public async Task Internal_listing_preserves_global_pagination()
    {
        using var context = new Context(7, "employee");
        var response = await Functions.GetAddresses(new Request(context, "GET", "?limit=1&offset=1"), context);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Null(_store.ListOwner);
        Assert.Equal(1, _store.ListOffset);
        Assert.Equal(101, Assert.Single(await Body<Address[]>(response)).AddressID);
    }

    [Theory]
    [InlineData(7, 102, "GET")]
    [InlineData(8, 101, "GET")]
    [InlineData(7, 102, "PUT")]
    [InlineData(8, 101, "PUT")]
    [InlineData(7, 102, "DELETE")]
    [InlineData(8, 101, "DELETE")]
    [InlineData(7, 102, "TYPE")]
    [InlineData(8, 101, "TYPE")]
    public async Task Other_owner_address_never_reaches_data_or_mutation(int owner, int address, string operation)
    {
        using var context = new Context(owner);
        var response = await Invoke(operation, address, context);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(0, _store.DataCalls);
        Assert.Equal((address, owner), _store.OwnershipLookup);
    }

    [Theory]
    [InlineData("GET")]
    [InlineData("PUT")]
    [InlineData("DELETE")]
    [InlineData("TYPE")]
    public async Task Missing_owner_denied_before_even_ownership_lookup(string operation)
    {
        using var context = new Context(null);
        Assert.Equal(HttpStatusCode.Forbidden, (await Invoke(operation, 101, context)).StatusCode);
        Assert.Null(_store.OwnershipLookup);
        Assert.Equal(0, _store.DataCalls);
    }

    [Theory]
    [InlineData(0, "GET")]
    [InlineData(-1, "GET")]
    [InlineData(0, "PUT")]
    [InlineData(-1, "PUT")]
    [InlineData(0, "DELETE")]
    [InlineData(-1, "DELETE")]
    [InlineData(0, "TYPE")]
    [InlineData(-1, "TYPE")]
    public async Task Nonpositive_consumer_owner_denied_before_data(int owner, string operation)
    {
        using var context = new Context(owner);
        Assert.Equal(HttpStatusCode.Forbidden, (await Invoke(operation, 101, context)).StatusCode);
        Assert.Null(_store.OwnershipLookup);
        Assert.Equal(0, _store.DataCalls);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task Nonpositive_consumer_owner_cannot_list_create_or_query_people(int owner)
    {
        using var context = new Context(owner);
        Assert.Equal(HttpStatusCode.Forbidden, (await Functions.GetAddresses(
            new Request(context, "GET"), context)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Functions.GetPersonAddresses(
            new Request(context, "GET", "?businessEntityIds=999"), context)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Functions.CreateAddress(
            new Request(context, "POST", body: """{"AddressLine1":"Test","City":"Test","PostalCode":"00000","StateProvinceID":1}"""),
            context)).StatusCode);
        Assert.Equal(0, _store.DataCalls);
    }

    [Theory]
    [InlineData(7, 101)]
    [InlineData(8, 102)]
    public async Task Own_address_read_succeeds(int owner, int address)
    {
        using var context = new Context(owner);
        var response = await Invoke("GET", address, context);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(address, (await Body<Address>(response)).AddressID);
        Assert.Equal(1, _store.DataCalls);
        Assert.Equal((address, owner), _store.OwnershipLookup);
    }

    [Theory]
    [InlineData(7, 101)]
    [InlineData(8, 102)]
    public async Task Own_address_update_uses_atomic_owner_bound_service(int owner, int address)
    {
        using var context = new Context(owner);
        var response = await Invoke("PUT", address, context);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal((address, owner), _store.OwnershipLookup);
        Assert.Equal(1, _store.DataCalls);
        Assert.Equal(0, _store.InternalUpdateCalls);
    }

    [Theory]
    [InlineData(7, 101)]
    [InlineData(8, 102)]
    public async Task Shared_address_update_returns_conflict_without_mutation(int owner, int address)
    {
        _store.Shared = true;
        using var context = new Context(owner);
        var response = await Invoke("PUT", address, context);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal((address, owner), _store.OwnershipLookup);
        Assert.Equal(0, _store.DataCalls);
    }

    [Fact]
    public async Task Internal_address_update_keeps_the_existing_service_path()
    {
        using var context = new Context(7, "employee");
        var response = await Invoke("PUT", 101, context);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1, _store.InternalUpdateCalls);
        Assert.Null(_store.OwnershipLookup);
    }

    [Theory]
    [InlineData(7, 101)]
    [InlineData(8, 102)]
    public async Task Own_address_delete_uses_atomic_owner_bound_service(int owner, int address)
    {
        using var context = new Context(owner);
        var response = await Invoke("DELETE", address, context);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal((address, owner), _store.OwnershipLookup);
        Assert.Equal(1, _store.DataCalls);
        Assert.Equal(0, _store.InternalDeleteCalls);
    }

    [Fact]
    public async Task Internal_address_delete_keeps_the_existing_service_path()
    {
        using var context = new Context(7, "employee");
        var response = await Invoke("DELETE", 101, context);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(1, _store.InternalDeleteCalls);
        Assert.Null(_store.OwnershipLookup);
    }

    [Theory]
    [InlineData(7)]
    [InlineData(8)]
    public async Task Create_and_person_queries_override_supplied_other_owner(int owner)
    {
        using var context = new Context(owner);
        var request = new Request(context, "POST", body: """
            {"AddressLine1":"Test","City":"Test","PostalCode":"00000","StateProvinceID":1,"BusinessEntityID":999}
            """);
        Assert.Equal(HttpStatusCode.Created, (await Functions.CreateAddress(request, context)).StatusCode);
        Assert.Equal(owner, _store.CreateOwner);
        Assert.Equal(HttpStatusCode.OK, (await Functions.GetPersonAddresses(
            new Request(context, "GET", "?businessEntityIds=999,998"), context)).StatusCode);
        Assert.Equal(new[] { owner }, _store.PersonOwners);
    }

    [Theory]
    [InlineData(7, 101)]
    [InlineData(8, 102)]
    public async Task Own_type_update_ignores_supplied_other_owner(int owner, int address)
    {
        using var context = new Context(owner);
        Assert.Equal(HttpStatusCode.NoContent, (await Invoke("TYPE", address, context)).StatusCode);
        Assert.Equal(owner, _store.TypeOwner);
    }

    private Task<HttpResponseData> Invoke(string operation, int address, Context context)
    {
        var request = new Request(context, operation, "?businessEntityId=999",
            """{"City":"Test","AddressTypeID":3,"BusinessEntityID":999}""");
        return operation switch
        {
            "GET" => Functions.GetAddressById(request, address, context),
            "PUT" => Functions.UpdateAddress(request, address, context),
            "DELETE" => Functions.DeleteAddress(request, address, context),
            "TYPE" => Functions.SetAddressType(request, address, context),
            _ => throw new ArgumentOutOfRangeException(nameof(operation)),
        };
    }

    private static async Task<T> Body<T>(HttpResponseData response)
    {
        response.Body.Position = 0;
        return (await JsonSerializer.DeserializeAsync<T>(response.Body,
            new JsonSerializerOptions(JsonSerializerDefaults.Web)))!;
    }

    private sealed class Store : IAddressService
    {
        private readonly Address[] _addresses = [
            new() { AddressID = 1 }, new() { AddressID = 101 }, new() { AddressID = 102 }];
        public int DataCalls { get; private set; }
        public int? ListOwner { get; private set; }
        public int? ListLimit { get; private set; }
        public int? ListOffset { get; private set; }
        public (int Address, int Owner)? OwnershipLookup { get; private set; }
        public int? CreateOwner { get; private set; }
        public int? TypeOwner { get; private set; }
        public int[]? PersonOwners { get; private set; }
        public int InternalDeleteCalls { get; private set; }
        public int InternalUpdateCalls { get; private set; }
        public bool Shared { get; set; }
        public Task<bool> IsAddressOwnedByAsync(int addressId, int businessEntityId)
        {
            OwnershipLookup = (addressId, businessEntityId);
            return Task.FromResult(addressId == (businessEntityId == 7 ? 101 : 102));
        }
        public Task<IEnumerable<Address>> GetAddressesAsync(int? limit = 100, int? offset = 0, int? businessEntityId = null)
        {
            DataCalls++;
            ListOwner = businessEntityId; ListLimit = limit; ListOffset = offset;
            var addresses = businessEntityId is null ? _addresses :
                _addresses.Where(address => address.AddressID == (businessEntityId == 7 ? 101 : 102));
            return Task.FromResult(addresses.Skip(offset ?? 0).Take(limit ?? 100));
        }
        public Task<Address?> GetAddressByIdAsync(int id, int? businessEntityId = null)
        {
            if (businessEntityId is int owner)
            {
                OwnershipLookup = (id, owner);
                if (id != (owner == 7 ? 101 : 102)) return Task.FromResult<Address?>(null);
            }
            DataCalls++;
            return Task.FromResult(_addresses.SingleOrDefault(address => address.AddressID == id));
        }
        public Task<Address> CreateAddressAsync(CreateAddressRequest request)
        {
            DataCalls++; CreateOwner = request.BusinessEntityID;
            return Task.FromResult(new Address { AddressID = 103 });
        }
        public Task<IEnumerable<PersonAddressResult>> GetPersonAddressesAsync(IEnumerable<int> businessEntityIds)
        {
            DataCalls++; PersonOwners = businessEntityIds.ToArray();
            return Task.FromResult<IEnumerable<PersonAddressResult>>([]);
        }
        public Task<Address?> UpdateAddressAsync(int id, UpdateAddressRequest request)
        {
            DataCalls++;
            InternalUpdateCalls++;
            return Task.FromResult<Address?>(new Address { AddressID = id });
        }
        public Task<OwnedAddressUpdateResult> UpdateOwnedAddressAsync(
            int id, int businessEntityId, UpdateAddressRequest request)
        {
            OwnershipLookup = (id, businessEntityId);
            if (id != (businessEntityId == 7 ? 101 : 102))
                return Task.FromResult(new OwnedAddressUpdateResult(OwnedAddressUpdateStatus.NotOwned));
            if (Shared)
                return Task.FromResult(new OwnedAddressUpdateResult(OwnedAddressUpdateStatus.Shared));
            DataCalls++;
            return Task.FromResult(new OwnedAddressUpdateResult(
                OwnedAddressUpdateStatus.Updated, new Address { AddressID = id }));
        }
        public Task<bool> DeleteAddressAsync(int id)
        {
            DataCalls++;
            InternalDeleteCalls++;
            return Task.FromResult(true);
        }
        public Task<bool> DeleteOwnedAddressAsync(int id, int businessEntityId)
        {
            OwnershipLookup = (id, businessEntityId);
            if (id != (businessEntityId == 7 ? 101 : 102)) return Task.FromResult(false);
            DataCalls++;
            return Task.FromResult(true);
        }
        public Task<SetAddressTypeResult> SetAddressTypeAsync(int businessEntityId, int addressId, int addressTypeId)
        {
            DataCalls++; TypeOwner = businessEntityId;
            return Task.FromResult(SetAddressTypeResult.Updated);
        }
    }

    private sealed class Context : FunctionContext, IDisposable
    {
        private readonly ServiceProvider _services = new ServiceCollection()
            .AddSingleton<IOptions<WorkerOptions>>(Options.Create(new WorkerOptions
            {
                Serializer = new JsonObjectSerializer(new JsonSerializerOptions(JsonSerializerDefaults.Web))
            }))
            .BuildServiceProvider();
        public Context(int? owner, string category = "consumer")
        {
            InstanceServices = _services;
            Items[FunctionUser.ContextKey] = new FunctionUser
            {
                IsAuthenticated = true, Category = category, BusinessEntityId = owner,
            };
        }
        public override string InvocationId => "address-test";
        public override string FunctionId => "address-test";
        public override TraceContext TraceContext => throw new NotSupportedException();
        public override BindingContext BindingContext => throw new NotSupportedException();
        public override RetryContext RetryContext => null!;
        public override IServiceProvider InstanceServices { get; set; }
        public override FunctionDefinition FunctionDefinition => throw new NotSupportedException();
        public override IDictionary<object, object> Items { get; set; } = new Dictionary<object, object>();
        public override IInvocationFeatures Features => throw new NotSupportedException();
        public void Dispose() => _services.Dispose();
    }

    private sealed class Request(FunctionContext context, string method, string query = "", string body = "{}")
        : HttpRequestData(context)
    {
        public override Stream Body { get; } = new MemoryStream(Encoding.UTF8.GetBytes(body));
        public override HttpHeadersCollection Headers { get; } = new();
        public override IReadOnlyCollection<IHttpCookie> Cookies => [];
        public override Uri Url { get; } = new("https://functions.example.test/api/addresses" + query);
        public override IEnumerable<ClaimsIdentity> Identities => [];
        public override string Method => method;
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
