#!/bin/bash
set -euo pipefail

#############################################
# Color output helpers
#############################################
color_cyan() { echo -e "\033[36m$1\033[0m"; }
color_green() { echo -e "\033[32m$1\033[0m"; }
color_yellow() { echo -e "\033[33m$1\033[0m"; }
color_red() { echo -e "\033[31m$1\033[0m"; }
color_dark_gray() { echo -e "\033[90m$1\033[0m"; }

#############################################
# azd environment variable helpers
#############################################
get_azd_value() {
  local name=$1
  local default=${2:-}
  local raw exit_code
  
  raw=$(azd env get-value "$name" 2>&1 || true)
  exit_code=$?
  
  # Check for error patterns or empty result
  if [[ $exit_code -ne 0 ]] || \
     [[ "$raw" =~ [Ee][Rr][Rr][Oo][Rr].*not\ found ]] || \
     [[ "$raw" =~ [Nn]o\ value\ found ]] || \
     [[ -z "$raw" ]]; then
    echo "$default"
    return
  fi
  
  # Trim whitespace and return
  echo "$raw" | xargs
}

set_azd_value() {
  local name=$1
  local value=$2
  azd env set "$name" "$value" >/dev/null 2>&1
}

#############################################
# Azure AI Foundry Account + Model Selection
#############################################
ensure_foundry_account() {
  local sub_id=$1
  local rg=$2
  local acct=$3
  local loc=$4
  
  if [[ -z "$acct" ]]; then
    color_red "Error: ensure_foundry_account received an empty account name."
    exit 1
  fi
  
  # Check if account exists
  if az cognitiveservices account show -n "$acct" -g "$rg" --subscription "$sub_id" &>/dev/null; then
    local existing_loc
    existing_loc=$(az cognitiveservices account show -n "$acct" -g "$rg" --subscription "$sub_id" --query location -o tsv)
    if [[ "$existing_loc" != "$loc" ]]; then
      color_yellow "Warning: Existing account region '$existing_loc' differs from requested '$loc'; proceeding with existing region."
    fi
  else
    color_green "Creating Microsoft Foundry account '$acct' in $loc..."
    az cognitiveservices account create \
      --name "$acct" \
      --resource-group "$rg" \
      --subscription "$sub_id" \
      --kind AIServices \
      --sku S0 \
      --location "$loc" \
      --custom-domain "$acct" \
      --yes \
      >/dev/null
  fi
}

get_account_models() {
  local sub_id=$1
  local rg=$2
  local acct=$3
  
  local api_version="2025-07-01-preview"
  local url="/subscriptions/$sub_id/resourceGroups/$rg/providers/Microsoft.CognitiveServices/accounts/$acct/models?api-version=$api_version"
  
  local response
  if ! response=$(az rest --method GET --url "$url" 2>&1); then
    color_red "Error: Failed to call models endpoint: $response"
    echo "[]"
    return
  fi
  
  if [[ -z "$response" ]] || [[ "$response" == "null" ]]; then
    color_yellow "Warning: Empty response when enumerating models."
    echo "[]"
    return
  fi
  
  # Parse JSON and extract model info, excluding audio/transcribe/realtime models
  local models
  models=$(echo "$response" | jq -c '
    if type == "object" and has("value") then .value
    elif type == "array" then .
    else []
    end |
    map(select(.name != null and (.name | test("realtime|transcribe|audio"; "i") | not))) |
    map({
      name: .name,
      format: (if .format then .format else "" end),
      version: (if .version then .version else "" end)
    })
  ' 2>/dev/null || echo "[]")
  
  echo "$models"
}

url_encode() {
  local string="${1}"
  local strlen=${#string}
  local encoded=""
  local pos c o
  
  for (( pos=0 ; pos<strlen ; pos++ )); do
    c=${string:$pos:1}
    case "$c" in
      [-_.~a-zA-Z0-9] ) o="${c}" ;;
      * ) printf -v o '%%%02x' "'$c"
    esac
    encoded+="${o}"
  done
  echo "${encoded}"
}

