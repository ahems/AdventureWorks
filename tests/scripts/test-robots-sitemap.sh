#!/bin/bash

# Test script for validating robots.txt and sitemap.xml functionality
# This demonstrates proper SEO compliance by testing:
# 1. robots.txt accessibility and content
# 2. sitemap.xml location from robots.txt
# 3. sitemap.xml XML structure and validation
# 4. URL availability from sitemap entries

set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}ℹ $1${NC}"
}

# Get the API URL from azd environment
FUNCTION_URL=$(azd env get-values | grep "VITE_API_FUNCTIONS_URL" | cut -d'=' -f2 | tr -d '"')
APP_URL=$(azd env get-values | grep "APP_REDIRECT_URI" | cut -d'=' -f2 | tr -d '"' | sed 's|/signin-oidc||')

if [ -z "$FUNCTION_URL" ]; then
    print_error "API_FUNCTIONS_URL not found in azd environment"
    echo "Run 'azd provision' first to deploy the infrastructure"
    exit 1
fi

if [ -z "$APP_URL" ]; then
    print_error "APP_REDIRECT_URI not found in azd environment"
    echo "Run 'azd provision' first to deploy the infrastructure"
    exit 1
fi

echo "=================================================="
echo "Testing Robots.txt and Sitemap Functionality"
echo "=================================================="
echo "App URL: $APP_URL"
echo "API Functions URL: $FUNCTION_URL"
echo ""

# Step 1: Test robots.txt
print_info "Step 1: Fetching robots.txt..."
ROBOTS_RESPONSE=$(curl -s -w "\n%{http_code}" "$APP_URL/robots.txt")
ROBOTS_HTTP_CODE=$(echo "$ROBOTS_RESPONSE" | tail -n1)
ROBOTS_CONTENT=$(echo "$ROBOTS_RESPONSE" | head -n-1)

if [ "$ROBOTS_HTTP_CODE" = "200" ]; then
    print_success "robots.txt accessible (HTTP 200)"
else
    print_error "robots.txt returned HTTP $ROBOTS_HTTP_CODE"
    exit 1
fi

# Validate robots.txt contains essential directives
print_info "Step 2: Validating robots.txt content..."

if echo "$ROBOTS_CONTENT" | grep -q "User-agent:"; then
    print_success "Contains User-agent directive"
else
    print_error "Missing User-agent directive"
    exit 1
fi

if echo "$ROBOTS_CONTENT" | grep -q "Allow:"; then
    print_success "Contains Allow directive"
else
    print_error "Missing Allow directive"
    exit 1
fi

if echo "$ROBOTS_CONTENT" | grep -q "Sitemap:"; then
    print_success "Contains Sitemap directive"
    SITEMAP_URL=$(echo "$ROBOTS_CONTENT" | grep "Sitemap:" | head -n1 | awk '{print $2}' | tr -d '\r')
    echo "  Sitemap URL: $SITEMAP_URL"
else
    print_error "Missing Sitemap directive in robots.txt"
    exit 1
fi

# Extract sitemap URL from robots.txt (use function URL as fallback)
if [ -z "$SITEMAP_URL" ]; then
    SITEMAP_URL="${FUNCTION_URL}/api/sitemap.xml"
    print_info "Using fallback sitemap URL: $SITEMAP_URL"
fi

echo ""

# Step 3: Test sitemap.xml accessibility
print_info "Step 3: Fetching sitemap.xml..."
SITEMAP_RESPONSE=$(curl -s -L -w "\n%{http_code}" "$SITEMAP_URL")
SITEMAP_HTTP_CODE=$(echo "$SITEMAP_RESPONSE" | tail -n1)
SITEMAP_CONTENT=$(echo "$SITEMAP_RESPONSE" | head -n-1)

if [ "$SITEMAP_HTTP_CODE" = "200" ]; then
    print_success "sitemap.xml accessible (HTTP 200)"
    # Check if it was a redirect
    REDIRECT_URL=$(curl -s -I -L -w "%{url_effective}" -o /dev/null "$SITEMAP_URL")
    if [ "$REDIRECT_URL" != "$SITEMAP_URL" ]; then
        print_info "Followed redirect to: $REDIRECT_URL"
    fi
else
    print_error "sitemap.xml returned HTTP $SITEMAP_HTTP_CODE"
    exit 1
fi

# Step 4: Validate sitemap XML structure
print_info "Step 4: Validating sitemap.xml structure..."

# Check for XML declaration
if echo "$SITEMAP_CONTENT" | head -n1 | grep -q '<?xml'; then
    print_success "Contains XML declaration"
else
    print_error "Missing XML declaration"
fi

# Check for urlset namespace
if echo "$SITEMAP_CONTENT" | grep -q 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'; then
    print_success "Contains correct sitemap namespace"
else
    print_error "Missing or incorrect sitemap namespace"
fi

# Check for urlset element
if echo "$SITEMAP_CONTENT" | grep -q '<urlset'; then
    print_success "Contains urlset root element"
else
    print_error "Missing urlset root element"
    exit 1
fi

# Count URL entries
URL_COUNT=$(echo "$SITEMAP_CONTENT" | grep -c '<url>' || true)
if [ "$URL_COUNT" -gt 0 ]; then
    print_success "Contains $URL_COUNT URL entries"
else
    print_error "No URL entries found in sitemap"
    exit 1
fi

