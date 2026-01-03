# Translation Blob Storage with SAS URLs

## Overview

The Durable Functions translation orchestrator now saves results to Azure Blob Storage and returns a 1-day SAS URL for easy download. The blob filename includes the source filename (e.g., "common") to identify where the translated file should be placed in the app's locales folder.

## Blob Naming Convention

```
{instanceId}/{languageCode}-{sourceFilename}-{timestamp}.json
```

**Example:**

```
97f39d18c9fb49a8889bee96dc432365/fr-common-20260102-233554.json
```

This makes it clear:

- `fr` = French translation
- `common` = source file was `common.json`
- Destination: `app/src/locales/fr/common.json`

## API Usage

### Request Format

```bash
POST /api/TranslateLanguageFile_HttpStart
Content-Type: application/json

{
  "languageData": {
    "section1": {
      "key1": "value1",
      "key2": "value2"
    }
  },
  "targetLanguage": "fr",
  "sourceFilename": "common"
}
```

### Response Format

```json
{
  "id": "97f39d18c9fb49a8889bee96dc432365",
  "statusUrl": "https://.../api/TranslateLanguageFile_Status?instanceId=..."
}
```

### Status Polling

```bash
GET /api/TranslateLanguageFile_Status?instanceId={instanceId}
```

**Completed Response:**

```json
{
  "instanceId": "97f39d18c9fb49a8889bee96dc432365",
  "runtimeStatus": "Completed",
  "output": "https://avstoragewje2yrjsuipbs.blob.core.windows.net/translation-outputs/97f39d18c9fb49a8889bee96dc432365/fr-common-20260102-233554.json?skoid=...&sig=..."
}
```

## SAS URL Details

- **Expiry**: 1 day from generation
- **Permissions**: Read-only
- **Authentication**: User delegation key (works with managed identity)
- **No additional auth required**: Direct curl/wget download

## Downloading Translated Files

### Using curl

```bash
# Extract SAS URL from status response
SAS_URL=$(curl -s "https://.../api/TranslateLanguageFile_Status?instanceId=..." | jq -r '.output' | tr -d '"')

# Download directly (no auth needed)
curl -s "$SAS_URL" -o translated-fr-common.json
```

### Using wget

```bash
wget -O translated-fr-common.json "$SAS_URL"
```

### In batch scripts

```bash
#!/bin/bash

# Poll until complete
while true; do
  STATUS=$(curl -s "$STATUS_URL" | jq -r '.runtimeStatus')
  if [ "$STATUS" == "Completed" ]; then
    SAS_URL=$(curl -s "$STATUS_URL" | jq -r '.output' | tr -d '"')

    # Extract language and filename from URL
    BLOB_NAME=$(echo "$SAS_URL" | sed 's/.*\///' | sed 's/?.*//')
    # Example: fr-common-20260102-233554.json

    LANG=$(echo "$BLOB_NAME" | cut -d'-' -f1)      # fr
    FILENAME=$(echo "$BLOB_NAME" | cut -d'-' -f2)  # common

    # Download to correct location
    curl -s "$SAS_URL" -o "app/src/locales/$LANG/$FILENAME.json"
    break
  fi
  sleep 5
done
```

## Storage Container

- **Account**: avstoragewje2yrjsuipbs
- **Container**: translation-outputs
- **Access**: Private (managed identity)
- **Lifecycle**: Files can be auto-deleted after N days via lifecycle policy

## Error Handling

If SAS generation fails (e.g., permissions issue), the function returns the plain blob URI:

```
https://avstoragewje2yrjsuipbs.blob.core.windows.net/translation-outputs/...
```

This requires Azure authentication (az login) to download.

## Benefits

1. **No output size limits**: Unlike SerializedOutput (which had 1MB limit), blobs support large translations
2. **Framework agnostic**: Works around Durable Functions isolated worker limitation
3. **Easy downloading**: SAS URLs work with curl/wget without additional auth
4. **Filename preservation**: Blob name includes source filename for easy mapping
5. **Audit trail**: All translations stored in blob storage with timestamps
6. **Cost effective**: Blob storage is cheaper than function execution storage

## Example Workflow

1. Submit translation request with `sourceFilename: "common"`
2. Poll status endpoint until `runtimeStatus: "Completed"`
3. Extract SAS URL from `output` field
4. Parse blob name to get language code (`fr`) and filename (`common`)
5. Download JSON: `curl -s "$SAS_URL" -o app/src/locales/fr/common.json`
6. Commit translated file to repository

## Testing

See `/tmp/test-translation-with-filename.sh` for complete example that:

- Starts translation orchestration
- Polls for completion
- Downloads result via SAS URL
- Displays translated JSON
