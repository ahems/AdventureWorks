#!/bin/bash

# Script to run Playwright tests on Playwright Workspaces (Azure LoadTest Service)
# Replaces deprecated Microsoft Playwright Testing service (retiring 2026-03-08)
#
# Usage: ./run-tests-on-azure-playwright.sh [test-spec]
#
# Examples:
#   ./run-tests-on-azure-playwright.sh                    # Run all tests
#   ./run-tests-on-azure-playwright.sh product-reviews    # Run specific test file
#
# Prerequisites:
# 1. Azure resources deployed via 'azd up'
# 2. Authenticated via 'az login'
# 3. Playwright dependencies installed: cd tests && npm install

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Color output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Azure Playwright Testing - Test Runner ===${NC}\n"

# Check if tests directory exists
if [ ! -d "$TESTS_DIR" ]; then
    echo -e "${RED}Error: tests directory not found at $TESTS_DIR${NC}"
    exit 1
fi

cd "$TESTS_DIR"

# Get Playwright service URL from azd environment
echo -e "${BLUE}Fetching Azure Playwright Testing configuration...${NC}"
PLAYWRIGHT_SERVICE_URL=$(azd env get-value PLAYWRIGHT_SERVICE_URL 2>/dev/null || echo "")

if [ -z "$PLAYWRIGHT_SERVICE_URL" ]; then
    echo -e "${YELLOW}Warning: PLAYWRIGHT_SERVICE_URL not found in azd environment.${NC}"
    echo -e "${YELLOW}Attempting to construct from PLAYWRIGHT_WORKSPACE_NAME...${NC}"
    
    PLAYWRIGHT_WORKSPACE_NAME=$(azd env get-value PLAYWRIGHT_WORKSPACE_NAME 2>/dev/null || echo "")
    AZURE_LOCATION=$(azd env get-value AZURE_LOCATION 2>/dev/null || echo "")
    
    if [ -n "$PLAYWRIGHT_WORKSPACE_NAME" ] && [ -n "$AZURE_LOCATION" ]; then
        PLAYWRIGHT_SERVICE_URL="https://${AZURE_LOCATION}.api.playwright.microsoft.com/accounts/${PLAYWRIGHT_WORKSPACE_NAME}"
        echo -e "${GREEN}Constructed service URL: $PLAYWRIGHT_SERVICE_URL${NC}"
    else
        echo -e "${RED}Error: Could not determine Playwright service URL.${NC}"
        echo -e "${YELLOW}Make sure you've run 'azd up' to deploy the infrastructure.${NC}"
        exit 1
    fi
fi

export PLAYWRIGHT_SERVICE_URL

# Check if user is logged in to Azure CLI
echo -e "\n${BLUE}Verifying Azure CLI authentication...${NC}"
if ! az account show &>/dev/null; then
    echo -e "${RED}Error: Not logged in to Azure CLI.${NC}"
    echo -e "${YELLOW}Please run: az login${NC}"
    exit 1
fi

ACCOUNT_NAME=$(az account show --query "name" -o tsv)
echo -e "${GREEN}✓ Authenticated as: $ACCOUNT_NAME${NC}"

# Check if @azure/playwright is installed
echo -e "\n${BLUE}Checking Playwright dependencies...${NC}"
if ! npm list @azure/playwright &>/dev/null; then
    echo -e "${YELLOW}Installing @azure/playwright and @azure/identity...${NC}"
    npm install --save-dev @azure/playwright @azure/identity
fi

# Install Playwright browsers if needed
if ! npx playwright --version &>/dev/null; then
    echo -e "${YELLOW}Installing Playwright browsers...${NC}"
    npx playwright install chromium
fi

echo -e "${GREEN}✓ Dependencies ready${NC}"

# Prepare test command
TEST_SPEC="${1:-}"
if [ -n "$TEST_SPEC" ]; then
    TEST_CMD="npx playwright test $TEST_SPEC --config=playwright.azure.config.ts"
    echo -e "\n${BLUE}Running test spec: ${TEST_SPEC}${NC}"
else
    TEST_CMD="npx playwright test --config=playwright.azure.config.ts"
    echo -e "\n${BLUE}Running all tests${NC}"
fi

# Display configuration
echo -e "\n${BLUE}Configuration:${NC}"
echo -e "  Service URL: ${GREEN}$PLAYWRIGHT_SERVICE_URL${NC}"
echo -e "  Test Directory: ${GREEN}$TESTS_DIR${NC}"
echo -e "  Config File: ${GREEN}playwright.azure.config.ts${NC}"

# Run tests
echo -e "\n${BLUE}Starting test execution on Playwright Workspaces...${NC}\n"
echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}\n"

if $TEST_CMD; then
    echo -e "\n${YELLOW}═══════════════════════════════════════════════════════${NC}"
    echo -e "\n${GREEN}✓ Tests completed successfully!${NC}\n"
    
    # Show dashboard link
    PLAYWRIGHT_DASHBOARD_URL=$(azd env get-value PLAYWRIGHT_DASHBOARD_URL 2>/dev/null || echo "")
    if [ -n "$PLAYWRIGHT_DASHBOARD_URL" ]; then
        echo -e "${BLUE}View results in Azure Portal:${NC}"
        echo -e "${GREEN}$PLAYWRIGHT_DASHBOARD_URL${NC}"
    fi
    
    exit 0
else
    echo -e "\n${YELLOW}═══════════════════════════════════════════════════════${NC}"
    echo -e "\n${RED}✗ Tests failed. Check the output above for details.${NC}\n"
    
    echo -e "${BLUE}Local report:${NC}"
    echo -e "  Run: ${GREEN}npx playwright show-report${NC}\n"
    
    exit 1
fi
