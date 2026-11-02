#!/bin/bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# Exercise the hook's selection block without running its Azure provisioning code.
selection=$(sed -n '/^# Select a current, general-purpose chat model\./,/^# Select embedding model/{ /^# Select embedding model/!p; }' "$repo_root/scripts/hooks/preup.sh")
[[ -n "$selection" ]] || { echo "FAIL: chat selection block not found" >&2; exit 1; }

quota=$(jq -nc '[
  {ModelName: "gpt-6.1-terra", ModelVersion: "2026-10-26", SkuName: "GlobalStandard", AvailableCapacity: 7000},
  {ModelName: "gpt-5-mini", ModelVersion: "2025-08-07", SkuName: "GlobalStandard", AvailableCapacity: 20000},
  {ModelName: "gpt-5-nano", ModelVersion: "2025-08-07", SkuName: "GlobalStandard", AvailableCapacity: 30000},
  {ModelName: "gpt-4.1", ModelVersion: "2025-04-14", SkuName: "GlobalStandard", AvailableCapacity: 10000},
  {ModelName: "gpt-4o", ModelVersion: "2025-04-14", SkuName: "GlobalStandard", AvailableCapacity: 10000},
  {ModelName: "gpt-3.5-turbo", ModelVersion: "2024-01-25", SkuName: "GlobalStandard", AvailableCapacity: 10000},
  {ModelName: "other-chat", ModelVersion: "2024-01-25", SkuName: "GlobalStandard", AvailableCapacity: 10000},
  {ModelName: "o3", ModelVersion: "2027-01-01", SkuName: "GlobalStandard", AvailableCapacity: 40000},
  {ModelName: "text-embedding-3-small", ModelVersion: "1", SkuName: "GlobalStandard", AvailableCapacity: 41600},
  {ModelName: "gpt-image-2", ModelVersion: "2026-04-21", SkuName: "GlobalStandard", AvailableCapacity: 8}
]')

run_selection() {
  local candidates=$1 preferred=${2:-} tier=${3:-balanced} mincap=${4:-1}
  {
    cat <<'SETUP'
set -euo pipefail
all_quota=$1
preferred=$2
tier=$3
mincap=$4
get_azd_value() {
  case "$1" in
    CHAT_MODEL_NAME_REGEX) printf '%s\n' "$preferred" ;;
    CHAT_MODEL_COST_TIER) printf '%s\n' "$tier" ;;
    CHAT_MODEL_MIN_CAPACITY) printf '%s\n' "$mincap" ;;
    *) echo "Unexpected setting: $1" >&2; exit 1 ;;
  esac
}
set_azd_value() { printf '%s=%s\n' "$1" "$2"; }
color_red() { printf '%s\n' "$1" >&2; }
color_yellow() { printf '%s\n' "$1" >&2; }
color_green() { printf '%s\n' "$1" >&2; }
SETUP
    printf '%s\n' "$selection"
  } | bash -s -- "$candidates" "$preferred" "$tier" "$mincap" 2>&1
}

assert_pick() {
  local label=$1 expected=$2
  shift 2
  local output
  output=$(run_selection "$@")
  if ! grep -Fxq "chatGptModelName=$expected" <<< "$output" ||
     grep -q 'fallback' <<< "$output"; then
    printf 'FAIL: %s\n%s\n' "$label" "$output" >&2
    exit 1
  fi
  printf 'PASS: %s\n' "$label"
}

assert_pick "default policy selects deployed model without fallback" gpt-6.1-terra "$quota"
assert_pick "explicit regex override" gpt-4.1 "$quota" '^gpt-4\.1$'
assert_pick "GPT-4.1 ranks above GPT-4o" gpt-4.1 "$quota" '^gpt-4'
assert_pick "GPT-3.5 is ranked below unknown general chat" other-chat "$quota" '^(gpt-3\.5-turbo|other-chat)$'
assert_pick "economy tier prefers nano" gpt-5-nano "$quota" '' economy
assert_pick "premium tier permits nano" gpt-5-mini "$quota" '^gpt-5' premium
assert_pick "minimum capacity gates preferred candidates" gpt-5-mini "$quota" '' balanced 8000

sku_quota=$(jq '[.[] | select(.ModelName == "gpt-6.1-terra")] |
  . + [.[0] + {SkuName: "Standard", AvailableCapacity: 50000}]' <<< "$quota")
output=$(run_selection "$sku_quota")
grep -Fxq 'chatGptSkuName=GlobalStandard' <<< "$output"
echo "PASS: preferred SKU ranks ahead of capacity"

output=$(run_selection "$quota" '^unavailable-model$')
grep -q 'Preferred chat policy had no match; using safe general-chat fallback.' <<< "$output"
grep -q '^chatGptModelName=' <<< "$output"
echo "PASS: genuine no-match still uses fallback"

output=$(run_selection '[]')
grep -q 'Warning: No chat model selected.' <<< "$output"
if grep -q '^chatGptModelName=' <<< "$output"; then
  echo "FAIL: empty catalog persisted a chat model" >&2
  exit 1
fi
echo "PASS: empty catalog does not persist a selection"

assert_error() {
  local label=$1
  shift
  local output
  if output=$(run_selection "$@"); then
    printf 'FAIL: %s unexpectedly succeeded\n%s\n' "$label" "$output" >&2
    exit 1
  fi
  grep -q 'Error: Failed to evaluate preferred chat policy.' <<< "$output"
  if grep -Eq 'fallback|^chatGptModelName=' <<< "$output"; then
    printf 'FAIL: %s hid a policy error\n%s\n' "$label" "$output" >&2
    exit 1
  fi
  printf 'PASS: %s\n' "$label"
}

assert_error "invalid regex fails explicitly" "$quota" '['
assert_error "invalid minimum capacity fails explicitly" "$quota" '' balanced invalid
