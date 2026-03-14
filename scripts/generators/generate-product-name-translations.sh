#!/usr/bin/env bash
# Generates translated product names and vector embeddings for all 23 cultures
# and writes them to seed-job/sql/ProductNames-ai.csv for use by the seed job.
#
# Only products with FinishedGoodsFlag = 1 (in Product.csv) get translations and
# embeddings. All other products get one row per culture with the original English
# name and NULL for ProductNameEmbedding, reducing file size and API usage.
#
# For each culture, for finished-goods only:
#   1. Translation (non-English only): one chat completions call returning a JSON array.
#   2. Embedding: one embeddings call returning 1536-dim vectors.
#
# English variants (en, en-au, en-ca, en-gb, en-ie, en-nz) skip translation and
# use the original English names for finished goods, but still generate embeddings.
#
# Output CSV format (tab-delimited, no header row):
#   ProductID  CultureID  Name  ProductNameEmbedding  rowguid  ModifiedDate
#   (ProductNameEmbedding is empty for non-finished-goods products → NULL in DB.)
#
# Prerequisites:
#   az login (or Managed Identity)    -- for Azure access token
#   jq, python3, curl                 -- standard dev-container tools
#   azd env get-values                -- must include AZURE_OPENAI_ACCOUNT_NAME
#                                        and ideally AI_AGENT_MODEL
#
# Usage:
#   cd <repo root>
#   bash scripts/generators/generate-product-name-translations.sh

set -euo pipefail

echo "ProductName Translation + Embedding Generator"
echo "==============================================="
echo ""

# ── Dependency check ─────────────────────────────────────────────────────────────

for dep in jq python3 curl az; do
    if ! command -v "$dep" &>/dev/null; then
        echo "Error: '$dep' is required but was not found in PATH." >&2
        exit 1
    fi
done

# ── Path resolution ───────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
INPUT_CSV="$REPO_ROOT/seed-job/sql/Product.csv"
OUTPUT_CSV="$REPO_ROOT/seed-job/sql/ProductNames-ai.csv"

if [ ! -f "$INPUT_CSV" ]; then
    echo "Error: Input file not found: $INPUT_CSV" >&2
    exit 1
fi

echo "Input:  $INPUT_CSV"
echo "Output: $OUTPUT_CSV"
echo ""

# ── Azure OpenAI config ───────────────────────────────────────────────────────────

OPENAI_ACCOUNT=$(azd env get-values 2>/dev/null | grep '^AZURE_OPENAI_ACCOUNT_NAME=' | cut -d'=' -f2 | tr -d '"')
if [ -z "$OPENAI_ACCOUNT" ]; then
    echo "Error: AZURE_OPENAI_ACCOUNT_NAME not found in azd environment." >&2
    echo "       Run 'azd env get-values' to check, or ensure 'azd up' has been run." >&2
    exit 1
fi

CHAT_MODEL=$(azd env get-values 2>/dev/null | (grep '^AI_AGENT_MODEL=' || true) | cut -d'=' -f2 | tr -d '"')
if [ -z "$CHAT_MODEL" ]; then
    CHAT_MODEL="chat"
    echo "Note: AI_AGENT_MODEL not found in azd env, defaulting to '$CHAT_MODEL'." >&2
fi

CHAT_API_VERSION="2024-08-01-preview"
CHAT_ENDPOINT="https://${OPENAI_ACCOUNT}.openai.azure.com/openai/deployments/${CHAT_MODEL}/chat/completions?api-version=${CHAT_API_VERSION}"

EMBEDDING_DEPLOYMENT="embedding"
EMBEDDING_API_VERSION="2024-02-01"
EMBEDDING_ENDPOINT="https://${OPENAI_ACCOUNT}.openai.azure.com/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=${EMBEDDING_API_VERSION}"

echo "Azure OpenAI account:   $OPENAI_ACCOUNT"
echo "Chat deployment:        $CHAT_MODEL"
echo "Embedding deployment:   $EMBEDDING_DEPLOYMENT"
echo ""

# ── Azure access token ────────────────────────────────────────────────────────────

