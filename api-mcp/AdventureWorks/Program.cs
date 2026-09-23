using AdventureWorks.Auth;
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
		   // OAuth authorization: re-evaluate the validated token's scopes and (for
		   // consumers) record ownership on EVERY tools/call. Registered first so denials
		   // short-circuit before any tool executes. Returns a safe error result on deny.
		   filters.AddCallToolFilter(next => async (context, ct) =>
		   {
			   var denial = await McpToolAuthorizationFilter.AuthorizeAsync(context, ct);
			   return denial ?? await next(context, ct);
		   });

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

// Self-contained OAuth authorization server + resource-server validation for MCP.
var authOptions = builder.AddMcpAuthorization(connectionString ?? string.Empty);

var app = builder.Build();

// AuthN/AuthZ, OAuth endpoints (authorize/token/login/consent/logout), protected-resource
// metadata, and the /mcp WWW-Authenticate challenge. Must precede endpoint mapping.
app.UseMcpAuthorization(authOptions);

app.MapDefaultEndpoints();

// /mcp requires a valid resource-bound token carrying the mcp.access scope.
app.MapMcp("/mcp").RequireAuthorization(McpAuthorizationExtensions.McpPolicy);

// Fail fast unless every discovered MCP tool has an authorization policy.
app.ValidateToolAuthorizationCoverage();

app.Run();

/// <summary>
/// Exposes the implicit Program class to the test project so
/// <see cref="Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory{TEntryPoint}"/> can
/// boot the OAuth authorization server in-process for endpoint/JWKS/metadata tests.
/// </summary>
public partial class Program { }