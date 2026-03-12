#!/usr/bin/env bash
# Generates translated SpecialOffer descriptions for all 23 cultures and writes
# them to seed-job/sql/SpecialOffer.csv for use by the seed job.
#
# Uses the existing 16-row SpecialOffer data as the "en" source (or a backup
# embedded list), translates the Description field into each non-English
# culture via Azure OpenAI chat completions (one batch per culture), and
# outputs 368 rows (16 × 23) with CultureID. Only Description is translated;
# Type, Category, dates, etc. stay the same per offer.
#
# Output CSV (tab-delimited, no header): SpecialOfferID, CultureID, Description,
# DiscountPct, Type, Category, StartDate, EndDate, MinQty, MaxQty, rowguid, ModifiedDate
#
# Prerequisites: az login, jq, python3, curl, azd env (AZURE_OPENAI_ACCOUNT_NAME)
# Usage: cd <repo root> && bash scripts/generators/generate-special-offer-translations.sh

set -euo pipefail

echo "SpecialOffer Translation Generator"
echo "===================================="
echo ""

for dep in jq python3 curl az; do
    if ! command -v "$dep" &>/dev/null; then
        echo "Error: '$dep' is required but was not found in PATH." >&2
        exit 1
    fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
# Optional: read from existing CSV if it has the OLD format (no CultureID). Otherwise use embedded source.
INPUT_CSV="$REPO_ROOT/seed-job/sql/SpecialOffer.csv"
OUTPUT_CSV="$REPO_ROOT/seed-job/sql/SpecialOffer.csv"

# Embedded 16 offers (SpecialOfferID, Description, DiscountPct, Type, Category, StartDate, EndDate, MinQty, MaxQty, rowguid, ModifiedDate) for when CSV already has new format
OFFERS_JSON=$(mktemp /tmp/aw_offers_XXXXXX.json)
ENGLISH_DESCRIPTIONS_FILE=$(mktemp /tmp/aw_offer_descs_XXXXXX.json)
TRANSLATED_DESCRIPTIONS_FILE=$(mktemp /tmp/aw_offer_translated_XXXXXX.json)
trap 'rm -f "$OFFERS_JSON" "$ENGLISH_DESCRIPTIONS_FILE" "$TRANSLATED_DESCRIPTIONS_FILE"' EXIT

# Build offers from current CSV: old format (11 cols) or new format (12 cols); if new, use only en rows
python3 - "$INPUT_CSV" "$OFFERS_JSON" <<'PYEOF'
import json, sys, re
input_path = sys.argv[1]
out_path = sys.argv[2]
rows = []
with open(input_path, 'r', encoding='utf-8') as f:
    for line in f:
        line = line.rstrip('\n\r')
        if not line.strip():
            continue
        parts = line.split('\t')
        # Old format: SpecialOfferID, Description, DiscountPct, Type, Category, StartDate, EndDate, MinQty, MaxQty, rowguid, ModifiedDate (11)
        # New format: SpecialOfferID, CultureID, Description, ... (12)
        if len(parts) >= 11:
            if len(parts) >= 12 and re.match(r'^[a-z]{2}(-[a-z]{2})?\s*$', (parts[1] or '').strip()):
                # Already has CultureID - only keep English (en) rows as source
                culture_id = parts[1].strip().lower()
                if culture_id != 'en':
                    continue
                sid, desc = parts[0].strip(), parts[2].strip()
                discount, type_, category = parts[3].strip(), parts[4].strip(), parts[5].strip()
                start_date, end_date = parts[6].strip(), parts[7].strip()
                min_qty, max_qty = parts[8].strip(), parts[9].strip() if len(parts) > 9 else ''
                rowguid = parts[10].strip() if len(parts) > 10 else ''
                modified = parts[11].strip() if len(parts) > 11 else '2026-01-01 00:00:00.000'
            else:
                sid, desc = parts[0].strip(), parts[1].strip()
                discount, type_, category = parts[2].strip(), parts[3].strip(), parts[4].strip()
                start_date, end_date = parts[5].strip(), parts[6].strip()
                min_qty = parts[7].strip()
                max_qty = parts[8].strip() if len(parts) > 8 else ''
                rowguid = parts[9].strip() if len(parts) > 9 else ''
                modified = parts[10].strip() if len(parts) > 10 else '2026-01-01 00:00:00.000'
            if sid.isdigit():
                rows.append({
                    'SpecialOfferID': int(sid),
                    'Description': desc,
                    'DiscountPct': discount,
                    'Type': type_,
                    'Category': category,
                    'StartDate': start_date,
                    'EndDate': end_date,
                    'MinQty': min_qty,
                    'MaxQty': max_qty,
                    'rowguid': rowguid,
                    'ModifiedDate': modified or '2026-01-01 00:00:00.000'
                })
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(rows, f, indent=0)
PYEOF

