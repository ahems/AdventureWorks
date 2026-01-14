var builder = DistributedApplication.CreateBuilder(args);

builder.AddProject<Projects.AdventureWorks>("adventureworks-mcp")
	   .WithExternalHttpEndpoints();

builder.Build().Run();
