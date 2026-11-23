using System.Diagnostics.Tracing;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace AdventureWorks.Telemetry;

/// <summary>Bounded exporter diagnostics without event payloads, exception bodies or credentials.</summary>
public sealed class ExporterDiagnostics(ILogger<ExporterDiagnostics> logger) : EventListener, IHostedService
{
    private long _lastWarning;

    protected override void OnEventSourceCreated(EventSource source)
    {
        if (source.Name is "OpenTelemetry-Sdk" or "Azure-Monitor-OpenTelemetry-Exporter")
            EnableEvents(source, EventLevel.Warning);
    }

    protected override void OnEventWritten(EventWrittenEventArgs args)
    {
        var now = Environment.TickCount64;
        var previous = Interlocked.Read(ref _lastWarning);
        if (now - previous < 60_000 || Interlocked.CompareExchange(ref _lastWarning, now, previous) != previous) return;
        logger?.LogWarning("Telemetry exporter diagnostic: source {Source}, event {EventId}; payload omitted",
            args.EventSource.Name, args.EventId);
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken)
    {
        Dispose();
        return Task.CompletedTask;
    }
}
