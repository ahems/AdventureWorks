using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Azure.Identity;
using Azure.Core.Serialization;
using AddressFunctions.Services;
using api_functions.Services;
using Microsoft.OpenApi.Models;
using Azure.AI.Projects;
using Azure.AI.OpenAI;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

// Register Application Insights for telemetry
builder.Services.AddApplicationInsightsTelemetryWorkerService();

// Configure JSON serialization to use camelCase for API responses  
builder.Services.Configure<WorkerOptions>(options =>
{
    var settings = System.Text.Json.JsonSerializerDefaults.Web;
    options.Serializer = new Azure.Core.Serialization.JsonObjectSerializer(
        new System.Text.Json.JsonSerializerOptions(settings)
        {
            PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase
        });
});

// Configure DefaultAzureCredential for Azure SDK clients
// This will use: Azure CLI > Environment > Workload Identity > Managed Identity
// When AZURE_CLIENT_ID is set (user-assigned MI), it will use that specific identity
var managedIdentityClientId = builder.Configuration["AZURE_CLIENT_ID"];
var defaultCredential = new DefaultAzureCredential(new DefaultAzureCredentialOptions
{
    ExcludeManagedIdentityCredential = false,
    ExcludeEnvironmentCredential = false,
    ManagedIdentityClientId = managedIdentityClientId // Use user-assigned MI when specified
});
builder.Services.AddSingleton(defaultCredential);

// Register HttpClient (retained for services that still need it)
builder.Services.AddHttpClient();

// Aspire SQL Client with automatic tracing and health checks
builder.AddSqlServerClient("SQL_CONNECTION_STRING");

// Aspire Blob Storage with observability (only if connection string is configured)
var storageConnectionString = builder.Configuration["AZURE_STORAGE_CONNECTION_STRING"];
if (!string.IsNullOrEmpty(storageConnectionString))
{
    builder.AddAzureBlobServiceClient("AZURE_STORAGE_CONNECTION_STRING");
    builder.AddAzureQueueServiceClient("AZURE_STORAGE_CONNECTION_STRING");
}

// Register custom services with connection string from configuration
builder.Services.AddScoped<AddressService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new AddressService(connectionString);
});

// Register CustomerStatsService for global customer analytics (bypasses DAB 100-item pagination)
builder.Services.AddScoped<CustomerStatsService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new CustomerStatsService(connectionString);
});

builder.Services.AddScoped<ProductService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new ProductService(connectionString);
});

builder.Services.AddScoped<SpecialOfferService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new SpecialOfferService(connectionString);
});

builder.Services.AddScoped<ReviewService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new ReviewService(connectionString);
});

// Register OrderService for MCP Server
builder.Services.AddScoped<OrderService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new OrderService(connectionString);
});

// Register ReceiptService for PDF receipt generation
builder.Services.AddScoped<ReceiptService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new ReceiptService(connectionString);
});

// Register PasswordService for password hashing and verification
builder.Services.AddScoped<PasswordService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new PasswordService(connectionString);
});

// Register ExchangeRateService for refreshing Sales.CurrencyRate from Frankfurter API
builder.Services.AddScoped<ExchangeRateService>(sp =>
{
    var configuration    = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    var httpClientFactory = sp.GetRequiredService<IHttpClientFactory>();
    var logger            = sp.GetRequiredService<ILogger<ExchangeRateService>>();
    return new ExchangeRateService(connectionString, httpClientFactory, logger);
});

// Register ReportingService for pre-aggregated SQL reporting (bypasses DAB 100-item pagination)
builder.Services.AddScoped<ReportingService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new ReportingService(connectionString);
});

// Register PdfReceiptGenerator for PDF receipt generation
builder.Services.AddScoped<PdfReceiptGenerator>();

// Register Azure AI Foundry Responses API client — singleton shared across all agent services.
// Invokes "kind: prompt" agents created in the new Foundry portal experience.
// Uses previous_response_id for multi-turn continuity and store:true for Foundry memory.
builder.Services.AddSingleton<FoundryAgentClient>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var credential = sp.GetRequiredService<DefaultAzureCredential>();
    var logger = sp.GetRequiredService<ILogger<FoundryAgentClient>>();
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();
    var httpClientFactory = sp.GetRequiredService<IHttpClientFactory>();
    var projectEndpoint = configuration["AI_FOUNDRY_PROJECT_ENDPOINT"]
        ?? throw new InvalidOperationException("AI_FOUNDRY_PROJECT_ENDPOINT environment variable is not set");

    // MCP tool URLs — used as fallback tool config when the managed identity
    // lacks "AIServices/agents/read" permission to fetch the agent definition dynamically.
    var mcpServiceUrl = configuration["MCP_SERVICE_URL"] ?? string.Empty;
    var apiUrl = configuration["API_URL"] ?? string.Empty;

    // Derive the DAB API origin (strip any path suffix like /graphql/) and append /mcp
    var dabMcpUrl = string.Empty;
    if (!string.IsNullOrEmpty(apiUrl))
    {
        if (Uri.TryCreate(apiUrl, UriKind.Absolute, out var apiUri))
            dabMcpUrl = $"{apiUri.Scheme}://{apiUri.Authority}/mcp";
    }

    // Model deployment name (falls back to "chat" which is the standard deployment)
    var modelDeployment = configuration["chatGptDeploymentName"] ?? "chat";

    return new FoundryAgentClient(logger, telemetryClient, credential, projectEndpoint, httpClientFactory, mcpServiceUrl, dabMcpUrl, modelDeployment);
});

