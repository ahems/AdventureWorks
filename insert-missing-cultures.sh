#!/bin/bash

# Insert missing cultures into Production.Culture table via DAB REST API
API_URL="https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/api/Culture"

# Array of cultures to add (CultureID, Name)
declare -a cultures=(
  "de:German"
  "en-au:English (Australia)"
  "en-ca:English (Canada)"
  "en-gb:English (United Kingdom)"
  "en-ie:English (Ireland)"
  "en-nz:English (New Zealand)"
  "id:Indonesian"
  "it:Italian"
  "ja:Japanese"
  "ko:Korean"
  "nl:Dutch"
  "pt:Portuguese"
  "ru:Russian"
  "tr:Turkish"
  "vi:Vietnamese"
  "zh:Chinese (Simplified)"
)

echo "Inserting missing cultures into Production.Culture table..."

for culture in "${cultures[@]}"; do
  IFS=':' read -r cultureId name <<< "$culture"
  
  echo "Inserting: $cultureId - $name"
  
  response=$(curl -s -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -d "{\"CultureID\": \"$cultureId\", \"Name\": \"$name\", \"ModifiedDate\": \"2026-01-01T00:00:00.000Z\"}")
  
  if echo "$response" | jq -e '.value' > /dev/null 2>&1; then
    echo "  ✓ Successfully inserted $cultureId"
  else
    echo "  ✗ Failed to insert $cultureId"
    echo "    Response: $response"
  fi
done

echo ""
echo "Verifying total culture count..."
total=$(curl -s -X POST "https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ cultures { items { CultureID } } }"}' | jq '.data.cultures.items | length')

echo "Total cultures in database: $total (expected: 23)"
