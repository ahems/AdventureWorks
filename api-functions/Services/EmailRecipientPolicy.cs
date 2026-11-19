using System.Net.Mail;

namespace api_functions.Services;

/// <summary>
/// Recipient rules applied at the final Azure Communication Services send boundary.
/// Domains reserved by RFC 2606 / RFC 6761 can never receive mail, so sending to them only
/// produces bounces. Assurance fixtures use these domains, which keeps every delayed, retried or
/// queue-driven message for a test identity suppressed without any test-specific state.
/// </summary>
public static class EmailRecipientPolicy
{
    private static readonly string[] ReservedTopLevelDomains = ["invalid", "test", "example", "localhost"];
    private static readonly string[] ReservedSecondLevelDomains = ["example.com", "example.net", "example.org"];

    public static bool IsReservedNonDeliverable(string? emailAddress)
    {
        if (string.IsNullOrWhiteSpace(emailAddress))
            return false;

        string host;
        try
        {
            host = new MailAddress(emailAddress.Trim()).Host.TrimEnd('.').ToLowerInvariant();
        }
        catch (FormatException)
        {
            return false;
        }

        var labels = host.Split('.');
        if (ReservedTopLevelDomains.Contains(labels[^1]))
            return true;
        return ReservedSecondLevelDomains.Any(domain => host == domain || host.EndsWith("." + domain, StringComparison.Ordinal));
    }
}
