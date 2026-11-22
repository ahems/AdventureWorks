#nullable enable
using System.Diagnostics;
using System.Data;
using System.Net.Http.Json;
using System.Text.Json;
using Azure.Core;
using Azure.Data.Tables;
using Azure.Identity;
using Azure.Messaging.WebPubSub;
using Azure.Storage.Blobs;
using Azure.Storage.Queues;
using Azure.Storage.Files.Shares;
using Azure.Storage.Files.Shares.Models;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace api_functions.Services;

public record DependencyCheck(string Id, string Name, string Group, bool Required,
    string Status, string Message, long ResponseTimeMs);

public record DependencyHealthReport(DateTimeOffset CheckedAt, IReadOnlyList<DependencyCheck> Checks)
{
    public string Status => Checks.Any(c => c.Required && c.Status != "healthy") ? "unhealthy" : "healthy";
}

public record DependencyProbe(string Id, string Name, string Group, bool Required,
    Func<CancellationToken, Task<(string Status, string Message)>> Run);

public sealed class SelectedIdentityCredential(TokenCredential inner, Guid expectedClientId) : TokenCredential
{
    private int _verified;
    public bool Verified => Volatile.Read(ref _verified) != 0;

    public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
        Check(inner.GetToken(requestContext, cancellationToken));

    public override async ValueTask<AccessToken> GetTokenAsync(
        TokenRequestContext requestContext, CancellationToken cancellationToken) =>
        Check(await inner.GetTokenAsync(requestContext, cancellationToken));

    private AccessToken Check(AccessToken token)
    {
        VerifyToken(token, expectedClientId);
        Interlocked.Exchange(ref _verified, 1);
        return token;
    }

    internal static void VerifyToken(AccessToken token, Guid expectedClientId)
    {
        JsonWebToken jwt;
        try
        {
            jwt = new JsonWebTokenHandler().ReadJsonWebToken(token.Token);
        }
        catch (Exception error) when (error is ArgumentException or SecurityTokenException)
        {
            throw new UnverifiableIdentityTokenException();
        }

        var claims = jwt.Claims.Where(claim => claim.Type is "appid" or "azp").ToArray();
        if (claims.Length == 0 || claims.Any(claim => !Guid.TryParse(claim.Value, out _)))
            throw new UnverifiableIdentityTokenException();
        if (claims.Any(claim => Guid.Parse(claim.Value) != expectedClientId))
            throw new IdentityTokenMismatchException();
    }
}

public sealed class UnverifiableIdentityTokenException()
    : InvalidOperationException("The Azure access token does not identify a verifiable application.");

public sealed class IdentityTokenMismatchException()
    : InvalidOperationException("The Azure access token belongs to a different application.");

