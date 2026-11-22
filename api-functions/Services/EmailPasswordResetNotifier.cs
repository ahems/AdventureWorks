using api_functions.Services;

namespace AddressFunctions.Services;

/// <summary>
/// Sends the storefront password-reset email through Azure Communication Services.
/// Reserved non-deliverable test domains are suppressed by <see cref="EmailService"/>.
/// </summary>
public sealed class EmailPasswordResetNotifier : IPasswordResetNotifier
{
    private readonly EmailService _emailService;

    public EmailPasswordResetNotifier(EmailService emailService)
    {
        _emailService = emailService;
    }

    public Task<bool> SendAsync(string email, string firstName, string resetUrl) =>
        _emailService.SendEmailDirectAsync(
            email,
            "Password Reset Request - AdventureWorks",
            BuildHtml(firstName, resetUrl));

    public static string BuildHtml(string firstName, string resetUrl)
    {
        var encodedUrl = System.Net.WebUtility.HtmlEncode(resetUrl);
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
                            <a href=""{encodedUrl}"" style=""
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
                                {encodedUrl}
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

        return htmlContent;
    }
}
