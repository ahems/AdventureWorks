using api_functions.Models;
using api_functions.Services;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ApiFunctions.Tests;

public class AIServiceImageDeploymentTests
{
    private static AIService Create(string? imageDeploymentName) =>
        new("https://foundry.example.invalid/", NullLogger<AIService>.Instance,
            new TelemetryClient(new TelemetryConfiguration { DisableTelemetry = true }), imageDeploymentName);

    [Fact]
    public void Uses_the_configured_image_deployment_name()
    {
        Assert.Equal("gpt-image-2", Create(" gpt-image-2 ").ImageDeploymentName);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public async Task Image_generation_is_unavailable_without_a_configured_deployment(string? configured)
    {
        var service = Create(configured);

        Assert.Null(service.ImageDeploymentName);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.GenerateProductImagesAsync(new List<ProductImageData>()));
        Assert.Contains("AI_IMAGE_DEPLOYMENT_NAME", error.Message);
    }
}
