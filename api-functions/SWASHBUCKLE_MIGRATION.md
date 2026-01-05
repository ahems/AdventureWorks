# OpenAPI Migration: Old Extension → Swashbuckle

## Quick Comparison

| Aspect           | Old (Extensions.OpenApi)                            | New (Swashbuckle)               |
| ---------------- | --------------------------------------------------- | ------------------------------- |
| Package          | `Microsoft.Azure.WebJobs.Extensions.OpenApi` v1.5.1 | `Swashbuckle.AspNetCore` v6.5.0 |
| .NET 8 Support   | Limited                                             | Full                            |
| Azure Deployment | ❌ Doesn't work in Container Apps                   | ✅ Works everywhere             |
| Documentation    | Special attributes                                  | Standard XML comments           |
| Configuration    | `IOpenApiConfigurationOptions`                      | `AddSwaggerGen()`               |
| Discovery        | Automatic                                           | Automatic                       |

## Code Migration Examples

### Before (Old Extension)

```csharp
using Microsoft.Azure.WebJobs.Extensions.OpenApi.Core.Attributes;
using Microsoft.OpenApi.Models;

[Function("GetAddresses")]
[OpenApiOperation(operationId: "GetAddresses", tags: new[] { "Addresses" })]
[OpenApiParameter(name: "limit", In = ParameterLocation.Query, Required = false, Type = typeof(int))]
[OpenApiResponseWithBody(statusCode: HttpStatusCode.OK, contentType: "application/json", bodyType: typeof(List<Address>))]
public async Task<HttpResponseData> GetAddresses(
    [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "addresses")] HttpRequestData req)
{
    // Implementation
}
```

### After (Swashbuckle)

```csharp
// No special imports needed!

/// <summary>
/// Get all addresses with pagination
/// </summary>
/// <param name="req">HTTP request with optional query parameters: limit (default 100), offset (default 0)</param>
/// <returns>Paginated list of addresses</returns>
/// <response code="200">Successfully retrieved addresses</response>
[Function("GetAddresses")]
public async Task<HttpResponseData> GetAddresses(
    [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "addresses")] HttpRequestData req)
{
    // Implementation
}
```

## Migration Checklist

- [x] Remove `Microsoft.Azure.WebJobs.Extensions.OpenApi` package
- [x] Add `Swashbuckle.AspNetCore` v6.5.0 package
- [x] Update Program.cs configuration
  - [x] Remove `IOpenApiConfigurationOptions` service registration
  - [x] Add `AddSwaggerGen()` configuration
- [x] Enable XML documentation generation in csproj
  - [x] Add `<GenerateDocumentationFile>true</GenerateDocumentationFile>`
  - [x] Add `<NoWarn>$(NoWarn);1591</NoWarn>`
- [x] Update function files
  - [x] Remove OpenAPI using statements
  - [x] Remove `[OpenApiOperation]` attributes
  - [x] Remove `[OpenApiParameter]` attributes
  - [x] Remove `[OpenApiRequestBody]` attributes
  - [x] Remove `[OpenApiResponseWithBody]` attributes
  - [x] Add XML documentation comments
- [x] Update OpenApiFunction.cs
  - [x] Inject `ISwaggerProvider` service
  - [x] Use Swashbuckle to generate spec dynamically
- [x] Test locally
- [ ] Deploy to Azure
- [ ] Verify Swagger UI works in production

## Files Changed

### Modified Files

1. **api-functions/api-functions.csproj**

   - Removed: `Microsoft.Azure.WebJobs.Extensions.OpenApi` v1.5.1
   - Added: `Swashbuckle.AspNetCore` v6.5.0
   - Added: XML documentation generation

2. **api-functions/Program.cs**

   - Removed: OpenAPI extension configuration
   - Added: Swashbuckle configuration with metadata

3. **api-functions/Functions/AddressFunctions.cs**

   - Removed: OpenAPI attributes
   - Added: XML documentation comments

4. **api-functions/Functions/SemanticSearchFunction.cs**

   - Removed: OpenAPI attributes
   - Added: XML documentation comments

5. **api-functions/Functions/SitemapFunction.cs**

   - Removed: OpenAPI attributes
   - Added: XML documentation comments

6. **api-functions/Functions/OpenApiFunction.cs**
   - Complete rewrite to use `ISwaggerProvider`
   - Dynamic spec generation instead of serving static file

### New Files

1. **api-functions/test-swashbuckle.sh** - Test script for Swashbuckle endpoints
2. **api-functions/SWASHBUCKLE_OPENAPI.md** - Documentation for Swashbuckle integration
3. **api-functions/SWASHBUCKLE_MIGRATION.md** - This migration guide

## Testing After Migration

### Local Testing

```bash
# Build the project
cd api-functions
dotnet build

# Start the Functions host
func start

# In another terminal, test the endpoints
./test-swashbuckle.sh

# Open Swagger UI in browser
open http://localhost:7071/api/swagger/ui
```

### Azure Testing

```bash
# Deploy to Azure
azd deploy api-functions

# Get the function URL
FUNCTION_URL=$(azd env get-values | grep FUNCTION_URL | cut -d'=' -f2 | tr -d '"')

# Test OpenAPI spec
curl "$FUNCTION_URL/openapi.json"

# Open Swagger UI
echo "Visit: $FUNCTION_URL/swagger/ui"
```

## Expected Behavior

### ✅ What Should Work

- OpenAPI spec generation at `/api/openapi.json`
- Swagger UI at `/api/swagger/ui`
- All HTTP-triggered functions appear in the spec
- XML documentation shows up in Swagger UI
- Works both locally and in Azure Container Apps

### ❌ What Changed

- No longer need static `openapi-spec.json` file
- No special OpenAPI attributes required
- Configuration is simpler and more standard
- Better IntelliSense support in IDE

## Advantages of Swashbuckle

1. **Industry Standard**: Most popular OpenAPI tool for .NET
2. **Better Support**: Active development and community
3. **Azure Compatible**: Works in all Azure hosting environments
4. **Simpler**: Standard XML comments vs. special attributes
5. **Dynamic**: Spec generated at runtime, always up-to-date
6. **Flexible**: Easy to customize and extend

## Next Steps

To add OpenAPI documentation to additional functions:

1. Add XML documentation comments above the function
2. Use standard `<summary>`, `<param>`, `<returns>`, and `<response>` tags
3. Build the project
4. The function automatically appears in the OpenAPI spec

No additional configuration or attributes needed!

## Rollback (If Needed)

If you need to rollback to the old extension:

```bash
cd api-functions
dotnet remove package Swashbuckle.AspNetCore
dotnet add package Microsoft.Azure.WebJobs.Extensions.OpenApi --version 1.5.1
git restore Program.cs Functions/
```

However, note that the old extension has known issues with Azure Container Apps deployment.
