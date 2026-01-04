#!/bin/bash

# Script to fill in missing translation keys using the Azure Function
# This script extracts missing keys and sends them to the translation function

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SOURCE_FILE="/workspaces/AdventureWorks/app/src/locales/en/common.json"
LOCALES_DIR="/workspaces/AdventureWorks/app/src/locales"

# Get the Azure Function URL from environment or use default
FUNCTION_URL="${TRANSLATION_FUNCTION_URL:-http://localhost:7071/api/TranslateLanguageFile}"

echo -e "${BLUE}=== Missing Translation Keys Filler ===${NC}"
echo "Source file: $SOURCE_FILE"
echo "Function URL: $FUNCTION_URL"
echo

# Define missing keys for each language
declare -A MISSING_KEYS

# Languages missing header.aiSearchPlaceholder
MISSING_KEYS["header.aiSearchPlaceholder"]="pt ar ru tr id vi he en-gb en-ca en-au en-nz en-ie zh-cht"

# Languages missing checkout.removeDiscountCode
MISSING_KEYS["checkout.removeDiscountCode"]="fr pt ar ru id vi en-gb en-ca en-au en-nz en-ie zh-cht"

# Languages missing reviewForm keys (5 keys, same languages)
MISSING_KEYS["reviewForm"]="es fr zh ru vi zh-cht"

# Function to extract specific keys from JSON
extract_keys() {
    local source_file=$1
    local keys=$2
    local output_file=$3
    
    # Create a jq filter to extract only the specified keys
    local filter="{"
    
    if [[ "$keys" == *"header.aiSearchPlaceholder"* ]]; then
        filter+='header: {aiSearchPlaceholder: .header.aiSearchPlaceholder},'
    fi
    
    if [[ "$keys" == *"checkout.removeDiscountCode"* ]]; then
        filter+='checkout: {removeDiscountCode: .checkout.removeDiscountCode},'
    fi
    
    if [[ "$keys" == *"reviewForm"* ]]; then
        filter+='reviewForm: {
            alreadyReviewed: .reviewForm.alreadyReviewed,
            error: .reviewForm.error,
            failedToSubmit: .reviewForm.failedToSubmit,
            thankYouForFeedback: .reviewForm.thankYouForFeedback,
            thankYouForReview: .reviewForm.thankYouForReview
        },'
    fi
    
    # Remove trailing comma and close
    filter="${filter%,}}"
    
    jq "$filter" "$source_file" > "$output_file"
}

# Function to merge translated keys back into existing file
merge_translations() {
    local target_file=$1
    local translated_file=$2
    
    # Use jq to merge, with translated_file taking precedence for new keys
    jq -s '
        .[0] as $existing |
        .[1] as $new |
        $existing |
        if $new.header.aiSearchPlaceholder then
            .header.aiSearchPlaceholder = $new.header.aiSearchPlaceholder
        else . end |
        if $new.checkout.removeDiscountCode then
            .checkout.removeDiscountCode = $new.checkout.removeDiscountCode
        else . end |
        if $new.reviewForm then
            .reviewForm.alreadyReviewed = $new.reviewForm.alreadyReviewed |
            .reviewForm.error = $new.reviewForm.error |
            .reviewForm.failedToSubmit = $new.reviewForm.failedToSubmit |
            .reviewForm.thankYouForFeedback = $new.reviewForm.thankYouForFeedback |
            .reviewForm.thankYouForReview = $new.reviewForm.thankYouForReview
        else . end
    ' "$target_file" "$translated_file" > "${target_file}.tmp"
    
    mv "${target_file}.tmp" "$target_file"
}

