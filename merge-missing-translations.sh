#!/bin/bash

# Download and merge translated missing keys from blob storage

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# Configuration
STORAGE_ACCOUNT="avstoragewje2yrjsuipbs"
CONTAINER="locales"
LOCALES_DIR="app/src/locales"
TEMP_DIR="/tmp/translations"

# Languages to process
LANGUAGES="ar en-au en-ca en-gb en-ie en-nz es fr he id pt ru tr vi zh zh-cht"

echo -e "${BLUE}=== Merge Missing Translations ===${NC}"
echo "Storage Account: $STORAGE_ACCOUNT"
echo "Container: $CONTAINER"
echo

# Create temp directory
mkdir -p "$TEMP_DIR"

# Download translations from blob storage
echo -e "${BLUE}📦 Downloading translations from blob storage...${NC}"
for lang in $LANGUAGES; do
    echo -n "  $lang... "
    
    blob_name="${lang}/missing_keys.json"
    local_file="$TEMP_DIR/${lang}_missing_keys.json"
    
    if az storage blob download \
        --account-name "$STORAGE_ACCOUNT" \
        --container-name "$CONTAINER" \
        --name "$blob_name" \
        --file "$local_file" \
        --auth-mode login \
        --only-show-errors 2>/dev/null; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${YELLOW}not found${NC}"
    fi
done

echo

# Merge translations
echo -e "${BLUE}🔀 Merging translations into local files...${NC}"
for lang in $LANGUAGES; do
    local_file="$TEMP_DIR/${lang}_missing_keys.json"
    target_file="$LOCALES_DIR/$lang/common.json"
    
    if [ ! -f "$local_file" ]; then
        continue
    fi
    
    echo -e "${YELLOW}  Processing $lang...${NC}"
    
    if [ ! -f "$target_file" ]; then
        echo -e "${RED}    ✗ Target file not found: $target_file${NC}"
        continue
    fi
    
    # Use jq to merge the translations
    jq -s '
        .[0] as $existing |
        .[1] as $new |
        $existing |
        # Merge header.aiSearchPlaceholder if it exists in new and not in existing
        if ($new.header.aiSearchPlaceholder and ($existing.header.aiSearchPlaceholder | not)) then
            .header.aiSearchPlaceholder = $new.header.aiSearchPlaceholder
        else . end |
        # Merge checkout.removeDiscountCode
        if ($new.checkout.removeDiscountCode and ($existing.checkout.removeDiscountCode | not)) then
            .checkout.removeDiscountCode = $new.checkout.removeDiscountCode
        else . end |
        # Merge reviewForm keys
        if $new.reviewForm then
            .reviewForm.alreadyReviewed = (if ($existing.reviewForm.alreadyReviewed | not) then $new.reviewForm.alreadyReviewed else $existing.reviewForm.alreadyReviewed end) |
            .reviewForm.error = (if ($existing.reviewForm.error | not) then $new.reviewForm.error else $existing.reviewForm.error end) |
            .reviewForm.failedToSubmit = (if ($existing.reviewForm.failedToSubmit | not) then $new.reviewForm.failedToSubmit else $existing.reviewForm.failedToSubmit end) |
            .reviewForm.thankYouForFeedback = (if ($existing.reviewForm.thankYouForFeedback | not) then $new.reviewForm.thankYouForFeedback else $existing.reviewForm.thankYouForFeedback end) |
            .reviewForm.thankYouForReview = (if ($existing.reviewForm.thankYouForReview | not) then $new.reviewForm.thankYouForReview else $existing.reviewForm.thankYouForReview end)
        else . end
    ' "$target_file" "$local_file" > "${target_file}.tmp"
    
    # Replace the original file
    mv "${target_file}.tmp" "$target_file"
    echo -e "${GREEN}    ✓ Merged successfully${NC}"
done

echo
echo -e "${GREEN}=== Done! ===${NC}"
echo
echo "Verify the changes with:"
echo "  git diff app/src/locales/*/common.json"
echo
echo "Cleanup temp files:"
echo "  rm -rf $TEMP_DIR"
