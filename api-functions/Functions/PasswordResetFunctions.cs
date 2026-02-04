using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using AddressFunctions.Services;
using api_functions.Services;
using System.Net;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;

namespace AddressFunctions.Functions;

/// <summary>
/// Azure Functions for password reset flow
/// </summary>
public class PasswordResetFunctions
{
    private readonly ILogger<PasswordResetFunctions> _logger;
    private readonly PasswordService _passwordService;
    private readonly EmailService _emailService;
    private readonly string _connectionString;

    public PasswordResetFunctions(
        ILogger<PasswordResetFunctions> logger,
        PasswordService passwordService,
        EmailService emailService,
        IConfiguration configuration)
    {
        _logger = logger;
        _passwordService = passwordService;
        _emailService = emailService;
        _connectionString = configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING is not configured");
    }

    /// <summary>
    /// Request a password reset - generates token and sends email
    /// </summary>
    [Function("RequestPasswordReset")]
    public async Task<HttpResponseData> RequestPasswordReset(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "password/reset/request")] HttpRequestData req)
    {
        _logger.LogInformation("RequestPasswordReset function processing request");

        try
        {
            var requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var resetRequest = JsonSerializer.Deserialize<PasswordResetRequest>(requestBody, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            if (resetRequest == null || string.IsNullOrWhiteSpace(resetRequest.Email))
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Email is required" });
                return badRequestResponse;
            }

            // Look up user by email
            var userInfo = await GetUserByEmailAsync(resetRequest.Email);

            if (userInfo == null)
            {
                // For security, don't reveal if email exists - always return success
                _logger.LogWarning($"Password reset requested for non-existent email: {resetRequest.Email}");
                var response = req.CreateResponse(HttpStatusCode.OK);
                await response.WriteAsJsonAsync(new { message = "If this email exists, a password reset link has been sent." });
                return response;
            }

            // Generate reset token (valid for 1 hour)
            var token = GenerateResetToken();
            var expiry = DateTime.UtcNow.AddHours(1);

            // Store token in database (using PasswordSalt field temporarily)
            await StoreResetTokenAsync(userInfo.BusinessEntityID, token, expiry);

            // Build reset URL - use the request origin to determine frontend URL
            var baseUrl = GetFrontendUrl(req);
            var resetUrl = $"{baseUrl}/reset-password?token={token}&id={userInfo.BusinessEntityID}";

            // Send email with reset link
            await SendPasswordResetEmailAsync(userInfo.Email, userInfo.FirstName, resetUrl, userInfo.BusinessEntityID);

            _logger.LogInformation($"Password reset email sent to {userInfo.Email}");

            var successResponse = req.CreateResponse(HttpStatusCode.OK);
            await successResponse.WriteAsJsonAsync(new
            {
                message = "If this email exists, a password reset link has been sent.",
                // For development/demo purposes, include the token (remove in production)
                debug = new { token, resetUrl }
            });
            return successResponse;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing password reset request");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred processing your request" });
            return errorResponse;
        }
    }

    /// <summary>
    /// Validate a password reset token
    /// </summary>
    [Function("ValidateResetToken")]
    public async Task<HttpResponseData> ValidateResetToken(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "password/reset/validate")] HttpRequestData req)
    {
        _logger.LogInformation("ValidateResetToken function processing request");

        try
        {
            var requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var validateRequest = JsonSerializer.Deserialize<ValidateTokenRequest>(requestBody, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            if (validateRequest == null || string.IsNullOrWhiteSpace(validateRequest.Token) || validateRequest.BusinessEntityID <= 0)
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Token and BusinessEntityID are required" });
                return badRequestResponse;
            }

            var isValid = await ValidateTokenAsync(validateRequest.BusinessEntityID, validateRequest.Token);

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new { isValid = isValid });
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
    /// Reset password using valid token
    /// </summary>
    [Function("ResetPassword")]
    public async Task<HttpResponseData> ResetPassword(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "password/reset/complete")] HttpRequestData req)
    {
        _logger.LogInformation("ResetPassword function processing request");

        try
        {
            var requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var resetRequest = JsonSerializer.Deserialize<CompleteResetRequest>(requestBody, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            if (resetRequest == null || string.IsNullOrWhiteSpace(resetRequest.Token) ||
                resetRequest.BusinessEntityID <= 0 || string.IsNullOrWhiteSpace(resetRequest.NewPassword))
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Token, BusinessEntityID, and NewPassword are required" });
                return badRequestResponse;
            }

            // Validate password length
            if (resetRequest.NewPassword.Length < 8)
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Password must be at least 8 characters long" });
                return badRequestResponse;
            }

            // Validate token
            var isValid = await ValidateTokenAsync(resetRequest.BusinessEntityID, resetRequest.Token);
            if (!isValid)
            {
                var unauthorizedResponse = req.CreateResponse(HttpStatusCode.Unauthorized);
                await unauthorizedResponse.WriteAsJsonAsync(new { error = "Invalid or expired reset token" });
                return unauthorizedResponse;
            }

            // Update password (this will overwrite the PasswordSalt with the real salt, clearing the token)
            var success = await _passwordService.StorePasswordAsync(resetRequest.BusinessEntityID, resetRequest.NewPassword);

            if (!success)
            {
                var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
                await errorResponse.WriteAsJsonAsync(new { error = "Failed to update password" });
                return errorResponse;
            }

            // No need to call ClearResetTokenAsync - StorePasswordAsync already overwrites PasswordSalt

            _logger.LogInformation($"Password successfully reset for BusinessEntityID {resetRequest.BusinessEntityID}");

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

    // Helper methods

    private string GetFrontendUrl(HttpRequestData req)
    {
        // Try to get the origin from the request headers
        if (req.Headers.TryGetValues("Origin", out var origins))
        {
            var origin = origins.FirstOrDefault();
            if (!string.IsNullOrEmpty(origin))
            {
                return origin;
            }
        }

        // Fallback to Referer header
        if (req.Headers.TryGetValues("Referer", out var referers))
        {
            var referer = referers.FirstOrDefault();
            if (!string.IsNullOrEmpty(referer) && Uri.TryCreate(referer, UriKind.Absolute, out var uri))
            {
                return $"{uri.Scheme}://{uri.Authority}";
            }
        }

        // Last resort: check environment variable or localhost
        return Environment.GetEnvironmentVariable("FRONTEND_URL") ?? "http://localhost:5173";
    }

    private string GenerateResetToken()
    {
        // Generate 8-character alphanumeric token to fit in PasswordSalt varchar(10)
        const string chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Excludes ambiguous chars
        var tokenBytes = new byte[8];
        using (var rng = RandomNumberGenerator.Create())
        {
            rng.GetBytes(tokenBytes);
        }
        return new string(tokenBytes.Select(b => chars[b % chars.Length]).ToArray());
    }

    private async Task<UserInfo?> GetUserByEmailAsync(string email)
    {
        using var connection = new Microsoft.Data.SqlClient.SqlConnection(_connectionString);
        await connection.OpenAsync();

        var sql = @"
            SELECT 
                p.BusinessEntityID,
                p.FirstName,
                p.LastName,
                ea.EmailAddress as Email
            FROM Person.Person p
            INNER JOIN Person.EmailAddress ea ON p.BusinessEntityID = ea.BusinessEntityID
            WHERE ea.EmailAddress = @Email";

        using var command = new Microsoft.Data.SqlClient.SqlCommand(sql, connection);
        command.Parameters.AddWithValue("@Email", email);

        using var reader = await command.ExecuteReaderAsync();
        if (await reader.ReadAsync())
        {
            return new UserInfo
            {
                BusinessEntityID = reader.GetInt32(0),
                FirstName = reader.GetString(1),
                LastName = reader.GetString(2),
                Email = reader.GetString(3)
            };
        }

        return null;
    }

    private async Task StoreResetTokenAsync(int businessEntityId, string token, DateTime expiry)
    {
        using var connection = new Microsoft.Data.SqlClient.SqlConnection(_connectionString);
        await connection.OpenAsync();

        // Store token directly in PasswordSalt (8 chars fits in varchar(10))
        // Use ModifiedDate to track when token was created for expiry validation
        // Use MERGE to handle cases where Password record doesn't exist yet
        var sql = @"
            MERGE Person.Password AS target
            USING (SELECT @BusinessEntityID AS BusinessEntityID) AS source
            ON (target.BusinessEntityID = source.BusinessEntityID)
            WHEN MATCHED THEN
                UPDATE SET 
                    PasswordSalt = @Token,
                    ModifiedDate = GETUTCDATE()
            WHEN NOT MATCHED THEN
                INSERT (BusinessEntityID, PasswordHash, PasswordSalt, rowguid, ModifiedDate)
                VALUES (@BusinessEntityID, '', @Token, NEWID(), GETUTCDATE());";

        using var command = new Microsoft.Data.SqlClient.SqlCommand(sql, connection);
        command.Parameters.AddWithValue("@BusinessEntityID", businessEntityId);
        command.Parameters.AddWithValue("@Token", token);

        await command.ExecuteNonQueryAsync();
    }

    private async Task<bool> ValidateTokenAsync(int businessEntityId, string token)
    {
        using var connection = new Microsoft.Data.SqlClient.SqlConnection(_connectionString);
        await connection.OpenAsync();

        var sql = "SELECT PasswordSalt, ModifiedDate FROM Person.Password WHERE BusinessEntityID = @BusinessEntityID";

        using var command = new Microsoft.Data.SqlClient.SqlCommand(sql, connection);
        command.Parameters.AddWithValue("@BusinessEntityID", businessEntityId);

        using var reader = await command.ExecuteReaderAsync();
        if (!await reader.ReadAsync())
        {
            return false;
        }

        var storedToken = reader.GetString(0);
        var modifiedDate = reader.GetDateTime(1);

        // Check if token matches
        if (storedToken != token)
        {
            return false;
        }

        // Check expiry (1 hour from ModifiedDate)
        // SQL Server returns DateTime with Kind=Unspecified, so specify it's UTC
        var modifiedDateUtc = DateTime.SpecifyKind(modifiedDate, DateTimeKind.Utc);
        var expiry = modifiedDateUtc.AddHours(1);
        if (DateTime.UtcNow > expiry)
        {
            return false;
        }

        return true;
    }

    private async Task ClearResetTokenAsync(int businessEntityId)
    {
        using var connection = new Microsoft.Data.SqlClient.SqlConnection(_connectionString);
        await connection.OpenAsync();

        // Clear the token data - set back to a proper salt value
        var sql = @"
            UPDATE Person.Password 
            SET PasswordSalt = '',
                ModifiedDate = GETUTCDATE()
            WHERE BusinessEntityID = @BusinessEntityID";

        using var command = new Microsoft.Data.SqlClient.SqlCommand(sql, connection);
        command.Parameters.AddWithValue("@BusinessEntityID", businessEntityId);

        await command.ExecuteNonQueryAsync();
    }

    private async Task SendPasswordResetEmailAsync(string email, string firstName, string resetUrl, int businessEntityId)
    {
        const string PRIMARY_COLOR = "#FF5E5B";
        const string ACCENT_COLOR = "#4a7c59";
        const string BACKGROUND_COLOR = "#FDF7F1";
        const string TEXT_COLOR = "#3c3c3c";
        const string BORDER_COLOR = "#3c3c3c";

        var htmlContent = $@"
<!DOCTYPE html>
<html lang=""en"">
<head>
    <meta charset=""UTF-8"">
    <meta name=""viewport"" content=""width=device-width, initial-scale=1.0"">
    <link href=""https://fonts.googleapis.com/css2?family=Short+Stack&display=swap"" rel=""stylesheet"">
    <title>Password Reset - AdventureWorks</title>
</head>
<body style=""
    margin: 0;
    padding: 0;
    font-family: 'Short Stack', cursive, Arial, sans-serif;
    background-color: {BACKGROUND_COLOR};
    color: {TEXT_COLOR};
"">
    <table role=""presentation"" width=""100%"" cellspacing=""0"" cellpadding=""0"" border=""0"" style=""background-color: {BACKGROUND_COLOR};"">
        <tr>
            <td align=""center"" style=""padding: 40px 20px;"">
                <table role=""presentation"" width=""600"" cellspacing=""0"" cellpadding=""0"" border=""0"" style=""
                    max-width: 600px;
                    background: white;
                    border: 3px solid {BORDER_COLOR};
                    box-shadow: 4px 4px 0 {BORDER_COLOR};
                "">
                    <!-- Header -->
                    <tr>
                        <td style=""
                            background-color: {PRIMARY_COLOR};
                            padding: 30px 40px;
                            text-align: center;
                            border-bottom: 3px solid {BORDER_COLOR};
                        "">
                            <table role=""presentation"" width=""100%"" cellspacing=""0"" cellpadding=""0"" border=""0"">
                                <tr>
                                    <td align=""center"">
                                        <div style=""display: inline-flex; align-items: center; gap: 12px;"">
                                            <span style=""font-size: 32px;"">🚴</span>
                                            <h1 style=""
                                                margin: 0;
                                                font-size: 32px;
                                                color: white;
                                                font-weight: bold;
                                                letter-spacing: -0.5px;
                                            "">
                                                Adventure<span style=""color: {ACCENT_COLOR};"">Works</span>
                                            </h1>
                                        </div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Greeting -->
                    <tr>
                        <td style=""padding: 40px 40px 20px 40px;"">
                            <h2 style=""
                                margin: 0 0 10px 0;
                                font-size: 24px;
                                color: {ACCENT_COLOR};
                                font-weight: bold;
                            "">
                                Hey {System.Net.WebUtility.HtmlEncode(firstName)}! 👋
                            </h2>
                        </td>
                    </tr>

                    <!-- Body Content -->
                    <tr>
                        <td style=""
                            padding: 0 40px 30px 40px;
                            font-size: 16px;
                            line-height: 1.6;
                        "">
                            <p style=""margin: 0 0 16px 0;"">
                                We received a request to reset your password. If you didn't make this request, you can safely ignore this email.
                            </p>
                            <p style=""margin: 0 0 16px 0;"">
                                To reset your password, click the button below. This link will expire in <strong>1 hour</strong>.
                            </p>
                        </td>
                    </tr>

                    <!-- Button -->
                    <tr>
                        <td style=""padding: 0 40px 40px 40px; text-align: center;"">
                            <a href=""{resetUrl}"" style=""
                                display: inline-block;
                                padding: 16px 40px;
                                background-color: {ACCENT_COLOR};
                                color: white;
                                text-decoration: none;
                                font-size: 18px;
                                font-weight: bold;
                                border: 3px solid {BORDER_COLOR};
                                box-shadow: 3px 3px 0 {BORDER_COLOR};
                                transition: all 0.2s;
                            "">
                                Reset My Password 🔑
                            </a>
                        </td>
                    </tr>

                    <!-- Alternative Link -->
                    <tr>
                        <td style=""
                            padding: 0 40px 40px 40px;
                            font-size: 14px;
                            color: {TEXT_COLOR};
                            opacity: 0.8;
                        "">
                            <p style=""margin: 0 0 8px 0;"">
                                If the button doesn't work, copy and paste this link into your browser:
                            </p>
                            <p style=""
                                margin: 0;
                                word-break: break-all;
                                color: {ACCENT_COLOR};
                            "">
                                {resetUrl}
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style=""
                            background-color: {BACKGROUND_COLOR};
                            border-top: 3px solid {BORDER_COLOR};
                            padding: 30px 40px;
                            text-align: center;
                        "">
                            <p style=""
                                margin: 0 0 15px 0;
                                font-size: 18px;
                                font-weight: bold;
                                color: {PRIMARY_COLOR};
                            "">
                                Stay secure on your adventures! 🚴
                            </p>
                            <p style=""
                                margin: 0 0 20px 0;
                                font-size: 14px;
                                color: {TEXT_COLOR};
                                opacity: 0.8;
                            "">
                                This link expires in 1 hour for your security.
                            </p>
                            <div style=""
                                border-top: 2px dashed {BORDER_COLOR};
                                padding-top: 20px;
                                margin-top: 20px;
                            "">
                                <p style=""margin: 0 0 5px 0; font-size: 13px; color: {TEXT_COLOR};"">
                                    <strong>AdventureWorks</strong>
                                </p>
                                <p style=""margin: 0 0 3px 0; font-size: 12px; color: {TEXT_COLOR}; opacity: 0.7;"">
                                    1 Adventure Way, Bothell, WA 98011
                                </p>
                                <p style=""margin: 0 0 3px 0; font-size: 12px; color: {TEXT_COLOR}; opacity: 0.7;"">
                                    (555) 123-4567
                                </p>
                                <p style=""margin: 0; font-size: 12px;"">
                                    <a href=""mailto:hello@adventureworks.com"" style=""
                                        color: {ACCENT_COLOR};
                                        text-decoration: none;
                                        font-weight: bold;
                                    "">hello@adventureworks.com</a>
                                </p>
                            </div>
                        </td>
                    </tr>
                </table>

                <!-- Disclaimer -->
                <table role=""presentation"" width=""600"" cellspacing=""0"" cellpadding=""0"" border=""0"" style=""max-width: 600px; margin-top: 20px;"">
                    <tr>
                        <td style=""
                            padding: 20px;
                            text-align: center;
                            font-size: 11px;
                            color: {TEXT_COLOR};
                            opacity: 0.6;
                        "">
                            You're receiving this email because you requested a password reset for your AdventureWorks account.
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>";

        await _emailService.SendEmailDirectAsync(
            email,
            "Password Reset Request - AdventureWorks",
            htmlContent
        );
    }

    private class UserInfo
    {
        public int BusinessEntityID { get; set; }
        public string FirstName { get; set; } = string.Empty;
        public string LastName { get; set; } = string.Empty;
        public string Email { get; set; } = string.Empty;
    }
}

public class PasswordResetRequest
{
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