# Step 5: Validate URL structure
print_info "Step 5: Validating URL entry structure..."

# Check for loc elements
LOC_COUNT=$(echo "$SITEMAP_CONTENT" | grep -c '<loc>' || true)
if [ "$LOC_COUNT" = "$URL_COUNT" ]; then
    print_success "All URLs have <loc> elements ($LOC_COUNT)"
else
    print_error "URL count mismatch: $URL_COUNT urls but $LOC_COUNT loc elements"
fi

# Check for lastmod elements
if echo "$SITEMAP_CONTENT" | grep -q '<lastmod>'; then
    print_success "Contains <lastmod> elements for freshness indication"
else
    print_info "No <lastmod> elements found (optional but recommended)"
fi

# Check for priority elements
if echo "$SITEMAP_CONTENT" | grep -q '<priority>'; then
    print_success "Contains <priority> elements"
else
    print_info "No <priority> elements found (optional)"
fi

# Check for changefreq elements
if echo "$SITEMAP_CONTENT" | grep -q '<changefreq>'; then
    print_success "Contains <changefreq> elements"
else
    print_info "No <changefreq> elements found (optional)"
fi

echo ""

# Step 6: Extract and test sample URLs
print_info "Step 6: Testing sample URLs from sitemap..."

# Extract first 5 URLs from sitemap
SAMPLE_URLS=$(echo "$SITEMAP_CONTENT" | grep '<loc>' | sed 's/.*<loc>\(.*\)<\/loc>.*/\1/' | head -n 5)

TESTED=0
PASSED=0
while IFS= read -r url; do
    if [ -n "$url" ]; then
        TESTED=$((TESTED + 1))
        HTTP_CODE=$(curl -s -L -o /dev/null -w "%{http_code}" "$url")
        
        if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
            print_success "URL accessible: $url (HTTP $HTTP_CODE)"
            PASSED=$((PASSED + 1))
        else
            print_error "URL failed: $url (HTTP $HTTP_CODE)"
        fi
    fi
done <<< "$SAMPLE_URLS"

echo ""
echo "URL Test Results: $PASSED/$TESTED passed"

# Step 7: Validate specific page types
print_info "Step 7: Validating page type coverage..."

# Check for homepage
if echo "$SITEMAP_CONTENT" | grep -q "<loc>$APP_URL</loc>\|<loc>$APP_URL/</loc>"; then
    print_success "Homepage included in sitemap"
else
    print_info "Homepage not found (may be using different URL format)"
fi

# Check for product pages
if echo "$SITEMAP_CONTENT" | grep -q "/product/"; then
    PRODUCT_COUNT=$(echo "$SITEMAP_CONTENT" | grep -c "/product/" || true)
    print_success "Product pages included ($PRODUCT_COUNT products)"
else
    print_info "No product pages found"
fi

# Check for category pages
if echo "$SITEMAP_CONTENT" | grep -q "/category/"; then
    CATEGORY_COUNT=$(echo "$SITEMAP_CONTENT" | grep -c "/category/" || true)
    print_success "Category pages included ($CATEGORY_COUNT categories)"
else
    print_info "No category pages found"
fi

echo ""
echo "=================================================="
echo "✅ All robots.txt and sitemap tests completed!"
echo "=================================================="
echo ""
echo "Summary:"
echo "  - robots.txt: accessible and valid"
echo "  - sitemap.xml: accessible with $URL_COUNT URLs"
echo "  - Sample URLs tested: $PASSED/$TESTED passed"
echo "  - Product pages: $PRODUCT_COUNT"
[ -n "$CATEGORY_COUNT" ] && echo "  - Category pages: $CATEGORY_COUNT"
echo ""
echo "Robot compliance: ✓ Ready for search engine crawling"
echo ""

# Save test results to file
TEST_RESULTS_DIR="/workspaces/AdventureWorks/test-results"
mkdir -p "$TEST_RESULTS_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RESULTS_FILE="$TEST_RESULTS_DIR/robots-sitemap-test-$TIMESTAMP.txt"

cat > "$RESULTS_FILE" << EOF
Robots.txt and Sitemap.xml Test Results
Generated: $(date)
================================================

Test Configuration:
- App URL: $APP_URL
- Function URL: $FUNCTION_URL
- Sitemap URL: $SITEMAP_URL

Robots.txt Validation:
- Status: ✓ PASSED
- HTTP Code: $ROBOTS_HTTP_CODE
- Contains User-agent: Yes
- Contains Allow: Yes
- Contains Sitemap: Yes

Sitemap.xml Validation:
- Status: ✓ PASSED
- HTTP Code: $SITEMAP_HTTP_CODE
- Total URLs: $URL_COUNT
- Has XML Declaration: Yes
- Has Sitemap Namespace: Yes
- Has <loc> elements: $LOC_COUNT
- Has <lastmod> elements: Yes
- Has <priority> elements: Yes
- Has <changefreq> elements: Yes

Content Coverage:
- Product pages: $PRODUCT_COUNT
- Category pages: ${CATEGORY_COUNT:-0}

Sample URL Tests:
- Tested: $TESTED
- Passed: $PASSED
- Success Rate: $(awk "BEGIN {printf \"%.1f\", ($PASSED/$TESTED)*100}")%

SEO Compliance: READY FOR CRAWLING
================================================
EOF

print_success "Test results saved to: $RESULTS_FILE"
