using AdventureWorks.Tools;
using AdventureWorks.Services;
using Microsoft.Extensions.Localization;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.AddConsole(consoleLogOptions =>
{
	// Configure all logs to go to stderr
	consoleLogOptions.LogToStandardErrorThreshold = LogLevel.Trace;
});

// Configure localization
builder.Services.AddLocalization(options => options.ResourcesPath = "Resources");

// Get database connection string from configuration
var connectionString = builder.Configuration.GetConnectionString("AdventureWorks");

// Get OpenAI endpoint from configuration
var openAiEndpoint = builder.Configuration["AZURE_OPENAI_ENDPOINT"]
	?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT configuration is required");

// Register AdventureWorks services with localization
builder.Services.AddScoped<OrderService>(sp =>
{
	var localizer = sp.GetRequiredService<IStringLocalizer<OrderService>>();
	return new OrderService(connectionString!, localizer);
});
builder.Services.AddScoped<ProductService>(sp =>
{
	var localizer = sp.GetRequiredService<IStringLocalizer<ProductService>>();
	return new ProductService(connectionString!, localizer);
});
builder.Services.AddScoped<ReviewService>(sp =>
{
	var localizer = sp.GetRequiredService<IStringLocalizer<ReviewService>>();
	return new ReviewService(connectionString!, localizer);
});
builder.Services.AddScoped<AIService>(sp =>
{
	var logger = sp.GetRequiredService<ILogger<AIService>>();
	return new AIService(openAiEndpoint, logger);
});

// Register MCP server with SSE transport and AdventureWorks tools
builder.Services
	   .AddMcpServer()
	   .WithHttpTransport(o => o.Stateless = false) // Enable stateful SSE transport
	   .WithTools<AdventureWorksMcpTools>();

builder.AddServiceDefaults();

var app = builder.Build();

app.MapDefaultEndpoints();

app.MapMcp("/mcp");

app.Run();