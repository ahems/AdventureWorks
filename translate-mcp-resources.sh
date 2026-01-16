#!/bin/bash

# MCP Resource File Translation Script
# Translates Strings.resx to all supported cultures using the Azure Function
#
# Usage: ./translate-mcp-resources.sh
# This script uses the deployed Azure Function URL from azd

set -e  # Exit on error

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/api-mcp/AdventureWorks/Resources"
SOURCE_FILE="$RESOURCES_DIR/Strings.resx"

# Supported cultures from MCP project (excluding base English)
CULTURES=(
  "ar:Arabic"
  "es:Spanish"
  "fr:French"
  "de:German"
  "he:Hebrew"
  "th:Thai"
  "zh-cht:Chinese (Traditional)"
  "en-gb:English (UK)"
  "en-ca:English (Canada)"
  "en-au:English (Australia)"
  "ja:Japanese"
  "ko:Korean"
)

# Check if jq is installed
if ! command -v jq &> /dev/null; then
  echo "Error: jq is required but not installed. Install with: sudo apt-get install jq"
  exit 1
fi

# Check if xmlstarlet is installed
if ! command -v xmlstarlet &> /dev/null; then
  echo "Error: xmlstarlet is required but not installed. Install with: sudo apt-get install xmlstarlet"
  exit 1
fi

# Check if azd is installed
if ! command -v azd &> /dev/null; then
  echo "Error: azd (Azure Developer CLI) is required but not installed."
  exit 1
fi

# Check if az CLI is installed and authenticated
if ! command -v az &> /dev/null; then
  echo "Error: az (Azure CLI) is required but not installed."
  exit 1
fi

# Test Azure CLI authentication
echo "Checking Azure CLI authentication..."
if ! az account show &> /dev/null; then
  echo "Error: Azure CLI is not authenticated. Please run: az login"
  exit 1
fi
echo "✓ Azure CLI authenticated"
echo ""

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

# Check if source file exists
if [ ! -f "$SOURCE_FILE" ]; then
  echo "Error: Source file not found: $SOURCE_FILE"
  exit 1
fi

echo "========================================="
echo "MCP Resource File Translation"
echo "========================================="
echo "Source File: $SOURCE_FILE"
echo "Output Directory: $RESOURCES_DIR"
echo "Function URL: $FUNCTION_URL"
echo ""
echo "Will translate to ${#CULTURES[@]} cultures."
echo ""

read -p "Continue? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

# Function to parse .resx to JSON
parse_resx_to_json() {
  local resx_file=$1
  local json_file=$2
  
  # Extract all data elements and convert to JSON
  # Use xmlstarlet to extract name and value, then build JSON with jq
  {
    echo "{"
    xmlstarlet sel -t -m "//data" \
      -v "@name" -o "|" -v "value" -n "$resx_file" | \
    while IFS='|' read -r name value; do
      # Escape the value for JSON
      escaped_value=$(echo "$value" | jq -Rs .)
      echo "\"$name\": $escaped_value,"
    done | sed '$s/,$//'
    echo "}"
  } > "$json_file"
  
  # Validate and format JSON
  if ! jq '.' "$json_file" > "${json_file}.tmp" 2>/dev/null; then
    echo "Error: Failed to parse .resx to valid JSON"
    return 1
  fi
  mv "${json_file}.tmp" "$json_file"
}

# Function to convert JSON to .resx
json_to_resx() {
  local json_file=$1
  local output_file=$2
  local culture=$3
  
  cat > "$output_file" << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<root>
  <xsd:schema id="root" xmlns="" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:msdata="urn:schemas-microsoft-com:xml-msdata">
    <xsd:import namespace="http://www.w3.org/XML/1998/namespace" />
    <xsd:element name="root" msdata:IsDataSet="true">
      <xsd:complexType>
        <xsd:choice maxOccurs="unbounded">
          <xsd:element name="metadata">
            <xsd:complexType>
              <xsd:sequence>
                <xsd:element name="value" type="xsd:string" minOccurs="0" />
              </xsd:sequence>
              <xsd:attribute name="name" use="required" type="xsd:string" />
              <xsd:attribute name="type" type="xsd:string" />
              <xsd:attribute name="mimetype" type="xsd:string" />
              <xsd:attribute ref="xml:space" />
            </xsd:complexType>
          </xsd:element>
          <xsd:element name="assembly">
            <xsd:complexType>
              <xsd:attribute name="alias" type="xsd:string" />
              <xsd:attribute name="name" type="xsd:string" />
            </xsd:complexType>
          </xsd:element>
          <xsd:element name="data">
            <xsd:complexType>
              <xsd:sequence>
                <xsd:element name="value" type="xsd:string" minOccurs="0" msdata:Ordinal="1" />
                <xsd:element name="comment" type="xsd:string" minOccurs="0" msdata:Ordinal="2" />
              </xsd:sequence>
              <xsd:attribute name="name" type="xsd:string" use="required" msdata:Ordinal="1" />
              <xsd:attribute name="type" type="xsd:string" msdata:Ordinal="3" />
              <xsd:attribute name="mimetype" type="xsd:string" msdata:Ordinal="4" />
              <xsd:attribute ref="xml:space" />
            </xsd:complexType>
          </xsd:element>
          <xsd:element name="resheader">
            <xsd:complexType>
              <xsd:sequence>
                <xsd:element name="value" type="xsd:string" minOccurs="0" msdata:Ordinal="1" />
              </xsd:sequence>
              <xsd:attribute name="name" type="xsd:string" use="required" />
            </xsd:complexType>
          </xsd:element>
        </xsd:choice>
      </xsd:complexType>
    </xsd:element>
  </xsd:schema>
  <resheader name="resmimetype">
    <value>text/microsoft-resx</value>
  </resheader>
  <resheader name="version">
    <value>2.0</value>
  </resheader>
  <resheader name="reader">
    <value>System.Resources.ResXResourceReader, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value>
  </resheader>
  <resheader name="writer">
    <value>System.Resources.ResXResourceWriter, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value>
  </resheader>
EOF

  # Add data elements from JSON
  jq -r 'to_entries[] | "  <data name=\"\(.key)\" xml:space=\"preserve\">\n    <value>\(.value | tostring)</value>\n  </data>"' "$json_file" >> "$output_file"
  
  echo "</root>" >> "$output_file"
}

