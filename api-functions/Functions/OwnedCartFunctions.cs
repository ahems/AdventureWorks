using System.Net;
using System.Text.Json;
using ApiFunctions.Auth;
using api_functions.Services;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

public sealed class OwnedCartFunctions(
    IOwnedCartService carts, FunctionsAccessTokenValidator validator, ILogger<OwnedCartFunctions> logger)
{
    public const string GuestHeader = "X-Guest-Cart-Session";
    private sealed record CartInput(int ProductID, int Quantity);

    private static string Header(HttpRequestData request, string name)
    {
        if (!request.Headers.TryGetValues(name, out var values))
            return "";
        var all = values.ToArray();
        if (all.Length != 1)
            throw new CartAccessException(HttpStatusCode.Unauthorized, "ambiguous_cart_credential");
        return all[0];
    }

    private async Task<CartActor> CallerAsync(HttpRequestData request)
    {
        var query = QueryHelpers.ParseQuery(request.Url.Query);
        var expected = query.TryGetValue("cartId", out var value) ? value.FirstOrDefault() : null;
        if (expected?.Length > 50)
            throw new CartAccessException(HttpStatusCode.BadRequest, "invalid_cart_id");
        var authorization = Header(request, "Authorization");
        if (request.Headers.TryGetValues("Authorization", out _))
        {
            if (!authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                throw new CartAccessException(HttpStatusCode.Unauthorized, "invalid_bearer");
            var validation = await validator.ValidateAsync(authorization[7..].Trim(),
                request.FunctionContext.CancellationToken);
            if (!validation.Succeeded)
                throw new CartAccessException(HttpStatusCode.Unauthorized, "invalid_bearer");
            var user = FunctionUser.FromPrincipal(validation.Principal!);
            var scope = request.Method == "GET" ? FunctionScopes.OrdersRead : FunctionScopes.OrdersWrite;
            if (!user.IsConsumer || user.BusinessEntityId is not > 0 || !user.HasScope(scope))
                throw new CartAccessException(HttpStatusCode.Forbidden, "consumer_cart_scope_required");
            return new(user.BusinessEntityId, null, expected);
        }
        return new(null, CartActor.HashToken(Header(request, GuestHeader)), expected);
    }

    private async Task<HttpResponseData> RespondAsync(HttpRequestData request, Func<Task<object>> action,
        HttpStatusCode status = HttpStatusCode.OK)
    {
        try
        {
            var payload = await action();
            var response = request.CreateResponse(status);
            response.Headers.Add("Cache-Control", "no-store");
            await response.WriteAsJsonAsync(payload);
            return response;
        }
        catch (CartAccessException error)
        {
            logger.LogWarning("Cart request denied: {Code}", error.Message);
            var response = request.CreateResponse(error.Status);
            response.Headers.Add("Cache-Control", "no-store");
            await response.WriteAsJsonAsync(new { error = error.Message });
            return response;
        }
        catch (JsonException error)
        {
            logger.LogWarning(error, "Invalid cart request JSON");
            var response = request.CreateResponse(HttpStatusCode.BadRequest);
            await response.WriteAsJsonAsync(new { error = "invalid_cart_request" });
            return response;
        }
        catch (SqlException error)
        {
            logger.LogError(error, "Owned cart database operation failed");
            var response = request.CreateResponse(HttpStatusCode.InternalServerError);
            await response.WriteAsJsonAsync(new { error = "cart_service_unavailable" });
            return response;
        }
    }

    [Function("GuestCartSession")]
    public Task<HttpResponseData> Session(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", "delete", Route = "cart/session")] HttpRequestData request) =>
        RespondAsync(request, async () =>
        {
            var cancellationToken = request.FunctionContext.CancellationToken;
            if (request.Method == "POST")
                return await carts.CreateSessionAsync(cancellationToken);
            await carts.RetireAsync(CartActor.HashToken(Header(request, GuestHeader)), cancellationToken);
            return new { retired = true };
        });

    [Function("OwnedCartItems")]
    public Task<HttpResponseData> Items(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", "post", "delete", Route = "cart/items")] HttpRequestData request) =>
        RespondAsync(request, async () =>
        {
            var actor = await CallerAsync(request);
            var cancellationToken = request.FunctionContext.CancellationToken;
            if (request.Method == "GET")
                return await carts.ReadAsync(actor, cancellationToken);
            if (request.Method == "DELETE")
            {
                await carts.DeleteAsync(actor, null, cancellationToken);
                return new { deleted = true };
            }
            var input = await JsonSerializer.DeserializeAsync<CartInput>(request.Body, cancellationToken: cancellationToken)
                ?? throw new CartAccessException(HttpStatusCode.BadRequest, "invalid_cart_request");
            return await carts.AddAsync(actor, input.ProductID, input.Quantity, cancellationToken);
        });

    [Function("OwnedCartItem")]
    public Task<HttpResponseData> Item(
        [HttpTrigger(AuthorizationLevel.Anonymous, "patch", "delete", Route = "cart/items/{id:int}")] HttpRequestData request,
        int id) => RespondAsync(request, async () =>
        {
            var actor = await CallerAsync(request);
            var cancellationToken = request.FunctionContext.CancellationToken;
            if (id <= 0)
                throw new CartAccessException(HttpStatusCode.BadRequest, "invalid_cart_item");
            if (request.Method == "DELETE")
            {
                await carts.DeleteAsync(actor, id, cancellationToken);
                return new { deleted = true };
            }
            var input = await JsonSerializer.DeserializeAsync<CartInput>(request.Body, cancellationToken: cancellationToken)
                ?? throw new CartAccessException(HttpStatusCode.BadRequest, "invalid_cart_request");
            return await carts.UpdateAsync(actor, id, input.Quantity, cancellationToken);
        });

    [Function("MergeGuestCart")]
    public Task<HttpResponseData> Merge(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "cart/merge")] HttpRequestData request,
        FunctionContext context) => RespondAsync(request, async () =>
        {
            var user = FunctionUser.Current(context);
            if (!user.IsAuthenticated || !user.IsConsumer || user.BusinessEntityId is not > 0 ||
                !user.HasScope(FunctionScopes.OrdersWrite))
                throw new CartAccessException(HttpStatusCode.Forbidden, "consumer_cart_scope_required");
            var query = QueryHelpers.ParseQuery(request.Url.Query);
            if (query.TryGetValue("cartId", out var expected) &&
                expected.ToString() != user.BusinessEntityId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture))
                throw new CartAccessException(HttpStatusCode.Forbidden, "cart_owner_mismatch");
            await carts.MergeAsync(user.BusinessEntityId.Value, CartActor.HashToken(Header(request, GuestHeader)),
                context.CancellationToken);
            return new { merged = true };
        });

    [Function("CleanupExpiredGuestCarts")]
    public async Task Cleanup([TimerTrigger("0 */10 * * * *")] TimerInfo timer, FunctionContext context)
    {
        await carts.CleanupAsync(context.CancellationToken);
        logger.LogInformation("Expired guest-cart cleanup batch completed");
    }
}
