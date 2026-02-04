#!/bin/bash

# Generate Application Insights Telemetry for Demo Analysis
# This script runs browsing sessions that create rich telemetry data

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Application Insights Telemetry Generator              ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check environment
if ! azd env get-values &> /dev/null; then
    echo -e "${RED}❌ Error: azd environment not found${NC}"
    echo "Please run 'azd up' first"
    exit 1
fi

WEB_URL=$(azd env get-value "APP_REDIRECT_URI" 2>/dev/null || echo "")
APP_INSIGHTS_NAME=$(azd env get-value "SERVICE_APP_NAME" 2>/dev/null || echo "")
RESOURCE_GROUP=$(azd env get-value "AZURE_RESOURCE_GROUP" 2>/dev/null || echo "")

echo -e "${GREEN}Configuration:${NC}"
echo "  Web URL: ${WEB_URL}"
echo "  App Insights: ${APP_INSIGHTS_NAME}"
echo ""

echo "This script generates realistic browsing telemetry for demo purposes."
echo ""
echo -e "${YELLOW}Select session type:${NC}"
echo ""
echo -e "${BLUE}1)${NC} Single Extended Session (5-7 minutes)"
echo "   - Anonymous bargain hunter who browses extensively"
echo "   - Views 6-10 products in detail"
echo "   - Cycles through product image galleries"
echo "   - Performs multiple searches"
echo "   - Adds 2-4 items to cart"
echo "   - Eventually abandons cart"
echo "   - Generates ~50-100 telemetry events"
echo ""
echo -e "${BLUE}2)${NC} Multiple Quick Sessions (3-4 minutes)"
echo "   - Simulates 3 different user personas"
echo "   - Window shopper, quick buyer, comparison shopper"
echo "   - Each has different browsing patterns"
echo "   - Generates ~40-60 telemetry events"
echo ""
echo -e "${BLUE}3)${NC} Both (8-11 minutes)"
echo "   - Runs both session types"
echo "   - Maximum telemetry generation"
echo "   - Generates ~90-160 telemetry events"
echo ""
echo -e "${BLUE}4)${NC} Continuous Generation (runs until stopped)"
echo "   - Repeatedly runs browsing sessions"
echo "   - Press Ctrl+C to stop"
echo "   - Generates hundreds of events"
echo ""
echo -e "${BLUE}5)${NC} View Recent Telemetry Summary"
echo ""

read -p "Enter choice [1-5]: " choice

