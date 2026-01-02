#!/bin/bash

# Batch Language File Translation Script
# Translates all English language files to all supported languages using the Azure Function
#
# Usage: ./batch-translate-language-file.sh
# This script automatically uses the deployed Azure Function URL from azd

set -e  # Exit on error

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCALES_DIR="$SCRIPT_DIR/app/src/locales"
SOURCE_DIR="$LOCALES_DIR/en"

# All supported languages (excluding source English)
LANGUAGES=(
  "es:Spanish"
  "fr:French"
  "de:German"
  "pt:Portuguese"
  "it:Italian"
  "nl:Dutch"
  "ru:Russian"
  "zh:Chinese (Simplified)"
  "zh-cht:Chinese (Traditional)"
  "ja:Japanese"
  "ko:Korean"
  "ar:Arabic"
  "he:Hebrew"
  "tr:Turkish"
  "vi:Vietnamese"
  "th:Thai"
  "id:Indonesian"
  "en-gb:English (UK)"
  "en-ca:English (Canada)"
  "en-au:English (Australia)"
  "en-nz:English (New Zealand)"
  "en-ie:English (Ireland)"
)

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

FUNCTION_URL="${FUNCTION_APP_URL}/api/TranslateLanguageFile_HttpStart"

echo "Function URL: $FUNCTION_URL"
echo ""

# Check if source directory exists
if [ ! -d "$SOURCE_DIR" ]; then
  echo "Error: Source directory not found: $SOURCE_DIR"
  exit 1
fi

# Get all JSON files in the source directory
SOURCE_FILES=($(find "$SOURCE_DIR" -name "*.json" -type f))

