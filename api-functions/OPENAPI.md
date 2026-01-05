# OpenAPI Specification for Azure Functions

This project includes OpenAPI (Swagger) documentation for all HTTP-triggered Azure Functions endpoints.

## ⚠️ Important: Azure Deployment Note

Due to compatibility limitations with `Microsoft.Azure.WebJobs.Extensions.OpenApi` in .NET 8 isolated worker mode on Azure, we use a **manual OpenAPI serving approach** that works both locally and in Azure.

## Accessing the OpenAPI Spec

### Azure Deployment (Production)

```bash
# Get your function URL
FUNCTION_URL=$(azd env get-values | grep FUNCTION_URL | cut -d'=' -f2 | tr -d '"')

# Access OpenAPI endpoints
$FUNCTION_URL/api/openapi.json       # OpenAPI JSON spec
$FUNCTION_URL/api/swagger/ui         # Swagger UI (interactive documentation)
```

Example:

```
https://av-func-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/swagger/ui
```

### Local Development

```bash
# Start the Functions app locally
cd api-functions
func start

# Access OpenAPI endpoints (via extension - works locally)
http://localhost:7071/api/swagger.json         # OpenAPI JSON spec (from extension)
http://localhost:7071/api/swagger/ui           # Swagger UI (from extension)

# Access via manual endpoints (same as Azure)
http://localhost:7071/api/openapi.json         # OpenAPI JSON spec (manual)
http://localhost:7071/api/swagger/ui           # Swagger UI (manual - same path!)
```

### After Deploying with `azd up`

```bash
# Get the function app URL
FUNCTION_URL=$(azd env get-values | grep FUNCTION_URL | cut -d'=' -f2 | tr -d '"')

# Access OpenAPI endpoints
$FUNCTION_URL/api/openapi.json       # OpenAPI JSON spec
$FUNCTION_URL/api/swagger/ui         # Swagger UI
```

## Updating the OpenAPI Spec

When you add new functions or modify existing ones:

### Step 1: Generate Spec Locally

```bash
# Start functions locally
cd api-functions
func start

# In another terminal, generate the spec
cd api-functions
./generate-openapi-spec.sh
```

This creates `openapi-spec.json` from the locally running functions.

### Step 2: Deploy to Azure

```bash
azd deploy api-functions
```

The `openapi-spec.json` file is automatically included in the deployment.

## Available Endpoints

The OpenAPI spec documents all HTTP-triggered functions including:

### Addresses API

- `GET /api/addresses` - Get all addresses (with pagination)
- `GET /api/addresses/{id}` - Get address by ID
- `POST /api/addresses` - Create new address
- `PUT /api/addresses/{id}` - Update address
- `DELETE /api/addresses/{id}` - Delete address

### Search API

- `POST /api/search/semantic` - AI-powered semantic search using embeddings

### SEO API

- `GET /api/sitemap.xml` - Generate dynamic XML sitemap

## OpenAPI Attributes

Functions are decorated with OpenAPI attributes that provide:

- **Operation metadata**: operationId, tags, summary, description
- **Parameter documentation**: path parameters, query parameters, headers
- **Request body schemas**: JSON body types and descriptions
- **Response schemas**: Status codes, content types, and response types
- **Error responses**: Documented error scenarios

### Example

```csharp
[Function("GetAddressById")]
[OpenApiOperation(
    operationId: "GetAddressById",
    tags: new[] { "Addresses" },
    Summary = "Get address by ID",
    Description = "Retrieves a specific address by its ID"
)]
[OpenApiParameter(
    name: "id",
    In = ParameterLocation.Path,
    Required = true,
    Type = typeof(int),
    Description = "The address ID"
)]
[OpenApiResponseWithBody(
    statusCode: HttpStatusCode.OK,
    contentType: "application/json",
    bodyType: typeof(Address),
    Description = "Successfully retrieved address"
)]
public async Task<HttpResponseData> GetAddressById(...)
```

## Using the Swagger UI

The Swagger UI provides an interactive interface to:

1. Browse all available endpoints
2. View detailed parameter and response documentation
3. Test endpoints directly from the browser
4. Copy curl commands
5. Download the OpenAPI spec in JSON or YAML format

## Integration with API Clients

The OpenAPI spec can be used to generate client SDKs using tools like:

- **OpenAPI Generator**: Generate clients for multiple languages
- **AutoRest**: Microsoft's client generation tool
- **Swagger Codegen**: Popular code generation tool
- **Postman**: Import OpenAPI spec to create collections

### Example: Generate TypeScript Client

```bash
# Install OpenAPI Generator
npm install -g @openapitools/openapi-generator-cli

# Generate TypeScript client
openapi-generator-cli generate \
  -i http://localhost:7071/api/swagger.json \
  -g typescript-fetch \
  -o ./generated-client
```

## Configuration

OpenAPI configuration is in [Program.cs](Program.cs):

```csharp
builder.Services.AddSingleton<IOpenApiConfigurationOptions>(_ =>
{
    var options = new OpenApiConfigurationOptions()
    {
        Info = new OpenApiInfo()
        {
            Version = "v1",
            Title = "AdventureWorks Azure Functions API",
            Description = "API endpoints for AdventureWorks e-commerce platform"
        },
        OpenApiVersion = OpenApiVersionType.V3,
        IncludeRequestingHostName = true
    };
    return options;
});
```

## Adding OpenAPI to New Functions

When creating new HTTP-triggered functions:

1. **Add using statements**:

```csharp
using Microsoft.Azure.WebJobs.Extensions.OpenApi.Core.Attributes;
using Microsoft.OpenApi.Models;
```

2. **Add OpenAPI attributes** before the function:

```csharp
[OpenApiOperation(operationId: "YourOperation", tags: new[] { "YourTag" })]
[OpenApiParameter(name: "param", In = ParameterLocation.Query, ...)]
[OpenApiRequestBody(contentType: "application/json", bodyType: typeof(YourType))]
[OpenApiResponseWithBody(statusCode: HttpStatusCode.OK, ...)]
```

3. **Document all response codes**: Include success and error responses

## Resources

- [Microsoft.Azure.WebJobs.Extensions.OpenApi Documentation](https://github.com/Azure/azure-functions-openapi-extension)
- [OpenAPI Specification](https://swagger.io/specification/)
- [Swagger UI](https://swagger.io/tools/swagger-ui/)
