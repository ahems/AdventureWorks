#!/bin/bash
# Post-provision script for setting up Static Web App build environment variables
# and configuring Aspire Dashboard access

set -e

echo "Configuring Azure resources for the demo..."

API_URL=$(azd env get-value 'API_URL' 2>/dev/null | head -n1 | tr -d '\n\r ')
if [ -n "$API_URL" ]; then
    azd env set 'VITE_API_URL' "$API_URL"
else
    echo "WARNING: API_URL not found in environment. VITE_API_URL will not be set."
fi

API_FUNCTIONS_URL=$(azd env get-value 'API_FUNCTIONS_URL' 2>/dev/null | head -n1 | tr -d '\n\r ')
if [ -n "$API_FUNCTIONS_URL" ]; then
    azd env set 'VITE_API_FUNCTIONS_URL' "$API_FUNCTIONS_URL"
else
    echo "WARNING: API_FUNCTIONS_URL not found in environment. VITE_API_FUNCTIONS_URL will not be set."
fi
if [ -n "$API_URL" ] && [ -n "$API_FUNCTIONS_URL" ]; then
    echo "Configured frontend API endpoints."
fi

# Grant current user Contributor role on Container Apps Environment for Aspire Dashboard access
CONTAINER_APP_ENV_NAME=$(azd env get-value 'CONTAINER_APP_ENVIRONMENT_NAME' 2>/dev/null | head -n1 | tr -d '\n\r ')
RESOURCE_GROUP=$(azd env get-value 'AZURE_RESOURCE_GROUP' 2>/dev/null | head -n1 | tr -d '\n\r ')

if [ -n "$CONTAINER_APP_ENV_NAME" ] && [ "$CONTAINER_APP_ENV_NAME" != "ERROR: key 'CONTAINER_APP_ENVIRONMENT_NAME' not found in the environment values" ]; then
    echo ""
    echo "Configuring Aspire Dashboard access..."
    
    # Get current user's object ID
    CURRENT_USER_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
    
    if [ -n "$CURRENT_USER_OBJECT_ID" ] && [ -n "$RESOURCE_GROUP" ]; then
        # Assign Contributor role to the current user on the Container Apps Environment
        # Use --scope to target the specific Container Apps Environment resource
        ENV_RESOURCE_ID="/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/managedEnvironments/$CONTAINER_APP_ENV_NAME"
        
        # Check if role assignment already exists (idempotent)
        EXISTING_ASSIGNMENT=$(az role assignment list \
            --scope "$ENV_RESOURCE_ID" \
            --assignee "$CURRENT_USER_OBJECT_ID" \
            --role "Contributor" \
            --query "[].id" -o tsv 2>/dev/null || echo "")
        
        if [ -z "$EXISTING_ASSIGNMENT" ]; then
            az role assignment create \
                --scope "$ENV_RESOURCE_ID" \
                --assignee "$CURRENT_USER_OBJECT_ID" \
                --role "Contributor" \
                --output none
            echo "  Aspire Dashboard access configured successfully"
        else
            echo "  Aspire Dashboard access already configured"
        fi

        # Do not continue if the exact user assignment is not visible yet.
        VERIFIED_ASSIGNMENT=$(az role assignment list \
            --scope "$ENV_RESOURCE_ID" \
            --assignee "$CURRENT_USER_OBJECT_ID" \
            --role "Contributor" \
            --query "[?principalId=='$CURRENT_USER_OBJECT_ID'].id" -o tsv)
        if [ -z "$VERIFIED_ASSIGNMENT" ]; then
            echo "ERROR: Could not verify the explicit Contributor assignment required by the Aspire Dashboard."
            exit 1
        fi
        echo "  Verified explicit Contributor assignment for the signed-in user"
    else
        echo "  WARNING: Could not determine current user or resource group. Skipping Aspire Dashboard role assignment."
    fi
else
    echo "  WARNING: CONTAINER_APP_ENVIRONMENT_NAME not found in environment. Skipping Aspire Dashboard configuration."
fi