// Register AI Agent Service for conversational AI backed by Azure AI Foundry
builder.Services.AddScoped<AIAgentService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var logger = sp.GetRequiredService<ILogger<AIAgentService>>();
    var foundryClient = sp.GetRequiredService<FoundryAgentClient>();
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();

    return new AIAgentService(
        logger,
        configuration,
        foundryClient,
        telemetryClient);
});

// Register Product Content Agent Service for AI-powered product generation via Foundry
builder.Services.AddScoped<ProductContentAgentService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var logger = sp.GetRequiredService<ILogger<ProductContentAgentService>>();
    var foundryClient = sp.GetRequiredService<FoundryAgentClient>();
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();

    return new ProductContentAgentService(
        logger,
        configuration,
        foundryClient,
        telemetryClient);
});

// Register Cart Recovery Agent Service for abandoned-cart analysis via Foundry
builder.Services.AddScoped<CartRecoveryAgentService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var logger = sp.GetRequiredService<ILogger<CartRecoveryAgentService>>();
    var foundryClient = sp.GetRequiredService<FoundryAgentClient>();
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();

    return new CartRecoveryAgentService(
        logger,
        configuration,
        foundryClient,
        telemetryClient);
});

// Register Promotion Agent Service for single-shot AI promotion generation via Foundry
builder.Services.AddScoped<PromotionAgentService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var logger = sp.GetRequiredService<ILogger<PromotionAgentService>>();
    var foundryClient = sp.GetRequiredService<FoundryAgentClient>();
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();

    return new PromotionAgentService(
        logger,
        configuration,
        foundryClient,
        telemetryClient);
});

// Register HelpMeChoose Service for the AI-powered product-advisor wizard
builder.Services.AddScoped<HelpMeChooseService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var logger = sp.GetRequiredService<ILogger<HelpMeChooseService>>();
    var foundryClient = sp.GetRequiredService<FoundryAgentClient>();
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();

    return new HelpMeChooseService(
        logger,
        configuration,
        foundryClient,
        telemetryClient);
});

// Register WorkOrderSimulationService for the manufacturing simulation engine
builder.Services.AddScoped<WorkOrderSimulationService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    var tableServiceUri = configuration["AzureWebJobsStorage:tableServiceUri"]
        ?? $"https://{configuration["AzureWebJobsStorage:accountName"]}.table.core.windows.net";
    var simulationTimeScale = double.TryParse(configuration["SIMULATION_TIME_SCALE_FACTOR"], out var scale) ? scale : 60.0;
    var defaultScrapRate    = double.TryParse(configuration["SIMULATION_SCRAP_RATE"],        out var rate)  ? rate  : 0.05;
    var logger = sp.GetRequiredService<ILogger<WorkOrderSimulationService>>();
    var bank   = sp.GetRequiredService<BankService>();
    return new WorkOrderSimulationService(connectionString, tableServiceUri, simulationTimeScale, defaultScrapRate, logger, bank);
});

// Register SupplyChainService for the procurement simulation
builder.Services.AddScoped<SupplyChainService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    var tableServiceUri = configuration["AzureWebJobsStorage:tableServiceUri"]
        ?? $"https://{configuration["AzureWebJobsStorage:accountName"]}.table.core.windows.net";
    var simulationTimeScale = double.TryParse(configuration["SIMULATION_TIME_SCALE_FACTOR"], out var scSupply) ? scSupply : 60.0;
    var logger    = sp.GetRequiredService<ILogger<SupplyChainService>>();
    var telemetry = sp.GetRequiredService<TelemetryClient>();
    var bank      = sp.GetRequiredService<BankService>();
    return new SupplyChainService(connectionString, tableServiceUri, simulationTimeScale, logger, telemetry, bank);
});

// Register ManufacturingPlanningService for planning intelligence endpoints
builder.Services.AddScoped<ManufacturingPlanningService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    var logger = sp.GetRequiredService<ILogger<ManufacturingPlanningService>>();
    return new ManufacturingPlanningService(connectionString, logger);
});

// Register WorkforceService — sources HumanResources data for manufacturing operator assignment
builder.Services.AddScoped<WorkforceService>(sp =>
{
    var configuration  = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    var tableServiceUri = configuration["AzureWebJobsStorage:tableServiceUri"]
        ?? $"https://{configuration["AzureWebJobsStorage:accountName"]}.table.core.windows.net";
    var logger = sp.GetRequiredService<ILogger<WorkforceService>>();
    return new WorkforceService(connectionString, tableServiceUri, logger);
});

