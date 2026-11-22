using System.Net;
using System.Text.Json;
using ApiFunctions.Auth;
using api_functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

public sealed class PaymentMethodFunctions(
    IPaymentMethodService paymentMethods,
    ILogger<PaymentMethodFunctions> logger)
{
    [Function("GetPaymentMethods")]
    public async Task<HttpResponseData> GetPaymentMethods(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "payment-methods")] HttpRequestData request,
        FunctionContext context)
    {
        var user = FunctionUser.Current(context);
        if (!user.IsAuthenticated || !(user.IsConsumer || user.IsInternal) ||
            user.BusinessEntityId is not int owner || owner <= 0)
        {
            logger.LogWarning("Payment method read denied: no recognized person-bound identity.");
            var denied = request.CreateResponse(HttpStatusCode.Forbidden);
            await denied.WriteAsJsonAsync(new { error = "A person-bound identity is required." });
            return denied;
        }

        var cards = await paymentMethods.GetForPersonAsync(owner);
        var response = request.CreateResponse(HttpStatusCode.OK);
        await response.WriteAsJsonAsync(cards);
        return response;
    }

    /// <summary>
    /// Saves a card for the signed-in consumer. Only card type, last four digits and expiry are
    /// accepted; a full card number is rejected and the stored CardNumber is always masked.
    /// </summary>
    [Function("CreatePaymentMethod")]
    public async Task<HttpResponseData> CreatePaymentMethod(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "payment-methods")] HttpRequestData request,
        FunctionContext context)
    {
        var user = FunctionUser.Current(context);
        if (!user.IsAuthenticated || !user.IsConsumer || user.BusinessEntityId is not int owner || owner <= 0)
        {
            logger.LogWarning("Payment method save denied: no signed consumer identity.");
            var denied = request.CreateResponse(HttpStatusCode.Forbidden);
            await denied.WriteAsJsonAsync(new { error = "A signed-in shopper is required." });
            return denied;
        }

        NewPaymentCard? card;
        string? error;
        try
        {
            using var body = await JsonDocument.ParseAsync(request.Body);
            card = TryParseCard(body.RootElement, DateTimeOffset.UtcNow, out error);
        }
        catch (JsonException)
        {
            card = null;
            error = "The request body must be a JSON object.";
        }

        if (card is null)
        {
            var bad = request.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteAsJsonAsync(new { error });
            return bad;
        }

        var saved = await paymentMethods.AddForPersonAsync(owner, card);
        var response = request.CreateResponse(HttpStatusCode.Created);
        await response.WriteAsJsonAsync(saved);
        return response;
    }

    public static readonly IReadOnlySet<string> CardTypes =
        new HashSet<string>(StringComparer.Ordinal) { "Vista", "SuperiorCard", "Distinguish", "ColonialVoice" };

    private static readonly HashSet<string> AllowedFields =
        new(StringComparer.Ordinal) { "cardType", "last4", "expMonth", "expYear" };

    public static NewPaymentCard? TryParseCard(JsonElement body, DateTimeOffset now, out string? error)
    {
        error = null;
        if (body.ValueKind != JsonValueKind.Object)
        {
            error = "The request body must be a JSON object.";
            return null;
        }

        var unexpected = body.EnumerateObject().Select(p => p.Name).FirstOrDefault(name => !AllowedFields.Contains(name));
        if (unexpected is not null)
        {
            error = "Only cardType, last4, expMonth and expYear are accepted; full card numbers are never stored.";
            return null;
        }

        if (!body.TryGetProperty("cardType", out var type) || type.ValueKind != JsonValueKind.String ||
            !CardTypes.Contains(type.GetString()!))
        {
            error = "cardType must be one of: " + string.Join(", ", CardTypes.Order()) + ".";
            return null;
        }

        if (!body.TryGetProperty("last4", out var last4) || last4.ValueKind != JsonValueKind.String ||
            last4.GetString() is not { Length: 4 } digits || !digits.All(char.IsAsciiDigit))
        {
            error = "last4 must be exactly four digits.";
            return null;
        }

        if (!TryGetInt(body, "expMonth", out var m) || m is < 1 or > 12 ||
            !TryGetInt(body, "expYear", out var y) ||
            y > now.Year + 20 || y < now.Year || (y == now.Year && m < now.Month))
        {
            error = "expMonth/expYear must be a current or future expiry date.";
            return null;
        }

        return new NewPaymentCard(type.GetString()!, digits, (byte)m, (short)y);
    }

    private static bool TryGetInt(JsonElement body, string name, out int value)
    {
        value = 0;
        return body.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.Number &&
               element.TryGetInt32(out value);
    }
}