echo "Preparing the MCP OAuth signing certificate..."
# NOTE: This runs EARLY — before the database-role, seed-job, and Foundry-agent
# steps below — on purpose. The api-mcp OAuth server fail-fasts at startup if this
# signing certificate is missing, so creating it must NOT be gated behind the more
# failure-prone steps that follow (a failure there would leave api-mcp crash-looping
# with ContainerBackOff). It only needs Key Vault + the deployer identity, both ready
# immediately after provisioning. Do not move it below those steps.
#
# The api-mcp self-contained OAuth authorization server signs JWT access tokens
# with an RSA private key that lives ONLY in Key Vault. The runtime managed
# identity already holds "Key Vault Secrets User" (granted in Bicep) to read the
# certificate PFX. Here we (a) grant the deployer the narrow "Key Vault
# Certificates Officer" role scoped to the vault, then (b) create a self-signed
# exportable RSA 2048 certificate if one does not already exist. Both steps are
# idempotent so re-running azd up is safe.
KEY_VAULT_NAME=$(azd env get-value 'MCP_SIGNING_KEY_VAULT_NAME' 2>/dev/null | head -n1 | tr -d '\n\r ')
SIGNING_CERT_NAME=$(azd env get-value 'MCP_SIGNING_CERTIFICATE_NAME' 2>/dev/null | head -n1 | tr -d '\n\r ')
[ -z "$SIGNING_CERT_NAME" ] && SIGNING_CERT_NAME="mcp-signing"

if [ -z "$KEY_VAULT_NAME" ] || [[ "$KEY_VAULT_NAME" == ERROR:* ]]; then
    echo "ERROR: MCP_SIGNING_KEY_VAULT_NAME is missing; the MCP OAuth server cannot start without its signing certificate." >&2
    exit 1
else
    SUBSCRIPTION_ID=$(az account show --query id -o tsv 2>/dev/null || echo "")
    VAULT_RESOURCE_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.KeyVault/vaults/${KEY_VAULT_NAME}"
    DEPLOYER_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")

    if [ -n "$DEPLOYER_OBJECT_ID" ]; then
        # Grant the deployer "Key Vault Certificates Officer" (idempotent), scoped to the vault only.
        EXISTING_CERT_OFFICER=$(az role assignment list \
            --scope "$VAULT_RESOURCE_ID" \
            --assignee "$DEPLOYER_OBJECT_ID" \
            --role "Key Vault Certificates Officer" \
            --query "[].id" -o tsv 2>/dev/null || echo "")
        if [ -z "$EXISTING_CERT_OFFICER" ]; then
            if az role assignment create \
                --scope "$VAULT_RESOURCE_ID" \
                --assignee "$DEPLOYER_OBJECT_ID" \
                --role "Key Vault Certificates Officer" \
                --output none 2>/dev/null; then
                echo "  Granted deployer 'Key Vault Certificates Officer' on $KEY_VAULT_NAME"
            elif az role assignment list \
                --scope "$VAULT_RESOURCE_ID" \
                --assignee "$DEPLOYER_OBJECT_ID" \
                --role "Key Vault Certificates Officer" \
                --query "[0].id" -o tsv 2>/dev/null | grep -q .; then
                echo "  Deployer already has 'Key Vault Certificates Officer' on $KEY_VAULT_NAME"
            else
                echo "ERROR: Could not grant Key Vault certificate permissions to the deployer." >&2
                exit 1
            fi
        else
            echo "  Deployer already has 'Key Vault Certificates Officer' on $KEY_VAULT_NAME"
        fi
    else
        echo "  WARNING: Could not determine deployer object ID; assuming existing Key Vault permissions."
    fi

    # Create the signing certificate only if it does not already exist (idempotent).
    if az keyvault certificate show --vault-name "$KEY_VAULT_NAME" --name "$SIGNING_CERT_NAME" &>/dev/null; then
        echo "  Signing certificate '$SIGNING_CERT_NAME' already exists in $KEY_VAULT_NAME"
    else
        # Self-signed, exportable RSA 2048 so api-mcp can read the PFX (private key)
        # via the Secrets endpoint. contentType application/x-pkcs12 => PFX with key.
        CERT_POLICY_FILE=$(mktemp /tmp/mcp-signing-policy.XXXXXX.json)
        cat > "$CERT_POLICY_FILE" <<'POLICY'
{
  "issuerParameters": { "name": "Self" },
  "keyProperties": {
    "exportable": true,
    "keyType": "RSA",
    "keySize": 2048,
    "reuseKey": false
  },
  "secretProperties": { "contentType": "application/x-pkcs12" },
  "x509CertificateProperties": {
    "subject": "CN=adventureworks-mcp",
    "validityInMonths": 12,
    "keyUsage": [ "digitalSignature" ]
  },
  "lifetimeActions": [
    { "action": { "actionType": "AutoRenew" }, "trigger": { "daysBeforeExpiry": 30 } }
  ]
}
POLICY
        # Bounded retries handle RBAC role propagation (Certificates Officer) which
        # can take up to a minute or two after assignment.
        echo "  Creating '$SIGNING_CERT_NAME' in Key Vault (waiting for permissions if needed)..."
        CERT_CREATED="false"
        for attempt in $(seq 1 12); do
            if az keyvault certificate create \
                --vault-name "$KEY_VAULT_NAME" \
                --name "$SIGNING_CERT_NAME" \
                --policy @"$CERT_POLICY_FILE" \
                --output none 2>/tmp/mcp-cert-err.txt; then
                CERT_CREATED="true"
                echo "  Signing certificate ready (attempt $attempt/12)."
                break
            fi
            sleep 15
        done
        rm -f "$CERT_POLICY_FILE"
        if [ "$CERT_CREATED" != "true" ]; then
            echo "  ERROR: Failed to create signing certificate '$SIGNING_CERT_NAME' after multiple attempts."
            echo "         Last error:"
            sed 's/^/           /' /tmp/mcp-cert-err.txt 2>/dev/null || true
            echo "         Re-run 'azd provision' or create the certificate manually:"
            echo "           az keyvault certificate create --vault-name $KEY_VAULT_NAME --name $SIGNING_CERT_NAME --policy @<policy.json>"
            exit 1
        fi
    fi
