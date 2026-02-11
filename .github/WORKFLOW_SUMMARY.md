# GitHub Actions Workflow for Service Principal Deployment

## Summary

A manually triggered GitHub Actions workflow has been created that authenticates using a service principal and runs the complete `azd up` pipeline including all lifecycle hooks.

## Files Created

1. **`.github/workflows/azd-up-service-principal.yml`** - The main workflow file
2. **`.github/workflows/README.md`** - Comprehensive documentation

## What It Does

The workflow automates the complete Azure deployment process that would normally be done by running `azd up` locally:

1. **Authentication**: Logs in to Azure using service principal credentials
2. **Environment Setup**: Installs all required tools (Azure CLI, azd, PowerShell, jq, Python)
3. **Configuration**: Creates azd environment and sets all required variables
4. **Deployment**: Runs `azd up --no-prompt` which executes all hooks:
   - `preup.sh` - Model discovery and Entra ID app registration
   - `azd provision` - Infrastructure deployment via Bicep
   - `postprovision.sh` - Database configuration and seed job
   - `azd deploy` - Service deployment
   - `postdeploy.sh` - Runtime configuration
   - `postup.sh` - Completion summary

## Required GitHub Secrets

You must configure these secrets in your GitHub repository before running the workflow:

- `AZURE_CLIENT_ID` - Service principal application (client) ID
- `AZURE_CLIENT_SECRET` - Service principal secret (password)
- `AZURE_TENANT_ID` - Azure tenant ID
- `AZURE_SUBSCRIPTION_ID` - Azure subscription ID

## Required Service Principal Permissions

The service principal needs:

1. **Contributor** role on the Azure subscription
2. **Microsoft Graph API**: `Application.ReadWrite.All` permission (for Entra ID app registrations in preup hook)
3. **SQL Database**: Admin access on the target SQL server (for database role assignments in postprovision hook)
4. **Directory Readers** role in Entra ID (for looking up objects)

## Workflow Inputs

When you trigger the workflow, you can provide:

- **AZURE_RESOURCE_GROUP** (required): Name of the resource group
- **AZURE_LOCATION** (optional, default: eastus2): Main Azure region
- **FOUNDRY_LOCATION** (optional, default: swedencentral): AI Foundry/Cognitive Services region
- **PLAYWRIGHT_LOCATION** (optional, default: westeurope): Playwright browser automation region

## How to Use

1. Configure the required GitHub secrets in your repository
2. Go to **Actions** tab in GitHub
3. Select **Deploy with Service Principal (azd up)**
4. Click **Run workflow**
5. Fill in the parameters
6. Click **Run workflow** to start

## Expected Duration

Approximately 21-29 minutes total:
- Infrastructure provisioning: ~21 minutes
- Container builds and deployments: varies
- Database seeding: ~8 minutes (initiated but runs asynchronously in background after workflow completes)

## Key Features

- ✅ Fully automated deployment matching `azd up` behavior
- ✅ Service principal authentication throughout all steps
- ✅ Non-interactive execution suitable for CI/CD
- ✅ All lifecycle hooks executed in correct order
- ✅ Error handling with log upload on failure
- ✅ Deployment summary on success

## Testing

The workflow structure has been validated with automated tests:
- YAML syntax validation
- Required inputs and secrets verification
- Key steps presence check
- Environment variable configuration validation
- Command format verification

## Next Steps

1. Create a service principal with required permissions
2. Configure GitHub secrets
3. Test the workflow with a deployment
4. Monitor the execution and verify all services deploy correctly

## Notes

- The workflow uses the exact same hooks and scripts as interactive `azd up`
- Service principal context is properly handled by existing hook scripts
- Some optional features (like Aspire Dashboard role assignment) will gracefully skip if service principal context is detected
- All environment variables that hooks expect are properly set before execution
