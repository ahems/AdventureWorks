#!/usr/bin/env bash
# =============================================================================
# agents/admin-customer-agent.sh
# Creates or updates the admin-customer-agent in Azure AI Foundry.
#
# Run standalone to deploy only this agent:
#   bash scripts/utilities/agents/admin-customer-agent.sh
#
# Or run via the orchestrator to deploy all agents:
#   bash scripts/utilities/create-foundry-agents.sh
# =============================================================================
source "$(dirname "$0")/lib/common.sh"

# Set up shared project connections when running standalone.
# The orchestrator sets FOUNDRY_CONNECTIONS_READY=1 before calling this script,
# which skips the duplicate connection upserts.
[[ "${FOUNDRY_CONNECTIONS_READY:-}" = "1" ]] || setup_shared_connections

# ── Memory store ───────────────────────────────────────────────────────────────
echo "Upserting memory store for admin-customer-agent..."
MEMORY_STORE=$(upsert_memory_store \
    "admin-customer-memory" \
    "Long-term memory for the AdventureWorks customer generation agent, scoped per locale" \
    "Retain recently generated customer names, cities, and email domains per locale so the agent produces varied and non-repetitive profiles across successive runs. Never store real personal data — all generated profiles are entirely fictional.")
if [ -z "$MEMORY_STORE" ]; then error "Failed to upsert admin-customer-memory"; exit 1; fi
success "Memory store ready: $MEMORY_STORE"
echo ""

# ── Agent definition ───────────────────────────────────────────────────────────
echo "Creating/updating admin-customer-agent..."

INSTRUCTIONS="You are a customer profile generation agent for AdventureWorks. Your role is to invent a realistic, completely fictitious customer profile appropriate for a given locale.

## Context
- Today's date: {{todayDate}}
- Target locale: {{locale}}

## Requirements
Generate a single fictitious customer profile culturally appropriate for the target locale:
- **firstName** and **lastName**: typical names for that locale/culture
- **email**: firstname.lastname style with a plausible domain (gmail, yahoo, hotmail, or a popular local domain for that country). Use lowercase.
- **phone**: correct country dialling code and format for the locale
- **addressLine1**: realistic street address format for that country
- **city**: a real city in that country
- **stateCode**: 2-3 letter province/state/region code; use the local equivalent (e.g. \"BY\" for Bavaria in Germany, \"IDF\" for Île-de-France). If the country has no states, use a plausible 2-letter abbreviation.
- **postalCode**: correct format for the country (e.g. 5-digit for US/DE, alphanumeric for UK/CA)
- **country**: full English name of the country

## Diversity
Use your memory of recently generated profiles for this locale to produce a varied result — different names, cities, and address styles each time.

## Response format
Return ONLY a valid JSON object with no markdown fences, no comments, no extra text:
{
  \"firstName\": \"...\",
  \"lastName\": \"...\",
  \"email\": \"...\",
  \"phone\": \"...\",
  \"addressLine1\": \"...\",
  \"city\": \"...\",
  \"stateCode\": \"...\",
  \"postalCode\": \"...\",
  \"country\": \"...\"
}"

DESCRIPTION="Generates realistic, completely fictitious customer profiles for any locale. Produces culturally appropriate names, addresses, phone numbers, and emails. Uses memory to ensure variety across successive runs for the same locale."

STARTER_PROMPTS='[{"text":"Generate a German customer profile"},{"text":"Generate a Japanese customer profile"},{"text":"Generate a Brazilian customer profile"},{"text":"Generate a French customer profile"},{"text":"Generate a US customer profile"}]'

# structured_inputs resolve Handlebars templates in the agent instructions.
STRUCTURED_INPUTS='{
  "locale":    {"type": "string", "description": "IETF locale code or country name identifying the target culture (e.g. \"de\" for German, \"ja\" for Japanese, \"fr-CA\" for Canadian French).", "default_value": "en"},
  "todayDate": {"type": "string", "description": "Today'\''s date (YYYY-MM-DD).", "default_value": ""}
}'

AGENT_ID=$(upsert_agent "admin-customer-agent" "Customer Profile Generator" "$INSTRUCTIONS" "$MEMORY_STORE" "$DESCRIPTION" "$STARTER_PROMPTS" "$STRUCTURED_INPUTS")
if [ -z "$AGENT_ID" ]; then error "Failed to create admin-customer-agent"; exit 1; fi
success "admin-customer-agent created: $AGENT_ID"
azd env set AI_AGENT_CUSTOMER_ID "$AGENT_ID"
azd env set AI_AGENT_CUSTOMER_MEMORY_STORE "$MEMORY_STORE"