public class DependencyHealthService(
    IConfiguration configuration,
    DefaultAzureCredential credential,
    IHttpClientFactory httpClients,
    ILogger<DependencyHealthService> logger)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private DependencyHealthReport? _cached;
    public static readonly TimeSpan CacheDuration = TimeSpan.FromSeconds(60);

    public static readonly string[] ApplicationQueues = [
        "order-receipt-generation", "order-email-generation", "ai-job-image-queue",
        "ai-job-chat-queue", "ai-job-embeddings-queue", "product-thumbnail-generation",
        "sales-order-status", "production-wo-queue", "supply-chain-orders-queue",
        "simulation-order-queue", "warehouse-ops-queue", "review-moderation-queue",
        "manufacturing-agent-queue", "auto-promotion-queue", "utility-status-queue",
        "verified-reviews-queue"
    ];
    public static readonly string[] ApplicationTables = [
        "shoppingSimulator", "awOrderPipelineConfig", "awSupplyChain", "awManufacturing",
        "awBankAccounts", "awBankTransactions", "awWarehouse", "awManufacturingAgentConfig",
        "awManufacturingAgentRuns", "awManufacturingProposals", "verifiedReviewsJob",
        "reviewModerationJob", "awAutoPromotionConfig", "aiRateLimits"
    ];
    public static readonly string[] ApplicationContainers = [
        "adventureworks-receipts", "locales", "function-releases"
    ];

    public async Task<DependencyHealthReport> GetReportAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_cached is not null && DateTimeOffset.UtcNow - _cached.CheckedAt < CacheDuration)
                return _cached;

            var checks = await Task.WhenAll(BuildProbes().Select(probe =>
                RunProbeAsync(probe, logger, cancellationToken)));
            _cached = new DependencyHealthReport(DateTimeOffset.UtcNow, checks);
            return _cached;
        }
        finally
        {
            _gate.Release();
        }
    }

    public static async Task<DependencyCheck> RunProbeAsync(DependencyProbe probe, ILogger logger,
        CancellationToken cancellationToken, TimeSpan? timeout = null)
    {
        var watch = Stopwatch.StartNew();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout ?? TimeSpan.FromSeconds(20));
        try
        {
            var (status, message) = await probe.Run(deadline.Token).WaitAsync(deadline.Token);
            if (status is "unhealthy" or "not-configured" or "unknown")
                logger.LogWarning("Dependency health check {CheckId}: {Status}", probe.Id, status);
            return new(probe.Id, probe.Name, probe.Group, probe.Required, status, message, watch.ElapsedMilliseconds);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning("Dependency health check {CheckId} timed out", probe.Id);
            return new(probe.Id, probe.Name, probe.Group, probe.Required, "timeout",
                "Dependency check timed out. See Application Insights.", watch.ElapsedMilliseconds);
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(ex, "Dependency health check {CheckId} failed", probe.Id);
            return new(probe.Id, probe.Name, probe.Group, probe.Required, "unhealthy",
                "Dependency unavailable or access denied. See Application Insights.", watch.ElapsedMilliseconds);
        }
    }

    public static (string Status, string Message) EvaluateSqlIdentity(object? value) => value switch
    {
        1 => ("healthy", "SQL principal matches the configured managed identity."),
        0 => ("unhealthy", "SQL principal does not match the configured managed identity."),
        null or DBNull => ("unknown", "SQL principal identity could not be verified."),
        _ => throw new InvalidOperationException("SQL identity probe returned an unexpected result.")
    };

    private IEnumerable<DependencyProbe> BuildProbes()
    {
        yield return new("sql", "Azure SQL", "services", true, async ct =>
        {
            var connectionString = configuration["SQL_CONNECTION_STRING"];
            if (string.IsNullOrWhiteSpace(connectionString))
                return ("not-configured", "SQL connection is not configured.");
            await using var connection = new SqlConnection(connectionString);
            await connection.OpenAsync(ct);
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT TOP (1) ProductID FROM Production.Product";
            command.CommandTimeout = 15;
            await command.ExecuteScalarAsync(ct);
            return ("healthy", "Connected and verified catalog read permission; no customer data returned.");
        });
        yield return new("sql-identity", "Azure SQL runtime identity", "capabilities", false, async ct =>
        {
            var connectionString = configuration["SQL_CONNECTION_STRING"];
            var configuredClientId = configuration["AZURE_CLIENT_ID"];
            if (string.IsNullOrWhiteSpace(connectionString) || string.IsNullOrWhiteSpace(configuredClientId))
                return ("not-configured", "SQL managed identity verification is not configured.");
            if (!Guid.TryParse(configuredClientId, out var clientId) || clientId == Guid.Empty)
                return ("unhealthy", "SQL managed identity configuration is invalid.");

            await using var connection = new SqlConnection(connectionString);
            await connection.OpenAsync(ct);
            await using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT CONVERT(int, CASE WHEN type = 'E' AND sid = CONVERT(binary(16), @ClientId)
                    THEN 1 ELSE 0 END)
                FROM sys.database_principals WHERE principal_id = USER_ID();
                """;
            command.Parameters.Add("@ClientId", SqlDbType.UniqueIdentifier).Value = clientId;
            command.CommandTimeout = 15;
            return EvaluateSqlIdentity(await command.ExecuteScalarAsync(ct));
        });
        yield return StorageProbe("blobs", "Blob storage", async (account, ct) =>
        {
            var client = new BlobServiceClient(StorageUri(account, "blob"), credential);
            await Task.WhenAll(ApplicationContainers.Select(name =>
                client.GetBlobContainerClient(name).GetPropertiesAsync(cancellationToken: ct)));
            return "Receipt, translation, and deployment containers are accessible.";
        });
        yield return StorageProbe("queues", "Queue storage", async (account, ct) =>
        {
            var client = new QueueServiceClient(StorageUri(account, "queue"), credential);
            await Task.WhenAll(ApplicationQueues.SelectMany(name => new[] { name, $"{name}-poison" })
                .Select(name => client.GetQueueClient(name).GetPropertiesAsync(cancellationToken: ct)));
            return $"All {ApplicationQueues.Length} application queues and their poison queues are accessible; no messages consumed.";
        });
        yield return StorageProbe("tables", "Table storage", async (account, ct) =>
        {
            var client = new TableServiceClient(StorageUri(account, "table"), credential);
            await Task.WhenAll(ApplicationTables.Select(async name =>
            {
                await using var pages = client.GetTableClient(name)
                    .QueryAsync<TableEntity>(maxPerPage: 1, select: ["PartitionKey"], cancellationToken: ct)
                    .AsPages().GetAsyncEnumerator(ct);
                await pages.MoveNextAsync();
            }));
            return "Simulator, order pipeline, manufacturing, warehouse, bank, and AI job tables are readable.";
        });
        yield return new("webpubsub-service", "Web PubSub service", "capabilities", false, async ct =>
        {
            var host = configuration["WEB_PUBSUB_HOST_NAME"];
            if (string.IsNullOrWhiteSpace(host))
                return ("not-configured", "Real-time push is not configured.");
            var client = new WebPubSubServiceClient(new Uri($"https://{host}"), "adventureworks", credential);
            await client.GroupExistsAsync("orders", new Azure.RequestContext { CancellationToken = ct });
            return ("healthy", "Service reachable with managed identity; an empty group is valid. No event sent.");
        });
        yield return new("files", "Seed log file storage", "capabilities", false, async ct =>
        {
            var account = configuration["AzureWebJobsStorage:accountName"];
            if (string.IsNullOrWhiteSpace(account))
                return ("not-configured", "Seed log storage is not configured.");
            var options = new ShareClientOptions { ShareTokenIntent = ShareTokenIntent.Backup };
            var client = new ShareServiceClient(StorageUri(account, "file"), credential, options)
                .GetShareClient("seed-job-logs");
            // Share properties require management permissions; probe the actual file-data capability instead.
            await client.GetRootDirectoryClient().GetPropertiesAsync(cancellationToken: ct);
            return ("healthy", "Seed log root directory is readable; seed execution is checked separately.");
        });
        yield return IdentityProbe("blob-identity", "Blob storage runtime identity", async (bound, ct) =>
        {
            var client = new BlobServiceClient(StorageUri(RequiredStorageAccount(), "blob"), bound);
            await client.GetBlobContainerClient("adventureworks-receipts")
                .GetPropertiesAsync(cancellationToken: ct);
        }, "AzureWebJobsStorage:accountName");
        yield return IdentityProbe("queue-identity", "Queue storage runtime identity", async (bound, ct) =>
        {
            var client = new QueueServiceClient(StorageUri(RequiredStorageAccount(), "queue"), bound);
            await client.GetQueueClient("order-receipt-generation").GetPropertiesAsync(cancellationToken: ct);
        }, "AzureWebJobsStorage:accountName");
        yield return IdentityProbe("table-identity", "Table storage runtime identity", async (bound, ct) =>
        {
            var client = new TableServiceClient(StorageUri(RequiredStorageAccount(), "table"), bound);
            await using var pages = client.GetTableClient("shoppingSimulator")
                .QueryAsync<TableEntity>(maxPerPage: 1, select: ["PartitionKey"], cancellationToken: ct)
                .AsPages().GetAsyncEnumerator(ct);
            await pages.MoveNextAsync();
        }, "AzureWebJobsStorage:accountName");
        yield return IdentityProbe("file-identity", "File storage runtime identity", async (bound, ct) =>
        {
            var options = new ShareClientOptions { ShareTokenIntent = ShareTokenIntent.Backup };
            var client = new ShareServiceClient(StorageUri(RequiredStorageAccount(), "file"), bound, options)
                .GetShareClient("seed-job-logs");
            await client.GetRootDirectoryClient().GetPropertiesAsync(cancellationToken: ct);
        }, "AzureWebJobsStorage:accountName");
        yield return IdentityProbe("webpubsub-identity", "Web PubSub runtime identity", async (bound, ct) =>
        {
            var client = new WebPubSubServiceClient(
                new Uri($"https://{configuration["WEB_PUBSUB_HOST_NAME"]}"), "adventureworks", bound);
            await client.GroupExistsAsync("orders", new Azure.RequestContext { CancellationToken = ct });
        }, "WEB_PUBSUB_HOST_NAME");
        foreach (var probe in McpProbes())
            yield return probe;
        yield return ConfigurationProbe("openai", "Azure OpenAI configuration",
            ["AZURE_OPENAI_ENDPOINT"], "Configured only; use the opt-in semantic search check to verify embeddings.");
        yield return ConfigurationProbe("foundry", "Foundry agent configuration",
            ["AI_FOUNDRY_PROJECT_ENDPOINT", "AI_AGENT_CHAT_ID"],
            "Chat agent and project configured; no inference or tool execution performed.");
        yield return ConfigurationProbe("manufacturing-agent", "Hosted manufacturing agent configuration",
            ["MANUFACTURING_AGENT_ENDPOINT"], "Endpoint configured only; does not invoke the autonomous agent.");
        yield return ConfigurationProbe("email", "Email configuration",
            ["COMMUNICATION_SERVICE_ENDPOINT", "EMAIL_SENDER_DOMAIN"],
            "Sender configured only; delivery and receipt generation are not exercised.");
        yield return new("order-emails", "Order notification emails", "capabilities", false, _ =>
            Task.FromResult(("configured", string.Equals(configuration["ORDER_NOTIFICATIONS_EMAIL_ENABLED"],
                "true", StringComparison.OrdinalIgnoreCase)
                ? "Shipped/delivered emails enabled. No test email sent."
                : "Shipped/delivered emails intentionally disabled; this is not an outage.")));
        yield return ConfigurationProbe("telemetry", "Backend telemetry configuration",
            ["APPLICATIONINSIGHTS_CONNECTION_STRING"], "Configured only; telemetry ingestion is not verified.");
    }

    private DependencyProbe StorageProbe(string id, string name,
        Func<string, CancellationToken, Task<string>> run) =>
        new(id, name, "services", true, async ct =>
        {
            var account = configuration["AzureWebJobsStorage:accountName"];
            if (string.IsNullOrWhiteSpace(account))
                return ("not-configured", "Managed-identity storage account is not configured.");
            return ("healthy", await run(account, ct));
        });

    private Uri StorageUri(string account, string service) => new(
        configuration[$"AzureWebJobsStorage:{service}ServiceUri"]
            ?? $"https://{account}.{service}.core.windows.net");

    private string RequiredStorageAccount() => configuration["AzureWebJobsStorage:accountName"]
        ?? throw new InvalidOperationException("Storage account configuration disappeared during a health check.");

    private DependencyProbe IdentityProbe(string id, string name,
        Func<TokenCredential, CancellationToken, Task> run, string dependencyKey) =>
        new(id, name, "capabilities", false, async ct =>
        {
            var configuredClientId = configuration["AZURE_CLIENT_ID"];
            if (string.IsNullOrWhiteSpace(configuredClientId) ||
                string.IsNullOrWhiteSpace(configuration[dependencyKey]))
                return ("not-configured", "Runtime identity verification is not configured.");
            if (!Guid.TryParse(configuredClientId, out var clientId) || clientId == Guid.Empty)
                return ("unhealthy", "Runtime identity configuration is invalid.");

            var bound = new SelectedIdentityCredential(credential, clientId);
            try
            {
                await run(bound, ct);
            }
            catch (IdentityTokenMismatchException)
            {
                return ("unhealthy", "The service token does not match the configured managed identity.");
            }
            catch (UnverifiableIdentityTokenException)
            {
                return ("unknown", "The service token identity could not be verified.");
            }
            return bound.Verified
                ? ("healthy", "A read succeeded using the configured managed identity.")
                : ("unknown", "The service token identity could not be verified.");
        });

    private DependencyProbe ConfigurationProbe(string id, string name, string[] keys, string message) =>
        new(id, name, "capabilities", false, _ => Task.FromResult(
            keys.All(key => !string.IsNullOrWhiteSpace(configuration[key]))
                ? ("configured", message)
                : ("not-configured", "Required configuration is missing; see deployment settings.")));

    private IEnumerable<DependencyProbe> McpProbes()
    {
        yield return new("mcp", "MCP process", "services", true, ct => CheckMcpAsync("/health", ct));
        yield return new("mcp-ready", "MCP dependencies", "services", true, ct => CheckMcpAsync("/ready", ct));
        yield return new("oauth", "OAuth discovery", "services", true,
            ct => CheckMcpAsync("/.well-known/oauth-authorization-server", ct));
    }

    private async Task<(string Status, string Message)> CheckMcpAsync(string path, CancellationToken ct)
    {
        var configured = configuration["MCP_SERVICE_URL"] ?? configuration["API_MCP_URL"];
        if (string.IsNullOrWhiteSpace(configured))
            return ("not-configured", "MCP service URL is not configured.");
        var baseUrl = configured.TrimEnd('/');
        if (baseUrl.EndsWith("/mcp", StringComparison.OrdinalIgnoreCase))
            baseUrl = baseUrl[..^4];
        using var client = httpClients.CreateClient();
        using var response = await client.GetAsync($"{baseUrl}{path}", ct);
        if (!response.IsSuccessStatusCode)
            return ("unhealthy", $"MCP probe returned HTTP {(int)response.StatusCode}. See Application Insights.");
        if (path == "/health")
        {
            if ((await response.Content.ReadAsStringAsync(ct)).Trim() != "Healthy")
                return ("unhealthy", "Invalid MCP liveness response.");
            return ("healthy", "MCP process is responding; this alone does not prove tool readiness.");
        }
        var json = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: ct);
        if (path == "/ready")
        {
            if (!json.TryGetProperty("status", out var status) || status.GetString() != "healthy"
                || !json.TryGetProperty("checks", out var checks) || checks.ValueKind != JsonValueKind.Array)
                return ("unhealthy", "MCP dependency checks did not pass.");
            var results = checks.EnumerateArray().ToArray();
            var valid = new[] { "sql", "tasks" }.All(id =>
            {
                var matches = results.Where(item => item.TryGetProperty("id", out var checkId)
                    && checkId.GetString() == id).ToArray();
                return matches.Length == 1 && matches[0].TryGetProperty("status", out var checkStatus)
                    && checkStatus.GetString() == "healthy";
            });
            return valid ? ("healthy", "MCP SQL and task storage read checks passed.")
                : ("unhealthy", "Invalid MCP dependency response.");
        }
        return new[] { "issuer", "token_endpoint", "authorization_endpoint", "jwks_uri" }.All(key =>
            json.TryGetProperty(key, out var endpoint) && endpoint.ValueKind == JsonValueKind.String
            && Uri.TryCreate(endpoint.GetString(), UriKind.Absolute, out var uri)
            && uri.Scheme is "https" or "http")
            && json.TryGetProperty("code_challenge_methods_supported", out var pkce)
            && pkce.ValueKind == JsonValueKind.Array && pkce.EnumerateArray().Any(item => item.GetString() == "S256")
                ? ("healthy", "OAuth discovery and PKCE metadata are available; sign-in is not exercised.")
                : ("unhealthy", "Invalid OAuth discovery response.");
    }
}
