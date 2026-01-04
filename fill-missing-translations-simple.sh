#!/bin/bash

# Simple script to fill missing translations by sending only missing keys to Azure Function
# This assumes the Azure Function is running (locally or in Azure)

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# Configuration
FUNCTION_URL="${TRANSLATION_FUNCTION_URL:-http://localhost:7071/api/TranslateLanguageFile}"
SOURCE_FILE="app/src/locales/en/common.json"
LOCALES_DIR="app/src/locales"

echo -e "${BLUE}=== Fill Missing Translations ===${NC}"
echo "Function URL: $FUNCTION_URL"
echo

# Create a JSON file with ONLY the missing keys
create_missing_keys_json() {
    jq '{
        header: {
            aiSearchPlaceholder: .header.aiSearchPlaceholder
        },
        checkout: {
            removeDiscountCode: .checkout.removeDiscountCode
        },
        reviewForm: {
            alreadyReviewed: .reviewForm.alreadyReviewed,
            error: .reviewForm.error,
            failedToSubmit: .reviewForm.failedToSubmit,
            thankYouForFeedback: .reviewForm.thankYouForFeedback,
            thankYouForReview: .reviewForm.thankYouForReview
        }
    }' "$SOURCE_FILE"
}

# Translate and wait for completion
translate_language() {
    local lang=$1
    local keys_json=$2
    
    echo -e "${YELLOW}Translating to $lang...${NC}"
    
    # Create request
    local request=$(jq -n \
        --argjson languageData "$keys_json" \
        --arg targetLanguage "$lang" \
        --arg sourceFilename "missing_keys" \
        '{languageData: $languageData, targetLanguage: $targetLanguage, sourceFilename: $sourceFilename}')
    
    # Start translation
    local response=$(curl -s -X POST "$FUNCTION_URL" \
        -H "Content-Type: application/json" \
        -d "$request")
    
    local instance_id=$(echo "$response" | jq -r '.id // empty')
    local status_url=$(echo "$response" | jq -r '.statusUrl // empty')
    
    if [[ -z "$instance_id" ]]; then
        echo -e "${RED}Failed to start translation for $lang${NC}"
        echo "Response: $response"
        return 1
    fi
    
    echo "  Instance ID: $instance_id"
    echo -n "  Waiting for completion"
    
    # Poll for completion (max 2 minutes)
    for i in {1..24}; do
        sleep 5
        echo -n "."
        
        local status=$(curl -s "$status_url" | jq -r '.runtimeStatus // "Unknown"')
        
        if [[ "$status" == "Completed" ]]; then
            echo
            echo -e "${GREEN}  ✓ Completed${NC}"
            return 0
        elif [[ "$status" == "Failed" ]]; then
            echo
            echo -e "${RED}  ✗ Failed${NC}"
            return 1
        fi
    done
    
    echo
    echo -e "${RED}  ✗ Timeout${NC}"
    return 1
}

# Get missing keys JSON
echo "Extracting missing keys from source..."
MISSING_KEYS_JSON=$(create_missing_keys_json)
echo -e "${GREEN}✓ Extracted keys${NC}"
echo

# Languages missing various keys
LANGS_HEADER_AI="pt ar ru tr id vi he en-gb en-ca en-au en-nz en-ie zh-cht"
LANGS_CHECKOUT="fr pt ar ru id vi en-gb en-ca en-au en-nz en-ie zh-cht"
LANGS_REVIEWFORM="es fr zh ru vi zh-cht"

# Combine all languages that need updates (deduplicated)
ALL_LANGS=$(echo "$LANGS_HEADER_AI $LANGS_CHECKOUT $LANGS_REVIEWFORM" | tr ' ' '\n' | sort -u | tr '\n' ' ')

echo "Languages to update: $ALL_LANGS"
echo

# Translate for each language
for lang in $ALL_LANGS; do
    translate_language "$lang" "$MISSING_KEYS_JSON"
    echo
done

echo -e "${GREEN}=== Translation batch submitted ===${NC}"
echo
echo "Translated files are saved to blob storage in the 'locales' container:"
echo "  Format: {languageCode}/missing_keys.json"
echo
echo "To merge them into your local files, download from blob storage and run:"
echo "  jq -s '.[0] * .[1]' app/src/locales/{lang}/common.json {lang}/missing_keys.json > temp.json"
echo "  mv temp.json app/src/locales/{lang}/common.json"