# Track statistics
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

SUCCESS_FILE="$TEMP_DIR/success_count"
FAILED_FILE="$TEMP_DIR/failed_count"
FAILED_ITEMS_FILE="$TEMP_DIR/failed_items"

echo "0" > "$SUCCESS_FILE"
echo "0" > "$FAILED_FILE"
touch "$FAILED_ITEMS_FILE"

# Parse source .resx to JSON
echo "Parsing source .resx file to JSON..."
SOURCE_JSON="$TEMP_DIR/source.json"
parse_resx_to_json "$SOURCE_FILE" "$SOURCE_JSON"
echo "✓ Parsed $(jq 'length' "$SOURCE_JSON") string resources"
echo ""

echo "Starting translations..."
echo "========================================="

# Retry configuration
MAX_RETRIES=3
BASE_DELAY=2

# Function to handle a single translation job
translate_culture() {
  local culture_code=$1
  local culture_name=$2
  
  # Check if file already exists
  OUTPUT_FILE="$RESOURCES_DIR/Strings.$culture_code.resx"
  if [ -f "$OUTPUT_FILE" ]; then
    echo "[$culture_code] ✓ Already exists, skipping..."
    echo $(($(cat "$SUCCESS_FILE") + 1)) > "$SUCCESS_FILE"
    return 0
  fi
  
  echo "[$culture_code] Starting translation to $culture_name..."
  
  # Create request payload
  REQUEST_PAYLOAD=$(jq -n \
    --arg lang "$culture_code" \
    --arg filename "Strings" \
    --slurpfile data "$SOURCE_JSON" \
    '{targetLanguage: $lang, sourceFilename: $filename, languageData: $data[0]}')
  
  # Retry loop for handling 504 errors
  RETRY_COUNT=0
  
  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    # Make the API request to start orchestration
    TEMP_FILE="$TEMP_DIR/translation_${culture_code}_$$"
    HTTP_STATUS=$(curl -s -w "%{http_code}" -o "$TEMP_FILE" \
      -X POST "$FUNCTION_URL" \
      -H "Content-Type: application/json" \
      -d "$REQUEST_PAYLOAD")
    
    if [ "$HTTP_STATUS" -eq 202 ]; then
      # Orchestration started - get status URL
      STATUS_URL=$(jq -r '.statusUrl' "$TEMP_FILE" 2>/dev/null)
      
      if [ -z "$STATUS_URL" ] || [ "$STATUS_URL" = "null" ]; then
        echo "[$culture_code] ✗ Failed: No status URL returned"
        echo "Strings.$culture_code.resx: No status URL" >> "$FAILED_ITEMS_FILE"
        echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
        rm -f "$TEMP_FILE"
        return 1
      fi
      
      # Poll for completion
      echo "[$culture_code] ⏳ Orchestration started, polling..."
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
            echo "[$culture_code] ✗ Failed: No blob path in output"
            echo "Strings.$culture_code.resx: No blob path" >> "$FAILED_ITEMS_FILE"
            echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
            rm -f "$TEMP_FILE"
            return 1
          fi
          
          echo "[$culture_code] 📥 Downloading translated content from blob: $BLOB_PATH"
          
          # Download the blob content from Azure Storage
          TRANSLATED_JSON_FILE="$TEMP_DIR/translated_${culture_code}.json"
          STORAGE_ACCOUNT="avstoragewje2yrjsuipbs"
          
          # Download using az storage blob download
          az storage blob download \
            --account-name "$STORAGE_ACCOUNT" \
            --container-name locales \
            --name "$BLOB_PATH" \
            --file "$TRANSLATED_JSON_FILE" \
            --auth-mode login \
            --only-show-errors 2>/dev/null
          
          if [ ! -f "$TRANSLATED_JSON_FILE" ] || [ ! -s "$TRANSLATED_JSON_FILE" ]; then
            echo "[$culture_code] ✗ Failed: Could not download blob from storage"
            echo "Strings.$culture_code.resx: Blob download failed" >> "$FAILED_ITEMS_FILE"
            echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
            rm -f "$TEMP_FILE"
            return 1
          fi
          
          # Convert JSON back to .resx
          OUTPUT_FILE="$RESOURCES_DIR/Strings.$culture_code.resx"
          json_to_resx "$TRANSLATED_JSON_FILE" "$OUTPUT_FILE" "$culture_code"
          
          echo "[$culture_code] ✓ Success (saved to: Strings.$culture_code.resx, ${POLL_ATTEMPT} polls)"
          echo $(($(cat "$SUCCESS_FILE") + 1)) > "$SUCCESS_FILE"
          rm -f "$TEMP_FILE" "$TRANSLATED_JSON_FILE"
          return 0
        elif [ "$RUNTIME_STATUS" = "Failed" ]; then
          ERROR_MSG=$(echo "$STATUS_RESPONSE" | jq -r '.error // .output // "Orchestration failed"' 2>/dev/null)
          # Get more detailed error if available
          if [ "$ERROR_MSG" = "Orchestration failed" ]; then
            ERROR_MSG=$(echo "$STATUS_RESPONSE" | jq -r 'if .customStatus then .customStatus else "Orchestration failed" end' 2>/dev/null)
          fi
          echo "[$culture_code] ✗ Failed: $ERROR_MSG"
          echo "[$culture_code] Full response: $STATUS_RESPONSE" >> "$TEMP_DIR/debug_${culture_code}.log"
          echo "Strings.$culture_code.resx: $ERROR_MSG" >> "$FAILED_ITEMS_FILE"
          echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
          rm -f "$TEMP_FILE"
          return 1
        elif [ "$RUNTIME_STATUS" = "Running" ] || [ "$RUNTIME_STATUS" = "Pending" ]; then
          # Still running, continue polling
          :
        else
          echo "[$culture_code] ⚠ Unknown status: $RUNTIME_STATUS"
        fi
      done
      
      if [ $POLL_ATTEMPT -ge $MAX_POLL_ATTEMPTS ]; then
        echo "[$culture_code] ✗ Failed: Timeout after $((MAX_POLL_ATTEMPTS * 5))s"
        echo "Strings.$culture_code.resx: Timeout" >> "$FAILED_ITEMS_FILE"
        echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
        rm -f "$TEMP_FILE"
        return 1
      fi
    elif [ "$HTTP_STATUS" -eq 504 ]; then
      # Gateway timeout - retry with exponential backoff
      RETRY_COUNT=$((RETRY_COUNT + 1))
      if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
        DELAY=$((BASE_DELAY * (2 ** (RETRY_COUNT - 1))))
        echo "[$culture_code] ⚠ Timeout (504) - Retry $RETRY_COUNT/$MAX_RETRIES after ${DELAY}s"
        sleep $DELAY
      else
        echo "[$culture_code] ✗ Failed: Timeout after $MAX_RETRIES retries"
        echo "Strings.$culture_code.resx: Timeout after retries" >> "$FAILED_ITEMS_FILE"
        echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
        rm -f "$TEMP_FILE"
        return 1
      fi
    else
      # Other error
      ERROR_MSG=$(jq -r '.error // "Unknown error"' "$TEMP_FILE" 2>/dev/null || echo "HTTP $HTTP_STATUS")
      echo "[$culture_code] ✗ Failed: $ERROR_MSG"
      echo "Strings.$culture_code.resx: $ERROR_MSG" >> "$FAILED_ITEMS_FILE"
      echo $(($(cat "$FAILED_FILE") + 1)) > "$FAILED_FILE"
      rm -f "$TEMP_FILE"
      return 1
    fi
  done
  
  rm -f "$TEMP_FILE"
  return 1
}

# Export function and variables for parallel processing
export -f translate_culture json_to_resx
export FUNCTION_URL RESOURCES_DIR TEMP_DIR SUCCESS_FILE FAILED_FILE FAILED_ITEMS_FILE
export MAX_RETRIES BASE_DELAY SOURCE_JSON

# Translate to each culture sequentially (to avoid overwhelming the function)
for culture_info in "${CULTURES[@]}"; do
  IFS=':' read -r culture_code culture_name <<< "$culture_info"
  translate_culture "$culture_code" "$culture_name"
  echo ""
  
  # Add a small delay between cultures to avoid rate limits
  sleep 2
done

# Read final statistics
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
echo "Translated .resx files saved to:"
echo "  $RESOURCES_DIR/"
echo ""
echo "Files created:"
for culture_info in "${CULTURES[@]}"; do
  IFS=':' read -r culture_code culture_name <<< "$culture_info"
  OUTPUT_FILE="$RESOURCES_DIR/Strings.$culture_code.resx"
  if [ -f "$OUTPUT_FILE" ]; then
    echo "  ✓ Strings.$culture_code.resx"
  fi
done
echo "========================================="

# Exit with error if any translations failed
if [ $FAILED -gt 0 ]; then
  exit 1
fi

exit 0
