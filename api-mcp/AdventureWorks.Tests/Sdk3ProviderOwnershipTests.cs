using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Xunit;

namespace AdventureWorks.Tests;

public class Sdk3ProviderOwnershipTests
{
    [Fact]
    public async Task Real_host_exports_one_sanitized_entry_with_one_provider_per_signal()
    {
        var capture = new Activities();
        using var factory = new OAuthTestFactory();
        using var configured = factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
            services.ConfigureOpenTelemetryTracerProvider(tracing => tracing.SetSampler(new AlwaysOnSampler())
                .AddProcessor(new SimpleActivityExportProcessor(capture)))));
        using var client = configured.CreateClient();
        using var response = await client.GetAsync("/telemetry-fixture?code=private-marker");
        for (var attempt = 0; attempt < 100 && !capture.Items.Any(activity => activity.Kind == ActivityKind.Server); attempt++)
            await Task.Delay(10);

        var provider = Assert.Single(configured.Services.GetServices<TracerProvider>());
        Assert.Single(configured.Services.GetServices<MeterProvider>());
        Assert.Single(configured.Services.GetServices<ILoggerProvider>().OfType<OpenTelemetryLoggerProvider>());
        Assert.Equal("api-mcp", provider.GetResource().Attributes.Single(attribute => attribute.Key == "service.name").Value);
        var entry = Assert.Single(capture.Items, activity => activity.Kind == ActivityKind.Server);
        Assert.DoesNotContain("private-marker", string.Join("|", entry.TagObjects.Select(tag => tag.Value)));
        Assert.DoesNotContain(capture.Items, activity => activity.Kind == ActivityKind.Server &&
            activity.DisplayName.StartsWith("MCP_", StringComparison.Ordinal));
    }

    private sealed class Activities : BaseExporter<Activity>
    {
        public ConcurrentQueue<Activity> Items { get; } = new();
        public override ExportResult Export(in Batch<Activity> batch)
        {
            foreach (var activity in batch) Items.Enqueue(activity);
            return ExportResult.Success;
        }
    }
}
