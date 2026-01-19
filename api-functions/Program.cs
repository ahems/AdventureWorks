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
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Hosting.AzureFunctions;
using Microsoft.Extensions.AI;
using Azure.AI.OpenAI;
using ModelContextProtocol.Client;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

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

// Register PasswordService for password hashing and verification
builder.Services.AddScoped<PasswordService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new PasswordService(connectionString);
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

// Create and register Durable Agent with MCP tools
// Note: This runs synchronously at startup, so MCP initialization happens before agent registration
var config = builder.Configuration;
var mcpServerUrl = config["MCP_SERVICE_URL"];
if (string.IsNullOrEmpty(mcpServerUrl))
{
    mcpServerUrl = "http://localhost:5000/mcp";
}

// Initialize MCP client synchronously (required for durable agent registration)
var mcpClient = McpClient.CreateAsync(
    new HttpClientTransport(
        new()
        {
            Name = "AdventureWorks MCP",
            Endpoint = new Uri(mcpServerUrl.TrimEnd('/'))
        }
    )
).GetAwaiter().GetResult();

var mcpTools = mcpClient.ListToolsAsync().GetAwaiter().GetResult();
Console.WriteLine($"Loaded {mcpTools.Count} MCP tools for durable agent from {mcpServerUrl}");

// Create the durable agent with Azure OpenAI and MCP tools
var endpoint = config["AZURE_OPENAI_ENDPOINT"]
    ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT environment variable is not set");
var deploymentName = config["chatGptDeploymentName"] ?? "chat";

var durableAgent = new AzureOpenAIClient(new Uri(endpoint), defaultCredential)
    .GetChatClient(deploymentName)
    .AsIChatClient()
    .CreateAIAgent(
        instructions: @"You are a helpful customer service assistant for AdventureWorks, an outdoor and sporting goods retailer.

You have access to tools that allow you to:
- Retrieve customer order history and order details
- Search for products and get detailed product information
- Find complementary products and personalized recommendations
- Analyze product reviews and customer sentiment
- Check real-time inventory availability across warehouses

Guidelines:
- Be friendly, professional, and helpful
- When you need to use a tool, tell the customer what you're checking
- Provide clear, concise answers
- If you need more information (like order number or product ID), ask for it
- Suggest relevant products and help with purchase decisions
- Always maintain customer context throughout the conversation",
        name: "AdventureWorksAgent",
        tools: mcpTools.ToArray());

// Configure as durable agent for Azure Functions
builder.ConfigureDurableAgents(options => options.AddAIAgent(durableAgent));

builder.Build().Run();
