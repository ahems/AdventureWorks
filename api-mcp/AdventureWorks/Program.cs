using AdventureWorks.Services;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.Extensions.Localization;
using ModelContextProtocol.Extensions.Tasks;
using ModelContextProtocol.Protocol;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.AddConsole(consoleLogOptions =>
{
	// Configure all logs to go to stderr
	consoleLogOptions.LogToStandardErrorThreshold = LogLevel.Trace;
});

// Add Application Insights telemetry
builder.Services.AddApplicationInsightsTelemetry();

// Configure localization (Microsoft.Extensions.Localization is actively used by services below)
// Services inject IStringLocalizer<Strings> for multilingual message formatting in OrderService, ProductService, ReviewService, and others
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

// Register CustomerGeneratorService for random fake customer data (Bogus)
builder.Services.AddSingleton<CustomerGeneratorService>();

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
builder.Services.AddHttpClient<SimulatorService>(client =>
{
	client.BaseAddress = new Uri(apiFunctionsUrl.TrimEnd('/') + "/");
});

// Resolve task store: durable Azure Table Storage when a storage account is configured, else in-memory
var storageAccountName = builder.Configuration["AzureWebJobsStorage:accountName"]
	?? Environment.GetEnvironmentVariable("STORAGE_ACCOUNT_NAME");
IMcpTaskStore taskStore = !string.IsNullOrEmpty(storageAccountName)
	? new AzureTableMcpTaskStore(storageAccountName)
	: new InMemoryMcpTaskStore();

// Register MCP server (v2.0 — stateless by default, assembly-level tool discovery)
builder.Services
	   .AddMcpServer()
	   .WithHttpTransport()
	   .WithToolsFromAssembly()
	   .WithTasks(taskStore)
	   .WithRequestFilters(filters =>
	   {
		   // Centralized Application Insights telemetry for every tool call
		   filters.AddCallToolFilter(next => async (context, ct) =>
		   {
			   var telemetry = context.Services.GetRequiredService<TelemetryClient>();
			   var toolName = context.Params?.Name ?? "unknown";
			   using var operation = telemetry.StartOperation<RequestTelemetry>($"MCP_{toolName}");

			   if (context.Params?.Arguments is { } args)
			   {
				   foreach (var kvp in args)
					   operation.Telemetry.Properties[kvp.Key] = kvp.Value.ToString()[..Math.Min(kvp.Value.ToString().Length, 200)];
			   }

			   try
			   {
				   var result = await next(context, ct);
				   operation.Telemetry.Success = true;
				   telemetry.TrackEvent("MCP_ToolExecuted", new Dictionary<string, string> { { "tool", toolName } });
				   return result;
			   }
			   catch (Exception ex) when (ex is not InputRequiredException)
			   {
				   operation.Telemetry.Success = false;
				   telemetry.TrackException(ex, new Dictionary<string, string> { { "tool", toolName } });
				   throw;
			   }
		   });
	   });

builder.AddServiceDefaults();

var app = builder.Build();

app.MapDefaultEndpoints();

app.MapMcp("/mcp");

app.Run();