# Function to translate for a specific language
translate_for_language() {
    local lang=$1
    local missing_sections=$2
    
    echo -e "${YELLOW}Processing $lang...${NC}"
    
    # Determine which keys to extract
    local keys_to_extract=""
    if [[ "$missing_sections" == *"header"* ]]; then
        keys_to_extract+=" header.aiSearchPlaceholder"
    fi
    if [[ "$missing_sections" == *"checkout"* ]]; then
        keys_to_extract+=" checkout.removeDiscountCode"
    fi
    if [[ "$missing_sections" == *"reviewForm"* ]]; then
        keys_to_extract+=" reviewForm"
    fi
    
    # Extract missing keys from source
    local temp_source="/tmp/missing_keys_${lang}.json"
    extract_keys "$SOURCE_FILE" "$keys_to_extract" "$temp_source"
    
    echo "  Keys to translate: $keys_to_extract"
    echo "  Extracted keys to: $temp_source"
    
    # Create request payload
    local request_payload=$(jq -n \
        --argjson languageData "$(cat $temp_source)" \
        --arg targetLanguage "$lang" \
        --arg sourceFilename "common" \
        '{languageData: $languageData, targetLanguage: $targetLanguage, sourceFilename: $sourceFilename}')
    
    # Call the Azure Function
    echo "  Calling translation function..."
    local response=$(curl -s -X POST "$FUNCTION_URL" \
        -H "Content-Type: application/json" \
        -d "$request_payload")
    
    # Extract instance ID and status URL
    local instance_id=$(echo "$response" | jq -r '.id // empty')
    local status_url=$(echo "$response" | jq -r '.statusUrl // empty')
    
    if [[ -z "$instance_id" ]]; then
        echo -e "${RED}  ERROR: Failed to start translation${NC}"
        echo "  Response: $response"
        return 1
    fi
    
    echo -e "${GREEN}  Translation started: $instance_id${NC}"
    echo "  Status URL: $status_url"
    
    # Poll for completion
    local max_attempts=60
    local attempt=0
    local status="Running"
    
    while [[ "$status" != "Completed" && $attempt -lt $max_attempts ]]; do
        sleep 5
        attempt=$((attempt + 1))
        
        local status_response=$(curl -s "$status_url")
        status=$(echo "$status_response" | jq -r '.runtimeStatus // "Unknown"')
        
        echo -n "."
        
        if [[ "$status" == "Completed" ]]; then
            echo
            echo -e "${GREEN}  Translation completed!${NC}"
            
            # Get the output (blob path)
            local blob_path=$(echo "$status_response" | jq -r '.output // empty' | tr -d '"')
            
            if [[ -n "$blob_path" ]]; then
                echo "  Result saved to blob: $blob_path"
                # Note: In production, you'd download from blob storage
                # For now, we'll use a local translated file if available
                echo -e "${YELLOW}  Note: Check blob storage for translated file: $blob_path${NC}"
            fi
            
            return 0
        elif [[ "$status" == "Failed" ]]; then
            echo
            echo -e "${RED}  Translation failed${NC}"
            local error=$(echo "$status_response" | jq -r '.error // "Unknown error"')
            echo "  Error: $error"
            return 1
        fi
    done
    
    echo
    echo -e "${RED}  Timeout waiting for translation${NC}"
    return 1
}

# Main execution
echo -e "${BLUE}=== Starting Translation Process ===${NC}"
echo

# Process languages missing header.aiSearchPlaceholder
echo -e "${BLUE}1. Processing languages missing 'header.aiSearchPlaceholder'${NC}"
for lang in pt ar ru tr id vi he en-gb en-ca en-au en-nz en-ie zh-cht; do
    translate_for_language "$lang" "header"
    echo
done

# Process languages missing checkout.removeDiscountCode
echo -e "${BLUE}2. Processing languages missing 'checkout.removeDiscountCode'${NC}"
for lang in fr pt ar ru id vi en-gb en-ca en-au en-nz en-ie zh-cht; do
    translate_for_language "$lang" "checkout"
    echo
done

# Process languages missing reviewForm section
echo -e "${BLUE}3. Processing languages missing 'reviewForm' keys${NC}"
for lang in es fr zh ru vi zh-cht; do
    translate_for_language "$lang" "reviewForm"
    echo
done

echo -e "${GREEN}=== Translation process completed ===${NC}"
echo
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Download the translated files from blob storage (locales container)"
echo "2. Merge them into your local files using the merge script below"
echo
echo "Or, if you have the translated files locally, you can merge them with:"
echo "  jq -s '.[0] * .[1]' existing.json translated.json > merged.json"
