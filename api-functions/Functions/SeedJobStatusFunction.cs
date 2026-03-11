using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Files.Shares;
using Azure.Storage.Files.Shares.Models;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace AdventureWorks.Functions;

public class SeedJobStatusFunction
{
    private const string ShareName = "seed-job-logs";
    private const string SuccessSentinel = "DATABASE SEEDING SCRIPT COMPLETED SUCCESSFULLY";
    private const string FatalErrorSentinel = "FATAL ERROR TRAPPED";
    private const string FailedSentinel = "Failed to execute database seeding";
    private const string StartTimePrefix = "Start Time: ";
    private const int TailBytes = 10 * 1024;
    private const int HeadBytes = 2048;
    private static readonly TimeSpan RunningThreshold = TimeSpan.FromHours(4);

    private readonly ILogger<SeedJobStatusFunction> _logger;

    public SeedJobStatusFunction(ILogger<SeedJobStatusFunction> logger)
    {
        _logger = logger;
    }

    [Function("SeedJobStatus")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "seed/status")] HttpRequestData req)
    {
        _logger.LogInformation("Seed job status endpoint called");

        var response = req.CreateResponse(HttpStatusCode.OK);
        response.Headers.Add("Content-Type", "application/json");

        try
        {
            var accountName = Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName");
            if (string.IsNullOrEmpty(accountName))
            {
                await WriteStatus(response, "unknown", isRunning: false, message: "Storage account not configured");
                return response;
            }

            var uri = new Uri($"https://{accountName}.file.core.windows.net");
            var options = new ShareClientOptions { ShareTokenIntent = ShareTokenIntent.Backup };
            var serviceClient = new ShareServiceClient(uri, new DefaultAzureCredential(), options);
            var shareClient = serviceClient.GetShareClient(ShareName);
            var rootDir = shareClient.GetRootDirectoryClient();

            // List files and take the newest by name (seed-YYYYMMDD-HHmmss.log)
            var newestFile = (ShareFileItem?)null;
            await foreach (var item in rootDir.GetFilesAndDirectoriesAsync())
            {
                if (item.IsDirectory)
                    continue;
                if (newestFile == null || string.CompareOrdinal(item.Name, newestFile.Name) > 0)
                    newestFile = item;
            }

            if (newestFile == null)
            {
                await WriteStatus(response, "unknown", isRunning: false, message: "No seed log found");
                return response;
            }

            var fileClient = rootDir.GetFileClient(newestFile.Name);
            var props = await fileClient.GetPropertiesAsync();
            var lastModified = props.Value.LastModified.UtcDateTime;
            var contentLength = props.Value.ContentLength;

            // Read tail for sentinels
            var tailLength = (int)Math.Min(TailBytes, contentLength);
            var tailOffset = contentLength - tailLength;
            string tailContent;
            var tailDownload = await fileClient.DownloadAsync(new ShareFileDownloadOptions
            {
                Range = new Azure.HttpRange(tailOffset, tailLength)
            });
            using (tailDownload.Value.Content)
            {
                using var reader = new StreamReader(tailDownload.Value.Content, Encoding.UTF8);
                tailContent = await reader.ReadToEndAsync();
            }

            if (tailContent.Contains(SuccessSentinel, StringComparison.Ordinal))
            {
                var durationHint = $"Last run: {lastModified:yyyy-MM-dd HH:mm:ss} UTC";
                await WriteStatus(response, "completed", isRunning: false, logFile: newestFile.Name,
                    lastRunTime: lastModified, message: "Seed job completed successfully", durationHint: durationHint);
                return response;
            }

            if (tailContent.Contains(FatalErrorSentinel, StringComparison.Ordinal) ||
                tailContent.Contains(FailedSentinel, StringComparison.Ordinal))
            {
                await WriteStatus(response, "failed", isRunning: false, logFile: newestFile.Name,
                    lastRunTime: lastModified, message: "Seed job failed (see log for details)");
                return response;
            }

            var logAge = DateTime.UtcNow - lastModified;
            if (logAge > RunningThreshold)
            {
                await WriteStatus(response, "failed", isRunning: false, logFile: newestFile.Name,
                    lastRunTime: lastModified, message: "Seed job did not complete (log older than 4h, no completion marker)");
                return response;
            }

            // Running: newest log is recent and has no completion/error sentinels
            string? runningForHuman = null;
            DateTime? runningStartTime = null;
            if (contentLength > 0)
            {
                var headLength = (int)Math.Min(HeadBytes, contentLength);
                var headDownload = await fileClient.DownloadAsync(new ShareFileDownloadOptions
                {
                    Range = new Azure.HttpRange(0, headLength)
                });
                using (headDownload.Value.Content)
                {
                    using var reader = new StreamReader(headDownload.Value.Content, Encoding.UTF8);
                    var headContent = await reader.ReadToEndAsync();
                    var idx = headContent.IndexOf(StartTimePrefix, StringComparison.Ordinal);
                    if (idx >= 0 && idx + StartTimePrefix.Length + 19 <= headContent.Length)
                    {
                        var dateStr = headContent.Substring(idx + StartTimePrefix.Length, 19);
                        if (DateTime.TryParseExact(dateStr, "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture,
                                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var startTime))
                        {
                            runningStartTime = startTime;
                            var elapsed = DateTime.UtcNow - startTime;
                            var minutes = (int)elapsed.TotalMinutes;
                            var seconds = elapsed.Seconds;
                            runningForHuman = $"{minutes}m {seconds}s";
                        }
                    }
                }
            }

            await WriteStatus(response, "running", isRunning: true, logFile: newestFile.Name,
                lastRunTime: lastModified, message: runningForHuman != null ? $"Running for {runningForHuman}" : "Seed job running",
                runningForHuman: runningForHuman, runningStartTime: runningStartTime);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to read seed job log");
            await WriteStatus(response, "unknown", isRunning: false, message: $"Unable to read seed log: {ex.Message}");
        }

        return response;
    }

    private static async Task WriteStatus(
        HttpResponseData response,
        string status,
        bool isRunning,
        string? message = null,
        string? logFile = null,
        DateTime? lastRunTime = null,
        string? durationHint = null,
        string? runningForHuman = null,
        DateTime? runningStartTime = null)
    {
        var payload = new
        {
            status,
            isRunning,
            lastRunTime = lastRunTime?.ToString("o"),
            logFile,
            message,
            durationHint,
            runningForHuman,
            runningStartTime = runningStartTime?.ToString("o")
        };
        var json = JsonSerializer.Serialize(payload);
        await response.WriteStringAsync(json);
    }
}
