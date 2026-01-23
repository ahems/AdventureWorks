# AdventureWorks E-Commerce - AI Agent Instructions

## Architecture Overview

This is a **3-tier Azure application** demonstrating enterprise patterns with passwordless authentication:

- **Frontend** (`app/`): React + TypeScript + Vite SPA deployed as Azure Static Web App
- **Backend API** (`api/`): Microsoft Data API Builder (DAB) providing GraphQL + REST, running in Azure Container Apps
- **Serverless Functions** (`api-functions/`): .NET 8 Azure Functions in Container Apps for custom business logic
- **Database**: Azure SQL with AdventureWorks schema using Entra ID authentication
- **Infrastructure** (`infra/`): Bicep modules with modular service definitions

### Data Flow Pattern

```
User → Static Web App → GraphQL (DAB) → Azure SQL
                     ↘ Azure Functions → Azure SQL
```

All services authenticate via **Managed Identity** (passwordless). No connection strings in code.

## Critical Development Workflows

### Local Development Setup

**IMPORTANT**: DO NOT remove the Azure Infrastructure or Azure resources while developing locally. The app relies on Azure-hosted services for authentication and data. Specifically: do not run "azd down".

**Environment variables required:**

Testin is done against the Azure-hosted services, so the following environment variables should have been set automatically once the azd up has been run be set and available in your local environment:

- AI_AGENT_MCP_ENDPOINT - the MCP service URL
- AI_AGENT_MODEL - the ChatGPT model deployment name
- AI_AGENT_OPENAI_ENDPOINT - the Azure OpenAI endpoint
- API_FUNCTIONS_URL - the Azure Functions URL
- API_MCP_URL - the MCP service URL
- API_URL - the GraphQL API URL
- APPINSIGHTS_CONNECTIONSTRING - the App Insights connection string
- APPINSIGHTS_INSTRUMENTATIONKEY - the App Insights instrumentation key
- APPLICATIONINSIGHTS_CONNECTION_STRING - the App Insights connection string
- APP_REDIRECT_URI - the app redirect URI
- AZURE_CLIENT_ID - the Azure client ID
- AZURE_CONTAINER_REGISTRY_ENDPOINT - the Azure Container Registry endpoint
- AZURE_LOCATION - the Azure location
- AZURE_OPENAI_ACCOUNT_NAME - the Azure OpenAI account name
- AZURE_OPENAI_ENDPOINT - the Azure OpenAI endpoint
- AZURE_RESOURCE_GROUP - the Azure resource group
- AZURE_STATIC_WEB_APP_DEPLOYMENT_TOKEN - the Azure Static Web App deployment token
- AZURE_SUBSCRIPTION_ID - the Azure subscription ID
- COMMUNICATION_SERVICE_ENDPOINT - the Communication Service endpoint
- COMMUNICATION_SERVICE_NAME - the Communication Service name
- EMAIL_SENDER_DOMAIN - the email sender domain
- MCP_SERVICE_URL - the MCP service URL
- SERVICE_API_FUNCTIONS_IMAGE_NAME - the API Functions image name
- SERVICE_API_FUNCTIONS_NAME - the API Functions service name
- SERVICE_API_IMAGE_NAME - the API image name
- SERVICE_API_MCP_IMAGE_NAME - the API MCP image name
- SERVICE_API_MCP_NAME - the API MCP service name
- SERVICE_API_NAME - the API service name
- SERVICE_API_RESOURCE_EXISTS - indicates if the API resource exists
- SERVICE_APP_NAME - the Static Web App service name
- SQL_ADMIN_PASSWORD - the SQL admin password
- SQL_ADMIN_USER - the SQL admin user
- SQL_DATABASE_NAME - the SQL database name
- SQL_SERVER_NAME - the SQL server name
- STORAGE_ACCOUNT_NAME - the Storage Account name
- TENANT_ID - the Azure tenant ID
- USER_MANAGED_IDENTITY_NAME - the User Managed Identity name
- VITE_API_FUNCTIONS_URL - the Azure Functions URL
- VITE_API_URL - the GraphQL API URL
- chatGptDeploymentVersion - the ChatGPT deployment version
- chatGptModelName - the ChatGPT model name
- chatGptSkuName - the ChatGPT SKU name
- cognitiveservicesLocation - the Cognitive Services location
- embeddingDeploymentModelName - the embedding deployment model name
- embeddingDeploymentSkuName - the embedding deployment SKU name
- embeddingDeploymentVersion - the embedding deployment version
- imageDeploymentModelName - the image deployment model name
- imageDeploymentSkuName - the image deployment SKU name
- imageDeploymentVersion - the image deployment version
- imageModelFormat - the image model format

