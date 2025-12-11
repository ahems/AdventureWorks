using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Configuration;
using AddressFunctions.Services;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

// Configure services
builder.Services
    .AddApplicationInsightsTelemetryWorkerService()
    .ConfigureFunctionsApplicationInsights();

// Register AddressService with connection string from configuration
builder.Services.AddScoped<AddressService>(sp =>
{
    var configuration = sp.GetRequiredService<IConfiguration>();
    var connectionString = configuration["SQL_CONNECTION_STRING"] 
        ?? throw new InvalidOperationException("SQL_CONNECTION_STRING environment variable is not set");
    return new AddressService(connectionString);
});

builder.Build().Run();
