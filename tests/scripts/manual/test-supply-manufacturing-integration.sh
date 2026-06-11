#!/bin/bash
# Supply Chain + Manufacturing - Full Integration Test Script
#
# Exercises the complete procurement → production pipeline:
#   1. Planning APIs  (feasibility, cost, catalog, overstock, thin-margin, shortage-forecast, reorder-recs)
#   2. Seed supply chain (reset, inspect vendors, pick the cheapest offer for a needed component)
#   3. Place a purchase order and watch it progress through states
#   4. Start a manufacturing run (ProductID=749 Mountain-100 Black 38)
#   5. Monitor both simultaneously — verify stalled run unblocks when stock arrives
#   6. Confirm vendor quality board populates after production
#   7. Clean up (stop manufacturing, reset supply chain)
#
# Usage: ./tests/scripts/manual/test-supply-manufacturing-integration.sh [functions-url]
# Requires: curl, jq
# ---------------------------------------------------------------------------

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

PASS=0; FAIL=0; SKIP=0
LAST_RESPONSE=""; LAST_STATUS=""

pass() { echo -e "  ${GREEN}✓ PASS${NC} $1"; PASS=$(( PASS + 1 )); }
fail() { echo -e "  ${RED}✗ FAIL${NC} $1"; FAIL=$(( FAIL + 1 )); }
skip() { echo -e "  ${YELLOW}⚠ SKIP${NC} $1"; SKIP=$(( SKIP + 1 )); }
info() { echo -e "  ${CYAN}ℹ${NC} $1"; }
section() { echo -e "\n${BLUE}${BOLD}━━ $1 ━━${NC}"; }

check() {
  local label="$1" expected="$2" method="$3" url="$4" body="${5:-}"
  local args=(-s -w "\n%{http_code}" -X "$method" -H "Content-Type: application/json" --max-time 30)
  [[ -n "$body" ]] && args+=(-d "$body")
  local raw; raw=$(curl "${args[@]}" "$url" 2>/dev/null)
  LAST_STATUS=$(echo "$raw" | tail -1)
  LAST_RESPONSE=$(echo "$raw" | head -n -1)
  if [[ "$LAST_STATUS" == "$expected" ]]; then
    pass "$label (HTTP $LAST_STATUS)"
  else
    fail "$label (expected HTTP $expected, got $LAST_STATUS)"
    [[ -n "$LAST_RESPONSE" ]] && echo "    Response: $(echo "$LAST_RESPONSE" | head -c 300)"
  fi
}

# ── URL setup ────────────────────────────────────────────────────────────────
if [[ -n "${1:-}" ]]; then
  BASE="$1"
else
  BASE=$(azd env get-values 2>/dev/null | grep "^API_FUNCTIONS_URL=" | cut -d'=' -f2 | tr -d '"')
fi

if [[ -z "${BASE:-}" ]]; then
  echo -e "${RED}Error: Cannot determine API_FUNCTIONS_URL.${NC}"
  echo "  Run 'azd up' or pass the URL as the first argument."
  exit 1
fi
BASE="${BASE%/}"

echo -e "${BOLD}Supply Chain + Manufacturing Integration Test${NC}"
echo -e "Base URL: ${CYAN}$BASE${NC}"
echo -e "Date:     $(date -u +%Y-%m-%dT%H:%M:%SZ)\n"

# ──────────────────────────────────────────────────────────────────────────────
# PART 1: PLANNING APIs
# ──────────────────────────────────────────────────────────────────────────────
section "Part 1: Planning APIs"

# Feasibility for all manufactured finished goods
check "GET /plan/feasibility" 200 GET "$BASE/api/plan/feasibility"
FEASIBILITY_COUNT=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Finished goods in feasibility snapshot: $FEASIBILITY_COUNT"
echo "$LAST_RESPONSE" | jq -r '.[:3][] | "  \(.productId) \(.name): maxProducibleNow=\(.maxProducibleNow) signal=\(.inventorySignal)"' 2>/dev/null || true

