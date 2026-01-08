using Microsoft.Data.SqlClient;
using Dapper;
using Azure.Core;
using Azure.Identity;
using Azure.Communication.Email;
using Azure.Storage.Blobs;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using System.Net.Mime;

namespace api_functions.Services;

public class EmailService
{
    private readonly string _connectionString;
    private readonly string _communicationServiceEndpoint;
    private readonly string _senderDomain;
    private readonly DefaultAzureCredential _credential;
    private readonly string? _storageAccountName;
    private readonly ILogger<EmailService> _logger;

    public EmailService(
        string connectionString,
        string communicationServiceEndpoint,
        string senderDomain,
        string? storageAccountName,
        ILogger<EmailService> logger)
    {
        _connectionString = connectionString;
        _communicationServiceEndpoint = communicationServiceEndpoint;
        _senderDomain = senderDomain;
        _storageAccountName = storageAccountName;
        _logger = logger;
        _credential = new DefaultAzureCredential();
    }

    /// <summary>
    /// Creates a SQL connection with managed identity authentication
    /// </summary>
    private async Task<SqlConnection> CreateConnectionAsync()
    {
        var connection = new SqlConnection(_connectionString);
        var token = await _credential.GetTokenAsync(
            new TokenRequestContext(new[] { "https://database.windows.net/.default" }));
        connection.AccessToken = token.Token;
        await connection.OpenAsync();
        return connection;
    }

    /// <summary>
    /// Get customer information including name and email address
    /// </summary>
    private async Task<(string FirstName, string LastName)?> GetCustomerInfoAsync(int customerId)
    {
        using var connection = await CreateConnectionAsync();

        var sql = @"
            SELECT 
                p.FirstName,
                p.LastName
            FROM Sales.Customer c
            INNER JOIN Person.Person p ON c.PersonID = p.BusinessEntityID
            WHERE c.CustomerID = @CustomerId";

        return await connection.QuerySingleOrDefaultAsync<(string FirstName, string LastName)>(
            sql, new { CustomerId = customerId });
    }

    /// <summary>
    /// Get and validate email address by ID for the given customer
    /// </summary>
    private async Task<string?> GetValidatedEmailAddressAsync(int customerId, int emailAddressId)
    {
        using var connection = await CreateConnectionAsync();

        var sql = @"
            SELECT ea.EmailAddress
            FROM Sales.Customer c
            INNER JOIN Person.EmailAddress ea ON c.PersonID = ea.BusinessEntityID
            WHERE c.CustomerID = @CustomerId AND ea.EmailAddressID = @EmailAddressId";

        return await connection.QuerySingleOrDefaultAsync<string>(
            sql, new { CustomerId = customerId, EmailAddressId = emailAddressId });
    }

    /// <summary>
    /// Generate HTML email content with DoodleCSS styling
    /// </summary>
    private string GenerateHtmlContent(string subject, string bodyText, string firstName)
    {
        // DoodleCSS Theme Colors (matching PDF and website)
        const string PRIMARY_COLOR = "#FF5E5B";      // Adventure orange/rust
        const string ACCENT_COLOR = "#4a7c59";       // Forest green
        const string BACKGROUND_COLOR = "#FDF7F1";   // Warm cream
        const string TEXT_COLOR = "#3c3c3c";         // Dark gray
        const string BORDER_COLOR = "#3c3c3c";       // Dark border

        // Format the body text as HTML paragraphs
        var paragraphs = bodyText.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => $"<p style=\"margin: 0 0 16px 0; line-height: 1.6;\">{System.Net.WebUtility.HtmlEncode(p)}</p>")
            .ToArray();
        var htmlBody = string.Join("", paragraphs);

