using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
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

// Add OpenTelemetry tracing for distributed tracing
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing =>
    {
        tracing
            .AddHttpClientInstrumentation()
            .AddSqlClientInstrumentation(options =>
            {
                options.SetDbStatementForText = true;
            });
    });

// Configure DefaultAzureCredential for Azure SDK clients
builder.Services.AddSingleton(new DefaultAzureCredential());

// Register HttpClient for MCP tool calls
builder.Services.AddHttpClient();

// Aspire SQL Client with automatic tracing and health checks
builder.AddSqlServerClient("SQL_CONNECTION_STRING");

// Aspire Blob Storage with observability
builder.AddAzureBlobClient("AZURE_STORAGE_CONNECTION_STRING");

// Aspire Queue Storage with observability
builder.AddAzureQueueClient("AZURE_STORAGE_CONNECTION_STRING");

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

// Register AdventureWorks MCP Tools for AI agent integration
builder.Services.AddScoped<AdventureWorksMcpTools>();

// Register AI Agent Service for conversational AI with MCP tools
builder.Services.AddScoped<AIAgentService>();

// Register AIService with Azure OpenAI endpoint
builder.Services.AddScoped<AIService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var endpoint = configuration["AZURE_OPENAI_ENDPOINT"]
        ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT environment variable is not set");
    return new AIService(endpoint, sp.GetRequiredService<ILogger<AIService>>());
});

builder.Build().Run();
