using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using System.Net;
using System.Text.Json;

namespace api_functions.Functions;

public class SendEmailFunction
{
    private readonly ILogger<SendEmailFunction> _logger;
    private readonly EmailService _emailService;

    public SendEmailFunction(ILogger<SendEmailFunction> logger, EmailService emailService)
    {
        _logger = logger;
        _emailService = emailService;
    }

    /// <summary>
    /// Send an email to a customer via Azure Communication Services
    /// </summary>
    /// <param name="req">HTTP request with email details in body</param>
    /// <param name="customerId">The customer ID from the route</param>
    /// <returns>Success/failure response</returns>
    /// <response code="200">Email sent successfully</response>
    /// <response code="400">Invalid request or email address doesn't belong to customer</response>
    /// <response code="500">Internal server error</response>
    [Function("SendCustomerEmail")]
    public async Task<HttpResponseData> SendCustomerEmail(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "customers/{customerId:int}/send-email")]
        HttpRequestData req,
        int customerId)
    {
        _logger.LogInformation("SendCustomerEmail function processing request for customer {CustomerId}", customerId);

        try
        {
            // Parse request body
            var requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var emailRequest = JsonSerializer.Deserialize<SendEmailRequest>(requestBody, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            if (emailRequest == null)
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Invalid request body" });
                return badRequestResponse;
            }

            // Validate required fields
            if (emailRequest.EmailAddressId <= 0)
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "EmailAddressId is required and must be greater than 0" });
                return badRequestResponse;
            }

            if (string.IsNullOrWhiteSpace(emailRequest.Subject))
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Subject is required" });
                return badRequestResponse;
            }

            if (string.IsNullOrWhiteSpace(emailRequest.Content))
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new { error = "Content is required" });
                return badRequestResponse;
            }

            // Send email (fire and forget)
            var success = await _emailService.SendCustomerEmailAsync(
                customerId,
                emailRequest.EmailAddressId,
                emailRequest.Subject,
                emailRequest.Content,
                emailRequest.AttachmentUrl);

            if (!success)
            {
                var badRequestResponse = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequestResponse.WriteAsJsonAsync(new
                {
                    error = "Failed to send email. EmailAddressId may not belong to this customer or customer not found."
                });
                return badRequestResponse;
            }

            // Return success response
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new
            {
                message = "Email sent successfully",
                customerId = customerId,
                emailAddressId = emailRequest.EmailAddressId
            });
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error sending email to customer {CustomerId}", customerId);
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while sending the email" });
            return errorResponse;
        }
    }
}

/// <summary>
/// Request model for sending emails to customers
/// </summary>
public class SendEmailRequest
{
    /// <summary>
    /// The EmailAddressID from Person.EmailAddress table (must belong to the customer)
    /// </summary>
    public int EmailAddressId { get; set; }

    /// <summary>
    /// Email subject line
    /// </summary>
    public string Subject { get; set; } = string.Empty;

    /// <summary>
    /// Plain text email content
    /// </summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>
    /// Optional: URL to attachment in Azure Storage (e.g., receipt PDF)
    /// </summary>
    public string? AttachmentUrl { get; set; }
}
