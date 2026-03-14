#!/bin/bash
#
# Temporary script: translate common.json for Turkish (tr) and Vietnamese (vi) only.
# Uses longer timeout (10 min) and sequential execution to avoid timeouts.
# Run from repo root. Delete this file after use.
#
set -e

REPO_ROOT="${PWD}"
LOCALES_DIR="$REPO_ROOT/app/src/locales"
SOURCE_FILE="$LOCALES_DIR/en/common.json"
BLOB_CONTAINER="locales"
MAX_POLL_ATTEMPTS=120   # 10 minutes (was 60 = 5 min in batch script)
POLL_INTERVAL=5
MAX_RETRIES=3
BASE_DELAY=2

if [ ! -f "$SOURCE_FILE" ]; then
  echo "Error: Run from repo root. Expected $SOURCE_FILE" >&2
  exit 1
fi
command -v jq &>/dev/null || { echo "Error: jq required" >&2; exit 1; }

echo "Retrieving Azure Function URL from azd environment..."
FUNCTION_APP_URL=$(azd env get-values 2>/dev/null | grep "^VITE_API_FUNCTIONS_URL=" | cut -d'=' -f2 | tr -d '"' | tr -d '\r')
if [ -z "$FUNCTION_APP_URL" ]; then
  echo "Error: Could not find VITE_API_FUNCTIONS_URL. Run from repo root with azd configured." >&2
  exit 1
fi
FUNCTION_URL="${FUNCTION_APP_URL}/api/TranslateLanguageFile_HttpStart"
STORAGE_ACCOUNT_NAME=$(azd env get-values 2>/dev/null | grep "^STORAGE_ACCOUNT_NAME=" | cut -d'=' -f2 | tr -d '"' | tr -d '\r' || true)

echo "Translating common.json → Turkish, then Vietnamese (sequential, ${MAX_POLL_ATTEMPTS} polls = $((MAX_POLL_ATTEMPTS * POLL_INTERVAL))s max each)"
echo ""

translate_one() {
  local lang_code=$1
  local lang_name=$2
  local FILE_NAME="common.json"
  local FILE_NAME_WITHOUT_EXT="common"

  echo "[common.json → $lang_name] Starting..."
  REQUEST_PAYLOAD=$(jq -n \
    --arg lang "$lang_code" \
    --arg filename "$FILE_NAME_WITHOUT_EXT" \
    --slurpfile data "$SOURCE_FILE" \
    '{targetLanguage: $lang, sourceFilename: $filename, languageData: $data[0]}')

  RETRY_COUNT=0
  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    TEMP_FILE=$(mktemp)
    HTTP_STATUS=$(curl -s -w "%{http_code}" -o "$TEMP_FILE" \
      -X POST "$FUNCTION_URL" \
      -H "Content-Type: application/json" \
      -d "$REQUEST_PAYLOAD")

    if [ "$HTTP_STATUS" -eq 202 ]; then
      STATUS_URL=$(jq -r '.statusUrl' "$TEMP_FILE" 2>/dev/null)
      rm -f "$TEMP_FILE"
      if [ -z "$STATUS_URL" ] || [ "$STATUS_URL" = "null" ]; then
        echo "[common.json → $lang_name] ✗ No status URL"
        return 1
      fi

      echo "[common.json → $lang_name] ⏳ Polling (max ${MAX_POLL_ATTEMPTS} × ${POLL_INTERVAL}s)..."
      POLL_ATTEMPT=0
      while [ $POLL_ATTEMPT -lt $MAX_POLL_ATTEMPTS ]; do
        sleep $POLL_INTERVAL
        POLL_ATTEMPT=$((POLL_ATTEMPT + 1))
        STATUS_RESPONSE=$(curl -s "$STATUS_URL")
        RUNTIME_STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.runtimeStatus' 2>/dev/null)

        if [ "$RUNTIME_STATUS" = "Completed" ]; then
          BLOB_PATH=$(echo "$STATUS_RESPONSE" | jq -r '.output' 2>/dev/null | tr -d '"')
          if [ -z "$BLOB_PATH" ] || [ "$BLOB_PATH" = "null" ]; then
            echo "[common.json → $lang_name] ✗ No blob path in output"
            return 1
          fi
          DEST_FILE="$LOCALES_DIR/$BLOB_PATH"
          mkdir -p "$(dirname "$DEST_FILE")"
          if [ -n "$STORAGE_ACCOUNT_NAME" ] && command -v az &>/dev/null; then
            if az storage blob download --account-name "$STORAGE_ACCOUNT_NAME" --container-name "$BLOB_CONTAINER" --name "$BLOB_PATH" --file "$DEST_FILE" --auth-mode login 2>/dev/null; then
              echo "[common.json → $lang_name] ✓ Done (${POLL_ATTEMPT} polls, saved to $DEST_FILE)"
            else
              echo "[common.json → $lang_name] ✓ Orchestration completed (blob: $BLOB_PATH); download failed (check az login)"
            fi
          else
            echo "[common.json → $lang_name] ✓ Orchestration completed (blob: $BLOB_PATH)"
          fi
          return 0
        elif [ "$RUNTIME_STATUS" = "Failed" ]; then
          ERROR_MSG=$(echo "$STATUS_RESPONSE" | jq -r '.output // "Orchestration failed"' 2>/dev/null)
          echo "[common.json → $lang_name] ✗ Failed: $ERROR_MSG"
          return 1
        fi
        # Running or Pending: continue
      done
      echo "[common.json → $lang_name] ✗ Timeout after $((MAX_POLL_ATTEMPTS * POLL_INTERVAL))s"
      RETRY_COUNT=$((RETRY_COUNT + 1))
      if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
        DELAY=$((BASE_DELAY * (2 ** RETRY_COUNT)))
        echo "[common.json → $lang_name] Retry $RETRY_COUNT/$MAX_RETRIES in ${DELAY}s..."
        sleep $DELAY
      fi
    elif [ "$HTTP_STATUS" -eq 504 ]; then
      rm -f "$TEMP_FILE"
      RETRY_COUNT=$((RETRY_COUNT + 1))
      if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
        DELAY=$((BASE_DELAY * (2 ** RETRY_COUNT)))
        echo "[common.json → $lang_name] 504 - Retry $RETRY_COUNT/$MAX_RETRIES in ${DELAY}s..."
        sleep $DELAY
      else
        echo "[common.json → $lang_name] ✗ 504 after $MAX_RETRIES retries"
        return 1
      fi
    else
      echo "[common.json → $lang_name] ✗ HTTP $HTTP_STATUS"
      [ -f "$TEMP_FILE" ] && cat "$TEMP_FILE" | jq . 2>/dev/null || true
      rm -f "$TEMP_FILE"
      return 1
    fi
  done
  return 1
}

FAILED=0
translate_one "tr" "Turkish" || FAILED=$((FAILED + 1))
translate_one "vi" "Vietnamese" || FAILED=$((FAILED + 1))

echo ""
if [ $FAILED -eq 0 ]; then
  echo "Both translations completed. You can delete this script: scripts/utilities/translate-common-tr-vi.sh"
else
  echo "Failed: $FAILED translation(s)"
  exit 1
fi
