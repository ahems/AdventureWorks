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

// Register AdventureWorks services
builder.Services.AddScoped<OrderService>(sp => new OrderService(connectionString!));
builder.Services.AddScoped<ProductService>(sp => new ProductService(connectionString!));
builder.Services.AddScoped<ReviewService>(sp => new ReviewService(connectionString!));

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