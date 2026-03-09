#!/usr/bin/env bash
# Builds ProductDescription-ai-embeddings.csv for the seed job by fetching
# ProductDescription rows (with embeddings) from the source DAB REST API and writing
# tab-delimited CSV: ProductDescriptionID, DescriptionEmbedding, ModifiedDate.
# The seed job then uses this file to UPDATE existing rows after import.
#
# Usage: run from repo root, or pass REPO_ROOT. Output: seed-job/sql/ProductDescription-ai-embeddings.csv

set -e

# Hard-coded source API (REST base; no trailing slash)
SOURCE_API="https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api"
PAGE_SIZE=100

# Resolve repo root (script lives in scripts/utilities/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
OUTPUT_FILE="$REPO_ROOT/seed-job/sql/ProductDescription-ai-embeddings.csv"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install jq to run this script." >&2
  exit 1
fi

echo "Source API: $SOURCE_API"
echo "Output:     $OUTPUT_FILE"
echo ""

# Header line (tab-delimited)
printf '%s\t%s\t%s\n' "ProductDescriptionID" "DescriptionEmbedding" "ModifiedDate" > "$OUTPUT_FILE"

URL="${SOURCE_API}/ProductDescription?\$first=${PAGE_SIZE}&\$select=ProductDescriptionID,DescriptionEmbedding,ModifiedDate"
PAGE=1
TOTAL_ROWS=0

while true; do
  RESP=$(curl -sS "$URL")
  if ! echo "$RESP" | jq -e '.value' &>/dev/null; then
    echo "Error: API response missing .value or invalid JSON." >&2
    echo "$RESP" | head -c 500 >&2
    exit 1
  fi

  # Output rows that have a non-null DescriptionEmbedding and ProductDescriptionID != 0 (skip placeholder)
  echo "$RESP" | jq -r '
    .value[]
    | select(.DescriptionEmbedding != null and .ProductDescriptionID != 0 and .ProductDescriptionID != null)
    | [.ProductDescriptionID, (.DescriptionEmbedding | tostring), (.ModifiedDate // "")]
    | @tsv
  ' >> "$OUTPUT_FILE"
  ROWS_THIS_PAGE=$(echo "$RESP" | jq -r '[.value[] | select(.DescriptionEmbedding != null and .ProductDescriptionID != 0 and .ProductDescriptionID != null)] | length')
  TOTAL_ROWS=$((TOTAL_ROWS + ROWS_THIS_PAGE))

  echo "  Page $PAGE: $ROWS_THIS_PAGE rows with embeddings (total: $TOTAL_ROWS)"

  nextLink=$(echo "$RESP" | jq -r '.nextLink // empty')
  if [ -z "$nextLink" ]; then
    break
  fi
  URL="$nextLink"
  PAGE=$((PAGE + 1))
done

echo ""
echo "Wrote $TOTAL_ROWS rows to $OUTPUT_FILE"
echo "Seed job will use this file to UPDATE Production.ProductDescription (DescriptionEmbedding, ModifiedDate) after import."
