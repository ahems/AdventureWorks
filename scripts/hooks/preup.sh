#!/bin/bash
set -euo pipefail

#############################################
# Color output helpers
#############################################
# Only use colors if output is to a terminal
if [[ -t 1 ]]; then
  color_cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
  color_green() { printf '\033[32m%s\033[0m\n' "$1"; }
  color_yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
  color_red() { printf '\033[31m%s\033[0m\n' "$1"; }
  color_dark_gray() { printf '\033[90m%s\033[0m\n' "$1"; }
else
  color_cyan() { printf '%s\n' "$1"; }
  color_green() { printf '%s\n' "$1"; }
  color_yellow() { printf '%s\n' "$1"; }
  color_red() { printf '%s\n' "$1"; }
  color_dark_gray() { printf '%s\n' "$1"; }
fi

#############################################
# azd environment variable helpers
#############################################
get_azd_value() {
  local name=$1
  local default=${2:-}
  local raw first_line
  
  raw=$(azd env get-value "$name" 2>&1 || true)
  
  # Check for error patterns or empty result
  if [[ "$raw" =~ [Ee][Rr][Rr][Oo][Rr].*not\ found ]] || \
     [[ "$raw" =~ [Nn]o\ value\ found ]] || \
     [[ -z "$raw" ]]; then
    echo "$default"
    return
  fi
  
  # Take only the first line: older azd versions emit a multi-line upgrade warning
  # to stdout after the value (e.g. "WARNING: your version of azd is out of date").
  first_line=$(echo "$raw" | head -n1)
  first_line="${first_line%% WARNING*}"
  echo "$first_line" | xargs
}

set_azd_value() {
  local name=$1
  local value=$2
  azd env set "$name" "$value" >/dev/null 2>&1
}

#############################################
# Azure AI Foundry Account + Model Selection
#############################################
ensure_resource_group() {
  local sub_id=$1
  local rg=$2
  local loc=$3
  
  if az group show -n "$rg" --subscription "$sub_id" &>/dev/null; then
    color_dark_gray "Resource group '$rg' already exists."
  else
    color_green "Creating resource group '$rg' in $loc..."
    az group create --name "$rg" --location "$loc" --subscription "$sub_id" >/dev/null
  fi
}

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
  
  # Filter for location, exclude Batch SKUs, only positive capacity - output to stdout
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

# Get or retrieve subscription ID from Azure CLI
subscription_id=$(get_azd_value "AZURE_SUBSCRIPTION_ID")

if [[ -z "$subscription_id" ]]; then
  color_cyan "AZURE_SUBSCRIPTION_ID not found, retrieving from Azure CLI context..."
  subscription_id=$(az account show --query 'id' -o tsv 2>/dev/null || true)
  if [[ -z "$subscription_id" ]]; then
    color_red "Error: Unable to retrieve subscription ID. Please run 'az login' first."
    exit 1
  fi
  set_azd_value "AZURE_SUBSCRIPTION_ID" "$subscription_id"
  color_green "Persisted AZURE_SUBSCRIPTION_ID to azd env."
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



# Ensure resource_group and env_name are set before any use
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

# Determine resource group location from AZURE_LOCATION (for resource group placement)
rg_location=$(get_azd_value "AZURE_LOCATION")
if [[ -z "$rg_location" ]]; then
  rg_location="eastus2"
  color_cyan "AZURE_LOCATION not set, defaulting to: $rg_location"
  set_azd_value "AZURE_LOCATION" "$rg_location"
else
  color_cyan "Using AZURE_LOCATION for resource group: $rg_location"
fi

# Get AI Foundry location: prefer FOUNDRY_LOCATION from azd env, else use AZURE_LOCATION
color_cyan "Looking for AI Foundry location in FOUNDRY_LOCATION environment variable..."
foundry_location=$(get_azd_value "FOUNDRY_LOCATION")

