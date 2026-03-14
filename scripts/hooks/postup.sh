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
  color_bold() { printf '\033[1m%s\033[0m\n' "$1"; }
else
  color_cyan() { printf '%s\n' "$1"; }
  color_green() { printf '%s\n' "$1"; }
  color_yellow() { printf '%s\n' "$1"; }
  color_bold() { printf '%s\n' "$1"; }
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

#############################################
# Main
#############################################

echo ""
color_bold "╔════════════════════════════════════════════════════════════════════╗"
color_bold "║                                                                    ║"
color_bold "║          🎉  AdventureWorks Demo Deployment Complete!  🎉          ║"
color_bold "║                                                                    ║"
color_bold "╚════════════════════════════════════════════════════════════════════╝"
echo ""

# Get URLs from azd environment
static_web_url=$(get_azd_value "SERVICE_APP_URL")
api_url=$(get_azd_value "API_URL")

# Fallback: try to construct static web app URL from service name
if [[ -z "$static_web_url" ]]; then
  app_name=$(get_azd_value "SERVICE_APP_NAME")
  if [[ -n "$app_name" ]]; then
    # Azure Static Web Apps follow pattern: https://<name>.<random>.azurestaticapps.net
    # We'll need to query Azure to get the actual URL
    resource_group=$(get_azd_value "AZURE_RESOURCE_GROUP")
    subscription_id=$(get_azd_value "AZURE_SUBSCRIPTION_ID")
    
    if [[ -n "$resource_group" ]] && [[ -n "$subscription_id" ]]; then
      static_web_url=$(az staticwebapp show \
        --name "$app_name" \
        --resource-group "$resource_group" \
        --subscription "$subscription_id" \
        --query "defaultHostname" -o tsv 2>/dev/null || true)
      
      if [[ -n "$static_web_url" ]]; then
        static_web_url="https://$static_web_url"
      fi
    fi
  fi
fi

color_green "Your AdventureWorks Demo e-commerce application is now live!"
echo ""
color_cyan "📋 Next Steps:"
echo ""

if [[ -n "$static_web_url" ]]; then
  color_yellow "1. Verify all services are healthy, and awake:"
  echo "   🔍 $static_web_url/health"
  echo ""
  color_yellow "2. Once everything is healthy, explore the site:"
  echo "   🛒 $static_web_url"
  echo ""
else
  color_yellow "1. Check your static web app URL in the Azure Portal"
  color_yellow "2. Visit <your-app-url>/health to verify services"
  color_yellow "3. Explore the site at <your-app-url>"
  echo ""
fi

if [[ -n "$api_url" ]]; then
  # Strip /graphql and any trailing slashes to get base URL
  api_base_url="${api_url%/graphql*}"
  api_base_url="${api_base_url%/}"
  color_yellow "3. Browse the REST API:"
  echo "   📚 $api_base_url/swagger/index.html"
  echo ""
fi

color_cyan "💡 Tips:"
echo "   • Check Application Insights for telemetry and diagnostics"
echo "   • Use 'azd env get-values' to see all environment variables"
echo ""
color_cyan "📚 Documentation:"
echo "   • Quick Start Guide: ./QUICKSTART.md"
echo "   • Frontend Development: ./app/README.md"
echo "   • GraphQL API (DAB): ./api/README.md"
echo "   • Azure Functions: ./api-functions/README.md"
echo "   • Infrastructure (Bicep): ./infra/README.md"
echo "   • Feature Documentation: ./docs/README.md"
echo "   • Utility Scripts: ./scripts/README.md"
echo ""

color_green "Happy exploring! 🚀"
echo ""
