#!/bin/bash

# Quick reference for Azure Playwright Testing operations
# This script provides easy access to common commands

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

show_help() {
    echo -e "${BLUE}Azure Playwright Testing - Quick Reference${NC}\n"
    echo "Usage: ./playwright-quick-ref.sh [command]"
    echo ""
    echo "Commands:"
    echo "  info        - Show Playwright workspace information"
    echo "  test        - Run all tests on Azure"
    echo "  dashboard   - Open Azure Portal dashboard"
    echo "  status      - Check workspace status"
    echo "  install     - Install required dependencies"
    echo "  help        - Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./playwright-quick-ref.sh info"
    echo "  ./playwright-quick-ref.sh test"
}

show_info() {
    echo -e "${BLUE}=== Playwright Workspace Information ===${NC}\n"
    
    WORKSPACE_NAME=$(azd env get-value PLAYWRIGHT_WORKSPACE_NAME 2>/dev/null || echo "Not found")
    WORKSPACE_ID=$(azd env get-value PLAYWRIGHT_WORKSPACE_ID 2>/dev/null || echo "Not found")
    SERVICE_URL=$(azd env get-value PLAYWRIGHT_SERVICE_URL 2>/dev/null || echo "Not found")
    DASHBOARD_URL=$(azd env get-value PLAYWRIGHT_DASHBOARD_URL 2>/dev/null || echo "Not found")
    
    echo -e "${GREEN}Workspace Name:${NC} $WORKSPACE_NAME"
    echo -e "${GREEN}Workspace ID:${NC} $WORKSPACE_ID"
    echo -e "${GREEN}Service URL:${NC} $SERVICE_URL"
    echo -e "${GREEN}Dashboard URL:${NC} $DASHBOARD_URL"
    
    if [ "$WORKSPACE_NAME" = "Not found" ]; then
        echo -e "\n${YELLOW}Note: Run 'azd up' to deploy the Playwright workspace.${NC}"
    fi
}

run_tests() {
    echo -e "${BLUE}Running tests on Azure Playwright Testing...${NC}\n"
    ./run-tests-on-azure-playwright.sh "$@"
}

open_dashboard() {
    DASHBOARD_URL=$(azd env get-value PLAYWRIGHT_DASHBOARD_URL 2>/dev/null || echo "")
    
    if [ -z "$DASHBOARD_URL" ]; then
        echo -e "${YELLOW}Error: Dashboard URL not found. Run 'azd up' first.${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}Opening dashboard in browser...${NC}"
    echo -e "${BLUE}$DASHBOARD_URL${NC}"
    
    if command -v xdg-open &> /dev/null; then
        xdg-open "$DASHBOARD_URL"
    elif command -v open &> /dev/null; then
        open "$DASHBOARD_URL"
    else
        echo -e "${YELLOW}Could not open browser automatically. Copy the URL above.${NC}"
    fi
}

check_status() {
    echo -e "${BLUE}Checking workspace status...${NC}\n"
    
    WORKSPACE_NAME=$(azd env get-value PLAYWRIGHT_WORKSPACE_NAME 2>/dev/null || echo "")
    RESOURCE_GROUP=$(azd env get-value AZURE_RESOURCE_GROUP 2>/dev/null || echo "")
    
    if [ -z "$WORKSPACE_NAME" ] || [ -z "$RESOURCE_GROUP" ]; then
        echo -e "${YELLOW}Workspace not deployed. Run 'azd up' first.${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}Workspace Name:${NC} $WORKSPACE_NAME"
    echo -e "${GREEN}Resource Group:${NC} $RESOURCE_GROUP"
    echo ""
    
    # Get workspace details from Azure
    az resource show \
        --name "$WORKSPACE_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --resource-type "Microsoft.AzurePlaywrightService/accounts" \
        --query "{Name:name, Location:location, Status:properties.provisioningState}" \
        --output table
}

install_deps() {
    echo -e "${BLUE}Installing Azure Playwright Testing dependencies...${NC}\n"
    
    cd tests 2>/dev/null || cd "$(dirname "$0")/tests" || {
        echo -e "${YELLOW}Could not find tests directory${NC}"
        exit 1
    }
    
    echo "Installing Node.js dependencies..."
    npm install
    
    echo ""
    echo "Installing @azure/microsoft-playwright-testing..."
    npm install --save-dev @azure/microsoft-playwright-testing
    
    echo ""
    echo "Installing Playwright browsers..."
    npx playwright install chromium
    
    echo -e "\n${GREEN}✓ Dependencies installed successfully${NC}"
}

# Main command routing
case "${1:-help}" in
    info)
        show_info
        ;;
    test)
        shift
        run_tests "$@"
        ;;
    dashboard)
        open_dashboard
        ;;
    status)
        check_status
        ;;
    install)
        install_deps
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo -e "${YELLOW}Unknown command: $1${NC}"
        echo ""
        show_help
        exit 1
        ;;
esac
