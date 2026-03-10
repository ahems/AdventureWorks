#!/usr/bin/env bash
# Generates translated subcategory names for all 23 cultures and writes them to
# seed-job/sql/ProductSubcategory.csv for use by the seed job.
#
# Reads the current ProductSubcategory.csv (37 rows), translates the English
# names into each non-English culture via Azure OpenAI chat completions (one
# batch per culture), and outputs 851 rows (37 × 23) with CultureID.
# English variants use the original names; original rowguids preserved for "en".
#
# Output CSV (tab-delimited, no header): ProductSubcategoryID, ProductCategoryID,
# CultureID, Name, rowguid, ModifiedDate
#
# Prerequisites: az login, jq, python3, curl, azd env (AZURE_OPENAI_ACCOUNT_NAME)
# Usage: cd <repo root> && bash scripts/generators/generate-subcategory-translations.sh

set -euo pipefail

echo "ProductSubcategory Translation Generator"
echo "========================================="
echo ""

for dep in jq python3 curl az; do
    if ! command -v "$dep" &>/dev/null; then
        echo "Error: '$dep' is required but was not found in PATH." >&2
        exit 1
    fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
INPUT_CSV="$REPO_ROOT/seed-job/sql/ProductSubcategory.csv"
OUTPUT_CSV="$REPO_ROOT/seed-job/sql/ProductSubcategory.csv"

if [ ! -f "$INPUT_CSV" ]; then
    echo "Error: Input file not found: $INPUT_CSV" >&2
    exit 1
fi

echo "Input/Output: $INPUT_CSV"
echo ""

OPENAI_ACCOUNT=$(azd env get-values 2>/dev/null | grep '^AZURE_OPENAI_ACCOUNT_NAME=' | cut -d'=' -f2 | tr -d '"')
if [ -z "$OPENAI_ACCOUNT" ]; then
    echo "Error: AZURE_OPENAI_ACCOUNT_NAME not found in azd environment." >&2
    exit 1
fi

CHAT_MODEL=$(azd env get-values 2>/dev/null | (grep '^AI_AGENT_MODEL=' || true) | cut -d'=' -f2 | tr -d '"')
if [ -z "$CHAT_MODEL" ]; then
    CHAT_MODEL="chat"
    echo "Note: AI_AGENT_MODEL not found in azd env, defaulting to '$CHAT_MODEL'." >&2
fi

API_VERSION="2024-08-01-preview"
CHAT_ENDPOINT="https://${OPENAI_ACCOUNT}.openai.azure.com/openai/deployments/${CHAT_MODEL}/chat/completions?api-version=${API_VERSION}"

echo "Azure OpenAI account: $OPENAI_ACCOUNT"
echo "Chat deployment:      $CHAT_MODEL"
echo ""

echo "Acquiring Azure access token..."
TOKEN=$(az account get-access-token --resource "https://cognitiveservices.azure.com" --query accessToken -o tsv 2>/dev/null)
if [ -z "$TOKEN" ]; then
    echo "Error: Failed to acquire access token. Run 'az login' and try again." >&2
    exit 1
fi
echo "Token acquired."
echo ""

# Temp files
SUBCATEGORIES_JSON=$(mktemp /tmp/aw_subcats_XXXXXX.json)
ENGLISH_NAMES_FILE=$(mktemp /tmp/aw_subcat_names_XXXXXX.json)
TRANSLATED_NAMES_FILE=$(mktemp /tmp/aw_subcat_translated_XXXXXX.json)
trap 'rm -f "$SUBCATEGORIES_JSON" "$ENGLISH_NAMES_FILE" "$TRANSLATED_NAMES_FILE"' EXIT

# Parse ProductSubcategory.csv: ProductSubcategoryID, ProductCategoryID, Name, rowguid, ModifiedDate
python3 - "$INPUT_CSV" <<'PYEOF' > "$SUBCATEGORIES_JSON"
import json, sys
rows = []
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    for line in f:
        line = line.rstrip('\n\r')
        if not line.strip():
            continue
        parts = line.split('\t')
        if len(parts) < 5:
            continue
        sid, cat_id, name, rowguid, mod = parts[0].strip(), parts[1].strip(), parts[2].strip(), parts[3].strip(), parts[4].strip()
        if not sid.isdigit() or not cat_id.isdigit():
            continue
        rows.append({
            'ProductSubcategoryID': int(sid),
            'ProductCategoryID': int(cat_id),
            'Name': name,
            'rowguid': rowguid,
            'ModifiedDate': mod or '2026-01-01 00:00:00.000'
        })
