# Language File Translation Function

## Overview

The `TranslateLanguageFile` Azure Function translates i18n (internationalization) language files from English to 15 different languages using AI. It's specifically designed for the AdventureWorks e-commerce demo application and maintains the fun, adventurous vibe of the original content while ensuring regional appropriateness.

## Endpoint

**HTTP POST** `/api/TranslateLanguageFile`

## Supported Languages

The function supports translation to the following 15 languages:

| Language Code | Language Name                   |
| ------------- | ------------------------------- |
| `es`          | Spanish                         |
| `fr`          | French                          |
| `de`          | German                          |
| `pt`          | Portuguese                      |
| `it`          | Italian                         |
| `nl`          | Dutch                           |
| `ru`          | Russian                         |
| `zh`          | Chinese (Mandarin)              |
| `ja`          | Japanese                        |
| `ko`          | Korean                          |
| `ar`          | Arabic (Modern Standard Arabic) |
| `tr`          | Turkish                         |
| `vi`          | Vietnamese                      |
| `th`          | Thai                            |
| `id`          | Indonesian                      |

## Request Format

```json
{
  "targetLanguage": "es",
  "languageData": {
    "header": {
      "signIn": "Sign In",
      "cart": "Cart"
    }
  }
}
```

### Parameters

- **targetLanguage** (string, required): The language code from the supported languages list
- **languageData** (object, required): The English language JSON object to translate

## Response Format

The function returns the translated JSON with the same structure as the input, but with all values translated:

```json
{
  "header": {
    "signIn": "Iniciar Sesión",
    "cart": "Carrito"
  }
}
```

### Error Responses

**400 Bad Request**

```json
{
  "error": "Unsupported language: xx. Supported languages: es (Spanish), fr (French), ..."
}
```

**500 Internal Server Error**

```json
{
  "error": "Internal server error: [error details]"
}
```

## Translation Features

### 1. **Maintains Structure**

- All JSON keys remain in English
- Only values are translated
- Nested objects and arrays are preserved

### 2. **Preserves Special Formatting**

- Placeholder variables: `{{count}}`, `{{percent}}`, `{{name}}`, etc.
- HTML tags and markup
- Special characters and punctuation

### 3. **Regional Localization**

- **Email addresses**: Uses regional domain suffixes
  - Example: `your@email.com` → `juan@email.es` (Spanish)
- **Street addresses**: Creates culturally appropriate, fun addresses
  - Example: "123 Adventure Lane, Seattle" → "Calle Aventura 123, Madrid"
- **City names**: Uses real cities from the target language region

### 4. **Content Guidelines**

- Maintains the fun, adventurous tone
- Preserves brand names and product codes in English
- Keeps technical terms (API, GraphQL) unchanged
- Ensures cultural appropriateness

## Examples

### Example 1: Translate to Spanish

**Request:**

```bash
curl -X POST http://localhost:7071/api/TranslateLanguageFile \
  -H "Content-Type: application/json" \
  -d '{
    "targetLanguage": "es",
    "languageData": {
      "hero": {
        "badge": "Adventure Awaits!",
        "title": "Gear Up for Your Adventure"
      }
    }
  }'
```

**Response:**

```json
{
  "hero": {
    "badge": "¡La Aventura Te Espera!",
    "title": "Equípate Para Tu Aventura"
  }
}
```

### Example 2: Translate Newsletter Section to French

**Request:**

```bash
curl -X POST http://localhost:7071/api/TranslateLanguageFile \
  -H "Content-Type: application/json" \
  -d '{
    "targetLanguage": "fr",
    "languageData": {
      "newsletter": {
        "title": "Join the Adventure Club!",
        "emailPlaceholder": "your@email.com",
        "disclaimer": "No spam, just good vibes. Unsubscribe anytime!"
      }
    }
  }'
```

**Response:**

```json
{
  "newsletter": {
    "title": "Rejoignez le Club Aventure !",
    "emailPlaceholder": "marie@email.fr",
    "disclaimer": "Pas de spam, que de bonnes vibrations. Désabonnez-vous à tout moment !"
  }
}
```

### Example 3: Translate Address Placeholders to Japanese

**Request:**

```json
{
  "targetLanguage": "ja",
  "languageData": {
    "account": {
      "placeholders": {
        "addressLine1": "123 Adventure Lane",
        "city": "Seattle"
      }
    }
  }
}
```

**Response:**

```json
{
  "account": {
    "placeholders": {
      "addressLine1": "冒険通り123番地",
      "city": "東京"
    }
  }
}
```

## Testing

### Using the Test Script

A test script is provided for easy testing:

```bash
# Test with Spanish (default)
./test-translate-language-file.sh

# Test with French
./test-translate-language-file.sh fr

# Test with custom endpoint
./test-translate-language-file.sh es http://your-function-app.azurewebsites.net/api/TranslateLanguageFile
```

### Using curl

```bash
curl -X POST http://localhost:7071/api/TranslateLanguageFile \
  -H "Content-Type: application/json" \
  -d @app/src/locales/en/common.json
```

Note: You'll need to wrap the file content in the proper request format:

