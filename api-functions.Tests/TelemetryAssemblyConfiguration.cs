using Xunit;

// SDK3 standalone TelemetryConfiguration changes the process-wide OTEL_SDK_DISABLED switch.
// Enabled exporter fixtures and disabled business fixtures must not build providers concurrently.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
