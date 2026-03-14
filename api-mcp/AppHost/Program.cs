using Aspire.Hosting.Azure;

var builder = DistributedApplication.CreateBuilder(args);

builder.AddProject<Projects.AdventureWorks>("adventureworks-mcp")
	   .WithExternalHttpEndpoints();

builder.AddAzureFunctionsProject<Projects.api_functions>("api-functions");

builder.Build().Run();