get_model_quota() {
  local sub_id=$1
  local location=$2
  local model_name=$3
  local model_version=$4
  local model_format=${5:-OpenAI}
  
  local api_version="2024-10-01"
  local encoded_format encoded_name encoded_version
  
  encoded_format=$(url_encode "$model_format")
  encoded_name=$(url_encode "$model_name")
  encoded_version=$(url_encode "$model_version")
  
  local url="/subscriptions/$sub_id/providers/Microsoft.CognitiveServices/modelCapacities?api-version=$api_version&modelFormat=$encoded_format&modelName=$encoded_name&modelVersion=$encoded_version"
  
  local response
  if ! response=$(az rest --method GET --url "$url" 2>/dev/null); then
    return
  fi
  
  # Filter for location, exclude Batch SKUs, only positive capacity
  echo "$response" | jq -c --arg loc "$location" '
    .value[]? |
    select(.location | ascii_downcase == ($loc | ascii_downcase)) |
    select(.properties.skuName | test("Batch$") | not) |
    select(.properties.availableCapacity > 0) |
    {
      Location: .location,
      SkuName: .properties.skuName,
      ModelFormat: .properties.model.format,
      ModelName: .properties.model.name,
      ModelVersion: .properties.model.version,
      AvailableCapacity: .properties.availableCapacity
    }
  ' 2>/dev/null || true
}

#############################################
# MAIN EXECUTION FLOW
#############################################

subscription_id=$(get_azd_value "AZURE_SUBSCRIPTION_ID")

if [[ -z "$subscription_id" ]]; then
  color_yellow "Warning: AZURE_SUBSCRIPTION_ID not found in azd environment. This may be required for model enumeration."
fi

# Ensure NAME & OBJECT_ID env vars (user context) using Azure CLI
name_val=$(get_azd_value "NAME")
object_id_val=$(get_azd_value "OBJECT_ID")

if [[ -z "$name_val" ]] || [[ -z "$object_id_val" ]]; then
  color_cyan "Retrieving current user information from Azure CLI..."
  name_val=$(az account show --query 'user.name' -o tsv)
  object_id_val=$(az ad signed-in-user show --query 'id' -o tsv)
  set_azd_value "NAME" "$name_val"
  set_azd_value "OBJECT_ID" "$object_id_val"
  color_green "Persisted NAME and OBJECT_ID to azd env."
fi

# Azure AI Foundry provisioning + model selection (skip if already fully selected)
existing_chat_complete=""
existing_emb_complete=""
existing_image_complete=""

[[ -n "$(get_azd_value chatGptDeploymentVersion)" ]] && \
[[ -n "$(get_azd_value chatGptSkuName)" ]] && \
[[ -n "$(get_azd_value chatGptModelName)" ]] && \
[[ -n "$(get_azd_value availableChatGptDeploymentCapacity)" ]] && \
  existing_chat_complete="true"

[[ -n "$(get_azd_value embeddingDeploymentVersion)" ]] && \
[[ -n "$(get_azd_value embeddingDeploymentSkuName)" ]] && \
[[ -n "$(get_azd_value embeddingDeploymentModelName)" ]] && \
[[ -n "$(get_azd_value availableEmbeddingDeploymentCapacity)" ]] && \
  existing_emb_complete="true"

[[ -n "$(get_azd_value imageDeploymentVersion)" ]] && \
[[ -n "$(get_azd_value imageDeploymentSkuName)" ]] && \
[[ -n "$(get_azd_value imageDeploymentModelName)" ]] && \
[[ -n "$(get_azd_value imageModelFormat)" ]] && \
[[ -n "$(get_azd_value availableImageDeploymentCapacity)" ]] && \
  existing_image_complete="true"

if [[ "$existing_chat_complete" == "true" ]] && \
   [[ "$existing_emb_complete" == "true" ]] && \
   [[ "$existing_image_complete" == "true" ]]; then
  color_yellow "Model selections already present. Skipping model discovery."
  exit 0
fi

# Get cognitive services location (AI Foundry region), with fallback to main Azure location
cognitive_services_location=$(get_azd_value "cognitiveservicesLocation")
if [[ -z "$cognitive_services_location" ]]; then
  cognitive_services_location=$(get_azd_value "AZURE_LOCATION" "eastus2")
  set_azd_value "cognitiveservicesLocation" "$cognitive_services_location"
  color_cyan "Set cognitiveservicesLocation = $cognitive_services_location (from AZURE_LOCATION)"
fi
location=$cognitive_services_location

# Persist default Azure location if it was not previously set
if [[ -z "$(get_azd_value AZURE_LOCATION)" ]]; then
  set_azd_value "AZURE_LOCATION" "$location"
  color_cyan "Set default AZURE_LOCATION = $location"
fi

# Get SQL database name from azd environment, default to 'AdventureWorks' if not set
sql_database_name=$(get_azd_value "SQL_DATABASE_NAME")
if [[ -z "$sql_database_name" ]]; then
  sql_database_name='AdventureWorks'
  echo "SQL_DATABASE_NAME not found in azd environment. Setting default: '$sql_database_name'"
  set_azd_value "SQL_DATABASE_NAME" "$sql_database_name"