fi

echo "Configuring Azure SQL access..."

# Check if user is logged in to Azure CLI
echo "Verifying Azure CLI login status..."
if ! az account show &>/dev/null; then
    echo ""
    echo "❌ ERROR: Not logged in to Azure CLI"
    echo ""
    echo "Please run 'az login' to authenticate with Azure, then try again."
    echo ""
    exit 1
fi
echo "  ✓ Azure CLI login verified"

# Get required values
SQL_SERVER_NAME=$(azd env get-value SQL_SERVER_NAME 2>/dev/null | head -n1 | tr -d '\n\r ')
SQL_DATABASE_NAME=$(azd env get-value SQL_DATABASE_NAME 2>/dev/null | head -n1 | tr -d '\n\r ')
USER_MANAGED_IDENTITY_NAME=$(azd env get-value USER_MANAGED_IDENTITY_NAME 2>/dev/null | head -n1 | tr -d '\n\r ')

if ! SQL_PUBLIC_NETWORK_ACCESS=$(az sql server show \
    --name "$SQL_SERVER_NAME" --resource-group "$RESOURCE_GROUP" \
    --query publicNetworkAccess --output tsv); then
    echo "ERROR: Could not determine SQL public network access; refusing firewall changes." >&2
    exit 1
fi
SQL_PUBLIC_NETWORK_ACCESS="${SQL_PUBLIC_NETWORK_ACCESS//$'\r'/}"
case "$SQL_PUBLIC_NETWORK_ACCESS" in
    Enabled|Disabled) ;;
    *)
        echo "ERROR: Unexpected SQL public network access '$SQL_PUBLIC_NETWORK_ACCESS'; refusing firewall changes." >&2
        exit 1
        ;;
esac

