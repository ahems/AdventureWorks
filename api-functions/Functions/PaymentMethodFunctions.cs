using System.Net;
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
}
