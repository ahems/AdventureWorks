using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.ApplicationInsights;
using Azure.Identity;
using AddressFunctions.Services;
using api_functions.Services;
using OpenTelemetry.Trace;
using OpenTelemetry.Metrics;
using Microsoft.OpenApi.Models;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

// Configure Swashbuckle for OpenAPI documentation
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo
    {
        Version = "v1",
        Title = "AdventureWorks Azure Functions API",
        Description = "API endpoints for AdventureWorks e-commerce platform including addresses, semantic search, and SEO",
        Contact = new OpenApiContact
        {
            Name = "AdventureWorks Support",
            Url = new Uri("https://github.com/ahems/AdventureWorks")
        }
    });

    // Include XML comments if available
    var xmlFile = $"{System.Reflection.Assembly.GetExecutingAssembly().GetName().Name}.xml";
    var xmlPath = Path.Combine(AppContext.BaseDirectory, xmlFile);
    if (File.Exists(xmlPath))
    {
        c.IncludeXmlComments(xmlPath);
    }
});

// Configure Application Insights + OpenTelemetry for enhanced observability
builder.Services
    .AddApplicationInsightsTelemetryWorkerService()
    .ConfigureFunctionsApplicationInsights();

// Add OpenTelemetry tracing for distributed tracing with Agent Framework support
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddHttpClientInstrumentation()
            .AddSqlClientInstrumentation(options =>
            {
                options.SetDbStatementForText = true;
            })
            .AddSource("Microsoft.Agents.*")  // Agent Framework tracing
            .AddSource("AIAgentService");      // Custom agent service tracing
    });

// Configure DefaultAzureCredential for Azure SDK clients
// This will use: Azure CLI > Environment > Workload Identity > Managed Identity
var defaultCredential = new DefaultAzureCredential(new DefaultAzureCredentialOptions
{
    ExcludeManagedIdentityCredential = false,
    ExcludeEnvironmentCredential = false
});
builder.Services.AddSingleton(defaultCredential);

// Register HttpClient for MCP tool calls
builder.Services.AddHttpClient();

// Aspire SQL Client with automatic tracing and health checks
builder.AddSqlServerClient("SQL_CONNECTION_STRING");

// Aspire Blob Storage with observability (only if connection string is configured)
var storageConnectionString = builder.Configuration["AZURE_STORAGE_CONNECTION_STRING"];
if (!string.IsNullOrEmpty(storageConnectionString))
{
    builder.AddAzureBlobClient("AZURE_STORAGE_CONNECTION_STRING");
    builder.AddAzureQueueClient("AZURE_STORAGE_CONNECTION_STRING");
}

// Register custom services with connection string from configuration
builder.Services.AddScoped<AddressService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new AddressService(connectionString);
});

builder.Services.AddScoped<ProductService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new ProductService(connectionString);
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

// Register PdfReceiptGenerator for PDF receipt generation
builder.Services.AddScoped<PdfReceiptGenerator>();

// Register AI Agent Service for conversational AI with MCP tools using Microsoft Agent Framework
// Service handles MCP client lifecycle and provides durable agent capabilities
builder.Services.AddScoped<AIAgentService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var logger = sp.GetRequiredService<ILogger<AIAgentService>>();
    var httpClientFactory = sp.GetRequiredService<IHttpClientFactory>();
    var telemetryClient = sp.GetRequiredService<TelemetryClient>();

    return new AIAgentService(
        logger,
        configuration,
        httpClientFactory,
        telemetryClient);
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

    // Debug: Log if storage account name is found
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

builder.Build().Run();
