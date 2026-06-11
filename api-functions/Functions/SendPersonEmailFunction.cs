using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using System.Net;
using System.Text.Json;

namespace api_functions.Functions;

public class SendPersonEmailFunction
{
    private readonly ILogger<SendPersonEmailFunction> _logger;
    private readonly EmailService _emailService;

    public SendPersonEmailFunction(ILogger<SendPersonEmailFunction> logger, EmailService emailService)
    {
        _logger = logger;
        _emailService = emailService;
    }

    /// <summary>
    /// Send a personalized email to an admin-facing person (Person.Person) by BusinessEntityID.
    /// Used by the admin bulk-email campaign feature.
    /// </summary>
    [Function("SendPersonEmail")]
    public async Task<HttpResponseData> SendPersonEmail(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "persons/{personId:int}/send-email")]
        HttpRequestData req,
        int personId)
    {
        _logger.LogInformation("SendPersonEmail triggered for person {PersonId}", personId);

        try
        {
            var requestBody = await new StreamReader(req.Body).ReadToEndAsync();
            var emailRequest = JsonSerializer.Deserialize<SendPersonEmailRequest>(requestBody, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            if (emailRequest == null
                || string.IsNullOrWhiteSpace(emailRequest.Subject)
                || string.IsNullOrWhiteSpace(emailRequest.Content))
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { error = "Subject and Content are required" });
                return bad;
            }

            var success = await _emailService.SendPersonEmailByIdAsync(
                personId,
                emailRequest.Subject,
                emailRequest.Content);

            if (!success)
            {
                var bad = req.CreateResponse(HttpStatusCode.BadRequest);
                await bad.WriteAsJsonAsync(new { error = "Failed to send email. No email address found for this person." });
                return bad;
            }

            var ok = req.CreateResponse(HttpStatusCode.OK);
            await ok.WriteAsJsonAsync(new { message = "Email sent successfully", personId });
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error sending email to person {PersonId}", personId);
            var err = req.CreateResponse(HttpStatusCode.InternalServerError);
            await err.WriteAsJsonAsync(new { error = "An error occurred while sending the email" });
            return err;
        }
    }
}

public class SendPersonEmailRequest
{
    public string Subject { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
}
