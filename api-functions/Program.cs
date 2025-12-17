using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Azure.Identity;
using AddressFunctions.Services;
using api_functions.Services;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

// Configure services
builder.Services
    .AddApplicationInsightsTelemetryWorkerService()
    .ConfigureFunctionsApplicationInsights();

// Configure DefaultAzureCredential for Azure SDK clients
builder.Services.AddSingleton(new DefaultAzureCredential());

// Register AddressService with connection string from configuration
builder.Services.AddScoped<AddressService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new AddressService(connectionString);
});

// Register ProductService with connection string from configuration
builder.Services.AddScoped<ProductService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"]
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new ProductService(connectionString);
});

// Register AIService with Azure OpenAI endpoint from configuration
builder.Services.AddScoped<AIService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var endpoint = configuration["AZURE_OPENAI_ENDPOINT"]
        ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT environment variable is not set");
    return new AIService(endpoint, sp.GetRequiredService<ILogger<AIService>>());
});

builder.Build().Run();