if [ "$SQL_PUBLIC_NETWORK_ACCESS" = "Enabled" ]; then
if [ -n "$SQL_SERVER_NAME" ] && [ -n "$SQL_DATABASE_NAME" ] && [ -n "$USER_MANAGED_IDENTITY_NAME" ]; then
    # The deployment host still needs SQL access during azd up. Restrict the temporary
    # public firewall exception to its IPv4 egress address; postup disables public access.
    if [ -z "${SQL_CLIENT_IP:-}" ]; then
        SQL_CLIENT_IP=$(curl -4fsS --connect-timeout 5 --max-time 10 https://api.ipify.org) || {
            echo "ERROR: Could not discover the deployment host's public IPv4 address; set SQL_CLIENT_IP and retry."
            exit 1
        }
    fi
    if ! printf '%s\n' "$SQL_CLIENT_IP" | awk -F. 'NF != 4 { exit 1 } { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i > 255) exit 1 }'; then
        echo "ERROR: SQL_CLIENT_IP must be a valid IPv4 address (got: $SQL_CLIENT_IP)"
        exit 1
    fi
    cleanup_sql_firewall_rule() {
        if [ "${SQL_CLIENT_FIREWALL_RULE_ACTIVE:-false}" = "true" ]; then
            if az sql server firewall-rule delete \
                --server "$SQL_SERVER_NAME" \
                --resource-group "$RESOURCE_GROUP" \
                --name "AllowClient" \
                --output none 2>/dev/null; then
                echo "Removed temporary SQL client firewall rule."
            else
                echo "WARNING: Could not remove the temporary SQL client firewall rule. If azd up stops before postup completes, remove AllowClient manually."
            fi
        fi
    }
    SQL_CLIENT_FIREWALL_RULE_ACTIVE=true
    trap cleanup_sql_firewall_rule EXIT

    echo "Temporarily allowing the deployment host to configure Azure SQL..."
    if az sql server firewall-rule show \
        --server "$SQL_SERVER_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --name "AllowClient" \
        --output none 2>/dev/null; then
        az sql server firewall-rule update \
            --server "$SQL_SERVER_NAME" \
            --resource-group "$RESOURCE_GROUP" \
            --name "AllowClient" \
            --start-ip-address "$SQL_CLIENT_IP" \
            --end-ip-address "$SQL_CLIENT_IP" \
            --output none
    else
        az sql server firewall-rule create \
            --server "$SQL_SERVER_NAME" \
            --resource-group "$RESOURCE_GROUP" \
            --name "AllowClient" \
            --start-ip-address "$SQL_CLIENT_IP" \
            --end-ip-address "$SQL_CLIENT_IP" \
            --output none
    fi

    echo "Assigning database permissions to the application identity..."

    # PowerShell 7+ ('pwsh') is required on the host running 'azd up' to execute the
    # role-assignment SQL. The Dev Container / Codespaces image installs it automatically
    # (ghcr.io/devcontainers/features/powershell); on a bare host it must be installed
    # first. Fail fast with a clear, actionable message instead of a cryptic
    # 'command not found' (exit 127) abort under 'set -e'.
    if ! command -v pwsh >/dev/null 2>&1; then
        echo ""
        echo "❌ ERROR: 'pwsh' (PowerShell 7+) was not found on PATH, but it is required to assign database roles."
        echo ""
        echo "Resolve this, then re-run 'azd up':"
        echo "  - Open this repository in the provided Dev Container / GitHub Codespaces (PowerShell is preinstalled), or"
        echo "  - Install PowerShell 7+ on this machine:"
        echo "      https://learn.microsoft.com/powershell/scripting/install/installing-powershell"
        echo ""
        exit 1
    fi

    # Use a minimal PowerShell script that calls az CLI (not Az PowerShell modules).
    # This avoids separate PowerShell login and uses current az CLI context.
    # Wrap in 'if' so a non-zero exit is captured safely under 'set -e' — a bare
    # command-substitution assignment would otherwise abort the whole hook.
    if PWSH_OUTPUT=$(pwsh -NoProfile -NonInteractive -Command "
        # Get SQL token using az CLI (same login as bash)
        try {
            \$tokenJson = az account get-access-token --resource https://database.windows.net/ 2>&1 | ConvertFrom-Json
            if (-not \$tokenJson.accessToken) {
                Write-Error 'Failed to get access token'
                exit 1
            }
            \$token = \$tokenJson.accessToken
        } catch {
            Write-Error \"Failed to get Azure access token: \$_\"
            exit 1
        }
        
        # Read and prepare SQL script
        try {
            \$sql = Get-Content 'seed-job/sql/assign-database-roles.sql' -Raw
            \$sql = \$sql -replace '{{IDENTITY_NAME}}', '$USER_MANAGED_IDENTITY_NAME'
        } catch {
            Write-Error \"Failed to read SQL script: \$_\"
            exit 1
        }
        
        # Execute SQL with token
        try {
            \$connString = 'Server=tcp:$SQL_SERVER_NAME.database.windows.net,1433;Initial Catalog=$SQL_DATABASE_NAME;Encrypt=True;TrustServerCertificate=False;'
            \$conn = New-Object System.Data.SqlClient.SqlConnection(\$connString)
            \$conn.AccessToken = \$token
            \$conn.Open()
            \$cmd = \$conn.CreateCommand()
            \$cmd.CommandText = \$sql
            \$null = \$cmd.ExecuteNonQuery()
            \$conn.Close()
            Write-Host '  ✓ Database roles assigned successfully'
        } catch {
            Write-Error \"Failed to execute SQL: \$_\"
            exit 1
        }
    " 2>&1); then
        echo "$PWSH_OUTPUT"
    else
        PWSH_EXIT_CODE=$?
        echo "$PWSH_OUTPUT"
        echo ""
        echo "❌ ERROR: Database role assignment failed (exit $PWSH_EXIT_CODE)"
        echo ""
        echo "This may be caused by:"
        echo "  - Azure CLI token expired (try running 'az login' again)"
        echo "  - Insufficient permissions on the SQL database"
        echo "  - Network connectivity issues"
        echo ""
        exit 1
    fi
    echo ""
else
    echo "ERROR: SQL server, database, or managed identity name is missing; cannot configure Azure SQL access." >&2
    exit 1
fi

echo "Configuring SQL Change Tracking for order processing..."

if [ -n "$SQL_SERVER_NAME" ] && [ -n "$SQL_DATABASE_NAME" ]; then
    # Use 'if' to capture exit code safely under 'set -e'; prevents premature script exit
    if PWSH_CT_OUTPUT=$(pwsh -NoProfile -NonInteractive -Command "
        param()
        \$ServerName   = '$SQL_SERVER_NAME'
        \$DatabaseName = '$SQL_DATABASE_NAME'

        try {
            \$tokenJson = az account get-access-token --resource https://database.windows.net/ 2>&1 | ConvertFrom-Json
            if (-not \$tokenJson.accessToken) { Write-Error 'Failed to get access token'; exit 1 }
            \$token = \$tokenJson.accessToken
        } catch { Write-Error \"Token error: \$_\"; exit 1 }

        try {
            \$connString = \"Server=tcp:\${ServerName}.database.windows.net,1433;Initial Catalog=\${DatabaseName};Encrypt=True;TrustServerCertificate=False;\"
            \$conn = New-Object System.Data.SqlClient.SqlConnection(\$connString)
            \$conn.AccessToken = \$token
            \$conn.Open()

            # Enable DB-level Change Tracking (idempotent)
            \$check = \$conn.CreateCommand()
            \$check.CommandText = 'SELECT COUNT(*) FROM sys.change_tracking_databases WHERE database_id = DB_ID()'
            \$ctOn = [int]\$check.ExecuteScalar()
            if (\$ctOn -eq 0) {
                \$alter = \$conn.CreateCommand()
                \$alter.CommandText = \"ALTER DATABASE [\${DatabaseName}] SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON)\"
                \$null = \$alter.ExecuteNonQuery()
                Write-Host '  ✓ Database Change Tracking: ENABLED'
            } else {
                Write-Host '  ✓ Database Change Tracking: already enabled'
            }

            # Enable table-level Change Tracking on Sales.SalesOrderHeader only if the table exists.
            # The table is created by the seed job which runs after post-provision; skip gracefully if absent.
            \$existsCmd = \$conn.CreateCommand()
            \$existsCmd.CommandText = \"SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'Sales' AND TABLE_NAME = 'SalesOrderHeader'\"
            \$tableExists = [int]\$existsCmd.ExecuteScalar()
            if (\$tableExists -eq 0) {
                Write-Host '  ℹ  Sales.SalesOrderHeader not yet present (seed job has not run) — table Change Tracking will be enabled by the seed job.'
            } else {
                \$check2 = \$conn.CreateCommand()
                \$check2.CommandText = 'SELECT COUNT(*) FROM sys.change_tracking_tables WHERE object_id = OBJECT_ID(''[Sales].[SalesOrderHeader]'')'
                \$tableOn = [int]\$check2.ExecuteScalar()
                if (\$tableOn -eq 0) {
                    \$alter2 = \$conn.CreateCommand()
                    \$alter2.CommandText = 'ALTER TABLE [Sales].[SalesOrderHeader] ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF)'
                    \$null = \$alter2.ExecuteNonQuery()
                    Write-Host '  ✓ Sales.SalesOrderHeader Change Tracking: ENABLED'
                } else {
                    Write-Host '  ✓ Sales.SalesOrderHeader Change Tracking: already enabled'
                }
            }

            \$conn.Close()
        } catch { Write-Error \"SQL error: \$_\"; exit 1 }
    " 2>&1); then
        echo "$PWSH_CT_OUTPUT"
    else
        PWSH_CT_EXIT=$?
        echo "$PWSH_CT_OUTPUT"
        echo "ERROR: SQL Change Tracking setup failed (exit $PWSH_CT_EXIT); order processing cannot be configured." >&2
        exit 1
    fi
else
    echo "ERROR: SQL_SERVER_NAME or SQL_DATABASE_NAME is missing; cannot configure Change Tracking." >&2
    exit 1
fi
else
    echo "SQL public network access is disabled; preserving private-only networking."
    echo "Skipping public firewall rules and deployment-host SQL role/Change Tracking setup."
    echo "Reusing existing managed-identity database permissions through the private-network seed job."
    echo "The seed execution must succeed; missing database access or overlay conflicts will fail deployment."
fi

echo "Preparing the database seed job..."

# Get Azure environment values for seed job deployment
ACR_ENDPOINT=$(azd env get-value AZURE_CONTAINER_REGISTRY_ENDPOINT 2>/dev/null | head -n1 | tr -d '\n\r ')
SEED_JOB_NAME=$(azd env get-value SERVICE_SEED_JOB_NAME 2>/dev/null | head -n1 | tr -d '\n\r ')

if [ -z "$RESOURCE_GROUP" ] || [ -z "$ACR_ENDPOINT" ] || [ -z "$SEED_JOB_NAME" ]; then
    echo "ERROR: Required environment variables not found for seed-job deployment."
    echo "Resource Group: ${RESOURCE_GROUP:-[NOT SET]}"
    echo "ACR Endpoint: ${ACR_ENDPOINT:-[NOT SET]}"
    echo "Seed Job Name: ${SEED_JOB_NAME:-[NOT SET]}"
    exit 1
fi

# Extract ACR name from endpoint (e.g., "avacragtyjfry4y6w6.azurecr.io" -> "avacragtyjfry4y6w6")
ACR_NAME="${ACR_ENDPOINT%%.*}"

# Ensure Git LFS files (e.g. seed-job/sql/ProductNames-ai.csv) are present so the build context includes real content, not pointers
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$REPO_ROOT" ] && [ -e "$REPO_ROOT/.git" ]; then
    if ! git lfs version &>/dev/null; then
        echo "ERROR: Git LFS is required to fetch the seed-job assets." >&2
        exit 1
    fi
    echo "Checking required seed-job assets..."
    if LFS_OUTPUT=$(cd "$REPO_ROOT" && git lfs pull 2>&1); then
        echo "  Seed-job assets ready."
    else
        echo "$LFS_OUTPUT" >&2
        echo "ERROR: Could not download Git LFS assets required to build the seed job." >&2
        exit 1
    fi
fi

# Check CSV/SVG/metadata consistency after LFS hydration, before publishing seed artifacts.
python3 scripts/data-management/validate-manufacturing-assets.py

# Build and push the image to ACR
echo "Building and publishing the seed-job image..."
if BUILD_OUTPUT=$(az acr build \
    --registry "$ACR_NAME" \
    --image seed-job:latest \
    --file seed-job/dockerfile \
    seed-job \
    --no-logs 2>&1); then
    BUILD_ID=$(printf '%s\n' "$BUILD_OUTPUT" | sed -nE 's/.*build with ID: ([[:alnum:]-]+).*/\1/p' | tail -n1)
    if [ -n "$BUILD_ID" ]; then
        echo "  Seed-job image build succeeded ($BUILD_ID)."
    else
        echo "  Seed-job image build succeeded."
    fi
else
    echo "$BUILD_OUTPUT" >&2
    echo "ERROR: Seed-job image build failed." >&2
    exit 1
fi

# Use the endpoint directly for the image name
IMAGE_NAME="${ACR_ENDPOINT}/seed-job:latest"

# Simple approach: Just update the container image for the specific container
# Preserve existing configuration; automatic deployment must never reset a populated database.
# Suppress verbose JSON output.
if ! JOB_UPDATE_OUTPUT=$(az containerapp job update \
    --name "$SEED_JOB_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --container-name "$SEED_JOB_NAME" \
    --image "$IMAGE_NAME" \
    --set-env-vars SEED_SKIP_EXISTING=true \
    --output none 2>&1); then
    echo "$JOB_UPDATE_OUTPUT" >&2
    echo "ERROR: Could not update the seed-job image." >&2
    exit 1
fi

source "$(dirname "${BASH_SOURCE[0]}")/seed-job-execution.sh"
if ! start_and_wait_for_seed_job "$SEED_JOB_NAME" "$RESOURCE_GROUP"; then
    exit 1
fi

echo "Configuring Azure AI permissions..."
# The Agents data-plane API requires Azure AI Developer role at the project scope.
# Account-level roles (assigned by Bicep) do not cascade for agents/write operations.
_AI_ACCOUNT=$(azd env get-value AZURE_OPENAI_ACCOUNT_NAME 2>/dev/null | head -n1 | tr -d '\n\r ')
_AI_PROJECT=$(azd env get-value AI_FOUNDRY_PROJECT_NAME 2>/dev/null | head -n1 | tr -d '\n\r ')
_SUBSCRIPTION=$(azd env get-value AZURE_SUBSCRIPTION_ID 2>/dev/null | head -n1 | tr -d '\n\r ')
_RG=$(azd env get-value AZURE_RESOURCE_GROUP 2>/dev/null | head -n1 | tr -d '\n\r ')
_USER_OID=$(azd env get-value OBJECT_ID 2>/dev/null | head -n1 | tr -d '\n\r ')
_MI_NAME=$(azd env get-value USER_MANAGED_IDENTITY_NAME 2>/dev/null | head -n1 | tr -d '\n\r ')

# Resolve project name from the Foundry endpoint if not stored separately
if [[ -z "$_AI_PROJECT" ]]; then
  _PROJ_ENDPOINT=$(azd env get-value AI_FOUNDRY_PROJECT_ENDPOINT 2>/dev/null | head -n1 | tr -d '\n\r ')
  _AI_PROJECT=$(echo "$_PROJ_ENDPOINT" | grep -oP '/projects/\K[^/?#]+' || true)
fi

ensure_project_role() {
  local principal_id=$1 principal_type=$2 role=$3 assignment create_error

  assignment=$(az role assignment list \
    --scope "$_PROJECT_SCOPE" \
    --assignee "$principal_id" \
    --role "$role" \
    --query "[0].id" -o tsv 2>/dev/null || true)
  [[ -n "$assignment" ]] && return 0

  if create_error=$(az role assignment create \
    --scope "$_PROJECT_SCOPE" \
    --assignee-object-id "$principal_id" \
    --assignee-principal-type "$principal_type" \
    --role "$role" \
    --output none 2>&1); then
    return 0
  fi

  assignment=$(az role assignment list \
    --scope "$_PROJECT_SCOPE" \
    --assignee "$principal_id" \
    --role "$role" \
    --query "[0].id" -o tsv 2>/dev/null || true)
  if [[ -z "$assignment" ]]; then
    echo "$create_error" >&2
    echo "ERROR: Could not assign '$role' at the Azure AI project scope." >&2
    return 1
  fi
}

if [[ -n "$_AI_ACCOUNT" ]] && [[ -n "$_AI_PROJECT" ]] && [[ -n "$_USER_OID" ]]; then
  _PROJECT_SCOPE="/subscriptions/${_SUBSCRIPTION}/resourceGroups/${_RG}/providers/Microsoft.CognitiveServices/accounts/${_AI_ACCOUNT}/projects/${_AI_PROJECT}"

  ensure_project_role "$_USER_OID" User "64702f94-c441-49e6-a78b-ef80e0188fee" || exit 1
  ensure_project_role "$_USER_OID" User "a001fd3d-188f-4b5d-821b-7da978bf7442" || exit 1

  # Assign Azure AI Developer to the managed identity at project scope
  _MI_PRINCIPAL=""
  if [[ -n "$_MI_NAME" ]]; then
    _MI_PRINCIPAL=$(az identity show -n "$_MI_NAME" -g "$_RG" --query principalId -o tsv 2>/dev/null || true)
    if [[ -n "$_MI_PRINCIPAL" ]]; then
      ensure_project_role "$_MI_PRINCIPAL" ServicePrincipal "64702f94-c441-49e6-a78b-ef80e0188fee" || exit 1
    else
      echo "ERROR: Could not resolve the application's managed identity for Azure AI permissions." >&2
      exit 1
    fi
  else
    echo "ERROR: USER_MANAGED_IDENTITY_NAME is missing; cannot configure Azure AI permissions." >&2
    exit 1
  fi

  # Assign the custom AIServices data-plane role (covers agents/write, memory stores, etc.)
  # The built-in Azure AI Developer role does NOT include AIServices/* data actions.
  _CUSTOM_ROLE_NAME=$(az role definition list \
    --scope "/subscriptions/${_SUBSCRIPTION}/resourceGroups/${_RG}" \
    --custom-role-only true --query "[?contains(roleName,'Foundry Agents')].roleName | [0]" -o tsv 2>/dev/null || true)
  if [[ -n "$_CUSTOM_ROLE_NAME" ]]; then
    ensure_project_role "$_USER_OID" User "$_CUSTOM_ROLE_NAME" || exit 1
    ensure_project_role "$_MI_PRINCIPAL" ServicePrincipal "$_CUSTOM_ROLE_NAME" || exit 1
    echo "Azure AI permissions configured."
  else
    echo "ERROR: The Foundry Agents custom role was not found in the Azure resource group." >&2
    exit 1
  fi

  # Allow time for RBAC propagation before agent creation
  echo "  Waiting for Azure AI permissions to propagate..."
  sleep 60
else
  echo "ERROR: Missing Azure AI account, project, or deployer identity; cannot configure agents." >&2
  exit 1
fi

if ! bash "$(git rev-parse --show-toplevel)/scripts/utilities/create-foundry-agents.sh"; then
    echo "ERROR: Could not configure Azure AI agents; deployment cannot continue." >&2
    exit 1
fi

if ENV_REFRESH_OUTPUT=$(azd env refresh --no-prompt 2>&1); then
    echo "Refreshed Azure deployment outputs."
else
    echo "$ENV_REFRESH_OUTPUT" >&2
    echo "ERROR: Could not refresh azd environment values from the Azure deployment." >&2
    exit 1
fi

echo "Azure resource configuration complete."
