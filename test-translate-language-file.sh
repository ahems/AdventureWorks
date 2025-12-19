#!/bin/bash

# Test script for the TranslateLanguageFile Azure Function
# Usage: ./test-translate-language-file.sh [language-code]
# Example: ./test-translate-language-file.sh es

# Default values
LANGUAGE_CODE="${1:-es}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_FILE="$SCRIPT_DIR/app/src/locales/en/common.json"

# Check if source file exists
if [ ! -f "$SOURCE_FILE" ]; then
  echo "Error: Source file not found: $SOURCE_FILE"
  exit 1
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
  echo "Error: jq is required but not installed. Install with: sudo apt-get install jq"
  exit 1
fi

# Check if azd is installed
if ! command -v azd &> /dev/null; then
  echo "Error: azd (Azure Developer CLI) is required but not installed."
  exit 1
fi

# Get the Azure Function URL from azd environment
echo "Retrieving Azure Function URL from azd environment..."
FUNCTION_APP_URL=$(azd env get-values | grep "^VITE_API_FUNCTIONS_URL=" | cut -d'=' -f2 | tr -d '"' | tr -d '\r')

if [ -z "$FUNCTION_APP_URL" ]; then
  echo "Error: Could not find VITE_API_FUNCTIONS_URL in azd environment."
  echo "Make sure you have deployed the function app with 'azd deploy api-functions'"
  exit 1
fi

FUNCTION_URL="${FUNCTION_APP_URL}/api/TranslateLanguageFile"

# Create the test payload using the full common.json file
TEST_PAYLOAD=$(jq -n \
  --arg lang "$LANGUAGE_CODE" \
  --slurpfile data "$SOURCE_FILE" \
  '{targetLanguage: $lang, languageData: $data[0]}')

echo "========================================="
echo "Testing Language File Translation"
echo "========================================="
echo "Target Language: $LANGUAGE_CODE"
echo "Source File: $SOURCE_FILE"
echo "Function URL: $FUNCTION_URL"
echo ""
echo "Sending request..."
echo ""

# Make the request and save the response
RESPONSE=$(curl -s -X POST "$FUNCTION_URL" \
  -H "Content-Type: application/json" \
  -d "$TEST_PAYLOAD")

# Check if the response is valid
if [ $? -eq 0 ]; then
  echo "Response received:"
  echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
  
  # Save to file if successful
  if echo "$RESPONSE" | jq -e '.' >/dev/null 2>&1; then
    OUTPUT_FILE="translated_${LANGUAGE_CODE}_common.json"
    echo "$RESPONSE" | jq '.' > "$OUTPUT_FILE"
    echo ""
    echo "✓ Translation saved to: $OUTPUT_FILE"
  fi
else
  echo "✗ Request failed"
  exit 1
fi

echo ""
echo "========================================="
echo "Supported Languages:"
echo "  es - Spanish"
echo "  fr - French"
echo "  de - German"
echo "  pt - Portuguese"
echo "  it - Italian"
echo "  nl - Dutch"
echo "  ru - Russian"
echo "  zh - Chinese (Mandarin)"
echo "  zh-cht - Chinese (Traditional)"
echo "  ja - Japanese"
echo "  ko - Korean"
echo "  ar - Arabic (Modern Standard Arabic)"
echo "  tr - Turkish"
echo "  vi - Vietnamese"
echo "  th - Thai"
echo "  id - Indonesian"
echo "  en-gb - English (United Kingdom)"
echo "  en-ca - English (Canada)"
echo "  en-au - English (Australia)"
echo "  en-nz - English (New Zealand)"
echo "  en-ie - English (Ireland)"
echo "========================================="
