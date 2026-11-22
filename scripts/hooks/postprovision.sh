#!/bin/bash
# Post-provision hook: reconciles runtime RBAC, sets storefront build variables,
# prepares the seed-job image, checks Aspire Dashboard access, creates the api-mcp
# Key Vault signing certificate, configures SQL access and roles, starts the seed job,
# and assigns Foundry project roles before creating the Foundry agents.

set -e

echo "Configuring Azure resources for the demo..."

# Incremental ARM deployments do not remove role assignments retired from Bicep. Report
# any legacy runtime grants (report-only: the conditioned deployer may not delete roles
# outside infra/azd-role-assignment-allowlist.json; legacy environments are recreated).
python3 "$(dirname "${BASH_SOURCE[0]}")/../utilities/reconcile-runtime-rbac.py"

RESOURCE_GROUP=$(azd env get-value 'AZURE_RESOURCE_GROUP' 2>/dev/null | head -n1 | tr -d '\n\r ')

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

# Build and publish the seed image while the independent resource configuration
# below runs. SQL setup must finish before the job starts on legacy public-SQL
# deployments, so this background stage only prepares the image and job template.
ACR_ENDPOINT=$(azd env get-value AZURE_CONTAINER_REGISTRY_ENDPOINT 2>/dev/null | head -n1 | tr -d '\n\r ')
SEED_JOB_NAME=$(azd env get-value SERVICE_SEED_JOB_NAME 2>/dev/null | head -n1 | tr -d '\n\r ')
if [ -z "$RESOURCE_GROUP" ] || [ -z "$ACR_ENDPOINT" ] || [ -z "$SEED_JOB_NAME" ]; then
    echo "ERROR: Required environment variables not found for seed-job deployment."
    echo "Resource Group: ${RESOURCE_GROUP:-[NOT SET]}"
    echo "ACR Endpoint: ${ACR_ENDPOINT:-[NOT SET]}"
    echo "Seed Job Name: ${SEED_JOB_NAME:-[NOT SET]}"
    exit 1
fi

SEED_SETUP_LOG=$(mktemp /tmp/seed-job-setup.XXXXXX.log)
SEED_SETUP_PID=""
SQL_CLIENT_FIREWALL_RULE_ACTIVE=false
cleanup_postprovision() {
    local status=$?
    trap - EXIT
    if [ -n "$SEED_SETUP_PID" ]; then
        if kill -0 "$SEED_SETUP_PID" 2>/dev/null; then
            kill "$SEED_SETUP_PID" 2>/dev/null || true
        fi
        wait "$SEED_SETUP_PID" 2>/dev/null || true
    fi
    if [ "$SQL_CLIENT_FIREWALL_RULE_ACTIVE" = "true" ]; then
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
    [ -z "$SEED_SETUP_LOG" ] || rm -f "$SEED_SETUP_LOG"
    exit "$status"
}
trap cleanup_postprovision EXIT

