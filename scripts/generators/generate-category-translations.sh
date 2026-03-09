#!/usr/bin/env bash
# Generates translated category names for all cultures in Production.Culture and
# writes them to seed-job/sql/ProductCategory.csv for use by the seed job.
#
# The original 4 AdventureWorks categories (Bikes, Components, Clothing, Accessories)
# are translated into every culture from Culture.csv and Culture-ai.csv using Azure
# OpenAI chat completions. English variants reuse the English names directly.
#
# Output CSV format (tab-delimited, no header row):
#   ProductCategoryID  CultureID  Name  rowguid  ModifiedDate
#
# Prerequisites:
#   az login (or Managed Identity)    -- for Azure access token
#   jq, python3, curl                 -- standard dev-container tools
#   azd env get-values                -- must include AZURE_OPENAI_ACCOUNT_NAME
#                                        and ideally AI_AGENT_MODEL
#
# Usage:
#   cd <repo root>
#   bash scripts/generators/generate-category-translations.sh

set -euo pipefail

echo "ProductCategory Translation Generator"
echo "======================================"
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
OUTPUT_CSV="$REPO_ROOT/seed-job/sql/ProductCategory.csv"

echo "Output: $OUTPUT_CSV"
echo ""

# ── Azure OpenAI config ──────────────────────────────────────────────────────────

OPENAI_ACCOUNT=$(azd env get-values 2>/dev/null | grep '^AZURE_OPENAI_ACCOUNT_NAME=' | cut -d'=' -f2 | tr -d '"')
if [ -z "$OPENAI_ACCOUNT" ]; then
    echo "Error: AZURE_OPENAI_ACCOUNT_NAME not found in azd environment." >&2
    echo "       Run 'azd env get-values' to check, or ensure 'azd up' has been run." >&2
    exit 1
fi

# Try to find the model from AI_AGENT_MODEL, fall back to gpt-4o
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

# ── Azure access token ───────────────────────────────────────────────────────────

echo "Acquiring Azure access token..."
TOKEN=$(az account get-access-token --resource "https://cognitiveservices.azure.com" --query accessToken -o tsv 2>/dev/null)
if [ -z "$TOKEN" ]; then
    echo "Error: Failed to acquire access token. Run 'az login' and try again." >&2
    exit 1
fi
echo "Token acquired."
echo ""

# ── Helper: translate a single category name to a target language ────────────────

translate_category() {
    local english_name="$1"
    local culture_code="$2"
    local language_name="$3"

    local system_prompt="You are a translation assistant. Translate product category names accurately and concisely. Return only the translated text, nothing else — no punctuation, no explanation."
    local user_prompt="Translate the bicycle/outdoor-sports product category name '${english_name}' into ${language_name} (language/locale: ${culture_code}). Return only the translated category name."

    local json_payload
    json_payload=$(python3 -c "
import json, sys
system = sys.argv[1]
user = sys.argv[2]
payload = {
    'messages': [
        {'role': 'system', 'content': system},
        {'role': 'user', 'content': user}
    ],
    'temperature': 0,
    'max_tokens': 50
}
print(json.dumps(payload))
" "$system_prompt" "$user_prompt")

    local response
    response=$(curl -sS -X POST "$CHAT_ENDPOINT" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "$json_payload")

    local error_msg
    error_msg=$(echo "$response" | jq -r '.error.message // empty' 2>/dev/null)
    if [ -n "$error_msg" ]; then
        echo "Error from OpenAI API for '$english_name' -> $culture_code: $error_msg" >&2
        return 1
    fi

    echo "$response" | jq -r '.choices[0].message.content' | tr -d '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

# ── Generate UUID ────────────────────────────────────────────────────────────────

new_uuid() {
    python3 -c "import uuid; print(str(uuid.uuid4()).upper())"
}

# ── Category definitions ─────────────────────────────────────────────────────────
# Original IDs and rowguids from the AdventureWorks base data

declare -A CATEGORY_ID=(
    [Bikes]=1
    [Components]=2
    [Clothing]=3
    [Accessories]=4
)

declare -A ENGLISH_ROWGUID=(
    [Bikes]="CFBDA25C-DF71-47A7-B81B-64EE161AA37C"
    [Components]="C657828D-D808-4ABA-91A3-AF2CE02300E9"
    [Clothing]="10A7C342-CA82-48D4-8A38-46A2EB089B74"
    [Accessories]="2BE3BE36-D9A2-4EEE-B593-ED895D97C2A6"
)

CATEGORIES=("Bikes" "Components" "Clothing" "Accessories")

MODIFIED_DATE="2026-01-01 00:00:00.000"

# ── Culture list with human-readable names for the prompt ────────────────────────
# Order: base 7 (Culture.csv) then AI 16 (Culture-ai.csv)
# Format: "code|DisplayName|isEnglishVariant"

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

# ── Write CSV ────────────────────────────────────────────────────────────────────

> "$OUTPUT_CSV"

PROCESSED=0
FAILED=0

for culture_entry in "${CULTURES[@]}"; do
    # Parse the culture entry
    culture_id_padded=$(echo "$culture_entry" | cut -d'|' -f1)
    language_name=$(echo "$culture_entry" | cut -d'|' -f2)
    is_english=$(echo "$culture_entry" | cut -d'|' -f3)

    # Trim trailing spaces for display and for the CSV CultureID value
    culture_id_trimmed=$(echo "$culture_id_padded" | sed 's/[[:space:]]*$//')

    echo "Processing culture: $culture_id_trimmed ($language_name)"

    for category_name in "${CATEGORIES[@]}"; do
        cat_id="${CATEGORY_ID[$category_name]}"

        if [ "$is_english" = "yes" ]; then
            translated_name="$category_name"
        else
            echo "  Translating '$category_name' -> $language_name..."
            translated_name=$(translate_category "$category_name" "$culture_id_trimmed" "$language_name")
            if [ -z "$translated_name" ]; then
                echo "  Warning: Empty translation for '$category_name' in $culture_id_trimmed, using English fallback." >&2
                translated_name="$category_name"
                FAILED=$((FAILED + 1))
            fi
            echo "  Result: $translated_name"
        fi

        # Use original rowguid for the base English (en) row; generate new UUID for all others
        if [ "$culture_id_trimmed" = "en" ]; then
            rowguid="${ENGLISH_ROWGUID[$category_name]}"
        else
            rowguid=$(new_uuid)
        fi

        # Write tab-delimited row with the padded CultureID (nchar(6) format)
        printf '%s\t%s\t%s\t%s\t%s\n' \
            "$cat_id" \
            "$culture_id_padded" \
            "$translated_name" \
            "$rowguid" \
            "$MODIFIED_DATE" >> "$OUTPUT_CSV"

        PROCESSED=$((PROCESSED + 1))
    done
done

echo ""
echo "======================================"
if [ "$FAILED" -gt 0 ]; then
    echo "Warning: $FAILED translation(s) fell back to English."
fi
echo "Wrote $PROCESSED rows to:"
echo "  $OUTPUT_CSV"
echo ""
echo "The seed job will load this file into Production.ProductCategory."
