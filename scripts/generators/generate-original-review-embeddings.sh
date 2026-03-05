#!/usr/bin/env bash
# Generates CommentsEmbedding for the 4 original AdventureWorks ProductReview records
# and writes them to seed-job/sql/ProductReview-ai-Embeddings.csv for use by the seed job.
#
# These 4 records (ProductReviewID 1-4) ship with hex-encoded UTF-16LE Comments and no
# CommentsEmbedding. All other reviews (~1393 AI-generated rows) already carry embeddings
# in ProductReview-ai.csv. This script fills the gap so that all reviews are searchable.
#
# The output CSV is consumed by seed-database.ps1 as a post-load UPDATE pass (similar to
# how ProductDescription-ai-embeddings.csv is applied for ProductDescription rows).
#
# Prerequisites:
#   az login (or Managed Identity)    -- for Azure access token
#   jq, python3, curl                 -- standard dev-container tools
#   azd env get-values                -- must include AZURE_OPENAI_ACCOUNT_NAME
#
# Usage:
#   cd <repo root>
#   bash scripts/generators/generate-original-review-embeddings.sh

set -euo pipefail

echo "Original ProductReview Embedding Generator"
echo "==========================================="
echo ""

# ── Dependency check ────────────────────────────────────────────────────────────

for dep in jq python3 curl az; do
    if ! command -v "$dep" &>/dev/null; then
        echo "Error: '$dep' is required but was not found in PATH." >&2
        exit 1
    fi
done

# ── Path resolution ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
INPUT_CSV="$REPO_ROOT/seed-job/sql/ProductReview.csv"
OUTPUT_CSV="$REPO_ROOT/seed-job/sql/ProductReview-ai-Embeddings.csv"

if [ ! -f "$INPUT_CSV" ]; then
    echo "Error: Input file not found: $INPUT_CSV" >&2
    exit 1
fi

echo "Input:  $INPUT_CSV"
echo "Output: $OUTPUT_CSV"
echo ""

# ── Azure OpenAI config ──────────────────────────────────────────────────────────

OPENAI_ACCOUNT=$(azd env get-values 2>/dev/null | grep '^AZURE_OPENAI_ACCOUNT_NAME=' | cut -d'=' -f2 | tr -d '"')
if [ -z "$OPENAI_ACCOUNT" ]; then
    echo "Error: AZURE_OPENAI_ACCOUNT_NAME not found in azd environment." >&2
    echo "       Run 'azd env get-values' to check, or ensure 'azd up' has been run." >&2
    exit 1
fi

EMBEDDING_DEPLOYMENT="embedding"
API_VERSION="2024-02-01"
OPENAI_ENDPOINT="https://${OPENAI_ACCOUNT}.openai.azure.com/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=${API_VERSION}"

echo "Azure OpenAI account:     $OPENAI_ACCOUNT"
echo "Embedding deployment:     $EMBEDDING_DEPLOYMENT"
echo ""

# ── Azure access token ───────────────────────────────────────────────────────────

echo "Acquiring Azure access token..."
TOKEN=$(az account get-access-token --resource "https://cognitiveservices.azure.com" --query accessToken -o tsv 2>/dev/null)
if [ -z "$TOKEN" ]; then
    echo "Error: Failed to acquire access token. Run 'az login' and try again." >&2
    exit 1
fi
echo "Token acquired."
echo ""

# ── Helper: decode hex UTF-16LE to plain text ────────────────────────────────────
# Writes decoded text to stdout. Uses only Python stdlib (no extra packages needed).

decode_hex_utf16le() {
    local hex_string="$1"
    python3 - <<PYEOF
import sys
hex_str = """$hex_string"""
hex_str = hex_str.strip()
try:
    text = bytes.fromhex(hex_str).decode('utf-16-le')
    print(text, end='')
except Exception as e:
    print(f"Error decoding hex: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
}

# ── Helper: call OpenAI Embeddings API ───────────────────────────────────────────
# Writes the embedding JSON array (e.g. "[0.123,...]") to stdout.

generate_embedding() {
    local text="$1"
    local json_payload
    # Use Python to safely JSON-encode the text (handles quotes, newlines, etc.)
    json_payload=$(python3 -c "import json, sys; print(json.dumps({'input': sys.stdin.read()}))" <<< "$text")

    local response
    response=$(curl -sS -X POST "$OPENAI_ENDPOINT" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "$json_payload")

    # Check for API error
    local error_msg
    error_msg=$(echo "$response" | jq -r '.error.message // empty' 2>/dev/null)
    if [ -n "$error_msg" ]; then
        echo "Error from OpenAI API: $error_msg" >&2
        echo "Full response: $response" >&2
        return 1
    fi

    # Extract embedding array as a compact JSON array
    echo "$response" | jq -c '.data[0].embedding'
}

# ── Write CSV header ─────────────────────────────────────────────────────────────

printf '%s\t%s\t%s\n' "ProductReviewID" "CommentsEmbedding" "ModifiedDate" > "$OUTPUT_CSV"

# ── Process each row in ProductReview.csv ────────────────────────────────────────
# Format (tab-delimited, no header row):
#   col 1: ProductReviewID
#   col 2: ProductID
#   col 3: ReviewerName
#   col 4: ReviewDate
#   col 5: EmailAddress
#   col 6: Rating
#   col 7: Comments (hex UTF-16LE)
#   col 8: ModifiedDate
#   col 9+: (empty trailing fields)

PROCESSED=0
FAILED=0

while IFS=$'\t' read -r review_id product_id reviewer_name review_date email rating comments modified_date _rest; do
    # Skip empty lines
    [ -z "$review_id" ] && continue
    # Skip non-numeric IDs (e.g. a header row if one is ever added)
    [[ "$review_id" =~ ^[0-9]+$ ]] || continue

    echo "Processing ProductReviewID $review_id (ReviewerName: $reviewer_name)..."

    # Step 1: Decode hex comments to plain text
    plain_text=$(decode_hex_utf16le "$comments")
    if [ -z "$plain_text" ]; then
        echo "  Warning: Empty decoded text for ProductReviewID $review_id, skipping." >&2
        FAILED=$((FAILED + 1))
        continue
    fi
    echo "  Decoded comment (first 80 chars): ${plain_text:0:80}..."

    # Step 2: Generate embedding via Azure OpenAI
    echo "  Generating embedding..."
    embedding=$(generate_embedding "$plain_text")
    if [ -z "$embedding" ]; then
        echo "  Error: No embedding returned for ProductReviewID $review_id, skipping." >&2
        FAILED=$((FAILED + 1))
        continue
    fi

    # Step 3: Determine ModifiedDate (use current UTC time if blank)
    if [ -z "$modified_date" ]; then
        modified_date=$(date -u +"%Y-%m-%dT%H:%M:%S.%3N")
    fi

    # Step 4: Append to CSV
    printf '%s\t%s\t%s\n' "$review_id" "$embedding" "$modified_date" >> "$OUTPUT_CSV"
    echo "  Done."
    PROCESSED=$((PROCESSED + 1))

done < "$INPUT_CSV"

echo ""
echo "==========================================="
if [ "$FAILED" -gt 0 ]; then
    echo "Warning: $FAILED row(s) failed and were skipped."
fi
echo "Wrote $PROCESSED embedding(s) to:"
echo "  $OUTPUT_CSV"
echo ""
echo "The seed job will use this file to UPDATE Production.ProductReview"
echo "(CommentsEmbedding, ModifiedDate) for the 4 original AdventureWorks records."
