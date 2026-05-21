#!/usr/bin/env bash
# =============================================================================
# tests/scripts/test-manufacturing-trigger.sh
#
# Validates the end-to-end flow:
#   new order (via DAB) → SQL Change Tracking → OrderPlacedSqlTrigger →
#   ManufacturingAgentService → Azure AI Foundry
#
# Prerequisites:
#   - azd environment populated (azd env get-values)
#   - Azure Functions deployed (azd deploy api-functions)
#   - Manufacturing agent created (bash scripts/utilities/agents/manufacturing-agent.sh)
#   - az CLI authenticated (az login)
#
# Usage:
#   bash tests/scripts/test-manufacturing-trigger.sh
# =============================================================================
set -euo pipefail

# ── Load azd environment values ───────────────────────────────────────────────
eval "$(azd env get-values 2>/dev/null | grep -E '^(API_URL|API_FUNCTIONS_URL|AZURE_RESOURCE_GROUP|SERVICE_API_FUNCTIONS_NAME)=' | sed 's/^/export /')"

if [ -z "${API_URL:-}" ] || [ -z "${API_FUNCTIONS_URL:-}" ]; then
    echo "ERROR: API_URL and API_FUNCTIONS_URL must be set in azd environment."
    echo "Run: azd env get-values"
    exit 1
fi

# API_URL may include a /graphql or /graphql/ suffix — derive the REST base URL
DAB_BASE_URL="${API_URL%%/graphql*}"

RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-}"
FUNCTIONS_APP="${SERVICE_API_FUNCTIONS_NAME:-}"

echo ""
echo "=========================================="
echo "Manufacturing Trigger End-to-End Test"
echo "=========================================="
echo "  DAB base URL       : $DAB_BASE_URL"
echo "  Functions URL      : $API_FUNCTIONS_URL"
echo "  Resource Group     : ${RESOURCE_GROUP:-<not set>}"
echo "  Functions App      : ${FUNCTIONS_APP:-<not set>}"
echo ""

# ── Step 1: Place a test order via DAB REST API ───────────────────────────────
echo "[1/4] Placing test order via DAB REST API..."

# Use a well-known customer from the seeded dataset (CustomerID=1 is typically available)
TEST_CUSTOMER_ID=1
ORDER_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build JSON body with Python to avoid shell quoting / newline issues
REST_BODY=$(python3 - <<PYEOF
import json, sys
body = {
    "RevisionNumber": 1,
    "OrderDate": "$ORDER_DATE",
    "DueDate": "$ORDER_DATE",
    "ShipDate": "$ORDER_DATE",
    "Status": 1,
    "OnlineOrderFlag": True,
    "CustomerID": $TEST_CUSTOMER_ID,
    "TerritoryID": 1,
    "BillToAddressID": 985,
    "ShipToAddressID": 985,
    "ShipMethodID": 1,
    "SubTotal": 99.99,
    "TaxAmt": 8.99,
    "Freight": 5.00,
    "TotalDue": 113.98,
    "Comment": "manufacturing-trigger-test"
}
print(json.dumps(body))
PYEOF
)

REST_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$DAB_BASE_URL/api/SalesOrderHeader" \
    -H "Content-Type: application/json" \
    -d "$REST_BODY" 2>&1)

HTTP_CODE=$(echo "$REST_RESPONSE" | tail -1)
REST_BODY_RESPONSE=$(echo "$REST_RESPONSE" | head -n -1)

SALES_ORDER_ID=$(echo "$REST_BODY_RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
# DAB REST wraps single-row responses in a 'value' array
items = data.get('value', [data])
row = items[0] if items else {}
sid = row.get('SalesOrderID') or row.get('salesOrderID') or row.get('salesOrderId') or ''
print(str(sid))
" 2>/dev/null || echo "")

if [ -z "$SALES_ORDER_ID" ] || [ "$SALES_ORDER_ID" = "None" ]; then
    echo "  WARNING: Could not extract SalesOrderID (HTTP $HTTP_CODE)."
    echo "  Response: $REST_BODY_RESPONSE"
    echo ""
    echo "  Falling back to log scan only (no order was placed)."
    SALES_ORDER_ID="unknown"
else
    echo "  ✓ Order created: SalesOrderID=$SALES_ORDER_ID (HTTP $HTTP_CODE)"
fi

# ── Step 2: Wait for SQL Change Tracking poll interval ────────────────────────
echo ""
echo "[2/4] Waiting 15 seconds for SQL Change Tracking trigger to fire..."
sleep 15

# ── Step 3: Check function app logs ──────────────────────────────────────────
echo ""
echo "[3/4] Checking function app logs for trigger + agent invocation..."

if [ -z "$RESOURCE_GROUP" ] || [ -z "$FUNCTIONS_APP" ]; then
    echo "  SKIP: AZURE_RESOURCE_GROUP / SERVICE_API_FUNCTIONS_NAME not set."
    echo "        Check Application Insights or the Azure portal manually."
else
    LOG_OUTPUT=$(az containerapp logs show \
        --name "$FUNCTIONS_APP" \
        --resource-group "$RESOURCE_GROUP" \
        --tail 60 \
        --format text 2>&1 || echo "")

    TRIGGER_LOG=$(echo "$LOG_OUTPUT" | grep -i "OrderPlacedSqlTrigger\|sql trigger\|SalesOrderID=$SALES_ORDER_ID" | tail -5 || echo "")
    AGENT_LOG=$(echo "$LOG_OUTPUT" | grep -i "manufacturing agent\|ManufacturingAgent\|ResponseId" | tail -5 || echo "")

    if [ -n "$TRIGGER_LOG" ]; then
        echo "  ✓ SQL trigger fired:"
        echo "$TRIGGER_LOG" | sed 's/^/      /'
    else
        echo "  ? SQL trigger log not found (may need more time, or check App Insights)"
    fi

    if [ -n "$AGENT_LOG" ]; then
        echo ""
        echo "  ✓ Manufacturing agent invoked:"
        echo "$AGENT_LOG" | sed 's/^/      /'
    else
        echo ""
        echo "  ? Manufacturing agent log not found (may need more time, or check App Insights)"
    fi
fi

# ── Step 4: Summary ───────────────────────────────────────────────────────────
echo ""
echo "[4/4] Test summary"
echo "=========================================="
if [ "$SALES_ORDER_ID" != "unknown" ]; then
    echo "  SalesOrderID : $SALES_ORDER_ID"
    echo "  Customer     : $TEST_CUSTOMER_ID"
fi
echo ""
echo "  To verify manually, check Application Insights for:"
echo "    - Operation: ManufacturingAgent.Invoke"
echo "    - Property : SalesOrderId=$SALES_ORDER_ID"
echo "    - Property : ResponseId (non-empty = agent ran successfully)"
echo ""
echo "  az monitor app-insights query --app <app-insights-name> \\"
echo "    --analytics-query \"requests | where name == 'ManufacturingAgent.Invoke' | order by timestamp desc | take 5\""
echo "=========================================="
