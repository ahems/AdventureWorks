using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using AddressFunctions.Models;
using AddressFunctions.Services;
using ApiFunctions.Auth;
using System.Net;
using System.Text.Json;

namespace AddressFunctions.Functions;

/// <summary>
/// Azure Functions for password management with PBKDF2 hashing
/// </summary>
public class PasswordFunctions
{
    private readonly ILogger<PasswordFunctions> _logger;
    private readonly PasswordService _passwordService;

    public PasswordFunctions(ILogger<PasswordFunctions> logger, PasswordService passwordService)
    {
        _logger = logger;
        _passwordService = passwordService;
    }

    private static async Task<HttpResponseData> ForbiddenAsync(HttpRequestData req, string message)
    {
        var response = req.CreateResponse(HttpStatusCode.Forbidden);
        await response.WriteAsJsonAsync(new { error = "forbidden", error_description = message });
        return response;
    }

    /// <summary>
    /// Registers a new e-shop customer in one transaction: BusinessEntity, Person (PersonType IN),
    /// EmailAddress and a PBKDF2 password. Replaces the former browser-side sequence of anonymous
    /// DAB creates + an anonymous password set, so the identity tables need no anonymous access.
    /// </summary>
    /// <response code="201">Account created</response>
    /// <response code="400">Invalid request body</response>
    /// <response code="409">An account with this email already exists</response>
    [Function("Signup")]
    public async Task<HttpResponseData> Signup(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "signup")] HttpRequestData req)
    {
        SignupRequest? body;
        try
        {
            body = await req.ReadFromJsonAsync<SignupRequest>();
        }
        catch (JsonException)
        {
            body = null;
        }

        var email = body?.Email?.Trim() ?? string.Empty;
        var firstName = body?.FirstName?.Trim() ?? string.Empty;
        var lastName = body?.LastName?.Trim() ?? string.Empty;
        if (body is null
            || !System.Net.Mail.MailAddress.TryCreate(email, out _) || email.Length > 50
            || firstName.Length is 0 or > 50 || lastName.Length is 0 or > 50
            || string.IsNullOrEmpty(body.Password) || body.Password.Length < 8)
        {
            var bad = req.CreateResponse(HttpStatusCode.BadRequest);
            await bad.WriteAsJsonAsync(new
            {
                error = "Invalid request. A valid email, first and last name, and a password of at least 8 characters are required."
            });
            return bad;
        }

        try
        {
            var created = await _passwordService.CreateCustomerAccountAsync(email, body.Password, firstName, lastName);
            if (created is null)
            {
                var conflict = req.CreateResponse(HttpStatusCode.Conflict);
                await conflict.WriteAsJsonAsync(new { error = "An account with this email already exists." });
                return conflict;
            }

            _logger.LogInformation("Created customer account BusinessEntityID {BusinessEntityId}", created.BusinessEntityId);
            var response = req.CreateResponse(HttpStatusCode.Created);
            await response.WriteAsJsonAsync(new
            {
                businessEntityId = created.BusinessEntityId,
                emailAddressId = created.EmailAddressId,
                email,
                firstName,
                lastName,
            });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error creating customer account");
            var error = req.CreateResponse(HttpStatusCode.InternalServerError);
            await error.WriteAsJsonAsync(new { error = "An error occurred while creating the account" });
            return error;
        }
    }

    /// <summary>
    /// Sets or updates a password for a business entity
    /// </summary>
    /// <param name="req">HTTP request with JSON body containing BusinessEntityID and Password</param>
    /// <returns>Success or error response</returns>
    /// <response code="200">Password successfully set/updated</response>
    /// <response code="400">Invalid request body</response>
    /// <response code="500">Internal server error</response>
    /// <example>
    /// POST /api/password
    /// {
    ///   "businessEntityID": 1,
    ///   "password": "SecurePassword123!"
    /// }
    /// </example>
    [Function("SetPassword")]
    public async Task<HttpResponseData> SetPassword(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "password")] HttpRequestData req,
        FunctionContext executionContext)
    {
        _logger.LogInformation("SetPassword function processing request");

        try
        {
            // Parse request body using ReadFromJsonAsync
            var setPasswordRequest = await req.ReadFromJsonAsync<SetPasswordRequest>();

            if (setPasswordRequest == null || setPasswordRequest.BusinessEntityID <= 0 || string.IsNullOrWhiteSpace(setPasswordRequest.Password))
            {
                _logger.LogWarning("Invalid request body for SetPassword");
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new
                {
                    error = "Invalid request. BusinessEntityID must be positive and Password must not be empty."
                });
                return badRequestResponse;
            }

            // Basic password validation
            if (setPasswordRequest.Password.Length < 8)
            {
                _logger.LogWarning($"Password too short for BusinessEntityID {setPasswordRequest.BusinessEntityID}");
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new
                {
                    error = "Password must be at least 8 characters long."
                });
                return badRequestResponse;
            }

            // Ownership: a consumer may only change their own password; staff (customers.write)
            // may reset customer passwords but never another employee's.
            var user = FunctionUser.Current(executionContext);
            if (user.IsConsumer && user.BusinessEntityId != setPasswordRequest.BusinessEntityID)
            {
                return await ForbiddenAsync(req, "You can only change your own password.");
            }
            if (user.IsInternal && !await _passwordService.IsIndividualCustomerAsync(setPasswordRequest.BusinessEntityID))
            {
                return await ForbiddenAsync(req, "Staff may only reset passwords for customer accounts.");
            }

            // Store the password
            var success = await _passwordService.StorePasswordAsync(
                setPasswordRequest.BusinessEntityID,
                setPasswordRequest.Password
            );

            if (success)
            {
                _logger.LogInformation($"Successfully set password for BusinessEntityID {setPasswordRequest.BusinessEntityID}");
                var response = req.CreateResponse(HttpStatusCode.OK);
                await response.WriteAsJsonAsync(new
                {
                    message = "Password successfully set",
                    businessEntityID = setPasswordRequest.BusinessEntityID
                });
                return response;
            }
            else
            {
                _logger.LogError($"Failed to set password for BusinessEntityID {setPasswordRequest.BusinessEntityID}");
                var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
                await errorResponse.WriteAsJsonAsync(new
                {
                    error = "Failed to set password"
                });
                return errorResponse;
            }
        }
        catch (JsonException ex)
        {
            _logger.LogError(ex, "Invalid JSON in request body");
            var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
            await badRequestResponse.WriteAsJsonAsync(new
            {
                error = "Invalid JSON format in request body"
            });
            return badRequestResponse;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error setting password");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new
            {
                error = "An error occurred while setting the password"
            });
            return errorResponse;
        }
    }

    /// <summary>
    /// Verifies a password for a business entity
    /// </summary>
    /// <param name="req">HTTP request with JSON body containing BusinessEntityID and Password</param>
    /// <returns>Verification result indicating if password is valid</returns>
    /// <response code="200">Password verification result</response>
    /// <response code="400">Invalid request body</response>
    /// <response code="500">Internal server error</response>
    /// <example>
    /// POST /api/password/verify
    /// {
    ///   "businessEntityID": 1,
    ///   "password": "SecurePassword123!"
    /// }
    /// </example>
    [Function("VerifyPassword")]
    public async Task<HttpResponseData> VerifyPassword(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "password/verify")] HttpRequestData req,
        FunctionContext executionContext)
    {
        _logger.LogInformation("VerifyPassword function processing request");

        try
        {
            // Parse request body using ReadFromJsonAsync
            var verifyPasswordRequest = await req.ReadFromJsonAsync<VerifyPasswordRequest>();

            if (verifyPasswordRequest == null || verifyPasswordRequest.BusinessEntityID <= 0 || string.IsNullOrWhiteSpace(verifyPasswordRequest.Password))
            {
                _logger.LogWarning("Invalid request body for VerifyPassword");
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new
                {
                    error = "Invalid request. BusinessEntityID must be positive and Password must not be empty."
                });
                return badRequestResponse;
            }

            // Self-only: verifying someone else's password would be a password-guessing oracle.
            // Sign-in itself happens at the api-mcp authorization server, not here.
            var user = FunctionUser.Current(executionContext);
            if (user.IsAuthenticated && user.BusinessEntityId != verifyPasswordRequest.BusinessEntityID)
            {
                return await ForbiddenAsync(req, "You can only verify your own password.");
            }

            // Verify the password
            var isValid = await _passwordService.VerifyPasswordAsync(
                verifyPasswordRequest.BusinessEntityID,
                verifyPasswordRequest.Password
            );

            _logger.LogInformation($"Password verification for BusinessEntityID {verifyPasswordRequest.BusinessEntityID}: {(isValid ? "Success" : "Failed")}");

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new VerifyPasswordResponse
            {
                IsValid = isValid,
                Message = isValid ? "Password is valid" : "Invalid password or user not found"
            });
            return response;
        }
        catch (JsonException ex)
        {
            _logger.LogError(ex, "Invalid JSON in request body");
            var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
            await badRequestResponse.WriteAsJsonAsync(new
            {
                error = "Invalid JSON format in request body"
            });
            return badRequestResponse;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error verifying password");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new
            {
                error = "An error occurred while verifying the password"
            });
            return errorResponse;
        }
    }
}