**For Azure Functions (api-functions) local development:**

The Functions project requires `MCP_SERVICE_URL` to connect to the Model Context Protocol server for AI agent capabilities. **Use the Azure-hosted MCP service** rather than running it locally:

````bash
# Get the MCP service URL from Azure
azd env get-values | grep MCP_SERVICE_URL



### Azure Deployment (azd)

The app uses **azd lifecycle hooks** for automated deployment orchestration:

```bash
azd up  # Full deploy: preup → provision → deploy → postdeploy
````

**Hook execution order:**

1. `preup.ps1` - Creates Entra ID app registrations, discovers OpenAI models
2. `azd provision` - Deploys Bicep infrastructure
3. `postprovision.ps1` - Configures SQL database roles, imports sample data
4. `azd deploy` - Builds containers via ACR remote build, deploys to Container Apps
5. `postdeploy.ps1` - Updates redirect URIs, sets runtime CORS config

**Key distinction**: `api/` and `api-functions/` build with **remote build** in ACR (see `azure.yaml`). The `app/` builds locally then deploys to Static Web Apps.

### Getting Azure Resource Information

All deployed Azure resource details (URLs, resource groups, connection strings, etc.) are available via:

```bash
azd env get-values
```

Key values include:

- `API_URL` - DAB GraphQL/REST API endpoint in Azure Container Apps
- `FUNCTION_URL` - Azure Functions endpoint in Container Apps
- `AZURE_RESOURCE_GROUP` - Resource group name
- `DATABASE_CONNECTION_STRING` - SQL connection string with Managed Identity auth

**Important**: The DAB API always paginates results at **100 items**. When querying large datasets, use filters or check for multiple pages:

```graphql
# This returns maximum 100 items even if more exist
query {
  products {
    items {
      ProductID
      Name
    }
  }
}

# Use filters to check for additional records
query {
  products(filter: { ProductID: { gt: 100 } }) {
    items {
      ProductID
    }
  }
}
```

### VS Code Tasks

Use built-in tasks for development (accessible via `Cmd/Ctrl+Shift+B`):

- `func: host start` - Run Azure Functions locally (depends on build task)
- `start frontend` - Run React dev server
- `start api (DAB)` - Run local DAB server
- `build all` - Compile .NET projects

## Project-Specific Conventions

### GraphQL API (DAB Naming)

**Critical**: DAB auto-generates schema from database tables with specific naming rules:

```typescript
// Database: ProductCategory → GraphQL: productCategories (camelCase + plural)
// Database: Person → GraphQL: people (irregular plural)
// Always use .items for list queries:
const { productCategories } = await client.request(gql`
  query {
    productCategories {
      items {
        ProductCategoryID
        Name
      }
    }
  }
`);
```

See [docs/DAB_NAMING_CONVENTIONS.md](docs/DAB_NAMING_CONVENTIONS.md) for complete rules.

### Configuration Files Pattern

The project uses **environment-based config pairs**:

- `api/dab-config.json` (local dev - CORS all origins, no auth)
- `api/dab-config.prod.json` (Azure - restricted CORS, Entra ID auth)
- `app/.env` (local API URL)
- `app/public/config.js` (runtime config injection for Azure)

**Never hardcode URLs** - always use environment variables or runtime config.

### Azure Functions Structure

Functions follow **isolated worker model** with dependency injection:

```csharp
// Program.cs registers services
builder.Services.AddScoped<AddressService>(sp => {
    var connectionString = configuration["SQL_CONNECTION_STRING"];
    return new AddressService(connectionString);
});

