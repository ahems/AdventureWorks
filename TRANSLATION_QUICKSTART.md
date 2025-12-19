# Quick Start: Using the Language Translation Function

## Prerequisites

1. Azure Functions runtime running locally or deployed to Azure
2. Azure OpenAI endpoint configured
3. `jq` installed for JSON processing

## Example 1: Simple Translation Test

Translate a simple object to Spanish:

```bash
curl -X POST http://localhost:7071/api/TranslateLanguageFile \
  -H "Content-Type: application/json" \
  -d '{
    "targetLanguage": "es",
    "languageData": {
      "welcome": "Welcome to AdventureWorks!",
      "signIn": "Sign In",
      "cart": "Shopping Cart"
    }
  }'
```

**Expected Output:**

```json
{
  "welcome": "¡Bienvenido a AdventureWorks!",
  "signIn": "Iniciar Sesión",
  "cart": "Carrito de Compras"
}
```

## Example 2: With Placeholders

Translation preserves template variables:

```bash
curl -X POST http://localhost:7071/api/TranslateLanguageFile \
  -H "Content-Type: application/json" \
  -d '{
    "targetLanguage": "fr",
    "languageData": {
      "itemsInCart": "You have {{count}} items in your cart",
      "save": "Save {{percent}}% on this item"
    }
  }'
```

**Expected Output:**

```json
{
  "itemsInCart": "Vous avez {{count}} articles dans votre panier",
  "save": "Économisez {{percent}}% sur cet article"
}
```

## Example 3: Regional Examples

Addresses and emails are localized:

```bash
curl -X POST http://localhost:7071/api/TranslateLanguageFile \
  -H "Content-Type: application/json" \
  -d '{
    "targetLanguage": "ja",
    "languageData": {
      "account": {
        "emailPlaceholder": "your@email.com",
        "address": "123 Adventure Lane, Seattle"
      }
    }
  }'
```

**Expected Output:**

```json
{
  "account": {
    "emailPlaceholder": "tanaka@email.jp",
    "address": "冒険通り123番地、東京"
  }
}
```

## Example 4: Translate Full Language File

```bash
# Using the test script
./test-translate-language-file.sh de

# Using curl with a file
jq -n --slurpfile data app/src/locales/en/common.json \
  '{targetLanguage: "de", languageData: $data[0]}' | \
  curl -X POST http://localhost:7071/api/TranslateLanguageFile \
    -H "Content-Type: application/json" \
    -d @- | \
  jq '.' > app/src/locales/de/common.json
```

## Example 5: Batch Translation

Translate to all supported languages:

```bash
./batch-translate-language-file.sh app/src/locales/en/common.json
```

This will create:

```
app/src/locales/
├── en/
│   └── common.json (original)
├── es/
│   └── common.json (Spanish)
├── fr/
│   └── common.json (French)
├── de/
│   └── common.json (German)
├── pt/
│   └── common.json (Portuguese)
├── it/
│   └── common.json (Italian)
├── nl/
│   └── common.json (Dutch)
├── ru/
│   └── common.json (Russian)
├── zh/
│   └── common.json (Chinese)
├── ja/
│   └── common.json (Japanese)
├── ko/
│   └── common.json (Korean)
├── ar/
│   └── common.json (Arabic)
├── tr/
│   └── common.json (Turkish)
├── vi/
│   └── common.json (Vietnamese)
├── th/
│   └── common.json (Thai)
└── id/
    └── common.json (Indonesian)
```

## Supported Language Codes

| Code | Language           |
| ---- | ------------------ |
| `es` | Spanish            |
| `fr` | French             |
| `de` | German             |
| `pt` | Portuguese         |
| `it` | Italian            |
| `nl` | Dutch              |
| `ru` | Russian            |
| `zh` | Chinese (Mandarin) |
| `ja` | Japanese           |
| `ko` | Korean             |
| `ar` | Arabic             |
| `tr` | Turkish            |
| `vi` | Vietnamese         |
| `th` | Thai               |
| `id` | Indonesian         |

## Error Handling

### Invalid Language Code

```bash
curl -X POST http://localhost:7071/api/TranslateLanguageFile \
  -H "Content-Type: application/json" \
  -d '{
    "targetLanguage": "xx",
    "languageData": {"test": "value"}
  }'
```

**Response (400):**

```json
{
  "error": "Unsupported language: xx. Supported languages: es (Spanish), fr (French), ..."
}
```

### Missing Parameters

```bash
curl -X POST http://localhost:7071/api/TranslateLanguageFile \
  -H "Content-Type: application/json" \
  -d '{
    "languageData": {"test": "value"}
  }'
```

**Response (400):**

```json
{
  "error": "Missing targetLanguage parameter"
}
```

## Integration Example

Use in a Node.js script:

```javascript
const axios = require("axios");
const fs = require("fs");

async function translateFile(sourceFile, targetLang) {
  const englishData = JSON.parse(fs.readFileSync(sourceFile, "utf8"));

  const response = await axios.post(
    "http://localhost:7071/api/TranslateLanguageFile",
    {
      targetLanguage: targetLang,
      languageData: englishData,
    }
  );

  const outputPath = `app/src/locales/${targetLang}/common.json`;
  fs.writeFileSync(outputPath, JSON.stringify(response.data, null, 2));

  console.log(`✓ Translated to ${targetLang}: ${outputPath}`);
}

// Translate to multiple languages
const languages = ["es", "fr", "de", "ja"];
for (const lang of languages) {
  await translateFile("app/src/locales/en/common.json", lang);
}
```

## Tips

1. **Review Translations**: AI translations are high quality but should be reviewed by native speakers
2. **Consistent Source**: Always use the same English source file for consistency
3. **Version Control**: Commit translations to track changes over time
4. **Test Incrementally**: Start with a small subset before translating entire files
5. **Regional Variations**: Be aware that the function uses one regional variant per language (e.g., European Spanish, not Latin American)

## Troubleshooting

### Function Not Responding

```bash
# Check if Functions runtime is running
curl http://localhost:7071/api/TranslateLanguageFile

# Start it if needed
cd api-functions && func start
```

### Invalid JSON Response

```bash
# The function returns valid JSON, but check your input:
echo '{"targetLanguage":"es","languageData":{"test":"value"}}' | jq '.'

# If jq fails, your JSON is malformed
```

### Timeout Errors

Large files may take time. Increase timeout or split into smaller chunks:

```bash
# Split large file into sections
jq '.header' en/common.json > sections/header.json
jq '.buttons' en/common.json > sections/buttons.json
# Translate each section separately
# Then merge results
```

## Next Steps

- Read the [full documentation](docs/LANGUAGE_FILE_TRANSLATION.md)
- See [implementation details](LANGUAGE_TRANSLATION_IMPLEMENTATION.md)
- Check [API Functions README](api-functions/README.md)
