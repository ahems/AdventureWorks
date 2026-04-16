using AdventureWorks.Tools;
using AdventureWorks.Services;
using Microsoft.ApplicationInsights;
using Microsoft.Extensions.Localization;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.AddConsole(consoleLogOptions =>
{
	// Configure all logs to go to stderr
	consoleLogOptions.LogToStandardErrorThreshold = LogLevel.Trace;
});

// Add Application Insights telemetry
builder.Services.AddApplicationInsightsTelemetry();

// Configure localization
builder.Services.AddLocalization();

// Get database connection string from configuration
var connectionString = builder.Configuration.GetConnectionString("AdventureWorks");

// Get OpenAI endpoint from configuration
var openAiEndpoint = builder.Configuration["AZURE_OPENAI_ENDPOINT"]
	?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT configuration is required");

// Get api-functions base URL for manufacturing and supply chain tools
var apiFunctionsUrl = builder.Configuration["API_FUNCTIONS_URL"]
	?? Environment.GetEnvironmentVariable("API_FUNCTIONS_URL")
	?? throw new InvalidOperationException("API_FUNCTIONS_URL configuration is required for manufacturing and supply chain tools");

// Register AdventureWorks services with localization
builder.Services.AddScoped<OrderService>(sp =>
{
	var localizer = sp.GetRequiredService<IStringLocalizer<AdventureWorks.Resources.Strings>>();
	return new OrderService(connectionString!, localizer);
});
builder.Services.AddScoped<ProductService>(sp =>
{
	var localizer = sp.GetRequiredService<IStringLocalizer<AdventureWorks.Resources.Strings>>();
	return new ProductService(connectionString!, localizer);
});
builder.Services.AddScoped<ReviewService>(sp =>
{
	var localizer = sp.GetRequiredService<IStringLocalizer<AdventureWorks.Resources.Strings>>();
	return new ReviewService(connectionString!, localizer);
});
builder.Services.AddScoped<AIService>(sp =>
{
	var logger = sp.GetRequiredService<ILogger<AIService>>();
	var telemetryClient = sp.GetRequiredService<TelemetryClient>();
	return new AIService(openAiEndpoint, logger, telemetryClient);
});

// Register HttpClient factories for api-functions proxy services
builder.Services.AddHttpClient<ManufacturingService>(client =>
{
	client.BaseAddress = new Uri(apiFunctionsUrl.TrimEnd('/') + "/");
});
builder.Services.AddHttpClient<SupplyChainService>(client =>
{
	client.BaseAddress = new Uri(apiFunctionsUrl.TrimEnd('/') + "/");
});
builder.Services.AddHttpClient<BankService>(client =>
{
	client.BaseAddress = new Uri(apiFunctionsUrl.TrimEnd('/') + "/");
});

// Register MCP server with SSE transport and AdventureWorks tools
builder.Services
	   .AddMcpServer()
	   .WithHttpTransport(o => o.Stateless = true) // Stateless mode: no session IDs required, compatible with Azure AI Foundry agents
	   .WithTools<AdventureWorksMcpTools>()
	   .WithTools<ManufacturingMcpTools>()
	   .WithTools<SupplyChainMcpTools>()
	   .WithTools<BankMcpTools>();

builder.AddServiceDefaults();

var app = builder.Build();

app.MapDefaultEndpoints();

app.MapMcp("/mcp");

app.Run();