prepare_seed_job() {
    local acr_name="${ACR_ENDPOINT%%.*}"

    # Ensure Git LFS files (e.g. seed-job/sql/ProductNames-ai.csv) are present
    # so the build context contains real assets, not pointer files.
    local repo_root
    repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$repo_root" ] && [ -e "$repo_root/.git" ]; then
        if ! git lfs version &>/dev/null; then
            echo "ERROR: Git LFS is required to fetch the seed-job assets." >&2
            return 1
        fi
        echo "Checking required seed-job assets..."
        if ! (cd "$repo_root" && git lfs pull); then
            echo "ERROR: Could not download Git LFS assets required to build the seed job." >&2
            return 1
        fi
        echo "  Seed-job assets ready."
    fi

    echo "Building and publishing the seed-job image..."
    local build_output build_id image_name update_output
    if build_output=$(az acr build \
        --registry "$acr_name" \
        --image seed-job:latest \
        --file seed-job/dockerfile \
        seed-job \
        --no-logs 2>&1); then
        build_id=$(printf '%s\n' "$build_output" | sed -nE 's/.*build with ID: ([[:alnum:]-]+).*/\1/p' | tail -n1)
        if [ -n "$build_id" ]; then
            echo "  Seed-job image build succeeded ($build_id)."
        else
            echo "  Seed-job image build succeeded."
        fi
    else
        echo "$build_output" >&2
        echo "ERROR: Seed-job image build failed." >&2
        return 1
    fi

    image_name="${ACR_ENDPOINT}/seed-job:latest"
    echo "Updating the seed-job template..."
    if ! update_output=$(az containerapp job update \
        --name "$SEED_JOB_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --container-name "$SEED_JOB_NAME" \
        --image "$image_name" \
        --set-env-vars SEED_SKIP_EXISTING=true \
        --output none 2>&1); then
        echo "$update_output" >&2
        echo "ERROR: Could not update the seed-job image." >&2
        return 1
    fi
    echo "Seed-job image and template are ready."
}

echo "Preparing the seed-job image and template in the background..."
prepare_seed_job >"$SEED_SETUP_LOG" 2>&1 &
SEED_SETUP_PID=$!

# Check effective Aspire Dashboard permissions without creating a role assignment
CONTAINER_APP_ENV_NAME=$(azd env get-value 'CONTAINER_APP_ENVIRONMENT_NAME' 2>/dev/null | head -n1 | tr -d '\n\r ')

if [ -n "$CONTAINER_APP_ENV_NAME" ] && [ "$CONTAINER_APP_ENV_NAME" != "ERROR: key 'CONTAINER_APP_ENVIRONMENT_NAME' not found in the environment values" ]; then
    echo ""
    echo "Configuring Aspire Dashboard access..."
    SUBSCRIPTION_ID=$(az account show --query id -o tsv 2>/dev/null || true)

    if [ -n "$SUBSCRIPTION_ID" ] && [ -n "$RESOURCE_GROUP" ] && command -v jq >/dev/null 2>&1; then
        ENV_RESOURCE_ID="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/managedEnvironments/$CONTAINER_APP_ENV_NAME"
        PERMISSIONS_URL="https://management.azure.com${ENV_RESOURCE_ID}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01"

        if PERMISSIONS=$(az rest --method get --url "$PERMISSIONS_URL" 2>/dev/null); then
            if printf '%s' "$PERMISSIONS" | jq -e '
                def action_matches($pattern; $action):
                    ($pattern | ascii_downcase) as $p
                    | ($action | ascii_downcase) as $a
                    | ($p == "*" or $p == $a or (($p | endswith("*")) and ($a | startswith($p[0:-1]))));
                any(.value[]?;
                    any(.actions[]?; action_matches(.; "Microsoft.App/managedEnvironments/write"))
                    and all(.notActions[]?; (action_matches(.; "Microsoft.App/managedEnvironments/write") | not))
                )
            ' >/dev/null; then
                echo "  Effective write access found; Aspire Dashboard access is available."
            else
                echo "  WARNING: Could not confirm Microsoft.App/managedEnvironments/write at this scope."
                echo "  Aspire Dashboard access may be unavailable; continuing deployment."
            fi
        else
            echo "  WARNING: Could not query effective permissions for the Container Apps Environment."
            echo "  Aspire Dashboard access was not verified; continuing deployment."
        fi
    else
        echo "  WARNING: Could not determine the subscription/resource group or jq is unavailable."
        echo "  Aspire Dashboard access was not verified; continuing deployment."
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
DEPLOYER_PRINCIPAL_TYPE=$(azd env get-value 'DEPLOYER_PRINCIPAL_TYPE' 2>/dev/null | head -n1 | tr -d '\n\r ')
if [ -z "$DEPLOYER_PRINCIPAL_TYPE" ] || [[ "$DEPLOYER_PRINCIPAL_TYPE" == ERROR:* ]]; then
    DEPLOYER_PRINCIPAL_TYPE="User"
fi
case "$DEPLOYER_PRINCIPAL_TYPE" in
    User|ServicePrincipal) ;;
    *)
        echo "ERROR: DEPLOYER_PRINCIPAL_TYPE must be User or ServicePrincipal (got: $DEPLOYER_PRINCIPAL_TYPE)." >&2
        exit 1
        ;;
esac
DEPLOYER_OBJECT_ID=$(azd env get-value 'OBJECT_ID' 2>/dev/null | head -n1 | tr -d '\n\r ')
if [[ "$DEPLOYER_OBJECT_ID" == ERROR:* ]]; then
    DEPLOYER_OBJECT_ID=""
fi
if [ -z "$DEPLOYER_OBJECT_ID" ]; then
    if [ "$DEPLOYER_PRINCIPAL_TYPE" = "ServicePrincipal" ]; then
        echo "ERROR: OBJECT_ID is required when DEPLOYER_PRINCIPAL_TYPE is ServicePrincipal." >&2
        exit 1
    fi
    DEPLOYER_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