```bash
jq -n --slurpfile data app/src/locales/en/common.json \
  '{targetLanguage: "es", languageData: $data[0]}' | \
  curl -X POST http://localhost:7071/api/TranslateLanguageFile \
    -H "Content-Type: application/json" \
    -d @-
```

## Regional Information by Language

The function uses the following regional configurations:

| Language        | Email Suffix | Example Cities                                              |
| --------------- | ------------ | ----------------------------------------------------------- |
| Spanish (es)    | `.es`        | Madrid, Barcelona, Valencia, Sevilla, Bilbao                |
| French (fr)     | `.fr`        | Paris, Lyon, Marseille, Toulouse, Nice                      |
| German (de)     | `.de`        | Berlin, Munich, Hamburg, Frankfurt, Cologne                 |
| Portuguese (pt) | `.pt`        | Lisbon, Porto, Braga, Coimbra, Faro                         |
| Italian (it)    | `.it`        | Rome, Milan, Naples, Turin, Florence                        |
| Dutch (nl)      | `.nl`        | Amsterdam, Rotterdam, Utrecht, The Hague, Eindhoven         |
| Russian (ru)    | `.ru`        | Moscow, Saint Petersburg, Novosibirsk, Yekaterinburg, Kazan |
| Chinese (zh)    | `.cn`        | Beijing, Shanghai, Guangzhou, Shenzhen, Chengdu             |
| Japanese (ja)   | `.jp`        | Tokyo, Osaka, Kyoto, Yokohama, Sapporo                      |
| Korean (ko)     | `.kr`        | Seoul, Busan, Incheon, Daegu, Daejeon                       |
| Arabic (ar)     | `.sa`        | Riyadh, Dubai, Cairo, Jeddah, Abu Dhabi                     |
| Turkish (tr)    | `.tr`        | Istanbul, Ankara, Izmir, Bursa, Antalya                     |
| Vietnamese (vi) | `.vn`        | Hanoi, Ho Chi Minh City, Da Nang, Hai Phong, Can Tho        |
| Thai (th)       | `.th`        | Bangkok, Chiang Mai, Phuket, Pattaya, Krabi                 |
| Indonesian (id) | `.id`        | Jakarta, Surabaya, Bandung, Bali, Yogyakarta                |

## Integration with Application

### Batch Translation Workflow

To translate all language files for the application:

```bash
#!/bin/bash
LANGUAGES=("es" "fr" "de" "pt" "it" "nl" "ru" "zh" "ja" "ko" "ar" "tr" "vi" "th" "id")
SOURCE_FILE="app/src/locales/en/common.json"

for lang in "${LANGUAGES[@]}"; do
  echo "Translating to $lang..."

  jq -n --slurpfile data "$SOURCE_FILE" \
    "{targetLanguage: \"$lang\", languageData: \$data[0]}" | \
    curl -X POST http://localhost:7071/api/TranslateLanguageFile \
      -H "Content-Type: application/json" \
      -d @- > "app/src/locales/$lang/common.json"

  echo "✓ Saved to app/src/locales/$lang/common.json"
done
```

## Architecture

### Function Components

1. **TranslateLanguageFile.cs**: HTTP trigger function

   - Validates input
   - Handles HTTP request/response
   - Calls AIService for translation

2. **AIService.cs**: Translation logic
   - `TranslateLanguageFileAsync()`: Main translation method
   - `GetRegionalInfo()`: Regional configuration helper
   - Uses Azure OpenAI chat completion with JSON mode

### AI Prompt Engineering

The function uses a carefully crafted system prompt that:

- Instructs the AI to maintain JSON structure
- Preserves placeholders and special formatting
- Provides regional examples for emails and addresses
- Ensures cultural appropriateness
- Maintains the adventurous, fun tone

## Requirements

- Azure OpenAI endpoint configured in `AZURE_OPENAI_ENDPOINT` environment variable
- Chat model deployment named "chat"
- .NET 8 Azure Functions runtime
- Managed Identity for Azure OpenAI authentication

## Performance

- **Temperature**: 0.7 (moderate creativity for natural, fun translations)
- **Max Tokens**: 16,000 (supports large language files)
- **Response Format**: JSON mode (ensures valid output)
- **Processing Time**: Varies by file size; typically 5-30 seconds for a complete language file

## Error Handling

The function includes comprehensive error handling:

- Invalid JSON input
- Missing parameters
- Unsupported languages
- AI service errors
- JSON parsing failures

All errors return appropriate HTTP status codes and descriptive error messages.

## Best Practices

1. **Start Small**: Test with a subset of your language file first
2. **Review Translations**: AI translations should be reviewed by native speakers
3. **Consistent Terminology**: Use the same source file for all languages to ensure consistency
4. **Version Control**: Track translated files in git to see changes over time
5. **Batch Processing**: For multiple languages, use a script to automate the process

## Limitations

- Maximum file size limited by Azure Functions request size (100MB)
- Maximum output tokens: 16,000 (very large files may be truncated)
- AI translations are high quality but should be reviewed by native speakers for production use
- Regional information is generic and may not reflect all regional variations

## Future Enhancements

Potential improvements:

- Support for additional languages
- Custom regional configuration per request
- Translation memory/cache to avoid re-translating unchanged content
- Diff-based translation (only translate changed keys)
- Batch processing endpoint for multiple language files
- Quality scoring and validation