print(json.dumps(rows))
PYEOF

SUBCOUNT=$(python3 -c "import json; print(len(json.load(open('$SUBCATEGORIES_JSON'))))")
echo "Read $SUBCOUNT subcategories from ProductSubcategory.csv."

python3 -c "
import json
rows = json.load(open('$SUBCATEGORIES_JSON'))
print(json.dumps([r['Name'] for r in rows]))
" > "$ENGLISH_NAMES_FILE"
echo ""

MODIFIED_DATE="2026-01-01 00:00:00.000"

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

translate_batch() {
    local culture_code="$1"
    local language_name="$2"

    local system_prompt="You are a professional translator for an outdoor sports and bicycle retail company. Translate product subcategory names (e.g. Mountain Bikes, Handlebars, Jerseys) from English to ${language_name}. Keep product/category terms accurate. Return ONLY a valid JSON array of translated strings in the exact same order and count as the input array. No markdown, no explanations — just the JSON array."
    local user_prompt="Translate these ${SUBCOUNT} bicycle/outdoor product subcategory names into ${language_name} (locale: ${culture_code}). Return a JSON array with exactly ${SUBCOUNT} translated strings."

    local json_payload
    json_payload=$(python3 -c "
import json, sys
system = sys.argv[1]
user = sys.argv[2]
names = json.load(open(sys.argv[3]))
user = user + ' Input: ' + json.dumps(names)
payload = {
    'messages': [
        {'role': 'system', 'content': system},
        {'role': 'user', 'content': user}
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

    local count
    count=$(python3 -c "import json; print(len(json.load(open('$TRANSLATED_NAMES_FILE'))))" 2>/dev/null || echo "0")
    if [ "$count" != "$SUBCOUNT" ]; then
        echo "  Warning: Expected $SUBCOUNT translations, got $count." >&2
        return 1
    fi
}

new_uuid() {
    python3 -c "import uuid; print(str(uuid.uuid4()).upper())"
}

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

    if [ "$is_english" = "yes" ]; then
        echo "  Using English names (no translation needed)"
        cp "$ENGLISH_NAMES_FILE" "$TRANSLATED_NAMES_FILE"
    else
        echo "  Translating $SUBCOUNT subcategory names to $language_name..."
        if ! translate_batch "$culture_id_trimmed" "$language_name"; then
            echo "  Falling back to English for $culture_id_trimmed." >&2
            cp "$ENGLISH_NAMES_FILE" "$TRANSLATED_NAMES_FILE"
            TOTAL_FAILED=$((TOTAL_FAILED + 1))
        else
            echo "  Translation complete."
        fi
    fi

    python3 - "$SUBCATEGORIES_JSON" "$TRANSLATED_NAMES_FILE" "$OUTPUT_CSV" "$culture_id_padded" "$MODIFIED_DATE" <<'WRITECSV'
import json, sys, uuid

subcats_file = sys.argv[1]
translated_file = sys.argv[2]
output_file = sys.argv[3]
culture_id_padded = sys.argv[4]
modified_date = sys.argv[5]

subcats = json.load(open(subcats_file))
translated = json.load(open(translated_file))

with open(output_file, 'a', encoding='utf-8') as f:
    for sc, name in zip(subcats, translated):
        if culture_id_padded.strip() == 'en':
            rowguid = sc['rowguid']
        else:
            rowguid = str(uuid.uuid4()).upper()
        f.write(f"{sc['ProductSubcategoryID']}\t{sc['ProductCategoryID']}\t{culture_id_padded}\t{name}\t{rowguid}\t{modified_date}\n")
print(f"  Wrote {len(subcats)} rows.")
WRITECSV
    TOTAL_ROWS=$((TOTAL_ROWS + SUBCOUNT))
done

echo ""
echo "========================================="
if [ "$TOTAL_FAILED" -gt 0 ]; then
    echo "Warning: $TOTAL_FAILED culture(s) fell back to English."
fi
echo "Wrote $TOTAL_ROWS rows to:"
echo "  $OUTPUT_CSV"
echo ""
echo "The seed job will load this file into Production.ProductSubcategory."