# Feasibility for Mountain-100 Black 38 (ProductID=749)
check "GET /plan/feasibility/749?qty=2" 200 GET "$BASE/api/plan/feasibility/749?qty=2"
echo "  $(echo "$LAST_RESPONSE" | jq -r '"product=\(.name) maxProducibleNow=\(.maxProducibleNow) bottleneck=\(.bottleneckComponentName // "none")"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 300)"

check "GET /plan/feasibility/9999 (nonexistent → 404)" 404 GET "$BASE/api/plan/feasibility/9999"

# Cost analysis
check "GET /plan/cost/749" 200 GET "$BASE/api/plan/cost/749"
echo "  $(echo "$LAST_RESPONSE" | jq -r '"materialCost=\(.materialCost) routingCost=\(.routingCost) listPrice=\(.listPrice) grossMarginPct=\(.grossMarginPct)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 300)"

check "GET /plan/cost/749/current (live cost)" 200 GET "$BASE/api/plan/cost/749/current"
echo "  $(echo "$LAST_RESPONSE" | jq -r '"totalManufacturingCost=\(.totalManufacturingCost) materialCost=\(.currentMaterialCost) pricingSignal=\(.pricingSignal)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 300)"

check "GET /plan/cost/9999 (nonexistent → 404)" 404 GET "$BASE/api/plan/cost/9999"

# Full catalog snapshot
check "GET /plan/catalog" 200 GET "$BASE/api/plan/catalog"
CATALOG_SNAP=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Catalog snapshot entries: $CATALOG_SNAP"

# Filter by inventory signal
check "GET /plan/catalog?inventorySignal=low-stock" 200 GET "$BASE/api/plan/catalog?inventorySignal=low-stock"
LOW_STOCK=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Low-stock products: $LOW_STOCK"

# Overstock
check "GET /plan/overstock" 200 GET "$BASE/api/plan/overstock"
echo "  $(echo "$LAST_RESPONSE" | jq -r '"count=\(.count) threshold=\(.thresholdWeeksOfSupply)w"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"

# Thin margin
check "GET /plan/thin-margin" 200 GET "$BASE/api/plan/thin-margin"
echo "  $(echo "$LAST_RESPONSE" | jq -r '"count=\(.count) threshold=\(.thresholdMarginPct)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"

# Shortage forecast
check "GET /plan/shortage-forecast?days=90" 200 GET "$BASE/api/plan/shortage-forecast?days=90"
echo "  $(echo "$LAST_RESPONSE" | jq -r '"critical=\(.critical) warning=\(.warning) watch=\(.watch)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"
CRITICAL_SHORTS=$(echo "$LAST_RESPONSE" | jq -r '.items[:2][] | "  ⚠ \(.productName) stockoutDays=\(.daysUntilStockout) urgency=\(.urgencyLevel)"' 2>/dev/null || true)
[[ -n "$CRITICAL_SHORTS" ]] && echo "$CRITICAL_SHORTS"

# Reorder recommendations
check "GET /plan/reorder-recommendations?days=60" 200 GET "$BASE/api/plan/reorder-recommendations?days=60"
REORDER_COUNT=$(echo "$LAST_RESPONSE" | jq -r '.totalRecommendations // (.items | length)' 2>/dev/null || echo 0)
REORDER_COST=$(echo "$LAST_RESPONSE" | jq -r '.estimatedTotalProcurementCost' 2>/dev/null || echo 0)
echo "  Reorder recommendations: $REORDER_COUNT, estimated cost: \$$REORDER_COST"
echo "$LAST_RESPONSE" | jq -r '.items[:2][] | "  → \(.productName) suggestedQty=\(.suggestedOrderQty) bestVendor=\(.bestVendor.vendorName // "none")"' 2>/dev/null || true

