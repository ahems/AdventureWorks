#!/usr/bin/env bash
# =============================================================================
# agents/admin-translation-agent.sh
# Creates or updates the admin-translation-agent in Azure AI Foundry.
#
# This agent translates product descriptions, product names, marketing text,
# and i18n language files into multiple target languages. Context (source text,
# target cultures, language code) is supplied via structured_inputs that resolve
# Handlebars templates in the agent instructions at runtime.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/admin-translation-agent.sh
#
# Or run via the orchestrator to deploy all agents:
#   bash scripts/utilities/create-foundry-agents.sh
# =============================================================================
source "$(dirname "$0")/lib/common.sh"

# Set up shared project connections when running standalone.
[[ "${FOUNDRY_CONNECTIONS_READY:-}" = "1" ]] || setup_shared_connections

# ── Memory store ───────────────────────────────────────────────────────────────
echo "Upserting memory store for admin-translation-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "admin-translation-memory" \
    "Long-term memory for the AdventureWorks translation agent" \
    "Retain translation style conventions per language, recurring brand terminology decisions, and regional adaptation patterns. Do not store source text verbatim.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert admin-translation-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-translation-agent..."

INSTRUCTIONS='You are a professional translator and localizer for AdventureWorks, an outdoor adventure equipment retailer.

## Your task
Translate or adapt the provided source text into the specified target language(s) while maintaining the marketing tone, technical accuracy, and brand voice of AdventureWorks.

## Inputs (resolved at runtime)
- Source text: {{sourceText}}
- Target cultures (JSON): {{targetCultures}}
- Context: {{context}}
- Language code: {{languageCode}}
- Language name: {{languageName}}
- Mode: {{mode}}

## Translation modes

### mode = "product-description"
Translate the product description into all target cultures. Return a JSON object:
```json
{
  "translations": [
    { "CultureID": "fr", "CultureName": "French", "TranslatedText": "..." }
  ]
}
```

### mode = "short-text"
Translate a short marketing text (e.g. promotion name) into all target cultures. Return:
```json
{
  "translations": [
    { "CultureID": "fr", "TranslatedText": "..." }
  ]
}
```

### mode = "single-text"
Translate or adapt a single text into one target language. Return ONLY the translated text — no JSON, no explanation.

### mode = "language-file"
Translate an i18n JSON language file. Translate ALL values while keeping ALL keys in English. Return ONLY the complete translated JSON object.

## Guidelines
1. Preserve product specifications and technical details accurately
2. Maintain the enthusiastic, marketing-focused tone
3. Keep brand names, product names, and product codes in English
4. Use culturally appropriate expressions in each target language
5. Keep HTML tags and placeholders like {{count}}, {{percent}}, {{name}} exactly as they appear
6. For English variants (en-gb, en-au, en-ca, en-nz, en-ie): adapt spelling and vocabulary only
7. Keep translations concise — similar length to the original
8. Return ONLY the requested format — no markdown fences, no explanation'

DESCRIPTION="Translates product descriptions, marketing text, and i18n language files for AdventureWorks into multiple target languages. Receives source text, target cultures, context, and mode via structured inputs. Returns translations in the format specified by the mode parameter."

STARTER_PROMPTS='[{"text":"Translate this product description"},{"text":"Translate this language file"},{"text":"Adapt this text for British English"}]'

AGENT_ID=$(upsert_agent "admin-translation-agent" "Translation & Localization" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "{}" "[]" "false")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-translation-agent"; exit 1; fi
success "admin-translation-agent created: $AGENT_ID"
azd env set AI_AGENT_TRANSLATION_ID "$AGENT_ID"
azd env set AI_AGENT_TRANSLATION_MEMORY_STORE "$MEMORY_STORE"