echo "Acquiring Azure access token..."
TOKEN=$(az account get-access-token --resource "https://cognitiveservices.azure.com" --query accessToken -o tsv 2>/dev/null)
if [ -z "$TOKEN" ]; then
    echo "Error: Failed to acquire access token. Run 'az login' and try again." >&2
    exit 1
fi
echo "Token acquired."
echo ""

# ── Temp files (cleaned up on exit) ──────────────────────────────────────────────

PRODUCTS_JSON_FILE=$(mktemp /tmp/aw_products_XXXXXX.json)
ENGLISH_NAMES_FILE=$(mktemp /tmp/aw_en_names_XXXXXX.json)
TRANSLATED_NAMES_FILE=$(mktemp /tmp/aw_translated_names_XXXXXX.json)
EMBEDDINGS_FILE=$(mktemp /tmp/aw_embeddings_XXXXXX.json)

trap 'rm -f "$PRODUCTS_JSON_FILE" "$ENGLISH_NAMES_FILE" "$TRANSLATED_NAMES_FILE" "$EMBEDDINGS_FILE"' EXIT

# ── Read all products from Product.csv ───────────────────────────────────────────
# Product.csv: tab-delimited, no header. Col 1 = ProductID, Col 2 = Name, Col 5 = FinishedGoodsFlag (1 = true).
# Only products with FinishedGoodsFlag = 1 get translations and embeddings; others get English name only and NULL embedding.

python3 - "$INPUT_CSV" <<'PYEOF' > "$PRODUCTS_JSON_FILE"
import json, sys

products = []  # all products in file order: {id, name, finished_goods}
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    for line in f:
        line = line.rstrip('\n\r')
        if not line.strip():
            continue
        parts = line.split('\t')
        if len(parts) < 5:
            continue
        pid = parts[0].strip()
        name = parts[1].strip()
        if not pid.isdigit():
            continue
        # FinishedGoodsFlag is 5th column (index 4); 1 = true
        finished = parts[4].strip() == '1'
        products.append({'id': int(pid), 'name': name, 'finished_goods': finished})

print(json.dumps(products))
PYEOF

PRODUCT_COUNT=$(python3 -c "import json; print(len(json.load(open('$PRODUCTS_JSON_FILE'))))")
FINISHED_COUNT=$(python3 -c "import json; p=json.load(open('$PRODUCTS_JSON_FILE')); print(sum(1 for x in p if x.get('finished_goods')))")
echo "Read $PRODUCT_COUNT products from Product.csv ($FINISHED_COUNT finished goods; only these get translations and embeddings)."

# English names for finished-goods only (used for translation and embedding batches)
python3 -c "
import json
products = json.load(open('$PRODUCTS_JSON_FILE'))
finished_names = [p['name'] for p in products if p.get('finished_goods')]
print(json.dumps(finished_names))
" > "$ENGLISH_NAMES_FILE"

echo ""

# ── Culture list ──────────────────────────────────────────────────────────────────
# Format: "paddedCode|DisplayName|isEnglishVariant"
# paddedCode is right-padded to 6 chars to match SQL Server NCHAR(6)

CULTURES=(
    "ar    |Arabic|no"
    "en    |English (US)|yes"
    "es    |Spanish|no"
    "fr    |French|no"
    "he    |Hebrew|no"
    "th    |Thai|no"
    "zh-cht|Chinese Traditional|no"
    "de    |German|no"
    "en-au |English (Australia)|yes"
    "en-ca |English (Canada)|yes"
    "en-gb |English (United Kingdom)|yes"
    "en-ie |English (Ireland)|yes"
    "en-nz |English (New Zealand)|yes"
    "id    |Indonesian|no"
    "it    |Italian|no"
    "ja    |Japanese|no"
    "ko    |Korean|no"
    "nl    |Dutch|no"
    "pt    |Portuguese|no"
    "ru    |Russian|no"
    "tr    |Turkish|no"
    "vi    |Vietnamese|no"
    "zh    |Chinese Simplified|no"
)

MODIFIED_DATE="2026-01-01 00:00:00.000"

