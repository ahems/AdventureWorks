#!/usr/bin/env bash
#
# Seed the sales-order-status queue with messages for all orders in status 1 (In Process).
# Uses azd env for Functions URL, DAB URL, storage account, and resource group.
# Each message triggers the same flow as the app's Purchase flow (BeginProcessingOrder).
#
# Prerequisites:
#   - azd CLI, az CLI, jq
#   - azd env selected and provisioned (azd env get-values has the required vars)
#   - az login (for storage queue access with --auth-mode login)
#
# Optional: set DAB_ACCESS_TOKEN for Bearer auth if DAB requires it.
#
# Usage: ./scripts/utilities/seed-sales-order-status-queue.sh [--dry-run]

set -e

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "Dry run: will not send messages to the queue."
  echo ""
fi

# Load azd environment
if ! command -v azd &>/dev/null; then
  echo "Error: azd CLI not found. Install Azure Developer CLI (azd)."
  exit 1
fi

echo "Loading configuration from azd environment..."
AZD_VALUES=$(azd env get-values 2>/dev/null) || true
if [[ -z "$AZD_VALUES" ]]; then
  echo "Error: Could not get azd env values. Run 'azd env refresh' or ensure an environment is selected."
  exit 1
fi

# Parse required values (azd env get-values outputs KEY="value" per line)
get_azd_value() {
  echo "$AZD_VALUES" | grep -E "^${1}=" | cut -d '=' -f 2- | tr -d '"'
}

API_URL=$(get_azd_value "API_URL")
API_FUNCTIONS_URL=$(get_azd_value "API_FUNCTIONS_URL")
STORAGE_ACCOUNT_NAME=$(get_azd_value "STORAGE_ACCOUNT_NAME")
AZURE_RESOURCE_GROUP=$(get_azd_value "AZURE_RESOURCE_GROUP")

# Optional: use for DAB REST if the API requires Bearer auth
DAB_ACCESS_TOKEN="${DAB_ACCESS_TOKEN:-}"

missing=""
[[ -z "$API_URL" ]] && missing="${missing} API_URL"
[[ -z "$STORAGE_ACCOUNT_NAME" ]] && missing="${missing} STORAGE_ACCOUNT_NAME"
[[ -z "$AZURE_RESOURCE_GROUP" ]] && missing="${missing} AZURE_RESOURCE_GROUP"

if [[ -n "$missing" ]]; then
  echo "Error: Missing from azd env:${missing}"
  echo "Run: azd env refresh"
  echo "Expected outputs: API_URL (DAB), STORAGE_ACCOUNT_NAME, AZURE_RESOURCE_GROUP. Optional: API_FUNCTIONS_URL."
  exit 1
fi

# DAB REST base: API_URL is the GraphQL endpoint (e.g. https://av-api-xxx.azurecontainerapps.io/graphql/)
# Strip /graphql or /graphql/ to get the base for REST /api/...
DAB_BASE_URL="${API_URL%/}"
DAB_BASE_URL="${DAB_BASE_URL%/graphql}"
DAB_BASE_URL="${DAB_BASE_URL%/graphql/}"

echo "DAB REST base:    $DAB_BASE_URL"
echo "Functions URL:    ${API_FUNCTIONS_URL:-<not set>}"
echo "Storage account:  $STORAGE_ACCOUNT_NAME"
echo "Resource group:   $AZURE_RESOURCE_GROUP"
echo ""

# Ensure we're in the right subscription if AZURE_SUBSCRIPTION_ID is set
AZURE_SUBSCRIPTION_ID=$(get_azd_value "AZURE_SUBSCRIPTION_ID")
if [[ -n "$AZURE_SUBSCRIPTION_ID" ]]; then
  az account set --subscription "$AZURE_SUBSCRIPTION_ID" 2>/dev/null || true
fi

# Fetch all orders in status 1 (In Process) from DAB REST
# OData filter: Status eq 1; select only SalesOrderID (space encoded as %20 for curl)
FILTER_URL="${DAB_BASE_URL}/api/SalesOrderHeader?\$filter=Status%20eq%201&\$select=SalesOrderID"
echo "Fetching orders with Status=1 from DAB..."

CURL_OPTS=(-s -S -w "\n%{http_code}" --connect-timeout 10 --max-time 30 "$FILTER_URL")
if [[ -n "$DAB_ACCESS_TOKEN" ]]; then
  CURL_OPTS=(-H "Authorization: Bearer $DAB_ACCESS_TOKEN" "${CURL_OPTS[@]}")
fi

TMP_RESPONSE=$(mktemp)
trap 'rm -f "$TMP_RESPONSE"' EXIT
if ! curl "${CURL_OPTS[@]}" > "$TMP_RESPONSE"; then
  echo "Error: Failed to reach DAB (connection timeout or network error)."
  echo "Check that $DAB_BASE_URL is reachable from this machine."
  exit 1
fi
CODE=$(sed -n '$p' "$TMP_RESPONSE")
RESPONSE=$(sed '$d' "$TMP_RESPONSE")

if [[ "$CODE" != "200" ]]; then
  echo "Error: DAB returned HTTP ${CODE:-<no code>}"
  echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
  if [[ "$CODE" == "401" ]]; then
    echo ""
    echo "If DAB requires auth, set DAB_ACCESS_TOKEN (e.g. from Azure AD or your app token) and retry."
  fi
  exit 1
fi

# Parse .value array of { "SalesOrderID": N }
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required to parse DAB response. Install jq."
  exit 1
fi

ORDER_IDS=()
while IFS= read -r id; do
  [[ -n "$id" ]] && ORDER_IDS+=("$id")
done < <(echo "$RESPONSE" | jq -r '.value[]? | .SalesOrderID // empty')

COUNT=${#ORDER_IDS[@]}
if [[ $COUNT -eq 0 ]]; then
  echo "No orders found with Status=1. Nothing to enqueue."
  exit 0
fi

echo "Found $COUNT order(s) with Status=1 (In Process)."
echo ""

# Queue name must match the one used by the Functions and infra
QUEUE_NAME="sales-order-status"

# Message format expected by ProcessSalesOrderStatus: { "SalesOrderID": <id>, "Status": 1 }
# The Functions app uses QueueMessageEncoding.Base64, so we store base64-encoded JSON (single line).
for id in "${ORDER_IDS[@]}"; do
  BODY="{\"SalesOrderID\":$id,\"Status\":1}"
  ENCODED=$(echo -n "$BODY" | base64 -w0 2>/dev/null || echo -n "$BODY" | base64 | tr -d '\n')
  echo "  SalesOrderID=$id"

  if [[ "$DRY_RUN" == "true" ]]; then
    continue
  fi

  if ! az storage message put \
    --queue-name "$QUEUE_NAME" \
    --content "$ENCODED" \
    --account-name "$STORAGE_ACCOUNT_NAME" \
    --auth-mode login \
    --output none 2>/dev/null; then
    echo "Error: Failed to put message for SalesOrderID=$id. Ensure 'az login' and Storage Queue Data Contributor (or key) for the storage account."
    exit 1
  fi
done

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "Dry run complete. Would have enqueued $COUNT message(s). Run without --dry-run to send."
  exit 0
fi

echo ""
echo "Done. Enqueued $COUNT message(s) to queue '$QUEUE_NAME' on storage account '$STORAGE_ACCOUNT_NAME'."
echo "Messages will be processed by the Functions (ProcessSalesOrderStatus) with the same flow as new orders from the app."