# Validate location is valid for Cognitive Services if provided
if [[ -n "$foundry_location" ]]; then
  color_cyan "Validating FOUNDRY_LOCATION '$foundry_location' is a valid Azure region for Cognitive Services..."
  valid_locations=$(az provider show --namespace Microsoft.CognitiveServices --query "resourceTypes[?resourceType=='accounts'].locations[]" -o tsv 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d ' ')
  
  # Normalize the foundry_location for comparison (lowercase, no spaces)
  normalized_location=$(echo "$foundry_location" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
  
  if echo "$valid_locations" | grep -q "^${normalized_location}$"; then
    color_green "Validated: '$foundry_location' is a valid region for AI Foundry (Cognitive Services)."
  else
    color_red "Error: FOUNDRY_LOCATION '$foundry_location' is not a valid Azure region for Cognitive Services."
    color_yellow "Valid regions include: $(echo "$valid_locations" | head -10 | tr '\n' ', ')"
    color_yellow "Please set FOUNDRY_LOCATION to a valid region or unset it to use resource group location."
    exit 1
  fi
fi

if [[ -z "$foundry_location" ]]; then
  color_yellow "FOUNDRY_LOCATION not set, using AZURE_LOCATION..."
  foundry_location="$rg_location"
  
  # Validate foundry_location is valid for Cognitive Services
  color_cyan "Validating '$foundry_location' is a valid Azure region for Cognitive Services..."
  valid_locations=$(az provider show --namespace Microsoft.CognitiveServices --query "resourceTypes[?resourceType=='accounts'].locations[]" -o tsv 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d ' ')
  normalized_location=$(echo "$foundry_location" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
  
  if echo "$valid_locations" | grep -q "^${normalized_location}$"; then
    color_green "Validated: '$foundry_location' is a valid region for AI Foundry (Cognitive Services)."
  else
    color_yellow "Warning: '$foundry_location' is not valid for Cognitive Services. Trying alternate regions..."
    # Try common Cognitive Services regions as fallback
    for fallback in "eastus2" "eastus" "westus" "westus2" "swedencentral"; do
      normalized_fallback=$(echo "$fallback" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
      if echo "$valid_locations" | grep -q "^${normalized_fallback}$"; then
        foundry_location="$fallback"
        color_cyan "Using fallback Foundry location: $foundry_location"
        break
      fi
    done
  fi
  
  set_azd_value "FOUNDRY_LOCATION" "$foundry_location"
else
  color_cyan "Using validated Foundry location from FOUNDRY_LOCATION: $foundry_location"
fi

# Get SQL database name from azd environment, default to 'AdventureWorks' if not set
sql_database_name=$(get_azd_value "SQL_DATABASE_NAME")
if [[ -z "$sql_database_name" ]]; then
  sql_database_name='AdventureWorks'
  color_cyan "SQL_DATABASE_NAME not found in azd environment. Setting default: '$sql_database_name'"
  set_azd_value "SQL_DATABASE_NAME" "$sql_database_name"
fi



# Ensure resource group exists before querying its id (use rg_location for resource group)
ensure_resource_group "$subscription_id" "$resource_group" "$rg_location"

# Compute Foundry account name as in Bicep: 'av-ai-${uniqueString(resourceGroup().id)}'
# Note: Bicep's uniqueString uses ONLY resourceGroup().id, not environment name or location
resource_group_id=$(az group show -n "$resource_group" --subscription "$subscription_id" --query id -o tsv 2>/dev/null || true)
if [[ -z "$resource_group_id" ]]; then
  color_red "Error: Could not retrieve resource group id for $resource_group."
  exit 1
fi
# Use Python to compute uniqueString matching Bicep's uniqueString(resourceGroup().id)
account_name=$(python3 -c "import hashlib; print('av-ai-' + hashlib.sha1('$resource_group_id'.encode('utf-8')).hexdigest()[:13].lower())")
set_azd_value "AZURE_OPENAI_ACCOUNT_NAME" "$account_name"
color_cyan "Microsoft Foundry account name: $account_name"

ensure_foundry_account "$subscription_id" "$resource_group" "$account_name" "$foundry_location"

color_cyan "Enumerating models for Microsoft Foundry account '$account_name' in region '$foundry_location'..."
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

# Get quota for each model (parallel with background jobs)
color_green "Retrieving quota for models (parallel)..."

# Create temporary file
quota_file=$(mktemp)
trap "rm -f $quota_file" EXIT

# Use background jobs with manual throttling and separate output files
temp_dir=$(mktemp -d)
trap "rm -rf $temp_dir $quota_file" EXIT

max_jobs=8
job_count=0
file_index=0

while IFS= read -r model_json; do
  name=$(echo "$model_json" | jq -r '.name' 2>&1) || { color_red "Failed to parse name from: $model_json"; continue; }
  version=$(echo "$model_json" | jq -r '.version' 2>&1) || { color_red "Failed to parse version from: $model_json"; continue; }
  format=$(echo "$model_json" | jq -r '.format' 2>&1) || { color_red "Failed to parse format from: $model_json"; continue; }
  [[ "$format" == "" ]] && format="OpenAI"
  
  if (( file_index % 10 == 0 )); then
    color_dark_gray "Processing model $file_index..."
  fi
  
  # Each job writes to its own file
  out_file="$temp_dir/$file_index.json"
  ((file_index++)) || true
  
  # Run in background - wrap in subshell to avoid errexit propagation
  (
    set +e  # Disable errexit for this subshell
    result=$(get_model_quota "$subscription_id" "$account_location" "$name" "$version" "$format")
    if [[ -n "$result" ]]; then
      echo "$result" > "$out_file"
    fi
    exit 0  # Always succeed
  ) &
  
  job_count=$((job_count + 1))
  
  # Throttle: wait if we've reached max concurrent jobs
  while [[ $(jobs -r | wc -l) -ge $max_jobs ]]; do
    sleep 0.1
  done
  
  if (( file_index % 10 == 0 )); then
    color_dark_gray "Processed $file_index models..."
  fi
done < <(echo "$models" | jq -c '.[]')

# Wait for remaining jobs - don't fail if jobs failed
wait || true

# Combine all result files (check if any exist first)
if ls "$temp_dir"/*.json 1> /dev/null 2>&1; then
  cat "$temp_dir"/*.json >> "$quota_file" 2>/dev/null || true
else
  color_yellow "Warning: No quota data collected from API calls."
fi

# Read all quota results, filtering out empty lines and non-JSON content
all_quota=$(grep -v '^$' "$quota_file" 2>/dev/null | grep '^{' 2>/dev/null | jq -s '.' 2>/dev/null || echo "[]")
quota_count=$(echo "$all_quota" | jq 'length')

if [[ "$quota_count" -eq 0 ]]; then
  color_yellow "Warning: No quota data collected."
  exit 0
fi

color_green "Sorting quota results..."
# Sort by AvailableCapacity descending
sorted=$(echo "$all_quota" | jq -c 'sort_by(-.AvailableCapacity)')

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
