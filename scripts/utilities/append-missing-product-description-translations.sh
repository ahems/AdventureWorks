#!/usr/bin/env bash
# Appends missing ProductDescription rows from the source API to
# seed-job/sql/ProductDescription-ai-translations.csv so the file is complete
# for the next seed job run. Only appends IDs that are NOT in the original
# AdventureWorks ProductDescription.csv (base data); -ai-translations is additive
# to the AI descriptions (ProductDescription-ai.csv), not the base data.
#
# Format appended: ProductDescriptionID|Description|ModifiedDate (pipe-delimited, no header).
# ModifiedDate is normalized from API ISO (T) to space.
#
# Usage: run from repo root, or set REPO_ROOT. Requires: curl, jq.

set -e

# Hard-coded source API (REST base; no trailing slash)
SOURCE_API="https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api"
PAGE_SIZE=100

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
TRANSLATIONS_CSV="$REPO_ROOT/seed-job/sql/ProductDescription-ai-translations.csv"
BASE_CSV="$REPO_ROOT/seed-job/sql/ProductDescription.csv"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install jq to run this script." >&2
  exit 1
fi

echo "Source API:  $SOURCE_API"
echo "CSV file:    $TRANSLATIONS_CSV"
echo ""

# Build set of ProductDescriptionIDs we must NOT append: base AdventureWorks data + already in translations file
declare -A EXISTING_IDS
BASE_COUNT=0
if [[ -f "$BASE_CSV" ]]; then
  while IFS= read -r line; do
    id="${line%%$'\t'*}"
    id="${id%%$'\r'}"
    if [[ "$id" =~ ^[0-9]+$ ]]; then
      EXISTING_IDS[$id]=1
      ((BASE_COUNT++)) || true
    fi
  done < "$BASE_CSV"
  echo "Base IDs from ProductDescription.csv (excluded): $BASE_COUNT"
fi

if [[ -f "$TRANSLATIONS_CSV" ]]; then
  before_trans=${#EXISTING_IDS[@]}
  while IFS= read -r line; do
    id="${line%%|*}"
    id="${id%%$'\r'}"
    if [[ "$id" =~ ^[0-9]+$ ]]; then
      EXISTING_IDS[$id]=1
    fi
  done < "$TRANSLATIONS_CSV"
  echo "IDs already in translations CSV: $((${#EXISTING_IDS[@]} - before_trans))"
  echo "Total IDs to skip when appending: ${#EXISTING_IDS[@]}"
else
  echo "Translations CSV not found; will create it (no header)."
  touch "$TRANSLATIONS_CSV"
fi
echo ""

APPENDED=0
URL="${SOURCE_API}/ProductDescription?\$first=${PAGE_SIZE}&\$select=ProductDescriptionID,Description,ModifiedDate"
PAGE=1

while true; do
  RESP=$(curl -sS "$URL")
  if ! echo "$RESP" | jq -e '.value' &>/dev/null; then
    echo "Error: API response missing .value or invalid JSON." >&2
    echo "$RESP" | head -c 500 >&2
    exit 1
  fi

  # jq outputs three lines per record: ProductDescriptionID, Description, ModifiedDate (so Description can contain |)
  while true; do
    IFS= read -r id || break
    IFS= read -r desc || break
    IFS= read -r modDate || break
    id="${id%%$'\r'}"
    desc="${desc%%$'\r'}"
    modDate="${modDate%%$'\r'}"
    if [[ -z "${EXISTING_IDS[$id]:-}" ]]; then
      # Normalize ModifiedDate: replace T with space
      modDateNorm="${modDate/T/ }"
      printf '%s|%s|%s\n' "$id" "$desc" "$modDateNorm" >> "$TRANSLATIONS_CSV"
      EXISTING_IDS[$id]=1
      ((APPENDED++)) || true
    fi
  done < <(echo "$RESP" | jq -r '
    .value[]
    | (.ProductDescriptionID | tostring),
      ((.Description // "") | gsub("\n"; " ") | gsub("\r"; "")),
      (.ModifiedDate // "" | gsub("T"; " "))
  ')

  ROWS_THIS_PAGE=$(echo "$RESP" | jq -r '.value | length')
  echo "  Page $PAGE: $ROWS_THIS_PAGE rows (appended so far: $APPENDED)"

  nextLink=$(echo "$RESP" | jq -r '.nextLink // empty')
  if [[ -z "$nextLink" ]]; then
    break
  fi
  URL="$nextLink"
  PAGE=$((PAGE + 1))
done

echo ""
echo "Appended $APPENDED missing translation rows to $TRANSLATIONS_CSV"
echo "Total lines in file: $(wc -l < "$TRANSLATIONS_CSV")"
