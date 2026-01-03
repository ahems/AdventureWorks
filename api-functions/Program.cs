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

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

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

// Register AIService with Azure OpenAI endpoint
builder.Services.AddScoped<AIService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var endpoint = configuration["AZURE_OPENAI_ENDPOINT"]
        ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT environment variable is not set");
    return new AIService(endpoint, sp.GetRequiredService<ILogger<AIService>>());
});

builder.Build().Run();