OFFERCOUNT=$(python3 -c "import json; print(len(json.load(open('$OFFERS_JSON'))))")
if [ "$OFFERCOUNT" -eq 0 ]; then
    echo "Error: No offers parsed from $INPUT_CSV. Ensure file has 11+ columns (old format) or 12+ with CultureID." >&2
    exit 1
fi
echo "Using $OFFERCOUNT offers as source (English descriptions)."

python3 -c "
import json
rows = json.load(open('$OFFERS_JSON'))
print(json.dumps([r['Description'] for r in rows]))
" > "$ENGLISH_DESCRIPTIONS_FILE"
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

    local system_prompt="You are a professional translator for an outdoor sports and bicycle retail company. Translate special offer / promotion descriptions (e.g. 'Mountain Tire Sale', 'Half-Price Pedal Sale', 'No Discount') from English to ${language_name}. Keep marketing tone and accuracy. Return ONLY a valid JSON array of translated strings in the exact same order and count as the input array. No markdown, no explanations — just the JSON array."
    local user_prompt="Translate these ${OFFERCOUNT} promotion/sale descriptions into ${language_name} (locale: ${culture_code}). Return a JSON array with exactly ${OFFERCOUNT} translated strings."

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
    'max_tokens': 4000
}
print(json.dumps(payload))
" "$system_prompt" "$user_prompt" "$ENGLISH_DESCRIPTIONS_FILE")

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
    echo "$content" > "$TRANSLATED_DESCRIPTIONS_FILE"

    local count
    count=$(python3 -c "import json; print(len(json.load(open('$TRANSLATED_DESCRIPTIONS_FILE'))))" 2>/dev/null || echo "0")
    if [ "$count" != "$OFFERCOUNT" ]; then
        echo "  Warning: Expected $OFFERCOUNT translations, got $count." >&2
        return 1
    fi
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
        echo "  Using English descriptions (no translation needed)"
        cp "$ENGLISH_DESCRIPTIONS_FILE" "$TRANSLATED_DESCRIPTIONS_FILE"
    else
        echo "  Translating $OFFERCOUNT offer descriptions to $language_name..."
        if ! translate_batch "$culture_id_trimmed" "$language_name"; then
            echo "  Falling back to English for $culture_id_trimmed." >&2
            cp "$ENGLISH_DESCRIPTIONS_FILE" "$TRANSLATED_DESCRIPTIONS_FILE"
            TOTAL_FAILED=$((TOTAL_FAILED + 1))
        else
            echo "  Translation complete."
        fi
    fi

    python3 - "$OFFERS_JSON" "$TRANSLATED_DESCRIPTIONS_FILE" "$OUTPUT_CSV" "$culture_id_padded" "$MODIFIED_DATE" <<'WRITECSV'
import json, sys, uuid

offers_file = sys.argv[1]
translated_file = sys.argv[2]
output_file = sys.argv[3]
culture_id_padded = sys.argv[4]
modified_date = sys.argv[5]

offers = json.load(open(offers_file))
translated = json.load(open(translated_file))

with open(output_file, 'a', encoding='utf-8') as f:
    for offer, desc in zip(offers, translated):
        if culture_id_padded.strip() == 'en':
            rowguid = offer['rowguid']
        else:
            rowguid = str(uuid.uuid4()).upper()
        max_qty = offer.get('MaxQty', '')
        # SpecialOfferID, CultureID, Description, DiscountPct, Type, Category, StartDate, EndDate, MinQty, MaxQty, rowguid, ModifiedDate
        f.write(f"{offer['SpecialOfferID']}\t{culture_id_padded}\t{desc}\t{offer['DiscountPct']}\t{offer['Type']}\t{offer['Category']}\t{offer['StartDate']}\t{offer['EndDate']}\t{offer['MinQty']}\t{max_qty}\t{rowguid}\t{modified_date}\n")
print(f"  Wrote {len(offers)} rows.")
WRITECSV
    TOTAL_ROWS=$((TOTAL_ROWS + OFFERCOUNT))
done

echo ""
echo "========================================="
if [ "$TOTAL_FAILED" -gt 0 ]; then
    echo "Warning: $TOTAL_FAILED culture(s) fell back to English."
fi
echo "Wrote $TOTAL_ROWS rows to:"
echo "  $OUTPUT_CSV"
echo ""
echo "The seed job will load this file into Sales.SpecialOffer."
