# Test Scripts

This directory contains shell-based API and integration tests for the AdventureWorks application.

## Overview

These scripts test the AdventureWorks APIs and Azure Functions directly using curl and jq. They complement the Playwright E2E tests found in the parent `tests/` directory.

## Prerequisites

- Deployed Azure environment (run `azd up` first)
- `jq` installed for JSON parsing: `sudo apt-get install jq`
- Environment variables set (automatically configured by `azd env`)

## Available Test Scripts

### AI & MCP Tests

- **test-ai-and-mcp-complete.sh** - Comprehensive test of AI Agent and MCP integration
- **test-ai-chat-and-mcp.sh** - Tests AI chat functionality with MCP tools
- **test-product-comparison.sh** - Tests AI-powered product comparison features
- **test-search-suggestions.sh** - Tests semantic search and AI suggestions

### Email & Communication Tests

- **test-send-email.sh** - Basic email sending functionality
- **test-email-with-attachment.sh** - Email with attachment (receipt PDFs)
- **test-receipt-generation.sh** - Order receipt PDF generation

### Authentication Tests

- **test-password-functions.sh** - Password hashing and verification
- **test-password-reset-flow.sh** - Complete password reset flow (request → validate → reset)

### Data & API Tests

- **test-product-reviews.sh** - Product review creation and retrieval
- **test-telemetry.sh** - Application Insights telemetry generation
- **test-robots-sitemap.sh** - SEO robots.txt and sitemap.xml generation

### Azure Playwright Tests

- **run-azure-playwright-tests.sh** - Runs Playwright E2E tests against Azure deployment

## Usage

### Running Individual Tests

```bash
# From repository root
cd tests/scripts

# Run a specific test
./test-ai-chat-and-mcp.sh

# Run password tests
./test-password-functions.sh
./test-password-reset-flow.sh
```

### Running All Tests

```bash
# Run all test scripts
cd tests/scripts
for script in test-*.sh; do
  echo "Running $script..."
  ./"$script"
done
```

### Testing Against Local Development

Most scripts default to Azure-deployed endpoints. To test locally:

1. Update `API_FUNCTIONS_URL` in each script to point to localhost
2. Ensure services are running locally (see main QUICKSTART.md)

## Environment Variables

Scripts automatically use these variables (set by `azd env`):

- `API_FUNCTIONS_URL` - Azure Functions endpoint
- `API_URL` - DAB GraphQL API endpoint
- `VITE_API_URL` - Frontend API endpoint
- `APPINSIGHTS_CONNECTIONSTRING` - Application Insights

## Test Data

- Tests use predefined customer IDs and product IDs
- Some tests create temporary data (reviews, emails) which is cleaned up
- Check individual script comments for specific test data requirements

## Expected Outputs

Each script:

- ✅ Prints success messages in green
- ❌ Prints errors in red
- Exits with code 0 on success, non-zero on failure

## Troubleshooting

### Common Issues

**"jq: command not found"**

```bash
sudo apt-get update && sudo apt-get install -y jq
```

**"API_FUNCTIONS_URL not set"**

```bash
azd env refresh
source <(azd env get-values)
```

**"401 Unauthorized"**

- Most API tests work without authentication
- Some tests require a valid customer context
- Check that Azure deployment is complete

### Service Warmup

Azure Functions may need warmup after deployment:

```bash
curl "$API_FUNCTIONS_URL/api/health"
```

## Contributing

When adding new test scripts:

1. Follow naming convention: `test-<feature>.sh`
2. Include clear comments and usage examples
3. Use proper exit codes (0 = success, non-zero = failure)
4. Validate required dependencies at script start
5. Clean up any test data created

## Related Documentation

- [Main Testing Guide](../../docs/testing/AI_AND_MCP_TESTING_GUIDE.md)
- [Playwright Tests](../README.md)
- [API Documentation](../../api/README.md)
