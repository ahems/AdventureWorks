# Fill Missing Translations

This directory contains scripts to fill in missing translation keys using the Azure Function.

## The Problem

Some keys in the translated `common.json` files are missing:

- **`header.aiSearchPlaceholder`** - missing in 13 languages
- **`checkout.removeDiscountCode`** - missing in 12 languages
- **`reviewForm` section** (5 keys) - missing in 6 languages (es, fr, zh, ru, vi, zh-cht)

## The Solution

Instead of re-translating entire files, we extract **only the missing keys** from the English source, send them to your Azure Function for translation, and merge the results back.

## Options

### Option 1: Node.js Script (Recommended)

**Best for:** Automated workflow with local merge capability

```bash
# If Azure Function is running locally:
node fill-missing-translations.js

# If Azure Function is deployed to Azure:
TRANSLATION_FUNCTION_URL="https://your-function-app.azurewebsites.net/api/TranslateLanguageFile" \
  node fill-missing-translations.js
```

**Features:**

- ✅ Extracts missing keys automatically
- ✅ Calls Azure Function for each language
- ✅ Polls until completion
- ✅ Can merge results automatically (if downloaded from blob)
- ✅ Colored console output with progress

### Option 2: Simple Bash Script

**Best for:** Quick batch submission

```bash
# If Azure Function is running locally:
./fill-missing-translations-simple.sh

# If Azure Function is deployed:
TRANSLATION_FUNCTION_URL="https://your-function-app.azurewebsites.net/api/TranslateLanguageFile" \
  ./fill-missing-translations-simple.sh
```

**Features:**

- ✅ Lightweight bash script
- ✅ Submits all translations in batch
- ✅ Shows progress with dots
- ⚠️ Results go to blob storage (manual merge needed)

### Option 3: Full Bash Script

**Best for:** Detailed logging and control

```bash
./fill-missing-translations.sh
```

**Features:**

- ✅ Most detailed logging
- ✅ Groups languages by missing keys
- ✅ Comprehensive error handling
- ⚠️ Results go to blob storage (manual merge needed)

## How It Works

1. **Extract**: Pulls only missing keys from `/app/src/locales/en/common.json`:

   ```json
   {
     "header": { "aiSearchPlaceholder": "..." },
     "checkout": { "removeDiscountCode": "..." },
     "reviewForm": { "alreadyReviewed": "...", ... }
   }
   ```

2. **Translate**: Sends this small JSON to Azure Function for each language

   - Function translates only these keys
   - Much faster than translating entire file
   - Stores results in blob storage (`locales` container)

3. **Merge**: Downloads translated JSON and merges into existing files
   ```bash
   # Manual merge example:
   jq -s '.[0] * .[1]' \
     app/src/locales/es/common.json \
     es/missing_keys.json > temp.json && \
     mv temp.json app/src/locales/es/common.json
   ```

## Prerequisites

### Running Locally

1. Start Azure Function:
   ```bash
   cd api-functions
   func start
   ```
2. Run script (it will use `http://localhost:7071` by default)

### Running Against Azure

1. Get your function URL from Azure Portal or:
   ```bash
   azd env get-values | grep FUNCTION_APP_URL
   ```
2. Set environment variable:
   ```bash
   export TRANSLATION_FUNCTION_URL="https://your-app.azurewebsites.net/api/TranslateLanguageFile"
   ```
3. Run script

## After Translation

Translations are saved to blob storage in the `locales` container:

```
locales/
  es/missing_keys.json
  fr/missing_keys.json
  zh/missing_keys.json
  ... etc
```

### Download and Merge

```bash
# Download from blob storage (example using Azure CLI)
az storage blob download \
  --account-name <your-storage-account> \
  --container-name locales \
  --name es/missing_keys.json \
  --file /tmp/es_missing.json

# Merge into existing file
jq -s '.[0] * .[1]' \
  app/src/locales/es/common.json \
  /tmp/es_missing.json > /tmp/merged.json

mv /tmp/merged.json app/src/locales/es/common.json
```

## Verification

After merging, verify all keys are present:

```bash
# Check a specific language
jq 'has("header") and .header | has("aiSearchPlaceholder")' \
  app/src/locales/es/common.json

# Should return: true
```

## Languages Affected

- **13 languages** missing `header.aiSearchPlaceholder`:
  pt, ar, ru, tr, id, vi, he, en-gb, en-ca, en-au, en-nz, en-ie, zh-cht

- **12 languages** missing `checkout.removeDiscountCode`:
  fr, pt, ar, ru, id, vi, en-gb, en-ca, en-au, en-nz, en-ie, zh-cht

- **6 languages** missing `reviewForm` section:
  es, fr, zh, ru, vi, zh-cht