fi
if ! [[ "$DEPLOYER_OBJECT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "ERROR: Could not determine a valid deployer object ID." >&2
    exit 1
fi

if [ -z "$KEY_VAULT_NAME" ] || [[ "$KEY_VAULT_NAME" == ERROR:* ]]; then
    echo "ERROR: MCP_SIGNING_KEY_VAULT_NAME is missing; the MCP OAuth server cannot start without its signing certificate." >&2
    exit 1
else
(
    # Keep certificate cleanup isolated from the later SQL EXIT trap.
    KEY_VAULT_CLIENT_FIREWALL_RULE_ACTIVE=false
    CERT_POLICY_FILE=""
    CERT_ERROR_FILE=""
    CERT_INVENTORY_FILE=""
    cleanup_key_vault_certificate_setup() {
        local status=$?
        if [ "$KEY_VAULT_CLIENT_FIREWALL_RULE_ACTIVE" = "true" ]; then
            if az keyvault network-rule remove \
                --name "$KEY_VAULT_NAME" \
                --resource-group "$RESOURCE_GROUP" \
                --subscription "$SUBSCRIPTION_ID" \
                --ip-address "${KEY_VAULT_CLIENT_IP}/32" \
                --output none; then
                echo "  Removed temporary Key Vault client firewall rule."
            else
                echo "ERROR: Could not remove the temporary Key Vault client firewall rule (${KEY_VAULT_CLIENT_IP}/32) from $KEY_VAULT_NAME." >&2
                status=1
            fi
        fi
        [ -z "$CERT_POLICY_FILE" ] || rm -f "$CERT_POLICY_FILE"
        [ -z "$CERT_ERROR_FILE" ] || rm -f "$CERT_ERROR_FILE"
        [ -z "$CERT_INVENTORY_FILE" ] || rm -f "$CERT_INVENTORY_FILE"
        exit "$status"
    }
    trap cleanup_key_vault_certificate_setup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    SUBSCRIPTION_ID=$(azd env get-value 'AZURE_SUBSCRIPTION_ID' 2>/dev/null | head -n1 | tr -d '\n\r ')
    if [ -z "$SUBSCRIPTION_ID" ] || [[ "$SUBSCRIPTION_ID" == ERROR:* ]]; then
        echo "ERROR: AZURE_SUBSCRIPTION_ID is missing; cannot configure the signing vault." >&2
        exit 1
    fi
    VAULT_RESOURCE_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.KeyVault/vaults/${KEY_VAULT_NAME}"
    if [ -n "$DEPLOYER_OBJECT_ID" ]; then
        # Grant the deployer "Key Vault Certificates Officer" (idempotent), scoped to the vault only.
        EXISTING_CERT_OFFICER=$(az role assignment list \
            --scope "$VAULT_RESOURCE_ID" \
            --subscription "$SUBSCRIPTION_ID" \
            --assignee-object-id "$DEPLOYER_OBJECT_ID" \
            --role "Key Vault Certificates Officer" \
            --query "[].id" -o tsv 2>/dev/null || echo "")
        if [ -z "$EXISTING_CERT_OFFICER" ]; then
            if az role assignment create \
                --scope "$VAULT_RESOURCE_ID" \
                --subscription "$SUBSCRIPTION_ID" \
                --assignee-object-id "$DEPLOYER_OBJECT_ID" \
                --assignee-principal-type "$DEPLOYER_PRINCIPAL_TYPE" \
                --role "Key Vault Certificates Officer" \
                --output none 2>/dev/null; then
                echo "  Granted deployer 'Key Vault Certificates Officer' on $KEY_VAULT_NAME"
            elif az role assignment list \
                --scope "$VAULT_RESOURCE_ID" \
                --subscription "$SUBSCRIPTION_ID" \
                --assignee-object-id "$DEPLOYER_OBJECT_ID" \
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

    KEY_VAULT_CLIENT_IP="${KEY_VAULT_CLIENT_IP:-${SQL_CLIENT_IP:-}}"
    if [ -z "$KEY_VAULT_CLIENT_IP" ]; then
        KEY_VAULT_CLIENT_IP=$(curl -4fsS --connect-timeout 5 --max-time 10 https://api.ipify.org) || {
            echo "ERROR: Could not discover the deployment host's public IPv4 address; set KEY_VAULT_CLIENT_IP and retry." >&2
            exit 1
        }
    fi
    if ! printf '%s\n' "$KEY_VAULT_CLIENT_IP" | awk -F. 'NF != 4 { exit 1 } { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i > 255) exit 1 }'; then
        echo "ERROR: KEY_VAULT_CLIENT_IP must be a valid IPv4 address (got: $KEY_VAULT_CLIENT_IP)" >&2
        exit 1
    fi
    # Use the management plane to check rules before making any data-plane calls.
    EXISTING_KEY_VAULT_CLIENT_RULE=$(az keyvault show \
        --name "$KEY_VAULT_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --subscription "$SUBSCRIPTION_ID" \
        --query "properties.networkAcls.ipRules[?value=='${KEY_VAULT_CLIENT_IP}' || value=='${KEY_VAULT_CLIENT_IP}/32'].value" \
        --output tsv)
    if [ -z "$EXISTING_KEY_VAULT_CLIENT_RULE" ]; then
        echo "  Temporarily allowing the deployment host to configure the Key Vault certificate..."
        # Also attempt cleanup if the add request fails after reaching Azure.
        KEY_VAULT_CLIENT_FIREWALL_RULE_ACTIVE=true
        az keyvault network-rule add \
            --name "$KEY_VAULT_NAME" \
            --resource-group "$RESOURCE_GROUP" \
            --subscription "$SUBSCRIPTION_ID" \
            --ip-address "${KEY_VAULT_CLIENT_IP}/32" \
            --output none
    fi

    CERT_ERROR_FILE=$(mktemp /tmp/mcp-signing-error.XXXXXX.txt)
    CERT_INVENTORY_FILE=$(mktemp /tmp/mcp-signing-inventory.XXXXXX.json)
    CERT_INVENTORY_READY=false
    for attempt in $(seq 1 12); do
        if az keyvault certificate list \
            --vault-name "$KEY_VAULT_NAME" \
            --subscription "$SUBSCRIPTION_ID" \
            --include-pending true \
            --query '[].{id:id}' \
            --output json >"$CERT_INVENTORY_FILE" 2>"$CERT_ERROR_FILE"; then
            CERT_INVENTORY_READY=true
            break
        fi
        [ "$attempt" -eq 12 ] || sleep 15
    done
    if [ "$CERT_INVENTORY_READY" != "true" ]; then
        echo "ERROR: Could not inspect Key Vault certificates; refusing to create or rotate the signing certificate." >&2
        sed 's/^/  /' "$CERT_ERROR_FILE" >&2
        exit 1
    fi

    if ! CERT_PRESENT=$(python3 - "$CERT_INVENTORY_FILE" "$KEY_VAULT_NAME" "$SIGNING_CERT_NAME" <<'PY'
import json
import re
import sys
from urllib.parse import urlsplit

try:
    with open(sys.argv[1], encoding="utf-8") as source:
        certificates = json.load(source)
    if not isinstance(certificates, list) or not re.fullmatch(r"[a-zA-Z0-9-]+", sys.argv[3]):
        raise ValueError("Invalid certificate inventory")
    names = []
    for certificate in certificates:
        identifier = certificate.get("id") if isinstance(certificate, dict) else None
        if not isinstance(identifier, str):
            raise ValueError("Missing certificate identifier")
        parsed = urlsplit(identifier)
        parts = parsed.path.split("/")
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or
                parsed.hostname.split(".")[0].lower() != sys.argv[2].lower() or
                parsed.query or parsed.fragment or len(parts) != 3 or parts[1] != "certificates" or
                not re.fullmatch(r"[a-zA-Z0-9-]+", parts[2])):
            raise ValueError("Invalid certificate identifier")
        names.append(parts[2].lower())
    print("true" if sys.argv[3].lower() in names else "false")
except (OSError, ValueError):
    print("ERROR: Invalid Key Vault certificate inventory; refusing certificate creation.", file=sys.stderr)
    sys.exit(1)
PY
    ); then
        exit 1
    fi

    if [ "$CERT_PRESENT" = "true" ]; then
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
        echo "  Creating '$SIGNING_CERT_NAME' in Key Vault..."
        if ! az keyvault certificate create \
            --vault-name "$KEY_VAULT_NAME" \
            --subscription "$SUBSCRIPTION_ID" \
            --name "$SIGNING_CERT_NAME" \
            --policy @"$CERT_POLICY_FILE" \
            --output none 2>"$CERT_ERROR_FILE"; then
            echo "ERROR: Signing certificate creation failed or its outcome is uncertain; no retry was attempted." >&2
            sed 's/^/  /' "$CERT_ERROR_FILE" >&2
            exit 1
        fi
        rm -f "$CERT_POLICY_FILE"
    fi

    CERT_READY=false
    for attempt in $(seq 1 12); do
        if az keyvault certificate show \
            --vault-name "$KEY_VAULT_NAME" --name "$SIGNING_CERT_NAME" \
            --subscription "$SUBSCRIPTION_ID" \
            --output none 2>"$CERT_ERROR_FILE"; then
            CERT_READY=true
            echo "  Signing certificate metadata is readable (attempt $attempt/12)."
            break
        fi
        [ "$attempt" -eq 12 ] || sleep 15
    done
    if [ "$CERT_READY" != "true" ]; then
        echo "ERROR: Signing certificate is not readable; no additional create was attempted." >&2
        sed 's/^/  /' "$CERT_ERROR_FILE" >&2
        exit 1
    fi
)
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
    SQL_CLIENT_FIREWALL_RULE_ACTIVE=true

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
    echo "Monitor seed execution logs for database access failures or overlay conflicts; deployment does not wait for completion."
fi

echo "Preparing the database seed job..."

if wait "$SEED_SETUP_PID"; then
    SEED_SETUP_PID=""
    cat "$SEED_SETUP_LOG"
else
    SEED_SETUP_STATUS=$?
    SEED_SETUP_PID=""
    cat "$SEED_SETUP_LOG" >&2
    echo "ERROR: Seed-job image/template preparation failed (exit $SEED_SETUP_STATUS)." >&2
    exit 1
fi

source "$(dirname "${BASH_SOURCE[0]}")/seed-job-execution.sh"
if ! start_seed_job "$SEED_JOB_NAME" "$RESOURCE_GROUP"; then
    exit 1
fi

echo "Configuring Azure AI permissions..."
# The Agents data-plane API requires Azure AI Developer role at the project scope.
# Account-level roles (assigned by Bicep) do not cascade for agents/write operations.
_AI_ACCOUNT=$(azd env get-value AZURE_OPENAI_ACCOUNT_NAME 2>/dev/null | head -n1 | tr -d '\n\r ')
_AI_PROJECT=$(azd env get-value AI_FOUNDRY_PROJECT_NAME 2>/dev/null | head -n1 | tr -d '\n\r ')
_SUBSCRIPTION=$(azd env get-value AZURE_SUBSCRIPTION_ID 2>/dev/null | head -n1 | tr -d '\n\r ')
_RG=$(azd env get-value AZURE_RESOURCE_GROUP 2>/dev/null | head -n1 | tr -d '\n\r ')
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
    --assignee-object-id "$principal_id" \
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
    --assignee-object-id "$principal_id" \
    --role "$role" \
    --query "[0].id" -o tsv 2>/dev/null || true)
  if [[ -z "$assignment" ]]; then
    echo "$create_error" >&2
    echo "ERROR: Could not assign '$role' at the Azure AI project scope." >&2
    return 1
  fi
}

