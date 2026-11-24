using System.Diagnostics.Tracing;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace AdventureWorks.Telemetry;

/// <summary>Bounded exporter diagnostics without event payloads, exception bodies or credentials.</summary>
public sealed class ExporterDiagnostics(ILogger<ExporterDiagnostics> logger) : EventListener, IHostedService
{
    private const string OpenTelemetrySdk = "OpenTelemetry-Sdk";
    private const int MetricInstrumentIgnored = 33;
    private long _lastWarning;

    protected override void OnEventSourceCreated(EventSource source)
    {
        if (source.Name is OpenTelemetrySdk or "Azure-Monitor-OpenTelemetry-Exporter")
            EnableEvents(source, EventLevel.Warning);
    }

    protected override void OnEventWritten(EventWrittenEventArgs args)
    {
        var instrumentIgnored = args.EventSource.Name == OpenTelemetrySdk && args.EventId == MetricInstrumentIgnored;
        var reason = instrumentIgnored ? PayloadText(args, 2) : null;
        if (instrumentIgnored && IsExpectedInstrumentIgnoredReason(reason)) return;

        var now = Environment.TickCount64;
        var previous = Interlocked.Read(ref _lastWarning);
        if (now - previous < 60_000 || Interlocked.CompareExchange(ref _lastWarning, now, previous) != previous) return;

        if (instrumentIgnored)
        {
            // Instrument/meter names and the SDK's fixed reason text contain no request or user data.
            logger?.LogWarning(
                "Telemetry exporter diagnostic: source {Source}, event {EventId}; instrument {Instrument}, meter {Meter} ignored: {Reason}",
                args.EventSource.Name, args.EventId, PayloadText(args, 0), PayloadText(args, 1), reason);
            return;
        }

        logger?.LogWarning("Telemetry exporter diagnostic: source {Source}, event {EventId}; payload omitted",
            args.EventSource.Name, args.EventId);
    }

    /// <summary>
    /// Every MeterProvider in the process (application, Statsbeat, SDK stats) is offered every
    /// instrument and reports the ones it does not subscribe to; the Azure Monitor distro also
    /// drops selected HTTP client instruments through views. Both are by design, not data loss.
    /// </summary>
    public static bool IsExpectedInstrumentIgnoredReason(string? reason) =>
        reason is not null &&
        (reason.StartsWith("Instrument belongs to a Meter not subscribed by this provider", StringComparison.Ordinal) ||
         reason.StartsWith("View configuration asks to drop this instrument", StringComparison.Ordinal));

    private static string? PayloadText(EventWrittenEventArgs args, int index) =>
        args.Payload is { } payload && payload.Count > index ? payload[index]?.ToString() : null;

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken)
    {
        Dispose();
        return Task.CompletedTask;
    }
}
