using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging.Console;

namespace AdventureWorks.Telemetry;

/// <summary>ACA/Functions console logs must not bypass exporter privacy rules.</summary>
public sealed class SafeConsoleFormatter() : ConsoleFormatter("adventureworks-safe")
{
    public override void Write<TState>(in LogEntry<TState> entry, IExternalScopeProvider? scopes, TextWriter writer)
    {
        var message = entry.Exception is { } exception
            ? $"Operation failed ({exception.GetType().Name}); exception content omitted."
            : TelemetryPrivacyProcessor.Clean(entry.Formatter(entry.State, null));
        if (string.IsNullOrEmpty(message)) return;
        writer.WriteLine($"{entry.LogLevel}: {entry.Category} [{entry.EventId.Id}] {message}");
    }
}