if [[ -n "$_AI_ACCOUNT" ]] && [[ -n "$_AI_PROJECT" ]] && [[ -n "$DEPLOYER_OBJECT_ID" ]]; then
  _PROJECT_SCOPE="/subscriptions/${_SUBSCRIPTION}/resourceGroups/${_RG}/providers/Microsoft.CognitiveServices/accounts/${_AI_ACCOUNT}/projects/${_AI_PROJECT}"

  ensure_project_role "$DEPLOYER_OBJECT_ID" "$DEPLOYER_PRINCIPAL_TYPE" "64702f94-c441-49e6-a78b-ef80e0188fee" || exit 1
  ensure_project_role "$DEPLOYER_OBJECT_ID" "$DEPLOYER_PRINCIPAL_TYPE" "a001fd3d-188f-4b5d-821b-7da978bf7442" || exit 1

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

  # This built-in data role is broader than the former custom role; Bicep gives
  # it only at the Foundry project scope. Ensure the deployer's assignment too.
  ensure_project_role "$DEPLOYER_OBJECT_ID" "$DEPLOYER_PRINCIPAL_TYPE" "19c28022-e58e-450d-a464-0b2a53034789" || exit 1
  echo "Azure AI permissions configured."

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

FOUNDRY_AGENT_CONFIG_HASH=$(python3 scripts/utilities/agents/lib/agent-config-fingerprint.py)
azd env set FOUNDRY_AGENT_CONFIG_HASH "$FOUNDRY_AGENT_CONFIG_HASH"

echo "Azure resource configuration complete."