fi

resource_group=$(get_azd_value "AZURE_RESOURCE_GROUP")
env_name=$(get_azd_value "AZURE_ENV_NAME")
if [[ -z "$resource_group" ]]; then
  if [[ -z "$env_name" ]]; then
    color_red "Error: AZURE_RESOURCE_GROUP not set and cannot derive because AZURE_ENV_NAME is missing."
    exit 1
  fi
  resource_group="rg-$env_name"
  set_azd_value "AZURE_RESOURCE_GROUP" "$resource_group"
  color_cyan "Derived and set AZURE_RESOURCE_GROUP = $resource_group"
fi

account_name=$(get_azd_value "AZURE_OPENAI_ACCOUNT_NAME")
if [[ -z "$account_name" ]]; then
  # Generate a random hash similar to PowerShell's approach
  hash=$(cat /dev/urandom | tr -dc 'a-f0-9' | fold -w 8 | head -n 1)
  account_name="av-openai-$hash"
  set_azd_value "AZURE_OPENAI_ACCOUNT_NAME" "$account_name"
  color_cyan "Derived Microsoft Foundry account name: $account_name"
fi

ensure_foundry_account "$subscription_id" "$resource_group" "$account_name" "$location"

color_cyan "Enumerating models for Microsoft Foundry account '$account_name' in region '$location'..."
if [[ -z "$subscription_id" ]]; then
  color_red "Error: Subscription id is missing; cannot enumerate models."
  exit 1
fi

models=$(get_account_models "$subscription_id" "$resource_group" "$account_name")
model_count=$(echo "$models" | jq 'length')

if [[ "$model_count" -eq 0 ]]; then
  color_red "Error: No models returned from Microsoft Foundry account; aborting preup hook."
  exit 1
fi

# Filter to OpenAI-format models
original_model_count=$model_count
models=$(echo "$models" | jq -c '[.[] | select(.format == "" or (.format | ascii_downcase == "openai"))]')
model_count=$(echo "$models" | jq 'length')

if [[ $model_count -lt $original_model_count ]]; then
  skipped_count=$((original_model_count - model_count))
  color_dark_gray "Filtered models: using $model_count OpenAI models out of $original_model_count total (skipped $skipped_count non-OpenAI)."
fi

# Get account location for quota queries
account_location=$(az cognitiveservices account show \
  -n "$account_name" \
  -g "$resource_group" \
  --subscription "$subscription_id" \
  --query location -o tsv)

# Get quota for each model (parallel execution)
throttle=${AOAI_QUOTA_DOP:-8}
color_green "Retrieving quota in parallel (ThrottleLimit=$throttle)..."

# Create temporary files for parallel processing
quota_file=$(mktemp)
trap "rm -f $quota_file" EXIT

# Export functions and variables for parallel execution
export -f get_model_quota url_encode
export subscription_id account_location

# Process models in parallel
echo "$models" | jq -c '.[]' | xargs -P "$throttle" -I {} bash -c '
  model_json="{}"
  name=$(echo "$model_json" | jq -r ".name")
  version=$(echo "$model_json" | jq -r ".version")
  format=$(echo "$model_json" | jq -r ".format")
  [[ "$format" == "" ]] && format="OpenAI"
  
  get_model_quota "$subscription_id" "$account_location" "$name" "$version" "$format"
' >> "$quota_file"

# Read all quota results
all_quota=$(cat "$quota_file" | jq -s '.')
quota_count=$(echo "$all_quota" | jq 'length')

if [[ "$quota_count" -eq 0 ]]; then
  color_yellow "Warning: No quota data collected."
  exit 0
fi

color_green "Sorting quota results..."
# Sort by AvailableCapacity descending, then ModelVersion descending
sorted=$(echo "$all_quota" | jq -c 'sort_by(-.AvailableCapacity, -.ModelVersion)')

# Select chat model with preference for 'mini' models, then exclude 'nano', then any available
chat_pick=$(echo "$sorted" | jq -c 'first(.[] | select(.ModelName | test("mini"; "i")))' 2>/dev/null || echo "null")
if [[ "$chat_pick" == "null" ]] || [[ -z "$chat_pick" ]]; then
  chat_pick=$(echo "$sorted" | jq -c 'first(.[] | select(.ModelName | test("nano"; "i") | not))' 2>/dev/null || echo "null")