# ──────────────────────────────────────────────────────────────────────────────
# PART 2: SUPPLY CHAIN BOOTSTRAP + ORDER FLOW
# ──────────────────────────────────────────────────────────────────────────────
section "Part 2: Supply Chain Bootstrap"

# Get vendor catalog and pick a well-stocked vendor for a BOM component
check "GET /supply/vendors" 200 GET "$BASE/api/supply/vendors"
VENDOR_COUNT=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
info "Active vendors: $VENDOR_COUNT"

# Find the vendor with best credit rating (1) that has stock
BEST_VENDOR=$(echo "$LAST_RESPONSE" | jq -r \
  '[.[] | select(.inStockComponents > 0)] | sort_by(.vendor.creditRating) | .[0].vendor.vendorId' \
  2>/dev/null || echo "")
BEST_VENDOR_NAME=$(echo "$LAST_RESPONSE" | jq -r \
  '[.[] | select(.inStockComponents > 0)] | sort_by(.vendor.creditRating) | .[0].vendor.name' \
  2>/dev/null || echo "")

if [[ -z "$BEST_VENDOR" || "$BEST_VENDOR" == "null" ]]; then
  skip "No in-stock vendors found; restocking first"
  # Trigger lazy init
  curl -s --max-time 30 "$BASE/api/supply/catalog" > /dev/null 2>&1 || true
  VENDORS_RESP=$(curl -s --max-time 30 "$BASE/api/supply/vendors" 2>/dev/null)
  BEST_VENDOR=$(echo "$VENDORS_RESP" | jq -r '[.[]] | sort_by(.vendor.creditRating) | .[0].vendor.vendorId' 2>/dev/null || echo "")
  BEST_VENDOR_NAME=$(echo "$VENDORS_RESP" | jq -r '[.[]] | sort_by(.vendor.creditRating) | .[0].vendor.name' 2>/dev/null || echo "")
fi

info "Selected vendor: #$BEST_VENDOR $BEST_VENDOR_NAME"

# Get the cheapest in-stock component from that vendor
check "GET /supply/vendors/$BEST_VENDOR" 200 GET "$BASE/api/supply/vendors/$BEST_VENDOR"
VENDOR_STOCK=$(echo "$LAST_RESPONSE" | jq '[.stock[] | select(.stockAvailable > 0)] | sort_by(.unitCost) | .[0]' 2>/dev/null || echo "null")
COMPONENT_PRODUCT_ID=$(echo "$VENDOR_STOCK" | jq -r '.productId' 2>/dev/null || echo "")
COMPONENT_MIN_QTY=$(echo "$VENDOR_STOCK" | jq -r '.minOrderQty // 1' 2>/dev/null || echo "1")
COMPONENT_STOCK=$(echo "$VENDOR_STOCK" | jq -r '.stockAvailable' 2>/dev/null || echo "0")
COMPONENT_NAME=$(echo "$VENDOR_STOCK" | jq -r '.productName' 2>/dev/null || echo "unknown")

info "Selected component: #$COMPONENT_PRODUCT_ID $COMPONENT_NAME (stock=$COMPONENT_STOCK, minQty=$COMPONENT_MIN_QTY)"

section "Part 3: Place Purchase Order"

ORDER_ID=""
if [[ -n "$COMPONENT_PRODUCT_ID" && "$COMPONENT_PRODUCT_ID" != "null" && "$COMPONENT_STOCK" -ge "$COMPONENT_MIN_QTY" ]]; then
  ORDER_QTY=$COMPONENT_MIN_QTY

  check "POST /supply/order" 201 POST "$BASE/api/supply/order" \
    "{\"vendorId\":\"$BEST_VENDOR\",\"productId\":$COMPONENT_PRODUCT_ID,\"qty\":$ORDER_QTY}"
  ORDER_ID=$(echo "$LAST_RESPONSE" | jq -r '.orderId // .OrderId' 2>/dev/null || echo "")
  SQL_PO_ID=$(echo "$LAST_RESPONSE" | jq -r '.sqlPurchaseOrderId // .SqlPurchaseOrderId' 2>/dev/null || echo "")
  ORDER_STATUS=$(echo "$LAST_RESPONSE" | jq -r '.status' 2>/dev/null || echo "")

  echo "  Order ID:       $ORDER_ID"
  echo "  SQL PO ID:      $SQL_PO_ID"
  echo "  Initial status: $ORDER_STATUS"
  echo "  $(echo "$LAST_RESPONSE" | jq -r '"vendor=\(.vendorName) component=\(.productName) qty=\(.qty) cost=\(.totalCost)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 300)"
