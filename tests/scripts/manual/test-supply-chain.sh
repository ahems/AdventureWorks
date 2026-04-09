#!/bin/bash
# Supply Chain Simulation - End-to-End Test Script
#
# Tests all /api/supply/* endpoints:
#   - GET /vendors, /vendors/{id}
#   - GET /catalog, /catalog/{productId}
#   - GET /quote?vendorId=&productId=&qty=
#   - POST /order (place order)
#   - GET /orders, /order/{id}
#   - DELETE /order/{id} (cancel)
#   - GET /orders/history
#   - POST /restock/{vendorId}
#   - DELETE /reset
#
# Usage: ./tests/scripts/manual/test-supply-chain.sh [functions-url]
# Requires: curl, jq
# ---------------------------------------------------------------------------

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ── Helpers ──────────────────────────────────────────────────────────────────
PASS=0; FAIL=0; SKIP=0
LAST_RESPONSE=""; LAST_STATUS=""

pass() { echo -e "  ${GREEN}✓ PASS${NC} $1"; PASS=$(( PASS + 1 )); }
fail() { echo -e "  ${RED}✗ FAIL${NC} $1"; FAIL=$(( FAIL + 1 )); }
skip() { echo -e "  ${YELLOW}⚠ SKIP${NC} $1"; SKIP=$(( SKIP + 1 )); }
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
    return 0
  else
    fail "$label (expected HTTP $expected, got $LAST_STATUS)"
    [[ -n "$LAST_RESPONSE" ]] && echo "    Response: $(echo "$LAST_RESPONSE" | head -c 300)"
    return 1
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

echo -e "${BOLD}Supply Chain Simulation Test${NC}"
echo -e "Base URL: ${CYAN}$BASE${NC}"
echo -e "Date:     $(date -u +%Y-%m-%dT%H:%M:%SZ)\n"

# ── 1. Vendors ────────────────────────────────────────────────────────────────
section "1. Vendors"

check "GET /supply/vendors" 200 GET "$BASE/api/supply/vendors"
VENDOR_COUNT=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Total vendors: $VENDOR_COUNT"

if [[ "$VENDOR_COUNT" -lt 1 ]]; then
  skip "No vendors returned — supply chain may need initialization (will retry after reset)"
else
  # Pick first vendor for detail tests
  FIRST_VENDOR_ID=$(echo "$LAST_RESPONSE" | jq -r '.[0].vendor.vendorId' 2>/dev/null || echo "")
  FIRST_VENDOR_NAME=$(echo "$LAST_RESPONSE" | jq -r '.[0].vendor.name' 2>/dev/null || echo "unknown")

  echo "  First vendor: #$FIRST_VENDOR_ID $FIRST_VENDOR_NAME"
  echo "$LAST_RESPONSE" | jq -r '.[:3][] | "  \(.vendor.vendorId) \(.vendor.name) creditRating=\(.vendor.creditRating) components=\(.totalComponents)"' 2>/dev/null || true

  check "GET /supply/vendors/$FIRST_VENDOR_ID" 200 GET "$BASE/api/supply/vendors/$FIRST_VENDOR_ID"
  echo "  $(echo "$LAST_RESPONSE" | jq -r '"name=\(.vendor.vendor.name) totalComponents=\(.vendor.totalComponents) inStock=\(.vendor.inStockComponents)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"
fi

# Bad vendor id → 404
check "GET /supply/vendors/9999999 (nonexistent → 404)" 404 GET "$BASE/api/supply/vendors/9999999"

# ── 2. Catalog ────────────────────────────────────────────────────────────────
section "2. Catalog"

check "GET /supply/catalog" 200 GET "$BASE/api/supply/catalog"
CATALOG_COUNT=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Catalog entries: $CATALOG_COUNT"
echo "$LAST_RESPONSE" | jq -r '.[:3][] | "  productId=\(.productId) \(.productName) vendor=\(.vendorId) stock=\(.stockAvailable) unitCost=\(.unitCost)"' 2>/dev/null || true

