#!/bin/bash

# Batch Language File Translation Script
# Translates all English language files to all supported languages using the Azure Function
#
# Usage: ./batch-translate-language-file.sh [--missing-only]
#   --missing-only: Only translate files that don't exist yet (skip existing translations)
# This script automatically uses the deployed Azure Function URL from azd

set -e  # Exit on error

# Parse command line arguments
MISSING_ONLY=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --missing-only)
      MISSING_ONLY=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./batch-translate-language-file.sh [--missing-only]"
      exit 1
      ;;
  esac
done

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

# Get all JSON files in the source directory, sorted by size (largest first)
# This processes common.json first since it's the largest file
SOURCE_FILES=($(find "$SOURCE_DIR" -name "*.json" -type f -exec du -b {} + | sort -rn | cut -f2))

if [ ${#SOURCE_FILES[@]} -eq 0 ]; then
  echo "Error: No JSON files found in $SOURCE_DIR"
  exit 1
fi

echo "========================================="
echo "Batch Language File Translation"
echo "========================================="
echo "Mode: $([ "$MISSING_ONLY" = true ] && echo "Missing files only" || echo "All files (overwrite)")"
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

# Count how many translations are needed (skip existing files if --missing-only)
NEEDED_TRANSLATIONS=0
SKIPPED_TRANSLATIONS=0
for SOURCE_FILE in "${SOURCE_FILES[@]}"; do
  FILE_NAME=$(basename "$SOURCE_FILE")
  for lang_info in "${LANGUAGES[@]}"; do
    IFS=':' read -r lang_code lang_name <<< "$lang_info"
    OUTPUT_FILE="$LOCALES_DIR/$lang_code/$FILE_NAME"
    if [ ! -f "$OUTPUT_FILE" ]; then
      NEEDED_TRANSLATIONS=$((NEEDED_TRANSLATIONS + 1))
    elif [ "$MISSING_ONLY" = true ]; then
      SKIPPED_TRANSLATIONS=$((SKIPPED_TRANSLATIONS + 1))
    fi
  done
done

echo ""
if [ "$MISSING_ONLY" = true ]; then
  echo "Translations to create: $NEEDED_TRANSLATIONS"
  echo "Existing translations to skip: $SKIPPED_TRANSLATIONS"
  echo ""
  echo "Note: Only missing translation files will be created."
else
  echo "Total translations to create: $((${#SOURCE_FILES[@]} * ${#LANGUAGES[@]}))"
  echo ""
  echo "Note: This will overwrite any existing translation files."
fi
echo ""

read -p "Continue? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

# Track statistics with temp files for parallel processing
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

SUCCESS_FILE="$TEMP_DIR/success_count"
FAILED_FILE="$TEMP_DIR/failed_count"
FAILED_ITEMS_FILE="$TEMP_DIR/failed_items"

echo "0" > "$SUCCESS_FILE"
echo "0" > "$FAILED_FILE"
touch "$FAILED_ITEMS_FILE"

echo ""
echo "Starting translations (parallel processing)..."
echo "========================================="

# Retry configuration
MAX_RETRIES=3
BASE_DELAY=2

# Parallel processing configuration
MAX_CONCURRENT_JOBS=15  # Increased for faster processing with blob existence checks

# Function to handle a single translation job
translate_job() {
  local SOURCE_FILE=$1
  local lang_code=$2
  local lang_name=$3
  local FILE_NAME=$(basename "$SOURCE_FILE")
  local FILE_NAME_WITHOUT_EXT="${FILE_NAME%.json}"
  
  echo "[$FILE_NAME → $lang_name] Starting translation..."
  
  # Create request payload with sourceFilename
  REQUEST_PAYLOAD=$(jq -n \
    --arg lang "$lang_code" \
    --arg filename "$FILE_NAME_WITHOUT_EXT" \
    --slurpfile data "$SOURCE_FILE" \
    '{targetLanguage: $lang, sourceFilename: $filename, languageData: $data[0]}')
  
  # Retry loop for handling 504 errors
  RETRY_COUNT=0
  SUCCESS_FLAG=false
  
  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    # Make the API request to start orchestration
    TEMP_FILE="$TEMP_DIR/translation_${lang_code}_${FILE_NAME}_$$"
    HTTP_STATUS=$(curl -s -w "%{http_code}" -o "$TEMP_FILE" \
      -X POST "$FUNCTION_URL" \
      -H "Content-Type: application/json" \
      -d "$REQUEST_PAYLOAD")
    
    if [ "$HTTP_STATUS" -eq 202 ]; then
      # Orchestration started - get status URL
      STATUS_URL=$(jq -r '.statusUrl' "$TEMP_FILE" 2>/dev/null)
      
      if [ -z "$STATUS_URL" ] || [ "$STATUS_URL" = "null" ]; then
        echo "[$FILE_NAME → $lang_name] ✗ Failed: No status URL returned"
        echo "$FILE_NAME → $lang_code: No status URL" >> "$FAILED_ITEMS_FILE"
        echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
        rm -f "$TEMP_FILE"
        return 1
      fi
      
      # Poll for completion
      echo "[$FILE_NAME → $lang_name] ⏳ Orchestration started, polling..."
      MAX_POLL_ATTEMPTS=60  # 5 minutes max
      POLL_ATTEMPT=0
      
      while [ $POLL_ATTEMPT -lt $MAX_POLL_ATTEMPTS ]; do
        sleep 5
        POLL_ATTEMPT=$((POLL_ATTEMPT + 1))
        
        STATUS_RESPONSE=$(curl -s "$STATUS_URL")
        RUNTIME_STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.runtimeStatus' 2>/dev/null)
        
        if [ "$RUNTIME_STATUS" = "Completed" ]; then
          # Get the blob path from output
          BLOB_PATH=$(echo "$STATUS_RESPONSE" | jq -r '.output' 2>/dev/null | tr -d '"')
          
          if [ -z "$BLOB_PATH" ] || [ "$BLOB_PATH" = "null" ]; then
            echo "[$FILE_NAME → $lang_name] ✗ Failed: No blob path in output"
            echo "$FILE_NAME → $lang_code: No blob path" >> "$FAILED_ITEMS_FILE"
            echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
            rm -f "$TEMP_FILE"
            return 1
          fi
          
          echo "[$FILE_NAME → $lang_name] ✓ Success (saved to: $BLOB_PATH, ${POLL_ATTEMPT} polls)"
          echo $(($(cat "$SUCCESS_FILE") + 1)) > "$SUCCESS_FILE"
          rm -f "$TEMP_FILE"
          return 0
        elif [ "$RUNTIME_STATUS" = "Failed" ]; then
          ERROR_MSG=$(echo "$STATUS_RESPONSE" | jq -r '.output // "Orchestration failed"' 2>/dev/null)
          echo "[$FILE_NAME → $lang_name] ✗ Failed: $ERROR_MSG"
          echo "$FILE_NAME → $lang_code: $ERROR_MSG" >> "$FAILED_ITEMS_FILE"
          echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
          rm -f "$TEMP_FILE"
          return 1
        elif [ "$RUNTIME_STATUS" = "Running" ] || [ "$RUNTIME_STATUS" = "Pending" ]; then
          # Still running, continue polling (silent to reduce output)
          :
        else
          echo "[$FILE_NAME → $lang_name] ⚠ Unknown status: $RUNTIME_STATUS"
        fi
      done
      
      if [ $POLL_ATTEMPT -ge $MAX_POLL_ATTEMPTS ]; then
        echo "[$FILE_NAME → $lang_name] ✗ Failed: Timeout after $((MAX_POLL_ATTEMPTS * 5))s"
        echo "$FILE_NAME → $lang_code: Timeout" >> "$FAILED_ITEMS_FILE"
        echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
        rm -f "$TEMP_FILE"
        return 1
      fi
    elif [ "$HTTP_STATUS" -eq 504 ]; then
      # Gateway timeout - retry with exponential backoff
      RETRY_COUNT=$((RETRY_COUNT + 1))
      if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
        DELAY=$((BASE_DELAY * (2 ** (RETRY_COUNT - 1))))
        echo "[$FILE_NAME → $lang_name] ⚠ Timeout (504) - Retry $RETRY_COUNT/$MAX_RETRIES after ${DELAY}s"
        sleep $DELAY
      else
        echo "[$FILE_NAME → $lang_name] ✗ Failed: Timeout after $MAX_RETRIES retries"
        echo "$FILE_NAME → $lang_code: Timeout after retries" >> "$FAILED_ITEMS_FILE"
        echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
        rm -f "$TEMP_FILE"
        return 1
      fi
    else
      # Other error
      ERROR_MSG=$(jq -r '.error // "Unknown error"' "$TEMP_FILE" 2>/dev/null || echo "HTTP $HTTP_STATUS")
      echo "[$FILE_NAME → $lang_name] ✗ Failed: $ERROR_MSG"
      echo "$FILE_NAME → $lang_code: $ERROR_MSG" >> "$FAILED_ITEMS_FILE"
      echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
      rm -f "$TEMP_FILE"
      return 1
    fi
  done
  
  rm -f "$TEMP_FILE"
  return 1
}

# Export function and variables for use in subshells
export -f translate_job
export FUNCTION_URL LOCALES_DIR TEMP_DIR SUCCESS_FILE FAILED_FILE FAILED_ITEMS_FILE
export MAX_RETRIES BASE_DELAY

# Process each source file
for SOURCE_FILE in "${SOURCE_FILES[@]}"; do
  FILE_NAME=$(basename "$SOURCE_FILE")
  
  echo ""
  echo "Processing: $FILE_NAME"
  echo "----------------------------------------"
  
  # Translate to each language in parallel
  ACTIVE_JOBS=0
  
  for lang_info in "${LANGUAGES[@]}"; do
    IFS=':' read -r lang_code lang_name <<< "$lang_info"
    
    # Check if output file already exists and skip if --missing-only is set
    OUTPUT_FILE="$LOCALES_DIR/$lang_code/$FILE_NAME"
    if [ "$MISSING_ONLY" = true ] && [ -f "$OUTPUT_FILE" ]; then
      echo "[$FILE_NAME → $lang_name] ⊘ Skipping (file exists)"
      continue
    fi
    
    # Wait if we've reached max concurrent jobs
    while [ $ACTIVE_JOBS -ge $MAX_CONCURRENT_JOBS ]; do
      # Wait for any job to complete
      wait -n 2>/dev/null || true
      ACTIVE_JOBS=$((ACTIVE_JOBS - 1))
    done
    
    # Start translation job in background
    translate_job "$SOURCE_FILE" "$lang_code" "$lang_name" &
    ACTIVE_JOBS=$((ACTIVE_JOBS + 1))
    
    # Small delay to stagger job starts and avoid simultaneous blob creation
    sleep 0.5
  done
  
  # Wait for all jobs for this file to complete
  echo ""
  echo "Waiting for all $FILE_NAME translations to complete..."
  wait
done

# Read final statistics from files
SUCCESS=$(cat "$SUCCESS_FILE")
FAILED=$(cat "$FAILED_FILE")

echo ""
echo "========================================="
echo "Translation Complete"
echo "========================================="
echo "Total Processed: $((SUCCESS + FAILED))"
echo "Successful: $SUCCESS"
echo "Failed: $FAILED"

if [ $FAILED -gt 0 ]; then
  echo ""
  echo "Failed Translations:"
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      echo "  - $line"
    fi
  done < "$FAILED_ITEMS_FILE"
fi

echo ""
echo "Translations are saved in Azure Blob Storage:"
echo "  Storage Account: avstoragewje2yrjsuipbs"
echo "  Container: locales"
echo "  Structure: {language-code}/{filename}.json"
echo ""
echo "To download all translated files:"
echo "  az storage blob download-batch \\"
echo "    --account-name avstoragewje2yrjsuipbs \\"
echo "    --source locales \\"
echo "    --destination $LOCALES_DIR \\"
echo "    --auth-mode login \\"
echo "    --overwrite"
echo "========================================="

# Exit with error if any translations failed
if [ $FAILED -gt 0 ]; then
  exit 1
fi

exit 0
