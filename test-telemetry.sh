#!/bin/bash

# Test Application Insights Telemetry
# This script provides shortcuts for running telemetry validation tests

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Application Insights Telemetry Testing                ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if azd environment is configured
if ! azd env get-values &> /dev/null; then
    echo -e "${RED}❌ Error: azd environment not found${NC}"
    echo "Please run 'azd up' or 'azd env select' first"
    exit 1
fi

# Check Azure authentication
if ! az account show &> /dev/null; then
    echo -e "${YELLOW}⚠️  Not logged in to Azure${NC}"
    echo "Running 'az login'..."
    az login
fi

# Get environment info
APP_INSIGHTS_NAME=$(azd env get-value "SERVICE_APP_NAME" 2>/dev/null || echo "")
RESOURCE_GROUP=$(azd env get-value "AZURE_RESOURCE_GROUP" 2>/dev/null || echo "")
WEB_URL=$(azd env get-value "APP_REDIRECT_URI" 2>/dev/null || echo "")

echo -e "${GREEN}Environment Configuration:${NC}"
echo "  App Insights: ${APP_INSIGHTS_NAME}"
echo "  Resource Group: ${RESOURCE_GROUP}"
echo "  Web URL: ${WEB_URL}"
echo ""

# Menu
echo "Select test mode:"
echo ""
echo -e "${BLUE}1)${NC} Quick Network Validation (30 seconds)"
echo "   ✓ Intercepts telemetry requests"
echo "   ✓ Verifies data is being sent"
echo "   ✗ Doesn't verify data storage"
echo ""
echo -e "${BLUE}2)${NC} Full End-to-End Validation (3-4 minutes)"
echo "   ✓ Queries Application Insights"
echo "   ✓ Verifies data is stored"
echo "   ✓ Validates event properties"
echo "   ⏱  Includes 90s ingestion delay"
echo ""
echo -e "${BLUE}3)${NC} Both Tests"
echo ""
echo -e "${BLUE}4)${NC} Manual Query (custom Kusto query)"
echo ""
echo -e "${BLUE}5)${NC} View Recent Telemetry (last 30 minutes)"
echo ""

read -p "Enter choice [1-5]: " choice

case $choice in
    1)
        echo -e "\n${GREEN}Running network validation test...${NC}\n"
        cd tests
        npx playwright test telemetry.spec.ts --reporter=list
        ;;
    2)
        echo -e "\n${GREEN}Running full end-to-end validation...${NC}"
        echo -e "${YELLOW}⚠️  This test takes 3-4 minutes due to Application Insights ingestion delay${NC}\n"
        cd tests
        npx playwright test telemetry-validation.spec.ts --reporter=list
        ;;
    3)
        echo -e "\n${GREEN}Running both tests...${NC}\n"
        cd tests
        npx playwright test telemetry --reporter=list
        ;;
    4)
        echo -e "\n${GREEN}Manual Query Mode${NC}"
        echo "Enter your Kusto query (press Ctrl+D when done):"
        echo ""
        query=$(cat)
        
        echo -e "\n${GREEN}Executing query...${NC}\n"
        az monitor app-insights query \
            --app "${APP_INSIGHTS_NAME}" \
            --resource-group "${RESOURCE_GROUP}" \
            --analytics-query "${query}" \
            --output table
        ;;
    5)
        echo -e "\n${GREEN}Recent Telemetry Summary (Last 30 minutes)${NC}\n"
        
        echo -e "${BLUE}Custom Events:${NC}"
        az monitor app-insights query \
            --app "${APP_INSIGHTS_NAME}" \
            --resource-group "${RESOURCE_GROUP}" \
            --analytics-query "customEvents | where timestamp > ago(30m) | summarize Count=count() by name | order by Count desc" \
            --output table
        
        echo -e "\n${BLUE}Page Views:${NC}"
        az monitor app-insights query \
            --app "${APP_INSIGHTS_NAME}" \
            --resource-group "${RESOURCE_GROUP}" \
            --analytics-query "pageViews | where timestamp > ago(30m) | summarize Count=count() by name | order by Count desc | take 10" \
            --output table
        
        echo -e "\n${BLUE}Recent Events (Last 10):${NC}"
        az monitor app-insights query \
            --app "${APP_INSIGHTS_NAME}" \
            --resource-group "${RESOURCE_GROUP}" \
            --analytics-query "union customEvents, pageViews | where timestamp > ago(30m) | project timestamp, itemType, name | order by timestamp desc | take 10" \
            --output table
        ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}✅ Done!${NC}"
echo ""
echo "For more information, see: tests/TELEMETRY_TESTING.md"