case $choice in
    1)
        echo -e "\n${GREEN}Running extended browsing session...${NC}"
        echo -e "${YELLOW}⏱️  This will take 5-7 minutes${NC}\n"
        cd tests
        npx playwright test telemetry-generator.spec.ts -g "bargain hunter" --reporter=list
        ;;
    2)
        echo -e "\n${GREEN}Running multiple quick sessions...${NC}"
        echo -e "${YELLOW}⏱️  This will take 3-4 minutes${NC}\n"
        cd tests
        npx playwright test telemetry-generator.spec.ts -g "multiple short" --reporter=list
        ;;
    3)
        echo -e "\n${GREEN}Running all telemetry generation tests...${NC}"
        echo -e "${YELLOW}⏱️  This will take 8-11 minutes${NC}\n"
        cd tests
        npx playwright test telemetry-generator.spec.ts --reporter=list
        ;;
    4)
        echo -e "\n${GREEN}Starting continuous telemetry generation...${NC}"
        echo -e "${YELLOW}⏱️  Press Ctrl+C to stop${NC}\n"
        
        session_count=0
        while true; do
            session_count=$((session_count + 1))
            echo -e "\n${BLUE}═══════════════════════════════════════════════${NC}"
            echo -e "${BLUE}Session #${session_count}${NC}"
            echo -e "${BLUE}═══════════════════════════════════════════════${NC}\n"
            
            cd tests
            npx playwright test telemetry-generator.spec.ts --reporter=list || true
            cd ..
            
            echo -e "\n${GREEN}✅ Session ${session_count} complete${NC}"
            echo -e "${YELLOW}⏳ Waiting 10 seconds before next session...${NC}\n"
            sleep 10
        done
        ;;
    5)
        echo -e "\n${GREEN}Recent Telemetry Summary (Last 1 hour)${NC}\n"
        
        if ! az account show &> /dev/null; then
            echo -e "${YELLOW}Not logged in to Azure. Logging in...${NC}"
            az login
        fi
        
        echo -e "${BLUE}📊 Custom Events by Type:${NC}"
        az monitor app-insights query \
            --app "${APP_INSIGHTS_NAME}" \
            --resource-group "${RESOURCE_GROUP}" \
            --analytics-query "customEvents | where timestamp > ago(1h) | summarize Count=count() by name | order by Count desc" \
            --output table
        
        echo -e "\n${BLUE}📄 Page Views:${NC}"
        az monitor app-insights query \
            --app "${APP_INSIGHTS_NAME}" \
            --resource-group "${RESOURCE_GROUP}" \
            --analytics-query "pageViews | where timestamp > ago(1h) | summarize Count=count() by name | order by Count desc" \
            --output table
        
        echo -e "\n${BLUE}🛒 Cart Behavior:${NC}"
        az monitor app-insights query \
            --app "${APP_INSIGHTS_NAME}" \
            --resource-group "${RESOURCE_GROUP}" \
            --analytics-query "customEvents | where timestamp > ago(1h) | where name in ('Product_AddToCart', 'Purchase_Complete') | summarize Count=count() by name" \
            --output table
        
        echo -e "\n${BLUE}👤 Unique Sessions:${NC}"
        az monitor app-insights query \
            --app "${APP_INSIGHTS_NAME}" \
            --resource-group "${RESOURCE_GROUP}" \
            --analytics-query "union pageViews, customEvents | where timestamp > ago(1h) | summarize UniqueUsers=dcount(user_Id), UniqueSessions=dcount(session_Id), TotalEvents=count()" \
            --output table
        
        echo -e "\n${BLUE}🔍 Search Queries (if tracked):${NC}"
        az monitor app-insights query \
            --app "${APP_INSIGHTS_NAME}" \
            --resource-group "${RESOURCE_GROUP}" \
            --analytics-query "customEvents | where timestamp > ago(1h) | where name == 'Search_Query' | project timestamp, customDimensions | take 10" \
            --output table || echo "No search events found"
        
        echo -e "\n${BLUE}⏱️  Session Duration Stats:${NC}"
        az monitor app-insights query \
            --app "${APP_INSIGHTS_NAME}" \
            --resource-group "${RESOURCE_GROUP}" \
            --analytics-query "pageViews | where timestamp > ago(1h) | summarize AvgDuration=avg(duration), MaxDuration=max(duration), MinDuration=min(duration), SessionCount=dcount(session_Id)" \
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

if [[ "$choice" != "5" ]]; then
    echo -e "${YELLOW}💡 Tip: Wait 2-3 minutes for Application Insights to ingest the data${NC}"
    echo ""
    echo "Then run one of these commands to analyze the telemetry:"
    echo ""
    echo -e "${BLUE}View summary:${NC}"
    echo "  ./generate-telemetry.sh  (choose option 5)"
    echo ""
    echo -e "${BLUE}Query specific events:${NC}"
    echo "  az monitor app-insights query \\"
    echo "    --app \"${APP_INSIGHTS_NAME}\" \\"
    echo "    --resource-group \"${RESOURCE_GROUP}\" \\"
    echo "    --analytics-query \"customEvents | where timestamp > ago(1h) | summarize count() by name\""
    echo ""
    echo -e "${BLUE}Open in Azure Portal:${NC}"
    echo "  https://portal.azure.com/#@/resource/subscriptions/\$(az account show --query id -o tsv)/resourceGroups/${RESOURCE_GROUP}/providers/microsoft.insights/components/${APP_INSIGHTS_NAME}/logs"
fi

echo ""
