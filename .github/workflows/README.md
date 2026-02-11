# GitHub Workflows

This directory contains GitHub Actions workflows for the AdventureWorks application.

## azd-up-service-principal.yml

A manually triggered workflow that deploys the entire AdventureWorks application to Azure using a service principal for authentication.

### Purpose

This workflow automates the full deployment process (`azd up`) including all lifecycle hooks:
- `preup.sh` - Creates Entra ID app registrations, discovers OpenAI models
- `azd provision` - Deploys Bicep infrastructure
- `postprovision.sh` - Configures SQL database roles, deploys seed-job
- `azd deploy` - Builds and deploys all services
- `postdeploy.sh` - Updates redirect URIs, configures CORS
- `postup.sh` - Displays completion summary

### Prerequisites

Before running this workflow, you must:

1. **Create a Service Principal** with appropriate permissions:
   ```bash
   az ad sp create-for-rbac --name "AdventureWorks-GitHub-Actions" \
     --role Contributor \
     --scopes /subscriptions/{subscription-id}
   ```
   
   Save the output which contains:
   - `appId` (AZURE_CLIENT_ID)
   - `password` (AZURE_CLIENT_SECRET)
   - `tenant` (AZURE_TENANT_ID)

2. **Grant additional permissions** to the service principal:
   - **Microsoft Graph API**: `Application.ReadWrite.All` (for creating Entra ID app registrations)
   - **SQL Database**: Admin access on the target SQL server (for database role assignments)
   
   You may also need to add the service principal to the "Directory Readers" role in Entra ID.

3. **Configure GitHub Secrets** in your repository:
   - `AZURE_CLIENT_ID` - The service principal application (client) ID
   - `AZURE_CLIENT_SECRET` - The service principal secret (password)
   - `AZURE_TENANT_ID` - Your Azure tenant ID
   - `AZURE_SUBSCRIPTION_ID` - Your Azure subscription ID

### Usage

1. Go to the **Actions** tab in your GitHub repository
2. Select **Deploy with Service Principal (azd up)** from the workflows list
3. Click **Run workflow**
4. Fill in the required parameters:
   - **AZURE_RESOURCE_GROUP** (required): Name of the Azure resource group to create/use
   - **AZURE_LOCATION** (optional, default: eastus2): Azure region for main resources
   - **FOUNDRY_LOCATION** (optional, default: swedencentral): Azure region for AI Foundry/Cognitive Services
   - **PLAYWRIGHT_LOCATION** (optional, default: westeurope): Azure region for Playwright browser automation
5. Click **Run workflow** to start the deployment

### What the Workflow Does

1. **Setup Phase**:
   - Checks out the repository
   - Verifies pre-installed tools (Azure CLI, PowerShell, Python)
   - Installs Azure Developer CLI (azd)
   - Installs additional dependencies (jq)

2. **Authentication Phase**:
   - Logs in to Azure CLI using service principal credentials
   - Logs in to PowerShell Az module using service principal credentials
   - Sets the subscription context

3. **Configuration Phase**:
   - Creates a new azd environment
   - Sets all required environment variables that the hook scripts expect
   - Configures service principal context for hooks

4. **Deployment Phase**:
   - Runs `azd up --no-prompt` which orchestrates the entire deployment
   - All hooks execute automatically in the correct order
   - Uses service principal credentials throughout

5. **Completion Phase**:
   - Displays deployment information on success
   - Uploads azd logs if the deployment fails

### Expected Duration

Total deployment time is approximately **29 minutes**:
- Infrastructure provisioning: ~21 minutes
- Database seeding: ~8 minutes (runs asynchronously)
- Container builds and deployments: included in the above

### Troubleshooting

**Authentication Errors**:
- Verify all GitHub secrets are set correctly
- Ensure the service principal has not expired
- Check that the service principal has the required permissions

**Permission Errors**:
- The service principal needs "Directory Readers" role in Entra ID for preup hook
- The service principal needs SQL admin access for postprovision hook
- Verify the service principal has Contributor role on the subscription

**Hook Failures**:
- Check the workflow logs for specific error messages
- The `postprovision.sh` hook requires PowerShell and Azure CLI access
- The `preup.sh` hook requires jq and Python to be available

**Timeout Issues**:
- The default GitHub Actions timeout is 6 hours
- If deployment takes longer, you may need to adjust the timeout
- Consider running steps separately if needed

### Monitoring Deployment

After the workflow completes:

1. Check the seed-job status:
   ```bash
   az containerapp job execution list \
     --name <seed-job-name> \
     --resource-group <resource-group-name>
   ```

2. View the deployed application:
   - The workflow output includes URLs for all services
   - Check the Application Insights dashboard for telemetry

### Differences from Interactive `azd up`

When using a service principal in GitHub Actions:
- All hooks run non-interactively (`--no-prompt` flag)
- Service principal object ID is used instead of user object ID
- PowerShell authentication uses credential objects instead of interactive login
- No browser-based authentication flows

### Security Considerations

- Never commit the service principal secret to the repository
- Use GitHub encrypted secrets for all sensitive values
- Regularly rotate the service principal secret
- Limit service principal permissions to only what's required
- Consider using Federated Identity Credentials (OIDC) instead of secrets for enhanced security