// Register ShoppingSimulatorService — manages Shopping Simulator state, queue depth, and
// the cached top-spender list used by the timer-driven order injection function.
builder.Services.AddScoped<ShoppingSimulatorService>(sp =>
{
    var configuration    = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    var accountName      = configuration["AzureWebJobsStorage:accountName"] ?? string.Empty;
    var tableServiceUri  = configuration["AzureWebJobsStorage:tableServiceUri"]
        ?? $"https://{accountName}.table.core.windows.net";
    var queueServiceUri  = configuration["AzureWebJobsStorage:queueServiceUri"]
        ?? $"https://{accountName}.queue.core.windows.net";
    var logger = sp.GetRequiredService<ILogger<ShoppingSimulatorService>>();
    return new ShoppingSimulatorService(connectionString, tableServiceUri, queueServiceUri, logger);
});

// Register OrderGenerationService for SQL write operations during AI order generation
builder.Services.AddScoped<OrderGenerationService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new OrderGenerationService(connectionString, sp.GetRequiredService<ILogger<OrderGenerationService>>());
});

// Register ManufacturingAgentService: autonomous agent invoked by SQL change-tracking trigger
builder.Services.AddScoped<ManufacturingAgentService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var logger = sp.GetRequiredService<ILogger<ManufacturingAgentService>>();
    var foundryClient = sp.GetRequiredService<FoundryAgentClient>();
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();
    return new ManufacturingAgentService(logger, configuration, foundryClient, telemetryClient);
});

// Register OrderGenerationAgentService: AI+Foundry orchestration for order generation wizard
builder.Services.AddScoped<OrderGenerationAgentService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var logger = sp.GetRequiredService<ILogger<OrderGenerationAgentService>>();
    var foundryClient = sp.GetRequiredService<FoundryAgentClient>();
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();
    var orderGenService = sp.GetRequiredService<OrderGenerationService>();
    var receiptService = sp.GetRequiredService<ReceiptService>();
    var pdfGenerator = sp.GetRequiredService<PdfReceiptGenerator>();

    return new OrderGenerationAgentService(
        logger,
        configuration,
        telemetryClient,
        orderGenService,
        receiptService,
        pdfGenerator,
        foundryClient);
});

// Register CustomerGenerationAgentService: AI+Foundry orchestration for customer generation
builder.Services.AddScoped<CustomerGenerationAgentService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var logger = sp.GetRequiredService<ILogger<CustomerGenerationAgentService>>();
    var foundryClient = sp.GetRequiredService<FoundryAgentClient>();
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();
    var orderGenService = sp.GetRequiredService<OrderGenerationService>();

    return new CustomerGenerationAgentService(
        logger,
        configuration,
        telemetryClient,
        orderGenService,
        foundryClient);
});

// Register BankService for the virtual bank simulator
builder.Services.AddScoped<BankService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    var tableServiceUri = configuration["AzureWebJobsStorage:tableServiceUri"]
        ?? $"https://{configuration["AzureWebJobsStorage:accountName"]}.table.core.windows.net";
    var logger = sp.GetRequiredService<ILogger<BankService>>();
    var telemetry = sp.GetRequiredService<TelemetryClient>();
    return new BankService(connectionString, tableServiceUri, logger, telemetry);
});

// Register AIService with Azure OpenAI endpoint
builder.Services.AddScoped<AIService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var endpoint = configuration["AZURE_OPENAI_ENDPOINT"]
        ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT environment variable is not set");
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();
    return new AIService(endpoint, sp.GetRequiredService<ILogger<AIService>>(), telemetryClient);
});

// Register EmailService for sending emails via Azure Communication Services
builder.Services.AddScoped<EmailService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    var communicationServiceEndpoint = configuration["COMMUNICATION_SERVICE_ENDPOINT"]
        ?? throw new InvalidOperationException("COMMUNICATION_SERVICE_ENDPOINT environment variable is not set");
    var emailSenderDomain = configuration["EMAIL_SENDER_DOMAIN"]
        ?? throw new InvalidOperationException("EMAIL_SENDER_DOMAIN environment variable is not set");

    // Storage account is optional - only needed when sending attachments
    // Try configuration first, then fall back to environment variable
    var storageAccountName = configuration["AzureWebJobsStorage__accountName"]
        ?? Environment.GetEnvironmentVariable("AzureWebJobsStorage__accountName");

    var logger = sp.GetRequiredService<ILogger<EmailService>>();
    if (string.IsNullOrEmpty(storageAccountName))
    {
        logger.LogWarning("AzureWebJobsStorage__accountName not found in configuration or environment. Email attachments will not work.");
    }
    else
    {
        logger.LogInformation("EmailService initialized with storage account: {StorageAccountName}", storageAccountName);
    }

    return new EmailService(
        connectionString,
        communicationServiceEndpoint,
        emailSenderDomain,
        storageAccountName,
        sp.GetRequiredService<ILogger<EmailService>>());
});

var app = builder.Build();

app.Run();