        return $@"
<!DOCTYPE html>
<html lang=""en"">
<head>
    <meta charset=""UTF-8"">
    <meta name=""viewport"" content=""width=device-width, initial-scale=1.0"">
    <link href=""https://fonts.googleapis.com/css2?family=Short+Stack&display=swap"" rel=""stylesheet"">
    <title>{System.Net.WebUtility.HtmlEncode(subject)}</title>
</head>
<body style=""
    margin: 0;
    padding: 0;
    font-family: 'Short Stack', cursive, Arial, sans-serif;
    background-color: {BACKGROUND_COLOR};
    color: {TEXT_COLOR};
    -webkit-font-smoothing: antialiased;
"">
    <table role=""presentation"" width=""100%"" cellspacing=""0"" cellpadding=""0"" border=""0"" style=""background-color: {BACKGROUND_COLOR};"">
        <tr>
            <td align=""center"" style=""padding: 40px 20px;"">
                <!-- Main Container -->
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
                            <h1 style=""
                                margin: 0;
                                font-size: 32px;
                                color: white;
                                font-weight: bold;
                                letter-spacing: -0.5px;
                            "">
                                Adventure<span style=""color: {ACCENT_COLOR};"">Works</span>
                            </h1>
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
                            padding: 0 40px 40px 40px;
                            font-size: 16px;
                            line-height: 1.6;
                            color: {TEXT_COLOR};
                        "">
                            {htmlBody}
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
                                Thank you for being part of our adventure! 🚴
                            </p>
                            <p style=""
                                margin: 0 0 20px 0;
                                font-size: 14px;
                                color: {TEXT_COLOR};
                                opacity: 0.8;
                            "">
                                Adventure awaits around every corner!
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
                            You're receiving this email because you're an AdventureWorks customer.
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>";
    }

    /// <summary>
    /// Download a blob attachment from storage using managed identity
    /// </summary>
    private async Task<(byte[] Content, string FileName)?> DownloadAttachmentAsync(string blobUrl)
    {
        try
        {
            if (string.IsNullOrEmpty(_storageAccountName))
            {
                _logger.LogError("Cannot download attachment: Storage account name not configured. Set AzureWebJobsStorage__accountName environment variable.");
                return null;
            }

            // Create BlobServiceClient lazily when needed
            var blobServiceUri = new Uri($"https://{_storageAccountName}.blob.core.windows.net");
            var blobServiceClient = new BlobServiceClient(blobServiceUri, _credential);

            var uri = new Uri(blobUrl);

            // Extract container and blob name from URL
            // Format: https://{account}.blob.core.windows.net/{container}/{blobName}
            var segments = uri.AbsolutePath.TrimStart('/').Split('/', 2);
            if (segments.Length != 2)
            {
                _logger.LogWarning("Invalid blob URL format: {BlobUrl}", blobUrl);
                return null;
            }

            var containerName = segments[0];
            var blobName = segments[1];

            var containerClient = blobServiceClient.GetBlobContainerClient(containerName);
            var blobClient = containerClient.GetBlobClient(blobName);

            // Download the blob content
            using var memoryStream = new MemoryStream();
            await blobClient.DownloadToAsync(memoryStream);

            return (memoryStream.ToArray(), Path.GetFileName(blobName));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error downloading attachment from {BlobUrl}", blobUrl);
            return null;
        }
    }

    /// <summary>
    /// Send an email to a customer with optional attachment
    /// Fire-and-forget operation
    /// </summary>
    public async Task<bool> SendCustomerEmailAsync(
        int customerId,
        int emailAddressId,
        string subject,
        string emailContent,
        string? attachmentUrl = null)
    {
        try
        {
            // Get and validate email address belongs to customer
            var emailAddress = await GetValidatedEmailAddressAsync(customerId, emailAddressId);
            if (string.IsNullOrEmpty(emailAddress))
            {
                _logger.LogWarning(
                    "EmailAddressID {EmailAddressId} does not belong to customer {CustomerId} or does not exist",
                    emailAddressId, customerId);
                return false;
            }

            // Get customer name
            var customerInfo = await GetCustomerInfoAsync(customerId);
            if (customerInfo == null)
            {
                _logger.LogWarning("Customer {CustomerId} not found", customerId);
                return false;
            }

            // Create Email Client with managed identity
            var emailClient = new EmailClient(new Uri(_communicationServiceEndpoint), _credential);

            // Build HTML email content with DoodleCSS styling
            var htmlContent = GenerateHtmlContent(subject, emailContent, customerInfo.Value.FirstName);

            // Build email content
            var emailContentBuilder = new EmailContent(subject)
            {
                PlainText = emailContent,
                Html = htmlContent
            };

            // Create email message
            var emailMessage = new EmailMessage(
                senderAddress: $"DoNotReply@{_senderDomain}",
                recipientAddress: emailAddress,
                content: emailContentBuilder);

            // Add attachment if provided
            if (!string.IsNullOrEmpty(attachmentUrl))
            {
                var attachment = await DownloadAttachmentAsync(attachmentUrl);
                if (attachment.HasValue)
                {
                    var emailAttachment = new EmailAttachment(
                        attachment.Value.FileName,
                        MediaTypeNames.Application.Octet,
                        new BinaryData(attachment.Value.Content));

                    emailMessage.Attachments.Add(emailAttachment);

                    _logger.LogInformation(
                        "Added attachment {FileName} to email for customer {CustomerId}",
                        attachment.Value.FileName, customerId);
                }
            }

            // Send email (fire and forget - don't wait for delivery)
            var emailSendOperation = await emailClient.SendAsync(
                Azure.WaitUntil.Started,
                emailMessage);

            _logger.LogInformation(
                "Email sent to customer {CustomerId} ({FirstName} {LastName}) at {EmailAddress}. Message ID: {MessageId}",
                customerId,
                customerInfo.Value.FirstName,
                customerInfo.Value.LastName,
                emailAddress,
                emailSendOperation.Id);

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex,
                "Error sending email to customer {CustomerId} with EmailAddressId {EmailAddressId}",
                customerId, emailAddressId);
            return false;
        }
    }
}
