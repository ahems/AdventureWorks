using Aspire.Hosting.Azure.Functions;

var builder = DistributedApplication.CreateBuilder(args);

builder.AddProject<Projects.AdventureWorks>("adventureworks-mcp")
	   .WithExternalHttpEndpoints();

builder.AddAzureFunctionsProject<Projects.ApiFunctions>("api-functions");

builder.Build().Run();