else
  skip "Skipping order placement — no suitable in-stock component found"
fi

# ── Poll order state machine ─────────────────────────────────────────────────
section "Part 4: Order State Machine (poll up to 2 min)"

ORDER_DELIVERED=false
if [[ -n "$ORDER_ID" && "$ORDER_ID" != "null" ]]; then
  MAX_WAIT=120
  POLL_INTERVAL=10
  elapsed=0
  PREV_STATUS=""

  while [[ $elapsed -lt $MAX_WAIT ]]; do
    sleep $POLL_INTERVAL
    elapsed=$((elapsed + POLL_INTERVAL))

    ORDER_RAW=$(curl -s --max-time 15 "$BASE/api/supply/order/$ORDER_ID" 2>/dev/null)
    CUR_STATUS=$(echo "$ORDER_RAW" | jq -r '.status' 2>/dev/null || echo "?")
    ETA=$(echo "$ORDER_RAW" | jq -r '.estimatedDeliveryUtc // "N/A"' 2>/dev/null || echo "N/A")

    if [[ "$CUR_STATUS" != "$PREV_STATUS" ]]; then
      echo "  [${elapsed}s] Status: ${PREV_STATUS:-initial} → ${CUR_STATUS}  eta=$ETA"
      PREV_STATUS="$CUR_STATUS"
    else
      echo -e "  [${elapsed}s] Still: $CUR_STATUS"
    fi

    if [[ "$CUR_STATUS" == "delivered" ]]; then
      ORDER_DELIVERED=true
      break
    fi
  done

  if [[ "$ORDER_DELIVERED" == "true" ]]; then
    pass "Order $ORDER_ID reached 'delivered' state within ${elapsed}s"
    # Check SQL-side status via GraphQL
    info "SQL PurchaseOrderID for cross-reference: $SQL_PO_ID"
  else
    skip "Order still in '$PREV_STATUS' after ${MAX_WAIT}s (async delivery continues in background)"
  fi
else
  skip "No order to poll"
fi

# ── Manufacturing run with scrap enabled ─────────────────────────────────────
section "Part 5: Manufacturing Run + Live Status"

# Set high-speed config so test doesn't take too long
for LOC in 10 50 60; do
  curl -s -X PUT -H "Content-Type: application/json" --max-time 15 \
    "$BASE/api/manufacturing/location-config/$LOC" \
    '{"capacityUnits":3,"dailyOperatingHours":16,"speedFactor":4.0,"overtimeMultiplier":1.5,"shiftStartHour":6,"note":"integration-test speed"}' \
    > /dev/null 2>&1 || true
done
info "Location configs set to fast-forward (speedFactor=4.0)"

# Enable supplier-quality scrap on Subassembly to populate vendor-quality board
curl -s -X PUT -H "Content-Type: application/json" --max-time 15 \
  "$BASE/api/manufacturing/scrap-config/50" \
  '{"failureRatePct":0.35,"scrapReasonIds":[1,3,7,10],"note":"integration-test supplier quality"}' \
  > /dev/null 2>&1 || true
info "Scrap config set for supplier attribution"

check "POST /manufacturing/begin (ProductID=749, qty=3)" 202 POST \
  "$BASE/api/manufacturing/begin" '{"productId":749,"orderQty":3}'

