#!/bin/bash

# Test script for GraphQL API endpoints
# This script exercises all GET and LIST GraphQL endpoints

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get API URL from azd environment, fall back to env var, or use default
if command -v azd &> /dev/null; then
    AZD_API_URL=$(azd env get-value API_URL 2>/dev/null || echo "")
    API_URL="${API_URL:-${AZD_API_URL:-http://localhost:5000/graphql}}"
else
    API_URL="${API_URL:-http://localhost:5000/graphql}"
fi

echo "Testing GraphQL API at: $API_URL"
echo "========================================"
echo ""

# Function to test a GraphQL query
test_query() {
    local test_name="$1"
    local query="$2"
    
    echo -n "Testing $test_name... "
    
    response=$(curl -s -X POST "$API_URL" \
        -H "Content-Type: application/json" \
        -d "{\"query\": \"$query\"}" \
        -w "\nHTTP_STATUS:%{http_code}" \
        -o /tmp/graphql_response_body.txt \
        --stderr /tmp/graphql_curl_stderr.txt)
    
    http_status=$(echo "$response" | grep "HTTP_STATUS" | cut -d: -f2)
    body=$(cat /tmp/graphql_response_body.txt 2>/dev/null || echo "")
    curl_stderr=$(cat /tmp/graphql_curl_stderr.txt 2>/dev/null || echo "")
    
    if [ "$http_status" = "200" ]; then
        # Check if response contains errors
        if echo "$body" | grep -q '"errors"'; then
            echo -e "${RED}FAILED${NC}"
            echo "  GraphQL Errors found in response:"
            echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
            return 1
        else
            echo -e "${GREEN}PASSED${NC}"
            return 0
        fi
    else
        echo -e "${RED}FAILED (HTTP $http_status)${NC}"
        echo "  Query: $query"
        if [ -n "$body" ]; then
            echo "  Response Body:"
            echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
        else
            echo "  Response Body: (empty)"
        fi
        if [ -n "$curl_stderr" ]; then
            echo "  Curl Error Output:"
            echo "$curl_stderr"
        fi
        echo ""
        return 1
    fi
}

passed=0
failed=0

# Test 1: Get all categories
if test_query "Get all categories" \
    "{ productCategories { items { ProductCategoryID Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 2: Get all subcategories
if test_query "Get all subcategories" \
    "{ productSubcategories { items { ProductSubcategoryID ProductCategoryID Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 3: Get all products
if test_query "Get all products" \
    "{ products { items { ProductID Name ProductNumber Color ListPrice } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 4: Get category by ID
if test_query "Get category by ID (ID=1)" \
    "{ productCategories(filter: { ProductCategoryID: { eq: 1 } }) { items { ProductCategoryID Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 5: Get subcategory by ID
if test_query "Get subcategory by ID (ID=1)" \
    "{ productSubcategories(filter: { ProductSubcategoryID: { eq: 1 } }) { items { ProductSubcategoryID ProductCategoryID Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 6: Get product by ID
if test_query "Get product by ID (ID=680)" \
    "{ products(filter: { ProductID: { eq: 680 } }) { items { ProductID Name ProductNumber Color ListPrice } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 7: Get products by subcategory
if test_query "Get products by subcategory (ID=1)" \
    "{ products(filter: { ProductSubcategoryID: { eq: 1 } }) { items { ProductID Name ProductSubcategoryID } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 8: Get subcategories by category
if test_query "Get subcategories by category (ID=1)" \
    "{ productSubcategories(filter: { ProductCategoryID: { eq: 1 } }) { items { ProductSubcategoryID Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 9: Get all sales orders
if test_query "Get all sales orders" \
    "{ salesOrderHeaders { items { SalesOrderID OrderDate TotalDue } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 10: Get sales order details
if test_query "Get sales order details" \
    "{ salesOrderDetails { items { SalesOrderID SalesOrderDetailID ProductID OrderQty UnitPrice } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 11: Get all customers
if test_query "Get all customers" \
    "{ customers { items { CustomerID PersonID StoreID TerritoryID } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 12: Get all persons (DAB uses 'people' as plural)
if test_query "Get all persons" \
    "{ people { items { BusinessEntityID PersonType FirstName LastName } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 13: Get product models
if test_query "Get all product models" \
    "{ productModels { items { ProductModelID Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 14: Get product descriptions
if test_query "Get all product descriptions" \
    "{ productDescriptions { items { ProductDescriptionID Description } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 15: Get all stores
if test_query "Get all stores" \
    "{ stores { items { BusinessEntityID Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 16: Get all vendors
if test_query "Get all vendors" \
    "{ vendors { items { BusinessEntityID Name AccountNumber } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 17: Get all departments
if test_query "Get all departments" \
    "{ departments { items { DepartmentID Name GroupName } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 18: Get all shifts
if test_query "Get all shifts" \
    "{ shifts { items { ShiftID Name StartTime EndTime } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 19: Get all locations
if test_query "Get all locations" \
    "{ locations { items { LocationID Name CostRate Availability } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 20: Get all credit cards
if test_query "Get all credit cards" \
    "{ creditCards { items { CreditCardID CardType CardNumber } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 21: Get all email addresses
if test_query "Get all email addresses" \
    "{ emailAddresses { items { BusinessEntityID EmailAddress EmailAddressID } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 22: Get all phone number types
if test_query "Get all phone number types" \
    "{ phoneNumberTypes { items { PhoneNumberTypeID Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 23: Get all product reviews
if test_query "Get all product reviews" \
    "{ productReviews { items { ProductReviewID ProductID ReviewerName Rating } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 24: Get all ship methods
if test_query "Get all ship methods" \
    "{ shipMethods { items { ShipMethodID Name ShipBase ShipRate } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 25: Get all sales territories