if [[ "$CATALOG_COUNT" -gt 0 ]]; then
  # Pick a product and vendor from catalog for order tests
  FIRST_CATALOG_PRODUCT=$(echo "$LAST_RESPONSE" | jq -r '.[0].productId' 2>/dev/null || echo "")
  FIRST_CATALOG_VENDOR=$(echo "$LAST_RESPONSE" | jq -r '.[0].vendorId' 2>/dev/null || echo "")
  FIRST_CATALOG_MIN_QTY=$(echo "$LAST_RESPONSE" | jq -r '.[0].minOrderQty // 1' 2>/dev/null || echo "1")
  FIRST_CATALOG_STOCK=$(echo "$LAST_RESPONSE" | jq -r '.[0].stockAvailable' 2>/dev/null || echo "0")
  FIRST_CATALOG_PRODUCT_NAME=$(echo "$LAST_RESPONSE" | jq -r '.[0].productName' 2>/dev/null || echo "unknown")

  echo "  → Using product $FIRST_CATALOG_PRODUCT ($FIRST_CATALOG_PRODUCT_NAME), vendor $FIRST_CATALOG_VENDOR for order tests"
  echo "    minOrderQty=$FIRST_CATALOG_MIN_QTY stockAvailable=$FIRST_CATALOG_STOCK"

  check "GET /supply/catalog/$FIRST_CATALOG_PRODUCT" 200 GET "$BASE/api/supply/catalog/$FIRST_CATALOG_PRODUCT"
  VENDOR_OFFERS=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
  echo "  Vendor offers for product $FIRST_CATALOG_PRODUCT: $VENDOR_OFFERS"
  echo "$LAST_RESPONSE" | jq -r '.[:3][] | "  vendor=\(.vendorId) stock=\(.stockAvailable) unitCost=\(.unitCost) totalCost=\(.totalCost)"' 2>/dev/null || true
else
  FIRST_CATALOG_PRODUCT=""
  FIRST_CATALOG_VENDOR=""
  skip "No catalog entries — cannot run product-specific catalog tests"
fi

check "GET /supply/catalog/9999999 (nonexistent → 404)" 404 GET "$BASE/api/supply/catalog/9999999"

# ── 3. Quotes ─────────────────────────────────────────────────────────────────
section "3. Quotes"

if [[ -n "$FIRST_CATALOG_PRODUCT" && -n "$FIRST_CATALOG_VENDOR" ]]; then
  check "GET /supply/quote (valid)" 200 GET \
    "$BASE/api/supply/quote?vendorId=$FIRST_CATALOG_VENDOR&productId=$FIRST_CATALOG_PRODUCT&qty=$FIRST_CATALOG_MIN_QTY"
  echo "  $(echo "$LAST_RESPONSE" | jq -r '"unitCost=\(.unitCost) shippingCost=\(.shippingCost) totalCost=\(.totalCost) stockAvailable=\(.stockAvailable)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 300)"
else
  skip "Skipping quote tests — no catalog data available"
fi

check "GET /supply/quote (missing productId → 400)" 400 GET \
  "$BASE/api/supply/quote?vendorId=1&qty=1"

check "GET /supply/quote (missing vendorId → 400)" 400 GET \
  "$BASE/api/supply/quote?productId=1&qty=1"

# ── 4. Order placement ────────────────────────────────────────────────────────
section "4. Order Placement"

ORDER_ID=""
if [[ -n "$FIRST_CATALOG_PRODUCT" && -n "$FIRST_CATALOG_VENDOR" && "$FIRST_CATALOG_STOCK" -ge "$FIRST_CATALOG_MIN_QTY" ]]; then
  ORDER_QTY=$FIRST_CATALOG_MIN_QTY

  check "POST /supply/order (place order)" 201 POST "$BASE/api/supply/order" \
    "{\"vendorId\":\"$FIRST_CATALOG_VENDOR\",\"productId\":$FIRST_CATALOG_PRODUCT,\"qty\":$ORDER_QTY}"
  ORDER_ID=$(echo "$LAST_RESPONSE" | jq -r '.orderId // .OrderId' 2>/dev/null || echo "")
  echo "  Order ID:     $ORDER_ID"
  echo "  $(echo "$LAST_RESPONSE" | jq -r '"status=\(.status) qty=\(.qty) totalCost=\(.totalCost)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 300)"