// Functions receive via constructor injection
public AddressFunctions(ILogger<AddressFunctions> logger, AddressService service)
```

Connection string uses **Active Directory Default** authentication (Managed Identity in Azure, Azure CLI locally).

### Bicep Infrastructure Patterns

Infrastructure uses **modular decomposition** in `infra/modules/`:

```bicep
// main.bicep orchestrates, modules handle individual services
module identity 'modules/identity.bicep' = { ... }
module database 'modules/database.bicep' = { params: { identityId: identity.outputs.id } }
```

**Key parameters** injected by azd from environment:

- `revisionSuffix` - unique per deployment (avoids Container App conflicts)
- `chatGptModelName`, `embeddingModelName` - discovered in preup.ps1
- `aadAdminObjectId` - current user's Entra ID for SQL admin

## Common Integration Points

### Frontend ↔ GraphQL API

Uses `graphql-request` library with React Query for caching:

```typescript
// app/src/hooks/useProducts.ts
export const useProducts = () =>
  useQuery({
    queryKey: ["products"],
    queryFn: async () => {
      const { products } = await graphqlClient.request(GET_PRODUCTS);
      return products.items;
    },
    staleTime: 2 * 60 * 1000, // 2 min cache
  });
```

**All list queries** return `{ items: [] }` structure - never access data directly without `.items`.

### Database Schema Context

Uses **AdventureWorks schema** with namespaced tables:

- `Production.Product`, `Production.ProductCategory`
- `Person.Person`, `Person.Address`
- `Sales.SalesOrderHeader`

DAB entities map to these via `dab-config.json` source definitions:

```json
"Product": { "source": "Production.Product" }
```

### Managed Identity Authentication Flow

All Azure resources use passwordless auth:

1. **Container Apps** get system-assigned MI at deployment
2. **SQL Database** grants roles in `postprovision.ps1`:
   ```sql
   CREATE USER [mi-name] FROM EXTERNAL PROVIDER;
   ALTER ROLE db_datareader ADD MEMBER [mi-name];
   ```
3. **Connection strings** use `Authentication=Active Directory Default`
4. **Local dev** inherits from `az login` credentials

## Testing & Debugging

### Test Scripts

The project includes several test scripts in root:

- `test-signup.sh` - Validates user registration flow
- `test-discounts.sh` - Tests special offers integration
- `test-inventory.js` - Node script for inventory checks

**Run functions locally** with the `func: host start` task, which auto-builds before starting.

### Verifying GraphQL Endpoints

```bash
cd api && ./test-graphql-endpoints.sh  # Tests all entity queries
```

### Examining the Azure Database

**Direct SQL access from dev container usually fails** due to Entra ID authentication requirements. Instead, use the deployed DAB API:

```bash
# Get the API URL
API_URL=$(azd env get-values | grep API_URL | cut -d'=' -f2 | tr -d '"')

# Query via GraphQL
curl -X POST $API_URL/graphql -H "Content-Type: application/json" \
  -d '{"query": "{ products { items { ProductID Name } } }"}'

# Or use REST API
curl "$API_URL/api/Product"
```

**Remember**: API results are paginated at 100 items. To verify full table counts, use filters to check for records beyond the first page.

### Application Insights Integration

DAB and Functions auto-send telemetry. Check logs:

```bash
az monitor app-insights query --app <app-name> --analytics-query "requests | top 50 by timestamp desc"
```

## Common Gotchas

1. **CORS during local dev**: Always use `dab-config.json` (not `dab-config.prod.json`) locally
2. **GraphQL query failures**: Check for `.items` in response - DAB wraps all lists
3. **API pagination limits**: DAB API returns maximum 100 items per query - use filters or pagination to access larger datasets
4. **Direct SQL access**: Connecting to Azure SQL from dev container typically fails due to Entra ID auth - use the DAB API instead to query the database
5. **Build failures**: Functions require restore before build - use `restore (functions)` task first
6. **Connection errors**: Ensure `az login` is fresh - tokens expire after hours
7. **Missing env vars**: DAB reads from `@env()` placeholders - check azd environment with `azd env get-values`

## Documentation Map

- [QUICKSTART.md](QUICKSTART.md) - Local development walkthrough
- [app/LOCAL_DEVELOPMENT.md](app/LOCAL_DEVELOPMENT.md) - Frontend-specific setup
- [api/README.md](api/README.md) - DAB deployment details
- [MIGRATION_SUMMARY.md](MIGRATION_SUMMARY.md) - GraphQL integration history
- [docs/DAB_NAMING_CONVENTIONS.md](docs/DAB_NAMING_CONVENTIONS.md) - GraphQL schema rules
