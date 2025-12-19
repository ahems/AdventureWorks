# Azure Functions - API Functions

This directory contains Azure Functions that provide serverless backend capabilities for the AdventureWorks e-commerce application.

## Functions

### Address Functions

- **AddressFunctions**: Manages customer addresses (CRUD operations)

### AI-Powered Product Enhancement

- **EmbellishProductsUsingAI**: Enhances product descriptions using AI
- **GenerateProductEmbeddings**: Creates vector embeddings for products
- **GenerateProductImages**: Generates product images using DALL-E
- **GenerateProductThumbnails**: Creates thumbnails from product images
- **TranslateProductDescriptions**: Translates product descriptions to multiple languages

### Language Translation

- **TranslateLanguageFile**: Translates i18n language files from English to 15 languages
  - See [docs/LANGUAGE_FILE_TRANSLATION.md](../docs/LANGUAGE_FILE_TRANSLATION.md) for detailed documentation
  - Supports: Spanish, French, German, Portuguese, Italian, Dutch, Russian, Chinese, Japanese, Korean, Arabic, Turkish, Vietnamese, Thai, Indonesian
  - Maintains regional appropriateness (email domains, city names, addresses)
  - Preserves JSON structure and placeholders

## Services

### AddressService

Handles database operations for customer addresses using Azure SQL.

### AIService

Provides AI capabilities using Azure OpenAI:

- Product description enhancement
- Text embeddings generation
- Image generation
- Product description translation
- Language file translation

### ProductService

Manages product data operations with Azure SQL.

## Configuration

### Environment Variables

Required environment variables:

```bash
SQL_CONNECTION_STRING=Server=tcp:your-server.database.windows.net,1433;Initial Catalog=AdventureWorks;Authentication=Active Directory Default;
AZURE_OPENAI_ENDPOINT=https://your-openai-endpoint.openai.azure.com/
```

### Local Development

1. Copy `local.settings.json.example` to `local.settings.json` (if exists) or run the setup script:

   ```bash
   ./update-local-settings.sh
   ```

2. Build the project:

   ```bash
   dotnet build
   ```

3. Start the Functions host:

   ```bash
   func start
   ```

   Or use the VS Code task: `func: host start`

## Project Structure

```
api-functions/
├── Functions/           # HTTP-triggered functions
│   ├── AddressFunctions.cs
│   ├── EmbellishProductsUsingAI.cs
│   ├── GenerateProductEmbeddings.cs
│   ├── GenerateProductImages.cs
│   ├── GenerateProductThumbnails.cs
│   ├── TranslateProductDescriptions.cs
│   └── TranslateLanguageFile.cs
├── Models/             # Data models
│   ├── Address.cs
│   ├── ProductData.cs
│   └── TranslationData.cs
├── Services/           # Business logic
│   ├── AddressService.cs
│   ├── AIService.cs
│   └── ProductService.cs
├── Program.cs          # Function app configuration
├── host.json          # Function host configuration
└── Dockerfile         # Container image definition
```

## Deployment

The functions are deployed to Azure Container Apps as part of the main application deployment:

```bash
# Deploy all infrastructure and functions
azd up

# Deploy functions only
azd deploy api-functions
```

## Authentication

All functions use **Anonymous** authorization level for demo purposes. In production, you should:

- Use `Function` or `Admin` authorization levels
- Implement Azure AD authentication
- Use API Management for rate limiting and security

## Dependencies

- .NET 8.0
- Azure Functions Worker
- Azure OpenAI SDK
- Microsoft.Data.SqlClient
- Application Insights

## Testing

### Test Individual Functions Locally

```bash
# Test TranslateLanguageFile
./test-translate-language-file.sh es

# Test batch translation
./batch-translate-language-file.sh app/src/locales/en/common.json

# Test address functions
curl -X GET http://localhost:7071/api/addresses/123
```

### Run All Tests

```bash
# Unit tests (if implemented)
dotnet test

# Integration tests with local Azure Functions
# Start the function app first, then run tests
```

## Performance Considerations

- **Cold Start**: First request may take 5-10 seconds
- **Connection Pooling**: SQL connections are pooled automatically
- **AI Rate Limits**: Azure OpenAI has rate limits; implement retry logic for production
- **Timeout**: Default timeout is 5 minutes; adjust in host.json for long-running operations

## Monitoring

The functions automatically send telemetry to Application Insights:

```bash
# View logs in Azure
az monitor app-insights query --app <app-name> \
  --analytics-query "requests | where name == 'TranslateLanguageFile' | top 50 by timestamp desc"
```

## Troubleshooting

### Common Issues

1. **SQL Connection Errors**

   - Ensure you're logged in with `az login`
   - Check firewall rules on Azure SQL
   - Verify `SQL_CONNECTION_STRING` is set correctly

2. **OpenAI Errors**

   - Verify `AZURE_OPENAI_ENDPOINT` is correct
   - Check deployment names match (default: "chat", "embedding", "gpt-image-1")
   - Ensure Managed Identity has permissions

3. **Build Errors**
   - Clean and rebuild: `dotnet clean && dotnet build`
   - Restore packages: `dotnet restore`

## Contributing

When adding new functions:

1. Create the function in `Functions/` directory
2. Add any models to `Models/`
3. Add business logic to appropriate service in `Services/`
4. Update this README
5. Add tests
6. Update documentation

## License

See [LICENSE](../LICENSE) file in the root directory.
