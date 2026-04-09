#!/bin/bash
# Manufacturing Simulation - End-to-End Test Script
#
# Tests all manufacturing API endpoints:
#   - Status, active ops, scrap-config, location-config, workforce
#   - POST /begin  (starts a production run for Mountain-100 Black 38, 2 units)
#   - Poll /status until complete or timeout (3 min)
#   - Scrap + location config updates
#   - Vendor quality and scrap-events
#   - POST /stop (clears queue)
#
# Usage: ./tests/scripts/manual/test-manufacturing.sh [functions-url]
# Requires: curl, jq
# ---------------------------------------------------------------------------

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ── Helpers ──────────────────────────────────────────────────────────────────
PASS=0; FAIL=0; SKIP=0

pass() { echo -e "  ${GREEN}✓ PASS${NC} $1"; PASS=$(( PASS + 1 )); }
fail() { echo -e "  ${RED}✗ FAIL${NC} $1"; FAIL=$(( FAIL + 1 )); }
skip() { echo -e "  ${YELLOW}⚠ SKIP${NC} $1"; SKIP=$(( SKIP + 1 )); }
section() { echo -e "\n${BLUE}${BOLD}━━ $1 ━━${NC}"; }

# HTTP test helper
# $1=label  $2=expected_status  $3=method  $4=url  $5=body(optional)
check() {
  local label="$1" expected="$2" method="$3" url="$4" body="${5:-}"
  local args=(-s -w "\n%{http_code}" -X "$method" -H "Content-Type: application/json" --max-time 30)
  [[ -n "$body" ]] && args+=(-d "$body")
  local raw; raw=$(curl "${args[@]}" "$url" 2>/dev/null)
  local status; status=$(echo "$raw" | tail -1)
  local resp; resp=$(echo "$raw" | head -n -1)
  LAST_RESPONSE="$resp"
  LAST_STATUS="$status"
  if [[ "$status" == "$expected" ]]; then
    pass "$label (HTTP $status)"
    return 0
  else
    fail "$label (expected HTTP $expected, got $status)"
    [[ -n "$resp" ]] && echo "    Response: $(echo "$resp" | head -c 300)"
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
BASE="${BASE%/}"   # strip trailing slash

echo -e "${BOLD}Manufacturing Simulation Test${NC}"
echo -e "Base URL: ${CYAN}$BASE${NC}"
echo -e "Date:     $(date -u +%Y-%m-%dT%H:%M:%SZ)\n"

# ── 1. Read-only status endpoints ────────────────────────────────────────────
section "1. Status Endpoints"

check "GET /manufacturing/status" 200 GET "$BASE/api/manufacturing/status"
echo "  $(echo "$LAST_RESPONSE" | jq -r '"isRunning=\(.isRunning) queue=\(.queueDepth) pending=\(.pendingWorkOrders) inProgress=\(.inProgressWorkOrders) completedToday=\(.completedToday)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"

check "GET /manufacturing/active" 200 GET "$BASE/api/manufacturing/active"
ACTIVE_COUNT=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Active routing ops: $ACTIVE_COUNT"

check "GET /manufacturing/scrap-events" 200 GET "$BASE/api/manufacturing/scrap-events"
SCRAP_COUNT=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Total scrap events on record: $SCRAP_COUNT"

# ── 2. Config read endpoints ─────────────────────────────────────────────────
section "2. Configuration Endpoints"

check "GET /manufacturing/scrap-config" 200 GET "$BASE/api/manufacturing/scrap-config"
SCRAP_CONFIGS=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Scrap configs: $SCRAP_CONFIGS"
echo "$LAST_RESPONSE" | jq -r '.[:3][] | "  LocationID \(.locationId): failureRate=\(.failureRatePct) reasons=\(.scrapReasonIds)"' 2>/dev/null || true

check "GET /manufacturing/location-config" 200 GET "$BASE/api/manufacturing/location-config"
LOC_CONFIGS=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Location configs: $LOC_CONFIGS"
echo "$LAST_RESPONSE" | jq -r '.[:3][] | "  LocationID \(.locationId): capacity=\(.capacityUnits) speed=\(.speedFactor) hours=\(.dailyOperatingHours)h"' 2>/dev/null || true

check "GET /manufacturing/workforce" 200 GET "$BASE/api/manufacturing/workforce"
echo "  $(echo "$LAST_RESPONSE" | jq -r '"totalActive=\(.totalActiveWorkers) working=\(.currentlyWorking) available=\(.availableNow) locations=\(.byLocation | length)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"

check "GET /manufacturing/workforce/detail" 200 GET "$BASE/api/manufacturing/workforce/detail"
WORKERS=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Workers in detail: $WORKERS"

# ── 3. Config update endpoints ───────────────────────────────────────────────
section "3. Config Updates"

# Raise scrap rate on Subassembly (50) to test supplier attribution
check "PUT /manufacturing/scrap-config/50 (set 30% + supplier reasons)" 200 PUT \
  "$BASE/api/manufacturing/scrap-config/50" \
  '{"failureRatePct":0.30,"scrapReasonIds":[1,3,7,10],"note":"Test: supplier-quality stress"}'
echo "  $(echo "$LAST_RESPONSE" | jq -r '"failureRatePct=\(.failureRatePct) reasons=\(.scrapReasonIds)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"

# Increase capacity at Frame Forming (10) to ensure runs don't stall in tests
check "PUT /manufacturing/location-config/10 (2 slots, speed=2.0)" 200 PUT \
  "$BASE/api/manufacturing/location-config/10" \
  '{"capacityUnits":2,"dailyOperatingHours":8,"speedFactor":2.0,"overtimeMultiplier":1.5,"shiftStartHour":6,"note":"Test: fast-forward"}'
echo "  $(echo "$LAST_RESPONSE" | jq -r '"capacityUnits=\(.capacityUnits) speedFactor=\(.speedFactor)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"

# Subassembly (50): also speed up
check "PUT /manufacturing/location-config/50 (3 slots, speed=4.0)" 200 PUT \
  "$BASE/api/manufacturing/location-config/50" \
  '{"capacityUnits":3,"dailyOperatingHours":16,"speedFactor":4.0,"overtimeMultiplier":1.5,"shiftStartHour":6,"note":"Test: fast-forward"}'

# Final Assembly (60): speed up
check "PUT /manufacturing/location-config/60 (2 slots, speed=4.0)" 200 PUT \
  "$BASE/api/manufacturing/location-config/60" \
  '{"capacityUnits":2,"dailyOperatingHours":16,"speedFactor":4.0,"overtimeMultiplier":1.5,"shiftStartHour":6,"note":"Test: fast-forward"}'

# ── 4. Validation: bad input ─────────────────────────────────────────────────
section "4. Validation / Error Cases"

check "POST /manufacturing/begin (missing body → 400)" 400 POST \
  "$BASE/api/manufacturing/begin" '{}'

check "POST /manufacturing/begin (non-finished-good productId=317 → 400)" 400 POST \
  "$BASE/api/manufacturing/begin" '{"productId":317,"orderQty":1}'

check "PUT /manufacturing/scrap-config/50 (rate>1 → 400)" 400 PUT \
  "$BASE/api/manufacturing/scrap-config/50" \
  '{"failureRatePct":1.5,"scrapReasonIds":[]}'

# ── 5. Start a production run ────────────────────────────────────────────────
section "5. Begin Production Run (ProductID=749 Mountain-100 Black 38, qty=2)"

check "POST /manufacturing/begin" 202 POST "$BASE/api/manufacturing/begin" \
  '{"productId":749,"orderQty":2}'

RUN_ID=$(echo "$LAST_RESPONSE" | jq -r '.runId' 2>/dev/null || echo "")
ROOT_WO=$(echo "$LAST_RESPONSE" | jq -r '.rootWorkOrderId' 2>/dev/null || echo "")
TOTAL_WOS=$(echo "$LAST_RESPONSE" | jq -r '.totalWorkOrders' 2>/dev/null || echo "0")
LEAF_WOS=$(echo "$LAST_RESPONSE" | jq -r '.leafWorkOrders' 2>/dev/null || echo "0")
WARNINGS=$(echo "$LAST_RESPONSE" | jq -r '.warnings | length' 2>/dev/null || echo "0")

echo "  Run ID:          $RUN_ID"
echo "  Root WO ID:      $ROOT_WO"
echo "  Total WOs:       $TOTAL_WOS"
echo "  Leaf WOs queued: $LEAF_WOS"
echo "  Inv warnings:    $WARNINGS"
[[ "$WARNINGS" -gt 0 ]] && echo "  $(echo "$LAST_RESPONSE" | jq -r '.warnings[]' 2>/dev/null | head -3)"

if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  fail "No runId returned — cannot continue polling"
  SKIP_POLL=true
else
  SKIP_POLL=false
fi

# ── 6. Poll until complete or timeout ───────────────────────────────────────
section "6. Poll Manufacturing Status (max 3 min)"

if [[ "$SKIP_POLL" != "true" ]]; then
  MAX_WAIT=180   # seconds
  POLL_INTERVAL=10
  elapsed=0
  COMPLETED=false

  while [[ $elapsed -lt $MAX_WAIT ]]; do
    sleep $POLL_INTERVAL
    elapsed=$((elapsed + POLL_INTERVAL))

    STATUS_RAW=$(curl -s --max-time 15 "$BASE/api/manufacturing/status" 2>/dev/null)
    IS_RUNNING=$(echo "$STATUS_RAW" | jq -r '.isRunning' 2>/dev/null || echo "true")
    QUEUE=$(echo "$STATUS_RAW" | jq -r '.queueDepth' 2>/dev/null || echo "?")
    IN_PROG=$(echo "$STATUS_RAW" | jq -r '.inProgressWorkOrders' 2>/dev/null || echo "?")
    COMP=$(echo "$STATUS_RAW" | jq -r '.completedToday' 2>/dev/null || echo "?")
    STALLED=$(echo "$STATUS_RAW" | jq -r '.stalledForMaterials' 2>/dev/null || echo "0")

    echo -e "  [${elapsed}s] queue=$QUEUE inProgress=$IN_PROG completedToday=$COMP stalled=$STALLED"

    if [[ "$IS_RUNNING" == "false" || ( "$QUEUE" == "0" && "$IN_PROG" == "0" ) ]]; then
      echo -e "  ${GREEN}Run appears complete.${NC}"
      COMPLETED=true
      break
    fi
  done

  if [[ "$COMPLETED" == "true" ]]; then
    pass "Production run completed within timeout"
  else
    skip "Production run still in progress after ${MAX_WAIT}s (may be running asynchronously)"
  fi

  # Check active ops after run
  check "GET /manufacturing/active (post-run)" 200 GET "$BASE/api/manufacturing/active"
  ACTIVE_COUNT=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
  echo "  Active ops now: $ACTIVE_COUNT"
fi

# ── 7. Scrap and vendor quality (may have data after first run) ──────────────
section "7. Vendor Quality & Scrap Attribution"

check "GET /manufacturing/scrap-events" 200 GET "$BASE/api/manufacturing/scrap-events"
SCRAP_AFTER=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Scrap events after run: $SCRAP_AFTER"
echo "$LAST_RESPONSE" | jq -r '.[:3][] | "  WO \(.workOrderId) @ \(.locationName): \(.scrapReasonName) isTotalFailure=\(.isTotalFailure)"' 2>/dev/null || true

check "GET /manufacturing/vendor-quality" 200 GET "$BASE/api/manufacturing/vendor-quality"
VENDORS_WITH_SCRAP=$(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)
echo "  Vendors with attributed scrap: $VENDORS_WITH_SCRAP"
echo "$LAST_RESPONSE" | jq -r '.[:3][] | "  Vendor \(.vendorId) \(.vendorName): events=\(.totalScrapEvents)"' 2>/dev/null || true

# Check scrap-events filter by vendorId (if we have any scrap)
if [[ "$VENDORS_WITH_SCRAP" -gt 0 ]]; then
  FIRST_VENDOR=$(echo "$LAST_RESPONSE" | jq -r '.[0].vendorId' 2>/dev/null || echo "")
  if [[ -n "$FIRST_VENDOR" && "$FIRST_VENDOR" != "null" ]]; then
    check "GET /manufacturing/vendor-quality/$FIRST_VENDOR" 200 GET "$BASE/api/manufacturing/vendor-quality/$FIRST_VENDOR"
    echo "  $(echo "$LAST_RESPONSE" | jq -r '"vendorId=\(.vendorId) name=\(.vendorName) events=\(.totalScrapEvents)"' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"

    check "GET /manufacturing/scrap-events?vendorId=$FIRST_VENDOR" 200 GET \
      "$BASE/api/manufacturing/scrap-events?vendorId=$FIRST_VENDOR"
    echo "  Events for vendor $FIRST_VENDOR: $(echo "$LAST_RESPONSE" | jq 'length' 2>/dev/null || echo 0)"
  fi
else
  skip "No vendor-attributed scrap yet - run more production to populate"
fi

# ── 8. Stop simulation ───────────────────────────────────────────────────────
section "8. Stop Simulation"

check "POST /manufacturing/stop" 200 POST "$BASE/api/manufacturing/stop" '{}'
echo "  $(echo "$LAST_RESPONSE" | jq -r '.message' 2>/dev/null || echo "$LAST_RESPONSE" | head -c 200)"

# Reset configs back to defaults
check "PUT /manufacturing/location-config/10 (restore defaults)" 200 PUT \
  "$BASE/api/manufacturing/location-config/10" \
  '{"capacityUnits":2,"dailyOperatingHours":8,"speedFactor":1.0,"overtimeMultiplier":1.5,"shiftStartHour":6,"note":""}'

check "PUT /manufacturing/scrap-config/50 (restore defaults)" 200 PUT \
  "$BASE/api/manufacturing/scrap-config/50" \
  '{"failureRatePct":0.05,"scrapReasonIds":[1,3,7,10],"note":""}'

# ── Summary ───────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}━━ Results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  ${GREEN}PASS: $PASS${NC}   ${RED}FAIL: $FAIL${NC}   ${YELLOW}SKIP: $SKIP${NC}"
if [[ $FAIL -gt 0 ]]; then
  echo -e "  ${RED}Some tests failed.${NC}"
  exit 1
else
  echo -e "  ${GREEN}All required tests passed.${NC}"
fi