else
  skip "Skipping order placement — insufficient catalog data or stock"
fi

# ── 5. Invalid orders ────────────────────────────────────────────────────────
section "5. Order Validation"

check "POST /supply/order (missing fields → 400)" 400 POST "$BASE/api/supply/order" \
  '{"vendorId":"1"}'

check "POST /supply/order (bad qty=0 → 400)" 400 POST "$BASE/api/supply/order" \
  '{"vendorId":"1","productId":1,"qty":0}'

# Overstocking: request far more than available stock
check "POST /supply/order (overstock → 422)" 422 POST "$BASE/api/supply/order" \
  '{"vendorId":"9999999","productId":9999999,"qty":999999}'

# ── 6. Retrieve orders ────────────────────────────────────────────────────────
section "6. Order Retrieval"

check "GET /supply/orders (active)" 200 GET "$BASE/api/supply/orders"
ACTIVE_ORDERS=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Active orders: $ACTIVE_ORDERS"
echo "$LAST_RESPONSE" | jq -r '.[:3][] | "  \(.orderId) \(.productName) status=\(.status) qty=\(.qty)"' 2>/dev/null || true

if [[ -n "$ORDER_ID" && "$ORDER_ID" != "null" ]]; then
  check "GET /supply/order/$ORDER_ID" 200 GET "$BASE/api/supply/order/$ORDER_ID"
  echo "  $(echo "$LAST_RESPONSE" | jq -r '"orderId=\(.orderId) status=\(.status) qty=\(.qty) totalCost=\(.totalCost)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"
fi

check "GET /supply/order/NONEXISTENT-ORDER-ID (→ 404)" 404 GET "$BASE/api/supply/order/NONEXISTENT-ORDER-ID"

# ── 7. Place a second order then cancel it ───────────────────────────────────
section "7. Cancel Order"

CANCEL_ORDER_ID=""
if [[ -n "$FIRST_CATALOG_PRODUCT" && -n "$FIRST_CATALOG_VENDOR" ]]; then
  # Get fresh stock after previous order consumed some
  FRESH_CATALOG=$(curl -s --max-time 15 "$BASE/api/supply/catalog/$FIRST_CATALOG_PRODUCT" 2>/dev/null)
  FRESH_VENDOR_ROW=$(echo "$FRESH_CATALOG" | jq --arg v "$FIRST_CATALOG_VENDOR" '.[] | select(.vendorId==$v)' 2>/dev/null || echo "")
  FRESH_STOCK=$(echo "$FRESH_VENDOR_ROW" | jq -r '.stockAvailable // 0' 2>/dev/null || echo "0")
  FRESH_MIN=$(echo "$FRESH_VENDOR_ROW" | jq -r '.minOrderQty // 1' 2>/dev/null || echo "1")

  if [[ "$FRESH_STOCK" -ge "$FRESH_MIN" ]]; then
    PLACE_RAW=$(curl -s -w "\n%{http_code}" -X POST -H "Content-Type: application/json" \
      --max-time 30 "$BASE/api/supply/order" \
      -d "{\"vendorId\":\"$FIRST_CATALOG_VENDOR\",\"productId\":$FIRST_CATALOG_PRODUCT,\"qty\":$FRESH_MIN}" 2>/dev/null)
    PLACE_STATUS=$(echo "$PLACE_RAW" | tail -1)
    PLACE_BODY=$(echo "$PLACE_RAW" | head -n -1)

    if [[ "$PLACE_STATUS" == "201" ]]; then
      CANCEL_ORDER_ID=$(echo "$PLACE_BODY" | jq -r '.orderId // .OrderId' 2>/dev/null || echo "")
      pass "Placed order for cancellation (HTTP 201), orderId=$CANCEL_ORDER_ID"
    else
      skip "Could not place second order for cancellation (HTTP $PLACE_STATUS)"
    fi
  else
    skip "Insufficient stock for second order — skipping cancel test"
  fi
