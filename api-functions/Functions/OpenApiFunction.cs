using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.OpenApi.Models;
using System.Net;
using System.Text.Json;

namespace api_functions.Functions;

/// <summary>
/// Serves OpenAPI specification and Swagger UI for API documentation
/// Manually builds OpenAPI spec for Azure Functions isolated worker model
/// </summary>
public class OpenApiFunction
{
    /// <summary>
    /// Get OpenAPI specification in JSON format
    /// </summary>
    [Function("GetOpenApiSpec")]
    public async Task<HttpResponseData> GetOpenApiSpec(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "openapi.json")]
        HttpRequestData req)
    {
        var response = req.CreateResponse(HttpStatusCode.OK);
        response.Headers.Add("Content-Type", "application/json");
        response.Headers.Add("Access-Control-Allow-Origin", "*");

        try
        {
            var openApiDoc = BuildOpenApiDocument();
            var options = new JsonSerializerOptions
            {
                WriteIndented = true,
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            };

            var json = JsonSerializer.Serialize(openApiDoc, options);
            await response.WriteStringAsync(json);
        }
        catch (Exception ex)
        {
            response.StatusCode = HttpStatusCode.InternalServerError;
            await response.WriteAsJsonAsync(new { error = $"Failed to generate OpenAPI spec: {ex.Message}" });
        }

        return response;
    }

    private OpenApiDocument BuildOpenApiDocument()
    {
        var doc = new OpenApiDocument
        {
            Info = new OpenApiInfo
            {
                Version = "v1",
                Title = "AdventureWorks Azure Functions API",
                Description = "API endpoints for AdventureWorks e-commerce platform including addresses, semantic search, and SEO",
                Contact = new OpenApiContact
                {
                    Name = "AdventureWorks Support",
                    Url = new Uri("https://github.com/ahems/AdventureWorks")
                }
            },
            Servers = new List<OpenApiServer>
            {
                new OpenApiServer { Url = "http://localhost:7071", Description = "Local development" }
            },
            Paths = new OpenApiPaths()
        };

        // Add Address endpoints
        AddAddressEndpoints(doc.Paths);

        // Add Search endpoint
        AddSearchEndpoints(doc.Paths);

        // Add SEO endpoint
        AddSeoEndpoints(doc.Paths);

        return doc;
    }

    private void AddAddressEndpoints(OpenApiPaths paths)
    {
        // GET /api/addresses
        paths.Add("/api/addresses", new OpenApiPathItem
        {
            Operations = new Dictionary<OperationType, OpenApiOperation>
            {
                [OperationType.Get] = new OpenApiOperation
                {
                    Summary = "Get all addresses",
                    Description = "Retrieves a paginated list of addresses",
                    Tags = new List<OpenApiTag> { new OpenApiTag { Name = "Addresses" } },
                    Parameters = new List<OpenApiParameter>
                    {
                        new OpenApiParameter
                        {
                            Name = "limit",
                            In = ParameterLocation.Query,
                            Required = false,
                            Description = "Maximum number of addresses to return (default: 100)",
                            Schema = new OpenApiSchema { Type = "integer", Default = new Microsoft.OpenApi.Any.OpenApiInteger(100) }
                        },
                        new OpenApiParameter
                        {
                            Name = "offset",
                            In = ParameterLocation.Query,
                            Required = false,
                            Description = "Number of addresses to skip (default: 0)",
                            Schema = new OpenApiSchema { Type = "integer", Default = new Microsoft.OpenApi.Any.OpenApiInteger(0) }
                        }
                    },
                    Responses = new OpenApiResponses
                    {
                        ["200"] = new OpenApiResponse { Description = "Successfully retrieved addresses" },
                        ["500"] = new OpenApiResponse { Description = "Internal server error" }
                    }
                },
                [OperationType.Post] = new OpenApiOperation
                {
                    Summary = "Create a new address",
                    Description = "Creates a new address entry",
                    Tags = new List<OpenApiTag> { new OpenApiTag { Name = "Addresses" } },
                    RequestBody = new OpenApiRequestBody
                    {
                        Required = true,
                        Description = "Address data to create",
                        Content = new Dictionary<string, OpenApiMediaType>
                        {
                            ["application/json"] = new OpenApiMediaType
                            {
                                Schema = new OpenApiSchema { Type = "object" }
                            }
                        }
                    },
                    Responses = new OpenApiResponses
                    {
                        ["201"] = new OpenApiResponse { Description = "Address created successfully" },
                        ["400"] = new OpenApiResponse { Description = "Invalid request body" },
                        ["500"] = new OpenApiResponse { Description = "Internal server error" }
                    }
                }
            }
        });

        // GET /api/addresses/{id}
        paths.Add("/api/addresses/{id}", new OpenApiPathItem
        {
            Operations = new Dictionary<OperationType, OpenApiOperation>
            {
                [OperationType.Get] = new OpenApiOperation
                {
                    Summary = "Get address by ID",
                    Description = "Retrieves a specific address by its ID",
                    Tags = new List<OpenApiTag> { new OpenApiTag { Name = "Addresses" } },
                    Parameters = new List<OpenApiParameter>
                    {
                        new OpenApiParameter
                        {
                            Name = "id",
                            In = ParameterLocation.Path,
                            Required = true,
                            Description = "The address ID",
                            Schema = new OpenApiSchema { Type = "integer" }
                        }
                    },
                    Responses = new OpenApiResponses
                    {
                        ["200"] = new OpenApiResponse { Description = "Successfully retrieved address" },
                        ["404"] = new OpenApiResponse { Description = "Address not found" },
                        ["500"] = new OpenApiResponse { Description = "Internal server error" }
                    }
                },
                [OperationType.Put] = new OpenApiOperation
                {
                    Summary = "Update an address",
                    Description = "Updates an existing address by ID",
                    Tags = new List<OpenApiTag> { new OpenApiTag { Name = "Addresses" } },
                    Parameters = new List<OpenApiParameter>
                    {
                        new OpenApiParameter
                        {
                            Name = "id",
                            In = ParameterLocation.Path,
                            Required = true,
                            Description = "The address ID to update",
                            Schema = new OpenApiSchema { Type = "integer" }
                        }
                    },
                    RequestBody = new OpenApiRequestBody
                    {
                        Required = true,
                        Description = "Address data to update",
                        Content = new Dictionary<string, OpenApiMediaType>
                        {
                            ["application/json"] = new OpenApiMediaType
                            {
                                Schema = new OpenApiSchema { Type = "object" }
                            }
                        }
                    },
                    Responses = new OpenApiResponses
                    {
                        ["200"] = new OpenApiResponse { Description = "Address updated successfully" },
                        ["404"] = new OpenApiResponse { Description = "Address not found" },
                        ["400"] = new OpenApiResponse { Description = "Invalid request body" },
                        ["500"] = new OpenApiResponse { Description = "Internal server error" }
                    }
                },
                [OperationType.Delete] = new OpenApiOperation
                {
                    Summary = "Delete an address",
                    Description = "Deletes an address by ID",
                    Tags = new List<OpenApiTag> { new OpenApiTag { Name = "Addresses" } },
                    Parameters = new List<OpenApiParameter>
                    {
                        new OpenApiParameter
                        {
                            Name = "id",
                            In = ParameterLocation.Path,
                            Required = true,
                            Description = "The address ID to delete",
                            Schema = new OpenApiSchema { Type = "integer" }
                        }
                    },
                    Responses = new OpenApiResponses
                    {
                        ["204"] = new OpenApiResponse { Description = "Address deleted successfully" },
                        ["404"] = new OpenApiResponse { Description = "Address not found" },
                        ["500"] = new OpenApiResponse { Description = "Internal server error" }
                    }
                }
            }
        });
    }

    private void AddSearchEndpoints(OpenApiPaths paths)
    {
        paths.Add("/api/search/semantic", new OpenApiPathItem
        {
            Operations = new Dictionary<OperationType, OpenApiOperation>
            {
                [OperationType.Post] = new OpenApiOperation
                {
                    Summary = "Semantic search",
                    Description = "Performs AI-powered semantic search across products and reviews using embeddings",
                    Tags = new List<OpenApiTag> { new OpenApiTag { Name = "Search" } },
                    RequestBody = new OpenApiRequestBody
                    {
                        Required = true,
                        Description = "Search query and parameters",
                        Content = new Dictionary<string, OpenApiMediaType>
                        {
                            ["application/json"] = new OpenApiMediaType
                            {
                                Schema = new OpenApiSchema
                                {
                                    Type = "object",
                                    Properties = new Dictionary<string, OpenApiSchema>
                                    {
                                        ["query"] = new OpenApiSchema { Type = "string", Description = "Search query text" },
                                        ["limit"] = new OpenApiSchema { Type = "integer", Description = "Maximum results (default: 10)" },
                                        ["similarityThreshold"] = new OpenApiSchema { Type = "number", Description = "Minimum similarity (default: 0.7)" }
                                    },
                                    Required = new HashSet<string> { "query" }
                                }
                            }
                        }
                    },
                    Responses = new OpenApiResponses
                    {
                        ["200"] = new OpenApiResponse { Description = "Search results with matching products and reviews" },
                        ["400"] = new OpenApiResponse { Description = "Invalid request body" },
                        ["500"] = new OpenApiResponse { Description = "Internal server error" }
                    }
                }
            }
        });
    }

    private void AddSeoEndpoints(OpenApiPaths paths)
    {
        paths.Add("/api/sitemap.xml", new OpenApiPathItem
        {
            Operations = new Dictionary<OperationType, OpenApiOperation>
            {
                [OperationType.Get] = new OpenApiOperation
                {
                    Summary = "Generate sitemap",
                    Description = "Generates an XML sitemap for SEO with all products and static pages",
                    Tags = new List<OpenApiTag> { new OpenApiTag { Name = "SEO" } },
                    Responses = new OpenApiResponses
                    {
                        ["200"] = new OpenApiResponse
                        {
                            Description = "Successfully generated XML sitemap",
                            Content = new Dictionary<string, OpenApiMediaType>
                            {
                                ["application/xml"] = new OpenApiMediaType
                                {
                                    Schema = new OpenApiSchema { Type = "string" }
                                }
                            }
                        },
                        ["500"] = new OpenApiResponse { Description = "Internal server error" }
                    }
                }
            }
        });
    }

    /// <summary>
    /// Get Swagger UI for interactive API documentation
    /// </summary>
    [Function("GetSwaggerUI")]
    public async Task<HttpResponseData> GetSwaggerUI(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "swagger/ui")]
        HttpRequestData req)
    {
        var response = req.CreateResponse(HttpStatusCode.OK);
        response.Headers.Add("Content-Type", "text/html");

        var baseUrl = $"{req.Url.Scheme}://{req.Url.Authority}";

        var html = $@"<!DOCTYPE html>
<html lang=""en"">
<head>
    <meta charset=""UTF-8"">
    <title>AdventureWorks API Documentation</title>
    <link rel=""stylesheet"" type=""text/css"" href=""https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.10.3/swagger-ui.min.css"" />
    <style>
        body {{
            margin: 0;
            padding: 0;
        }}
    </style>
</head>
<body>
    <div id=""swagger-ui""></div>
    <script src=""https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.10.3/swagger-ui-bundle.min.js""></script>
    <script src=""https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.10.3/swagger-ui-standalone-preset.min.js""></script>
    <script>
        window.onload = function() {{
            SwaggerUIBundle({{
                url: '{baseUrl}/api/openapi.json',
                dom_id: '#swagger-ui',
                deepLinking: true,
                presets: [
                    SwaggerUIBundle.presets.apis,
                    SwaggerUIStandalonePreset
                ],
                plugins: [
                    SwaggerUIBundle.plugins.DownloadUrl
                ],
                layout: ""StandaloneLayout""
            }});
        }};
    </script>
</body>
</html>";

        await response.WriteStringAsync(html);
        return response;
    }
}