fi
if [[ "$chat_pick" == "null" ]] || [[ -z "$chat_pick" ]]; then
  chat_pick=$(echo "$sorted" | jq -c 'first(.[])' 2>/dev/null || echo "null")
fi

if [[ "$chat_pick" != "null" ]] && [[ -n "$chat_pick" ]]; then
  set_azd_value "chatGptDeploymentVersion" "$(echo "$chat_pick" | jq -r '.ModelVersion')"
  set_azd_value "chatGptSkuName" "$(echo "$chat_pick" | jq -r '.SkuName')"
  set_azd_value "chatGptModelName" "$(echo "$chat_pick" | jq -r '.ModelName')"
  set_azd_value "availableChatGptDeploymentCapacity" "$(echo "$chat_pick" | jq -r '.AvailableCapacity')"
  
  model_name=$(echo "$chat_pick" | jq -r '.ModelName')
  model_version=$(echo "$chat_pick" | jq -r '.ModelVersion')
  sku_name=$(echo "$chat_pick" | jq -r '.SkuName')
  capacity=$(echo "$chat_pick" | jq -r '.AvailableCapacity')
  color_green "Selected Chat model: $model_name $model_version SKU $sku_name Capacity $capacity"
else
  color_yellow "Warning: No chat model selected."
fi

# Select embedding model with preference for 'small' models, then any available
embedding_candidates=$(echo "$sorted" | jq -c '[.[] | select(.ModelName | contains("embedding"))]')
embedding_pick=$(echo "$embedding_candidates" | jq -c 'first(.[] | select(.ModelName | test("small"; "i")))' 2>/dev/null || echo "null")
if [[ "$embedding_pick" == "null" ]] || [[ -z "$embedding_pick" ]]; then
  embedding_pick=$(echo "$embedding_candidates" | jq -c 'first(.[])' 2>/dev/null || echo "null")
fi

if [[ "$embedding_pick" != "null" ]] && [[ -n "$embedding_pick" ]]; then
  set_azd_value "embeddingDeploymentVersion" "$(echo "$embedding_pick" | jq -r '.ModelVersion')"
  set_azd_value "embeddingDeploymentSkuName" "$(echo "$embedding_pick" | jq -r '.SkuName')"
  set_azd_value "embeddingDeploymentModelName" "$(echo "$embedding_pick" | jq -r '.ModelName')"
  set_azd_value "availableEmbeddingDeploymentCapacity" "$(echo "$embedding_pick" | jq -r '.AvailableCapacity')"
  
  model_name=$(echo "$embedding_pick" | jq -r '.ModelName')
  model_version=$(echo "$embedding_pick" | jq -r '.ModelVersion')
  sku_name=$(echo "$embedding_pick" | jq -r '.SkuName')
  capacity=$(echo "$embedding_pick" | jq -r '.AvailableCapacity')
  color_green "Selected Embeddings model: $model_name $model_version SKU $sku_name Capacity $capacity"
else
  color_yellow "Warning: No embeddings model selected."
fi

# Select image generation model (specifically filter for gpt-image-1)
image_candidates=$(echo "$sorted" | jq -c '[.[] | select(.ModelName | test("^gpt-?image-?1$"; "i"))]')
image_pick=$(echo "$image_candidates" | jq -c 'first(.[])' 2>/dev/null || echo "null")

if [[ "$image_pick" != "null" ]] && [[ -n "$image_pick" ]]; then
  set_azd_value "imageDeploymentVersion" "$(echo "$image_pick" | jq -r '.ModelVersion')"
  set_azd_value "imageDeploymentSkuName" "$(echo "$image_pick" | jq -r '.SkuName')"
  set_azd_value "imageDeploymentModelName" "gpt-image-1"
  set_azd_value "imageModelFormat" "$(echo "$image_pick" | jq -r '.ModelFormat')"
  set_azd_value "availableImageDeploymentCapacity" "$(echo "$image_pick" | jq -r '.AvailableCapacity')"
  
  model_version=$(echo "$image_pick" | jq -r '.ModelVersion')
  sku_name=$(echo "$image_pick" | jq -r '.SkuName')
  model_format=$(echo "$image_pick" | jq -r '.ModelFormat')
  capacity=$(echo "$image_pick" | jq -r '.AvailableCapacity')
  color_green "Selected Image model: gpt-image-1 $model_version SKU $sku_name Format $model_format Capacity $capacity"
else
  color_yellow "Warning: No gpt-image-1 model available in Azure catalog for this region. Bicep will skip image model deployment."
fi

color_cyan "preup.sh completed."
