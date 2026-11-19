using api_functions.Services;
using Azure.Communication.Email;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace api_functions.Tests;

public class EmailRecipientPolicyTests
{
    [Theory]
    [InlineData("auth-run-a@example.invalid")]
    [InlineData("someone@mail.TEST")]
    [InlineData("someone@example")]
    [InlineData("someone@host.localhost.")]
    [InlineData("someone@example.com")]
    [InlineData("someone@sub.example.org")]
    [InlineData("  someone@example.net  ")]
    public void ReservedDomainsAreNonDeliverable(string address) =>
        Assert.True(EmailRecipientPolicy.IsReservedNonDeliverable(address));

    [Theory]
    [InlineData("customer@adventure-works.com")]
    [InlineData("someone@notexample.com")]
    [InlineData("someone@example.com.au")]
    [InlineData("someone@invalid.org")]
    [InlineData("not-an-address")]
    [InlineData("")]
    [InlineData(null)]
    public void OtherAddressesAreNotSuppressed(string? address) =>
        Assert.False(EmailRecipientPolicy.IsReservedNonDeliverable(address));

    [Fact]
    public async Task DirectSendToReservedRecipientNeverCreatesAcsClient()
    {
        var service = new CountingEmailService();

        Assert.False(await service.SendEmailDirectAsync("fixture@example.invalid", "Subject", "<p>x</p>"));
        Assert.Equal(0, service.ClientsCreated);

        Assert.False(await service.SendEmailDirectAsync("customer@adventure-works.com", "Subject", "<p>x</p>"));
        Assert.Equal(1, service.ClientsCreated);
    }

    private sealed class CountingEmailService() : EmailService(
        "unused", "https://email.example.invalid", "example.invalid", null, NullLogger<EmailService>.Instance)
    {
        public int ClientsCreated { get; private set; }

        protected override EmailClient CreateEmailClient()
        {
            ClientsCreated++;
            throw new InvalidOperationException("Test transport refuses to send.");
        }
    }
}
