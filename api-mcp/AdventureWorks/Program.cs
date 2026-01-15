using AdventureWorks.Tools;
using AdventureWorks.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.AddConsole(consoleLogOptions =>
{
	// Configure all logs to go to stderr
	consoleLogOptions.LogToStandardErrorThreshold = LogLevel.Trace;
});

// Get database connection string from configuration
var connectionString = builder.Configuration.GetConnectionString("AdventureWorks");

// Get OpenAI endpoint from configuration
var openAiEndpoint = builder.Configuration["AZURE_OPENAI_ENDPOINT"]
	?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT configuration is required");

// Register AdventureWorks services
builder.Services.AddScoped<OrderService>(sp => new OrderService(connectionString!));
builder.Services.AddScoped<ProductService>(sp => new ProductService(connectionString!));
builder.Services.AddScoped<ReviewService>(sp => new ReviewService(connectionString!));
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