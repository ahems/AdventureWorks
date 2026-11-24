using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using AdventureWorks.Telemetry;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using Xunit;

namespace AdventureWorks.Tests;

public class ExporterDiagnosticsTests
{
    [Fact]
    public void Unsubscribed_meters_are_not_reported_but_invalid_instruments_are()
    {
        var subscribed = $"Aw.Diag.Subscribed.{Guid.NewGuid():N}";
        var logger = new CapturingLogger();
        using var diagnostics = new ExporterDiagnostics(logger);
        using var provider = Sdk.CreateMeterProviderBuilder()
            .AddMeter(subscribed)
            .AddReader(new PeriodicExportingMetricReader(new NoOpExporter()))
            .Build();

        using (var unsubscribed = new Meter($"Aw.Diag.Unsubscribed.{Guid.NewGuid():N}"))
            unsubscribed.CreateCounter<long>("benign.counter");
        Assert.DoesNotContain(logger.Messages, m => m.Contains("Aw.Diag.Unsubscribed", StringComparison.Ordinal));

        using (var meter = new Meter(subscribed))
            meter.CreateCounter<long>("1-invalid name");
        Assert.Contains(logger.Messages, m =>
            m.Contains("event 33", StringComparison.Ordinal) &&
            m.Contains("1-invalid name", StringComparison.Ordinal) &&
            m.Contains(subscribed, StringComparison.Ordinal));
    }

    private sealed class NoOpExporter : BaseExporter<Metric>
    {
        public override ExportResult Export(in Batch<Metric> batch) => ExportResult.Success;
    }

    private sealed class CapturingLogger : ILogger<ExporterDiagnostics>
    {
        public ConcurrentQueue<string> Messages { get; } = new();
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => Messages.Enqueue(formatter(state, exception));
    }
}