if test_query "Get all sales territories" \
    "{ salesTerritories { items { TerritoryID Name CountryRegionCode } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 26: Get all sales people
if test_query "Get all sales people" \
    "{ salesPeople { items { BusinessEntityID TerritoryID SalesQuota } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 27: Get all cultures
if test_query "Get all cultures" \
    "{ cultures { items { CultureID Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 28: Get all currencies
if test_query "Get all currencies" \
    "{ currencies { items { CurrencyCode Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 29: Get all country regions
if test_query "Get all country regions" \
    "{ countryRegions { items { CountryRegionCode Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 30: Get all state provinces
if test_query "Get all state provinces" \
    "{ stateProvinces { items { StateProvinceID StateProvinceCode Name CountryRegionCode } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 31: Get all address types
if test_query "Get all address types" \
    "{ addressTypes { items { AddressTypeID Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 32: Get all contact types
if test_query "Get all contact types" \
    "{ contactTypes { items { ContactTypeID Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 33: Get all product photos
if test_query "Get all product photos" \
    "{ productPhotos { items { ProductPhotoID ThumbNailPhoto LargePhoto } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 34: Get all special offers
if test_query "Get all special offers" \
    "{ specialOffers { items { SpecialOfferID Description DiscountPct Type } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 35: Get all work orders
if test_query "Get all work orders" \
    "{ workOrders { items { WorkOrderID ProductID OrderQty StockedQty } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 36: Get all purchase order headers
if test_query "Get all purchase order headers" \
    "{ purchaseOrderHeaders { items { PurchaseOrderID VendorID OrderDate TotalDue } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 37: Get all purchase order details
if test_query "Get all purchase order details" \
    "{ purchaseOrderDetails { items { PurchaseOrderID ProductID OrderQty UnitPrice } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 38: Get all shopping cart items
if test_query "Get all shopping cart items" \
    "{ shoppingCartItems { items { ShoppingCartItemID ShoppingCartID ProductID Quantity } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 39: Get all product inventory
if test_query "Get all product inventory" \
    "{ productInventories { items { ProductID LocationID Quantity } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 40: Get all transaction history
if test_query "Get all transaction history" \
    "{ transactionHistories { items { TransactionID ProductID TransactionType Quantity } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 41: Get all unit measures
if test_query "Get all unit measures" \
    "{ unitMeasures { items { UnitMeasureCode Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 42: Get all sales reasons
if test_query "Get all sales reasons" \
    "{ salesReasons { items { SalesReasonID Name ReasonType } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 43: Get all scrap reasons
if test_query "Get all scrap reasons" \
    "{ scrapReasons { items { ScrapReasonID Name } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 44: Get all business entities
if test_query "Get all business entities" \
    "{ businessEntities { items { BusinessEntityID rowguid ModifiedDate } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 45: Get all person phones
if test_query "Get all person phones" \
    "{ personPhones { items { BusinessEntityID PhoneNumber PhoneNumberTypeID } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 46: Get all person credit cards
if test_query "Get all person credit cards" \
    "{ personCreditCards { items { BusinessEntityID CreditCardID } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 47: Get all product vendors
if test_query "Get all product vendors" \
    "{ productVendors { items { ProductID BusinessEntityID AverageLeadTime StandardPrice } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 48: Get all currency rates
if test_query "Get all currency rates" \
    "{ currencyRates { items { CurrencyRateID FromCurrencyCode ToCurrencyCode AverageRate } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 49: Get all sales tax rates
if test_query "Get all sales tax rates" \
    "{ salesTaxRates { items { SalesTaxRateID StateProvinceID TaxType TaxRate } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 50: Get all illustrations
if test_query "Get all illustrations" \
    "{ illustrations { items { IllustrationID Diagram } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 51: Get all product cost history
if test_query "Get all product cost history" \
    "{ productCostHistories { items { ProductID StartDate EndDate StandardCost } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 52: Get all product list price history
if test_query "Get all product list price history" \
    "{ productListPriceHistories { items { ProductID StartDate EndDate ListPrice } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 53: Get all product model illustrations
if test_query "Get all product model illustrations" \
    "{ productModelIllustrations { items { ProductModelID IllustrationID } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 54: Get all product model product description cultures
if test_query "Get all product model product description cultures" \
    "{ productModelProductDescriptionCultures { items { ProductModelID ProductDescriptionID CultureID } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 55: Get all product product photos
if test_query "Get all product product photos" \
    "{ productProductPhotos { items { ProductID ProductPhotoID Primary } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 56: Get all special offer products
if test_query "Get all special offer products" \
    "{ specialOfferProducts { items { SpecialOfferID ProductID } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 57: Get all sales order header sales reasons
if test_query "Get all sales order header sales reasons" \
    "{ salesOrderHeaderSalesReasons { items { SalesOrderID SalesReasonID } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 58: Get all country region currencies
if test_query "Get all country region currencies" \
    "{ countryRegionCurrencies { items { CountryRegionCode CurrencyCode ModifiedDate } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 59: Get all business entity addresses
if test_query "Get all business entity addresses" \
    "{ businessEntityAddresses { items { BusinessEntityID AddressID AddressTypeID } } }"; then
    ((passed++))
else
    ((failed++))
fi

# Test 60: Get all business entity contacts
if test_query "Get all business entity contacts" \
    "{ businessEntityContacts { items { BusinessEntityID PersonID ContactTypeID } } }"; then
    ((passed++))
else
    ((failed++))
fi

echo ""
echo "========================================"
echo "Test Results:"
echo -e "${GREEN}Passed: $passed${NC}"
echo -e "${RED}Failed: $failed${NC}"
echo "========================================"

if [ $failed -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