# ── Helper: batch translate all product names for one culture ─────────────────────
# Writes a JSON array of translated strings (same order as input) to TRANSLATED_NAMES_FILE.

translate_names_batch() {
    local culture_code="$1"
    local language_name="$2"

    local system_prompt="You are a professional translator for an outdoor sports and bicycle retail company. Translate product names from English to ${language_name}. Rules: 1) Keep all model numbers, product codes, and numeric size/dimension values unchanged (e.g. '42', 'SB-2394B', '-100', '58'). 2) Translate descriptive English words such as colors and product type names into ${language_name}. 3) Return ONLY a valid JSON array of translated strings in the exact same order and count as the input array. No markdown, no explanations — just the JSON array."

    local finished_count="$FINISHED_COUNT"
    local user_prompt="Translate these ${finished_count} bicycle/outdoor product names into ${language_name} (locale: ${culture_code}). Return a JSON array with exactly ${finished_count} translated strings."

    local json_payload
    json_payload=$(python3 -c "
import json, sys
system = sys.argv[1]
user   = sys.argv[2]
names  = json.load(open(sys.argv[3]))
user   = user + ' Input: ' + json.dumps(names)
payload = {
    'messages': [
        {'role': 'system', 'content': system},
        {'role': 'user',   'content': user}
    ],
    'temperature': 0,
    'max_tokens': 8000
}
print(json.dumps(payload))
" "$system_prompt" "$user_prompt" "$ENGLISH_NAMES_FILE")

    local response
    response=$(curl -sS -X POST "$CHAT_ENDPOINT" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "$json_payload")

    local error_msg
    error_msg=$(echo "$response" | jq -r '.error.message // empty' 2>/dev/null)
    if [ -n "$error_msg" ]; then
        echo "  Error from OpenAI API: $error_msg" >&2
        return 1
    fi

    # Extract content, strip any markdown code fence wrapping
    local content
    content=$(echo "$response" | jq -r '.choices[0].message.content')
    content=$(echo "$content" | python3 -c '
import sys, json, re
text = sys.stdin.read().strip()
text = re.sub(r"^```(?:json)?\s*", "", text)
text = re.sub(r"\s*```$", "", text)
text = text.strip()
try:
    data = json.loads(text)
    if isinstance(data, list):
        print(json.dumps(data))
    else:
        raise ValueError("not a list")
except Exception as e:
    print("PARSE_ERROR:", e, file=sys.stderr)
    sys.exit(1)
')

    echo "$content" > "$TRANSLATED_NAMES_FILE"

    # Validate count
    local translated_count
    translated_count=$(python3 -c "import json; print(len(json.load(open('$TRANSLATED_NAMES_FILE'))))" 2>/dev/null || echo "0")
    if [ "$translated_count" != "$FINISHED_COUNT" ]; then
        echo "  Warning: Expected $FINISHED_COUNT translations, got $translated_count." >&2
        return 1
    fi
}

# ── Helper: batch generate embeddings for all names ───────────────────────────────
# Reads names from TRANSLATED_NAMES_FILE, writes sorted embeddings to EMBEDDINGS_FILE.

generate_embeddings_batch() {
    local json_payload
    json_payload=$(python3 -c "
import json, sys
names = json.load(open(sys.argv[1]))
print(json.dumps({'input': names}))
" "$TRANSLATED_NAMES_FILE")

    local response
    response=$(curl -sS -X POST "$EMBEDDING_ENDPOINT" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "$json_payload")

    local error_msg
    error_msg=$(echo "$response" | jq -r '.error.message // empty' 2>/dev/null)
    if [ -n "$error_msg" ]; then
        echo "  Error from OpenAI Embeddings API: $error_msg" >&2
        return 1
    fi

    # Sort by index and extract embedding arrays into a top-level JSON array
    echo "$response" | jq -c '[.data | sort_by(.index) | .[].embedding]' > "$EMBEDDINGS_FILE"

    local embedding_count
    embedding_count=$(python3 -c "import json; print(len(json.load(open('$EMBEDDINGS_FILE'))))" 2>/dev/null || echo "0")
    if [ "$embedding_count" != "$FINISHED_COUNT" ]; then
        echo "  Warning: Expected $FINISHED_COUNT embeddings, got $embedding_count." >&2
        return 1
    fi
}

# ── Helper: write CSV rows for one culture ────────────────────────────────────────
# All products get a row: finished goods use translated name + embedding; others use English name + empty embedding (NULL).

write_csv_rows() {
    local culture_id_padded="$1"

    python3 - "$PRODUCTS_JSON_FILE" "$TRANSLATED_NAMES_FILE" "$EMBEDDINGS_FILE" "$OUTPUT_CSV" "$culture_id_padded" "$MODIFIED_DATE" <<'PYEOF'
import json, sys, uuid

products_file      = sys.argv[1]
translated_file    = sys.argv[2]
embeddings_file    = sys.argv[3]
output_file        = sys.argv[4]
culture_id_padded  = sys.argv[5]
modified_date      = sys.argv[6]

products  = json.load(open(products_file))
translated = json.load(open(translated_file))
embeddings = json.load(open(embeddings_file))

finished_idx = 0
written = 0
with open(output_file, 'a', encoding='utf-8') as f:
    for p in products:
        rowguid = str(uuid.uuid4()).upper()
        if p.get('finished_goods'):
            name = translated[finished_idx]
            emb = json.dumps(embeddings[finished_idx], separators=(',', ':'))
            finished_idx += 1
        else:
            name = p['name']
            emb = ''   # NULL in DB
        f.write(f"{p['id']}\t{culture_id_padded}\t{name}\t{emb}\t{rowguid}\t{modified_date}\n")
        written += 1

print(f"  Wrote {written} rows.")
PYEOF
}

# ── Main loop ─────────────────────────────────────────────────────────────────────

> "$OUTPUT_CSV"

TOTAL_ROWS=0
TOTAL_FAILED=0

for culture_entry in "${CULTURES[@]}"; do
    culture_id_padded=$(echo "$culture_entry" | cut -d'|' -f1)
    language_name=$(echo "$culture_entry" | cut -d'|' -f2)
    is_english=$(echo "$culture_entry" | cut -d'|' -f3)
    culture_id_trimmed=$(echo "$culture_id_padded" | sed 's/[[:space:]]*$//')

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Culture: $culture_id_trimmed ($language_name)"

    # Step 1: Translation
    if [ "$is_english" = "yes" ]; then
        echo "  Using English names for $FINISHED_COUNT finished goods (no translation needed)"
        cp "$ENGLISH_NAMES_FILE" "$TRANSLATED_NAMES_FILE"
    else
        echo "  Translating $FINISHED_COUNT finished-goods names to $language_name..."
        if ! translate_names_batch "$culture_id_trimmed" "$language_name"; then
            echo "  Falling back to English names for $culture_id_trimmed." >&2
            cp "$ENGLISH_NAMES_FILE" "$TRANSLATED_NAMES_FILE"
            TOTAL_FAILED=$((TOTAL_FAILED + 1))
        else
            echo "  Translation complete."
        fi
    fi

    # Step 2: Embeddings (finished goods only)
    echo "  Generating embeddings for $FINISHED_COUNT names..."
    if ! generate_embeddings_batch; then
        echo "  Error: Embedding generation failed for $culture_id_trimmed — skipping culture." >&2
        TOTAL_FAILED=$((TOTAL_FAILED + PRODUCT_COUNT))
        continue
    fi
    echo "  Embeddings complete."

    # Step 3: Write CSV rows (all products: finished with translation+embedding, others English+empty embedding)
    write_csv_rows "$culture_id_padded"
    TOTAL_ROWS=$((TOTAL_ROWS + PRODUCT_COUNT))
done

echo ""
echo "==============================================="
if [ "$TOTAL_FAILED" -gt 0 ]; then
    echo "Warning: $TOTAL_FAILED row(s) had issues (fell back to English or were skipped)."
fi
echo "Wrote $TOTAL_ROWS rows to:"
echo "  $OUTPUT_CSV"
echo ""
echo "The seed job will load this file into Production.ProductName."
