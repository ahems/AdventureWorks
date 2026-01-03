#!/bin/bash

LANGUAGES=("fr" "es" "it" "ru" "zh" "vi")
SOURCE_FILE="app/src/locales/en/common.json"
FILENAME="common.json"

for lang in "${LANGUAGES[@]}"; do
  echo "Starting translation for $lang..."
  
  response=$(curl -s -X POST "http://localhost:7071/api/TranslateLanguageFile" \
    -H "Content-Type: application/json" \
    -d "{
      \"filePath\": \"$SOURCE_FILE\",
      \"sourceFilename\": \"$FILENAME\",
      \"targetLanguages\": [\"$lang\"]
    }")
  
  instanceId=$(echo "$response" | jq -r '.id')
  echo "Started orchestration $instanceId for $lang"
  
  # Poll for completion
  while true; do
    status_response=$(curl -s "http://localhost:7071/runtime/webhooks/durabletask/instances/$instanceId")
    status=$(echo "$status_response" | jq -r '.runtimeStatus')
    
    if [ "$status" == "Completed" ]; then
      output=$(echo "$status_response" | jq -r '.output')
      echo "✅ $lang completed: $output"
      break
    elif [ "$status" == "Failed" ]; then
      echo "❌ $lang failed"
      break
    else
      echo "⏳ $lang status: $status"
      sleep 5
    fi
  done
  
  echo ""
done

echo "All translations submitted!"