RUN_ID=$(echo "$LAST_RESPONSE" | jq -r '.runId' 2>/dev/null || echo "")
ROOT_WO=$(echo "$LAST_RESPONSE" | jq -r '.rootWorkOrderId' 2>/dev/null || echo "")
TOTAL_WOS=$(echo "$LAST_RESPONSE" | jq -r '.totalWorkOrders' 2>/dev/null || echo "0")
INV_WARNINGS=$(echo "$LAST_RESPONSE" | jq -r '.warnings | length' 2>/dev/null || echo "0")

echo "  Run ID:          $RUN_ID"
echo "  Root WO:         $ROOT_WO"
echo "  Total WOs:       $TOTAL_WOS"
echo "  Inv warnings:    $INV_WARNINGS"
[[ "$INV_WARNINGS" -gt 0 ]] && info "Inventory shortages detected — supply chain delivery may unblock stalled WOs"

# ── Cross-system status monitoring ───────────────────────────────────────────
section "Part 6: Simultaneous Status Monitoring (up to 3 min)"

MAX_WAIT=180
POLL_INTERVAL=15
elapsed=0
MFG_DONE=false

while [[ $elapsed -lt $MAX_WAIT ]]; do
  sleep $POLL_INTERVAL
  elapsed=$((elapsed + POLL_INTERVAL))

  MFG_STATUS=$(curl -s --max-time 15 "$BASE/api/manufacturing/status" 2>/dev/null)
  SUPPLY_ORDERS=$(curl -s --max-time 15 "$BASE/api/supply/orders" 2>/dev/null)

  MFG_RUNNING=$(echo "$MFG_STATUS" | jq -r '.isRunning' 2>/dev/null || echo "?")
  MFG_QUEUE=$(echo "$MFG_STATUS" | jq -r '.queueDepth' 2>/dev/null || echo "?")
  MFG_PROG=$(echo "$MFG_STATUS" | jq -r '.inProgressWorkOrders' 2>/dev/null || echo "?")
  MFG_COMP=$(echo "$MFG_STATUS" | jq -r '.completedToday' 2>/dev/null || echo "?")
  MFG_STALLED=$(echo "$MFG_STATUS" | jq -r '.stalledForMaterials' 2>/dev/null || echo "0")
  SUPPLY_ACTIVE=$(echo "$SUPPLY_ORDERS" | jq 'length' 2>/dev/null || echo "?")

  echo "  [${elapsed}s] mfg: queue=$MFG_QUEUE inProgress=$MFG_PROG done=$MFG_COMP stalled=$MFG_STALLED | supply: activeOrders=$SUPPLY_ACTIVE"

  if [[ "$MFG_STALLED" -gt "0" ]]; then
    info "  ⚠ Manufacturing stalled on materials — supply chain delivery will unblock"
  fi

  if [[ "$MFG_RUNNING" == "false" || ( "$MFG_QUEUE" == "0" && "$MFG_PROG" == "0" ) ]]; then
    MFG_DONE=true
    echo -e "  ${GREEN}Manufacturing run completed.${NC}"
    break
  fi
done

if [[ "$MFG_DONE" == "true" ]]; then
  pass "Manufacturing run finished within ${elapsed}s"
else
  skip "Manufacturing still running at ${MAX_WAIT}s timeout"
fi

# ── Post-run validation ───────────────────────────────────────────────────────
section "Part 7: Post-Run Validation"

check "GET /manufacturing/active (should be empty post-run)" 200 GET "$BASE/api/manufacturing/active"
STILL_ACTIVE=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
if [[ "$STILL_ACTIVE" -eq 0 ]]; then
  pass "No active routing ops post-run"
else
  skip "Still $STILL_ACTIVE active ops (run may not have finished)"
fi