fi

if [[ -n "$CANCEL_ORDER_ID" && "$CANCEL_ORDER_ID" != "null" ]]; then
  check "DELETE /supply/order/$CANCEL_ORDER_ID" 200 DELETE \
    "$BASE/api/supply/order/$CANCEL_ORDER_ID" '{"reason":"Test cancellation"}'
  echo "  $(echo "$LAST_RESPONSE" | jq -r '.message' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"
else
  skip "No cancel order ID — skipping DELETE /supply/order/{id}"
fi

check "DELETE /supply/order/NONEXISTENT-ID (→ 422)" 422 DELETE \
  "$BASE/api/supply/order/NONEXISTENT-ID" '{}'

# ── 8. Order history ─────────────────────────────────────────────────────────
section "8. Order History"

check "GET /supply/orders/history" 200 GET "$BASE/api/supply/orders/history"
HISTORY_COUNT=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  History records: $HISTORY_COUNT"
echo "$LAST_RESPONSE" | jq -r '.[:3][] | "  \(.orderId) \(.productName) status=\(.status) qty=\(.qty)"' 2>/dev/null || true

# ── 9. Manual restock ────────────────────────────────────────────────────────
section "9. Manual Vendor Restock"

if [[ -n "${FIRST_VENDOR_ID:-}" ]]; then
  check "POST /supply/restock/$FIRST_VENDOR_ID (all components)" 200 POST \
    "$BASE/api/supply/restock/$FIRST_VENDOR_ID" '{}'
  echo "  $(echo "$LAST_RESPONSE" | jq -r '.message' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"

  # Restock specific product
  if [[ -n "$FIRST_CATALOG_PRODUCT" ]]; then
    check "POST /supply/restock/$FIRST_VENDOR_ID (productId=$FIRST_CATALOG_PRODUCT)" 200 POST \
      "$BASE/api/supply/restock/$FIRST_VENDOR_ID" \
      "{\"productId\":$FIRST_CATALOG_PRODUCT}"
    echo "  $(echo "$LAST_RESPONSE" | jq -r '.message' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"
  fi
else
  skip "No vendor ID found — skipping restock test"
fi

# ── 10. Verify stock increased after restock ──────────────────────────────────
section "10. Verify Post-Restock Stock Levels"

if [[ -n "$FIRST_CATALOG_PRODUCT" && -n "$FIRST_CATALOG_VENDOR" ]]; then
  check "GET /supply/catalog/$FIRST_CATALOG_PRODUCT (post-restock)" 200 GET \
    "$BASE/api/supply/catalog/$FIRST_CATALOG_PRODUCT"
  NEW_STOCK=$(echo "$LAST_RESPONSE" | jq --arg v "$FIRST_CATALOG_VENDOR" \
    '.[] | select(.vendorId==$v) | .stockAvailable' 2>/dev/null | head -1 || echo "?")
  echo "  Stock for vendor $FIRST_CATALOG_VENDOR after restock: $NEW_STOCK (was: $FIRST_CATALOG_STOCK)"
else
  skip "No catalog data — skipping post-restock verification"
fi

# ── 11. Reset simulation ──────────────────────────────────────────────────────
section "11. Reset Simulation"

check "DELETE /supply/reset" 200 DELETE "$BASE/api/supply/reset" ''
echo "  $(echo "$LAST_RESPONSE" | jq -r '.message' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"

# Verify vendors and catalog still accessible after reset
check "GET /supply/vendors (post-reset)" 200 GET "$BASE/api/supply/vendors"
echo "  Vendors after reset: $(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)"

check "GET /supply/catalog (post-reset)" 200 GET "$BASE/api/supply/catalog"
echo "  Catalog entries after reset: $(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)"

# ── Summary ───────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}━━ Results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${GREEN}PASS: $PASS${NC}   ${RED}FAIL: $FAIL${NC}   ${YELLOW}SKIP: $SKIP${NC}"
if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}Some tests failed.${NC}"
  exit 1
else
  echo -e "  ${GREEN}All required tests passed.${NC}"
fi