if [ ${#SOURCE_FILES[@]} -eq 0 ]; then
  echo "Error: No JSON files found in $SOURCE_DIR"
  exit 1
fi

echo "========================================="
echo "Batch Language File Translation"
echo "========================================="
echo "Source Directory: $SOURCE_DIR"
echo "Output Directory: $LOCALES_DIR"
echo "Function URL: $FUNCTION_URL"
echo ""
echo "Found ${#SOURCE_FILES[@]} source file(s):"
for file in "${SOURCE_FILES[@]}"; do
  echo "  - $(basename "$file")"
done
echo ""
echo "Will translate to ${#LANGUAGES[@]} languages."
# Count how many translations are needed (skip existing files)
NEEDED_TRANSLATIONS=0
for SOURCE_FILE in "${SOURCE_FILES[@]}"; do
  FILE_NAME=$(basename "$SOURCE_FILE")
  for lang_info in "${LANGUAGES[@]}"; do
    IFS=':' read -r lang_code lang_name <<< "$lang_info"
    OUTPUT_FILE="$LOCALES_DIR/$lang_code/$FILE_NAME"
    if [ ! -f "$OUTPUT_FILE" ]; then
      NEEDED_TRANSLATIONS=$((NEEDED_TRANSLATIONS + 1))
    fi
  done
done

echo ""
echo "Needed translations: $NEEDED_TRANSLATIONS (skipping existing files)"
echo ""

if [ $NEEDED_TRANSLATIONS -eq 0 ]; then
  echo "All files already translated. Nothing to do!"
  exit 0
fi

read -p "Continue? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

# Track statistics
SUCCESS=0
FAILED=0
SKIPPED=0
declare -a FAILED_ITEMS

echo ""
echo "Starting translations..."
echo "========================================="

# Retry configuration
MAX_RETRIES=3
BASE_DELAY=2

# Process each source file
for SOURCE_FILE in "${SOURCE_FILES[@]}"; do
  FILE_NAME=$(basename "$SOURCE_FILE")
  
  echo ""
  echo "Processing: $FILE_NAME"
  echo "----------------------------------------"
  
  # Translate to each language
  for lang_info in "${LANGUAGES[@]}"; do
    IFS=':' read -r lang_code lang_name <<< "$lang_info"
    
    # Create output directory if it doesn't exist
    OUTPUT_DIR="$LOCALES_DIR/$lang_code"
    mkdir -p "$OUTPUT_DIR"
    OUTPUT_FILE="$OUTPUT_DIR/$FILE_NAME"
    
    # Skip if file already exists
    if [ -f "$OUTPUT_FILE" ]; then
      echo "  ⊘ Skipped: $lang_name ($lang_code) - file already exists"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
    
    PROGRESS=$((SUCCESS + FAILED + SKIPPED + 1))
    TOTAL=$((${#SOURCE_FILES[@]} * ${#LANGUAGES[@]}))
    echo "[$PROGRESS/$TOTAL] Translating $FILE_NAME to $lang_name ($lang_code)..."
    
    # Create request payload
    REQUEST_PAYLOAD=$(jq -n \
      --arg lang "$lang_code" \
      --slurpfile data "$SOURCE_FILE" \
      '{targetLanguage: $lang, languageData: $data[0]}')
    
    # Retry loop for handling 504 errors
    RETRY_COUNT=0
    SUCCESS_FLAG=false
    
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
      # Make the API request to start orchestration
      TEMP_FILE="/tmp/translation_${lang_code}_${FILE_NAME}"
      HTTP_STATUS=$(curl -s -w "%{http_code}" -o "$TEMP_FILE" \
        -X POST "$FUNCTION_URL" \
        -H "Content-Type: application/json" \
        -d "$REQUEST_PAYLOAD")
      
      if [ "$HTTP_STATUS" -eq 202 ]; then
        # Orchestration started - get status URL
        STATUS_URL=$(jq -r '.statusUrl' "$TEMP_FILE" 2>/dev/null)
        
        if [ -z "$STATUS_URL" ] || [ "$STATUS_URL" = "null" ]; then
          echo "  ✗ Failed: No status URL returned"
          FAILED=$((FAILED + 1))
          FAILED_ITEMS+=("$FILE_NAME → $lang_code: No status URL")
          SUCCESS_FLAG=false
          break
        fi
        
        # Poll for completion
        echo "  ⏳ Orchestration started, waiting for completion..."
        MAX_POLL_ATTEMPTS=60  # 5 minutes max (5 seconds per attempt)
        POLL_ATTEMPT=0
        
        while [ $POLL_ATTEMPT -lt $MAX_POLL_ATTEMPTS ]; do
          sleep 5
          POLL_ATTEMPT=$((POLL_ATTEMPT + 1))
          
          STATUS_RESPONSE=$(curl -s "$STATUS_URL")
          RUNTIME_STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.runtimeStatus' 2>/dev/null)
          
          if [ "$RUNTIME_STATUS" = "Completed" ]; then
            # Get the output
            TRANSLATED_JSON=$(echo "$STATUS_RESPONSE" | jq -r '.output' 2>/dev/null)
            
            if [ -z "$TRANSLATED_JSON" ] || [ "$TRANSLATED_JSON" = "null" ]; then
              echo "  ✗ Failed: Empty output from orchestration"
              FAILED=$((FAILED + 1))
              FAILED_ITEMS+=("$FILE_NAME → $lang_code: Empty output")
              SUCCESS_FLAG=false
              break 2
            fi
            
            # Parse and save the translated JSON
            echo "$TRANSLATED_JSON" | jq '.' > "$OUTPUT_FILE" 2>/dev/null
            
            if [ $? -eq 0 ]; then
              FILE_SIZE=$(wc -c < "$OUTPUT_FILE")
              echo "  ✓ Success: $OUTPUT_FILE (${FILE_SIZE} bytes, ${POLL_ATTEMPT} polls)"
              SUCCESS=$((SUCCESS + 1))
              SUCCESS_FLAG=true
              break 2
            else
              echo "  ✗ Failed: Invalid JSON in output"
              FAILED=$((FAILED + 1))
              FAILED_ITEMS+=("$FILE_NAME → $lang_code: Invalid JSON output")
              SUCCESS_FLAG=false
              break 2
            fi
          elif [ "$RUNTIME_STATUS" = "Failed" ]; then
            ERROR_MSG=$(echo "$STATUS_RESPONSE" | jq -r '.output // "Orchestration failed"' 2>/dev/null)
            echo "  ✗ Failed: $ERROR_MSG"
            FAILED=$((FAILED + 1))
            FAILED_ITEMS+=("$FILE_NAME → $lang_code: $ERROR_MSG")
            SUCCESS_FLAG=false
            break 2
          elif [ "$RUNTIME_STATUS" = "Running" ] || [ "$RUNTIME_STATUS" = "Pending" ]; then
            # Still running, continue polling
            echo "  ⏳ Still processing... (attempt $POLL_ATTEMPT/$MAX_POLL_ATTEMPTS)"
          else
            echo "  ⚠ Unknown status: $RUNTIME_STATUS"
          fi
        done
        
        if [ $POLL_ATTEMPT -ge $MAX_POLL_ATTEMPTS ]; then
          echo "  ✗ Failed: Orchestration timeout after $((MAX_POLL_ATTEMPTS * 5)) seconds"
          FAILED=$((FAILED + 1))
          FAILED_ITEMS+=("$FILE_NAME → $lang_code: Orchestration timeout")
          SUCCESS_FLAG=false
          break
        fi
      elif [ "$HTTP_STATUS" -eq 504 ]; then
        # Gateway timeout - retry with exponential backoff
        RETRY_COUNT=$((RETRY_COUNT + 1))
        if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
          DELAY=$((BASE_DELAY * (2 ** (RETRY_COUNT - 1))))
          echo "  ⚠ Timeout (504) - Retry $RETRY_COUNT/$MAX_RETRIES after ${DELAY}s..."
          sleep $DELAY
        else
          echo "  ✗ Failed: Timeout after $MAX_RETRIES retries"
          FAILED=$((FAILED + 1))
          FAILED_ITEMS+=("$FILE_NAME → $lang_code: Timeout after retries")
          SUCCESS_FLAG=false
        fi
      else
        # Other error
        ERROR_MSG=$(jq -r '.error // "Unknown error"' "$TEMP_FILE" 2>/dev/null || echo "HTTP $HTTP_STATUS")
        echo "  ✗ Failed: $ERROR_MSG"
        FAILED=$((FAILED + 1))
        FAILED_ITEMS+=("$FILE_NAME → $lang_code: $ERROR_MSG")
        SUCCESS_FLAG=false
        break
      fi
    done
    
    # Clean up temp file
    rm -f "$TEMP_FILE"
    
    # Delay between requests to avoid rate limiting
    if [ "$SUCCESS_FLAG" = true ]; then
      sleep 1
    else
      # Longer delay after errors
      sleep 2
    fi
  done
done

echo ""
echo "========================================="
echo "Translation Complete"
echo "========================================="
echo "Total Processed: $((SUCCESS + FAILED + SKIPPED))"
echo "Successful: $SUCCESS"
echo "Skipped (already exist): $SKIPPED"
echo "Failed: $FAILED"

if [ $FAILED -gt 0 ]; then
  echo ""
  echo "Failed Translations:"
  for failed in "${FAILED_ITEMS[@]}"; do
    echo "  - $failed"
  done
fi

echo ""
echo "Translated files are in: $LOCALES_DIR/{language-code}/"
echo "========================================="

# Exit with error if any translations failed
if [ $FAILED -gt 0 ]; then
  exit 1
fi

exit 0