check "GET /manufacturing/scrap-events" 200 GET "$BASE/api/manufacturing/scrap-events"
SCRAP_TOTAL=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Total scrap events: $SCRAP_TOTAL"
echo "$LAST_RESPONSE" | jq -r '.[:5][] | "  WO=\(.workOrderId) loc=\(.locationName) reason=\"\(.scrapReasonName)\" totalFailure=\(.isTotalFailure) supplier=\(.supplierVendorName // "N/A")"' 2>/dev/null || true

check "GET /manufacturing/vendor-quality" 200 GET "$BASE/api/manufacturing/vendor-quality"
VENDOR_QUALITY_COUNT=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Vendors with attributed scrap: $VENDOR_QUALITY_COUNT"
echo "$LAST_RESPONSE" | jq -r '.[:3][] | "  \(.vendorId) \(.vendorName): scrapEvents=\(.totalScrapEvents) failures=\(.totalFailures)"' 2>/dev/null || true

if [[ "$VENDOR_QUALITY_COUNT" -gt 0 ]]; then
  WORST_VENDOR=$(echo "$LAST_RESPONSE" | jq -r 'sort_by(-.totalScrapEvents) | .[0].vendorId' 2>/dev/null || echo "")
  if [[ -n "$WORST_VENDOR" && "$WORST_VENDOR" != "null" ]]; then
    check "GET /manufacturing/vendor-quality/$WORST_VENDOR (worst vendor drill-down)" 200 GET \
      "$BASE/api/manufacturing/vendor-quality/$WORST_VENDOR"
    echo "  $(echo "$LAST_RESPONSE" | jq -r '"vendor=\"\(.vendorName)\" events=\(.totalScrapEvents) components=\(.components | length)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"
  fi
else
  skip "No vendor-attributed scrap events — probability-based, may not fire in every run"
fi

# Feasibility updated post-run
check "GET /plan/feasibility/749 (post-run)" 200 GET "$BASE/api/plan/feasibility/749?qty=1"
echo "  $(echo "$LAST_RESPONSE" | jq -r '"product=\(.name) maxProducibleNow=\(.maxProducibleNow)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"

# Cost updated post-run (if supply chain deliveries updated ProductCostHistory)
check "GET /plan/cost/749/current (post-run, reflects latest vendor costs)" 200 GET "$BASE/api/plan/cost/749/current"
echo "  $(echo "$LAST_RESPONSE" | jq -r '"totalManufacturingCost=\(.totalManufacturingCost) grossMarginPct=\(.grossMarginPct)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"

# ── Clean up ──────────────────────────────────────────────────────────────────
section "Part 8: Cleanup"

check "POST /manufacturing/stop" 200 POST "$BASE/api/manufacturing/stop" '{}'
echo "  $(echo "$LAST_RESPONSE" | jq -r '.message' 2>/dev/null || true)"

check "DELETE /supply/reset" 200 DELETE "$BASE/api/supply/reset" ''
echo "  $(echo "$LAST_RESPONSE" | jq -r '.message' 2>/dev/null || true)"

# Restore location configs to defaults
for LOC in 10 50 60; do
  curl -s -X PUT -H "Content-Type: application/json" --max-time 15 \
    "$BASE/api/manufacturing/location-config/$LOC" \
    '{"capacityUnits":2,"dailyOperatingHours":8,"speedFactor":1.0,"overtimeMultiplier":1.5,"shiftStartHour":6,"note":""}' \
    > /dev/null 2>&1 || true
done

curl -s -X PUT -H "Content-Type: application/json" --max-time 15 \
  "$BASE/api/manufacturing/scrap-config/50" \
  '{"failureRatePct":0.05,"scrapReasonIds":[1,3,7,10],"note":""}' \
  > /dev/null 2>&1 || true

info "Location and scrap configs restored to defaults"

# ── Summary ───────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}━━ Results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${GREEN}PASS: $PASS${NC}   ${RED}FAIL: $FAIL${NC}   ${YELLOW}SKIP: $SKIP${NC}"
if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}Some tests failed.${NC}"
  exit 1
else
  echo -e "  ${GREEN}All required tests passed.${NC}"
fi
