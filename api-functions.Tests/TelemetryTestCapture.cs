using Azure.Core.Pipeline;
using Azure.Monitor.OpenTelemetry.Exporter;
using Microsoft.ApplicationInsights.Channel;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Extensions.DependencyInjection;
using OpenTelemetry;
using OpenTelemetry.Logs;
using System.Net;

namespace ApiFunctions.Tests;

/// <summary>SDK3 log exporter; legacy DTOs keep existing business-evidence assertions readable.</summary>
internal sealed class TelemetryTestCapture : BaseExporter<LogRecord>
{
    public List<ITelemetry> Items { get; } = [];
    public List<ITelemetry>? Target { get; set; }

    public TelemetryConfiguration CreateConfiguration(bool privacy = false)
    {
        var configuration = new TelemetryConfiguration
        {
            ConnectionString = "InstrumentationKey=00000000-0000-0000-0000-000000000000",
            SamplingRatio = 1,
            EnableTraceBasedLogsSampler = false,
            EnableLiveMetrics = false,
            DisableOfflineStorage = true
        };
        configuration.ConfigureOpenTelemetryBuilder(builder =>
        {
            builder.Services.Configure<AzureMonitorExporterOptions>(options =>
            {
                options.Transport = new HttpClientTransport(new HttpClient(new OfflineHandler()));
                options.EnableLiveMetrics = false;
                options.DisableOfflineStorage = true;
            });
            builder.WithLogging(logging =>
            {
                if (privacy) logging.AddProcessor(new AdventureWorks.Telemetry.TelemetryLogPrivacyProcessor());
                logging.AddProcessor(new SimpleLogRecordExportProcessor(this));
            });
        });
        return configuration;
    }

    public override ExportResult Export(in Batch<LogRecord> batch)
    {
        foreach (var record in batch)
        {
            var fields = record.Attributes?.ToDictionary(item => item.Key, item => item.Value) ?? [];
            ITelemetry item;
            if (fields.TryGetValue("microsoft.custom_event.name", out var name))
            {
                var telemetry = new EventTelemetry(name?.ToString());
                foreach (var field in fields)
                    telemetry.Properties[field.Key] = field.Value?.ToString() ?? "";
                item = telemetry;
            }
            else if (record.Exception is { } exception)
                item = new ExceptionTelemetry(exception);
            else
                continue;
            if (item is EventTelemetry eventItem)
                eventItem.Properties["otel.trace_id"] = record.TraceId.ToHexString();
            if (item is ExceptionTelemetry exceptionItem)
                exceptionItem.Properties["otel.trace_id"] = record.TraceId.ToHexString();
            Items.Add(item);
            Target?.Add(item);
        }
        return ExportResult.Success;
    }

    internal sealed class OfflineHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"itemsReceived":0,"itemsAccepted":0,"errors":[]}""")
            });
    }
}
