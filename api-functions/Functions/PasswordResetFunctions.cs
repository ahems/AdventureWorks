using System.Net;
using System.Text.Json;
using AddressFunctions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace AddressFunctions.Functions;

/// <summary>
/// Public storefront password reset: request an emailed link, validate it, complete the reset.
/// </summary>
public class PasswordResetFunctions
{
    public const string GenericRequestMessage =
        "If an account exists for this email address, a password reset link has been sent.";

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private readonly ILogger<PasswordResetFunctions> _logger;
    private readonly PasswordResetService _resetService;

    public PasswordResetFunctions(ILogger<PasswordResetFunctions> logger, PasswordResetService resetService)
    {
        _logger = logger;
        _resetService = resetService;
    }

    /// <summary>
    /// Request a password reset. Always answers 202 with the same body so callers cannot
    /// learn whether an address is registered; the link is only ever delivered by email.
    /// </summary>
    [Function("RequestPasswordReset")]
    public async Task<HttpResponseData> RequestPasswordReset(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "password/reset/request")] HttpRequestData req)
    {
        PasswordResetRequest? resetRequest;
        try
        {
            resetRequest = await JsonSerializer.DeserializeAsync<PasswordResetRequest>(req.Body, JsonOptions);
        }
        catch (JsonException)
        {
            resetRequest = null;
        }

        if (resetRequest == null || string.IsNullOrWhiteSpace(resetRequest.Email))
        {
            var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
            await badRequestResponse.WriteAsJsonAsync(new { error = "Email is required" });
            return badRequestResponse;
        }

        try
        {
            await _resetService.RequestResetAsync(resetRequest.Email);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing password reset request");
        }

        var response = req.CreateResponse(HttpStatusCode.Accepted);
        await response.WriteAsJsonAsync(new { message = GenericRequestMessage });
        return response;
    }

    /// <summary>
    /// Staff-initiated reset email for a known customer (internal-only, <c>customers.write</c>).
    /// Unlike the anonymous route, staff learn whether the customer is eligible: 200 sent,
    /// 409 not a storefront consumer login, 502 email not delivered, 503 reset links not configured.
    /// </summary>
    [Function("AdminRequestPasswordReset")]
    public async Task<HttpResponseData> AdminRequestPasswordReset(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "password/reset/admin-request")] HttpRequestData req)
    {
        var resetRequest = await ReadAsync<AdminPasswordResetRequest>(req);
        if (resetRequest == null || resetRequest.BusinessEntityID <= 0 || string.IsNullOrWhiteSpace(resetRequest.Email))
        {
            var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
            await badRequestResponse.WriteAsJsonAsync(new { error = "businessEntityID and email are required" });
            return badRequestResponse;
        }

        AdminPasswordResetResult result;
        try
        {
            result = await _resetService.RequestResetForCustomerAsync(resetRequest.BusinessEntityID, resetRequest.Email);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing staff password reset request");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { result = "error", message = "Password reset could not be started." });
            return errorResponse;
        }

        var (status, code, message) = result switch
        {
            AdminPasswordResetResult.Sent => (HttpStatusCode.OK, "sent", "Password reset email sent."),
            AdminPasswordResetResult.NotEligible => (HttpStatusCode.Conflict, "not-eligible",
                "This customer has no storefront sign-in for that email address, so no reset email was sent."),
            AdminPasswordResetResult.EmailNotSent => (HttpStatusCode.BadGateway, "email-not-sent",
                "A reset link was issued but the email was not delivered (email is not configured, or the address is a sample address that is never emailed)."),
            _ => (HttpStatusCode.ServiceUnavailable, "not-configured",
                "Password reset links are not configured for this environment."),
        };
        var response = req.CreateResponse(status);
        await response.WriteAsJsonAsync(new { result = code, message });
        return response;
    }

    /// <summary>
    /// Validate a password reset token
    /// </summary>
    [Function("ValidateResetToken")]
    public async Task<HttpResponseData> ValidateResetToken(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "password/reset/validate")] HttpRequestData req)
    {
        try
        {
            var validateRequest = await ReadAsync<ValidateTokenRequest>(req);
            if (validateRequest == null || string.IsNullOrWhiteSpace(validateRequest.Token) || validateRequest.BusinessEntityID <= 0)
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Token and BusinessEntityID are required" });
                return badRequestResponse;
            }

            var isValid = await _resetService.ValidateAsync(validateRequest.BusinessEntityID, validateRequest.Token);

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new { isValid });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error validating reset token");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred validating the token" });
            return errorResponse;
        }
    }

    /// <summary>
    /// Reset password using a valid token. The token is consumed and the password replaced in
    /// one transaction; until then the current password keeps working.
    /// </summary>
    [Function("ResetPassword")]
    public async Task<HttpResponseData> ResetPassword(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "password/reset/complete")] HttpRequestData req)
    {
        try
        {
            var resetRequest = await ReadAsync<CompleteResetRequest>(req);
            if (resetRequest == null || string.IsNullOrWhiteSpace(resetRequest.Token) ||
                resetRequest.BusinessEntityID <= 0 || string.IsNullOrWhiteSpace(resetRequest.NewPassword))
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Token, BusinessEntityID, and NewPassword are required" });
                return badRequestResponse;
            }

            if (resetRequest.NewPassword.Length < 8)
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Password must be at least 8 characters long" });
                return badRequestResponse;
            }

            var outcome = await _resetService.CompleteAsync(
                resetRequest.BusinessEntityID, resetRequest.Token, resetRequest.NewPassword);
            if (outcome != PasswordResetOutcome.Completed)
            {
                var unauthorizedResponse = req.CreateResponse(HttpStatusCode.Unauthorized);
                await unauthorizedResponse.WriteAsJsonAsync(new { error = "Invalid or expired reset token" });
                return unauthorizedResponse;
            }

            _logger.LogInformation("Password reset completed for BusinessEntityID {BusinessEntityId}", resetRequest.BusinessEntityID);

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new { message = "Password successfully reset" });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error resetting password");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred resetting the password" });
            return errorResponse;
        }
    }

    private static async Task<T?> ReadAsync<T>(HttpRequestData req) where T : class
    {
        try
        {
            return await JsonSerializer.DeserializeAsync<T>(req.Body, JsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

public class PasswordResetRequest
{
    public string Email { get; set; } = string.Empty;
}

public class AdminPasswordResetRequest
{
    public int BusinessEntityID { get; set; }
    public string Email { get; set; } = string.Empty;
}

public class ValidateTokenRequest
{
    public int BusinessEntityID { get; set; }
    public string Token { get; set; } = string.Empty;
}

public class CompleteResetRequest
{
    public int BusinessEntityID { get; set; }
    public string Token { get; set; } = string.Empty;
    public string NewPassword { get; set; } = string.Empty;
}
