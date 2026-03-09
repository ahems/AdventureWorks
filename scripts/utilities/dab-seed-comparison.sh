#!/usr/bin/env bash
#
# DAB Seed Comparison and CSV Cross-Check Script
#
# Compares a "Known Good" DAB deployment with a "Clean" (seed-created) deployment:
# Phase 1: For every seed table exposed by DAB, fetch all records from both APIs,
#          compare by primary key, record missing_from_clean, extra_in_clean, value_mismatch.
# Phase 2: For each missing/mismatch, check if the record exists in the relevant seed CSV(s).
#
# Output: Single report file (e.g. reports/dab-seed-discrepancies-YYYYMMDD-HHMMSS.md)
#
# Prerequisites: bash, curl, jq, awk, cut, sort. No Node/Python required.
# Usage: ./scripts/utilities/dab-seed-comparison.sh
#
# Configuration: Clean DAB URL from azd env (API_URL). Known Good URL hardcoded below.

set -e

REPORT_DIR="${REPORT_DIR:-./reports}"
KNOWN_GOOD_BASE="${KNOWN_GOOD_BASE:-https://av-api-ewphuc52etkbc.purplesky-9d5d92b9.eastus2.azurecontainerapps.io}"
CONCURRENCY="${CONCURRENCY:-4}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SEED_SQL_DIR="${REPO_ROOT}/seed-job/sql"

# ---------------------------------------------------------------------------
# Embedded: entity name -> source table (Schema.Table) from api/dab-config.json
# Only table entities (views like ProductSearch excluded).
# ---------------------------------------------------------------------------
entity_to_source() {
  case "$1" in
    UnitMeasure) echo "Production.UnitMeasure" ;;
    Culture) echo "Production.Culture" ;;
    Currency) echo "Sales.Currency" ;;
    AddressType) echo "Person.AddressType" ;;
    ContactType) echo "Person.ContactType" ;;
    PhoneNumberType) echo "Person.PhoneNumberType" ;;
    SalesReason) echo "Sales.SalesReason" ;;
    CreditCard) echo "Sales.CreditCard" ;;
    CurrencyRate) echo "Sales.CurrencyRate" ;;
    CountryRegion) echo "Person.CountryRegion" ;;
    SalesTerritory) echo "Sales.SalesTerritory" ;;
    ShipMethod) echo "Purchasing.ShipMethod" ;;
    StateProvince) echo "Person.StateProvince" ;;
    BusinessEntity) echo "Person.BusinessEntity" ;;
    BusinessEntityAddress) echo "Person.BusinessEntityAddress" ;;
    Person) echo "Person.Person" ;;
    Password) echo "Person.Password" ;;
    EmailAddress) echo "Person.EmailAddress" ;;
    PersonPhone) echo "Person.PersonPhone" ;;
    PersonCreditCard) echo "Sales.PersonCreditCard" ;;
    SalesPerson) echo "Sales.SalesPerson" ;;
    Store) echo "Sales.Store" ;;
    Customer) echo "Sales.Customer" ;;
    Illustration) echo "Production.Illustration" ;;
    Location) echo "Production.Location" ;;
    ProductCategory) echo "Production.ProductCategory" ;;
    ProductSubcategory) echo "Production.ProductSubcategory" ;;
    ProductModel) echo "Production.ProductModel" ;;
    ProductDescription) echo "Production.ProductDescription" ;;
    ProductModelProductDescriptionCulture) echo "Production.ProductModelProductDescriptionCulture" ;;
    ProductModelIllustration) echo "Production.ProductModelIllustration" ;;
    Product) echo "Production.Product" ;;
    ProductCostHistory) echo "Production.ProductCostHistory" ;;
    ProductListPriceHistory) echo "Production.ProductListPriceHistory" ;;
    ProductInventory) echo "Production.ProductInventory" ;;
    SpecialOffer) echo "Sales.SpecialOffer" ;;
    SpecialOfferProduct) echo "Sales.SpecialOfferProduct" ;;
    SalesOrderHeader) echo "Sales.SalesOrderHeader" ;;
    SalesOrderDetail) echo "Sales.SalesOrderDetail" ;;
    SalesOrderHeaderSalesReason) echo "Sales.SalesOrderHeaderSalesReason" ;;
    ShoppingCartItem) echo "Sales.ShoppingCartItem" ;;
    CountryRegionCurrency) echo "Sales.CountryRegionCurrency" ;;
    SalesTaxRate) echo "Sales.SalesTaxRate" ;;
    ScrapReason) echo "Production.ScrapReason" ;;
    Department) echo "HumanResources.Department" ;;
    Shift) echo "HumanResources.Shift" ;;
    EmployeeDepartmentHistory) echo "HumanResources.EmployeeDepartmentHistory" ;;
    EmployeePayHistory) echo "HumanResources.EmployeePayHistory" ;;
    BusinessEntityContact) echo "Person.BusinessEntityContact" ;;
    Vendor) echo "Purchasing.Vendor" ;;
    ProductVendor) echo "Purchasing.ProductVendor" ;;
    PurchaseOrderHeader) echo "Purchasing.PurchaseOrderHeader" ;;
    PurchaseOrderDetail) echo "Purchasing.PurchaseOrderDetail" ;;
    ProductPhoto) echo "Production.ProductPhoto" ;;
    ProductProductPhoto) echo "Production.ProductProductPhoto" ;;
    TransactionHistory) echo "Production.TransactionHistory" ;;
    TransactionHistoryArchive) echo "Production.TransactionHistoryArchive" ;;
    WorkOrder) echo "Production.WorkOrder" ;;
    WorkOrderRouting) echo "Production.WorkOrderRouting" ;;
    SalesPersonQuotaHistory) echo "Sales.SalesPersonQuotaHistory" ;;
    SalesTerritoryHistory) echo "Sales.SalesTerritoryHistory" ;;
    ProductReview) echo "Production.ProductReview" ;;
    *) echo "" ;;
  esac
}

# ---------------------------------------------------------------------------
# Embedded: seed tables (Schema.Table) that are loaded from CSV (from csvLoadConfig).
# Used to filter entities: only compare if entity's source is in this set.
# ---------------------------------------------------------------------------
is_seed_table() {
  local t="$1"
  case "$t" in
    Production.UnitMeasure|Production.Culture|Sales.Currency|Person.AddressType|Person.ContactType|Person.PhoneNumberType|Sales.SalesReason|Sales.CreditCard|Sales.CurrencyRate|Person.CountryRegion|Sales.SalesTerritory|Purchasing.ShipMethod|Person.StateProvince|Person.Address|Person.BusinessEntity|Person.BusinessEntityAddress|Person.Person|Person.Password|Person.EmailAddress|Person.PersonPhone|HumanResources.Employee|Sales.PersonCreditCard|Sales.SalesPerson|Sales.Store|Sales.Customer|Production.Illustration|Production.Location|Production.ProductCategory|Production.ProductSubcategory|Production.ProductModel|Production.ProductDescription|Production.ProductModelProductDescriptionCulture|Production.ProductModelIllustration|Production.Product|Production.ProductCostHistory|Production.ProductListPriceHistory|Production.ProductInventory|Sales.SpecialOffer|Sales.SpecialOfferProduct|Sales.SalesOrderHeader|Sales.SalesOrderDetail|Sales.SalesOrderHeaderSalesReason|Sales.ShoppingCartItem|Sales.CountryRegionCurrency|Sales.SalesTaxRate|Production.ScrapReason|dbo.AWBuildVersion|HumanResources.Department|HumanResources.Shift|HumanResources.EmployeeDepartmentHistory|HumanResources.EmployeePayHistory|Person.BusinessEntityContact|Purchasing.Vendor|Purchasing.ProductVendor|Purchasing.PurchaseOrderHeader|Purchasing.PurchaseOrderDetail|Production.BillOfMaterials|Production.ProductPhoto|Production.ProductProductPhoto|Production.Culture|Production.Document|Production.ProductDocument|Production.TransactionHistory|Production.TransactionHistoryArchive|Production.WorkOrder|Production.WorkOrderRouting|Sales.SalesPersonQuotaHistory|Sales.SalesTerritoryHistory) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Embedded: Table -> CSV files with delimiter. Format "File<TAB>Delimiter" per file.
# Delimiter is stored as literal \t for tab or +| or |. One table can have multiple files.
# ---------------------------------------------------------------------------
table_to_csvs() {
  local table="$1"
  local tab=$'\t'
  case "$table" in
    Production.UnitMeasure) echo "UnitMeasure.csv${tab}\t" ;;
    Production.Culture) echo "Culture.csv${tab}\t"; echo "Culture-ai.csv${tab}\t" ;;
    Sales.Currency) echo "Currency.csv${tab}\t"; echo "Currency-ai.csv${tab}\t" ;;
    Person.AddressType) echo "AddressType.csv${tab}\t" ;;
    Person.ContactType) echo "ContactType.csv${tab}\t" ;;
    Person.PhoneNumberType) echo "PhoneNumberType.csv${tab}+|" ;;
    Sales.SalesReason) echo "SalesReason.csv${tab}\t" ;;
    Sales.CreditCard) echo "CreditCard.csv${tab}\t" ;;
    Sales.CurrencyRate) echo "CurrencyRate.csv${tab}\t" ;;
    Person.CountryRegion) echo "CountryRegion.csv${tab}\t" ;;
    Sales.SalesTerritory) echo "SalesTerritory.csv${tab}\t" ;;
    Purchasing.ShipMethod) echo "ShipMethod.csv${tab}\t" ;;
    Person.StateProvince) echo "StateProvince.csv${tab}\t"; echo "StateProvince-ai.csv${tab}\t" ;;
    Person.Address) echo "Address.csv${tab}\t" ;;
    Person.BusinessEntity) echo "BusinessEntity.csv${tab}+|" ;;
    Person.BusinessEntityAddress) echo "BusinessEntityAddress.csv${tab}+|" ;;
    Person.Person) echo "Person.csv${tab}+|" ;;
    Person.Password) echo "Password.csv${tab}+|" ;;
    Person.EmailAddress) echo "EmailAddress.csv${tab}+|" ;;
    Person.PersonPhone) echo "PersonPhone.csv${tab}+|" ;;
    HumanResources.Employee) echo "Employee.csv${tab}\t" ;;
    Sales.PersonCreditCard) echo "PersonCreditCard.csv${tab}\t" ;;
    Sales.SalesPerson) echo "SalesPerson.csv${tab}\t" ;;
    Sales.Store) echo "Store.csv${tab}+|" ;;
    Sales.Customer) echo "Customer.csv${tab}\t" ;;
    Production.Illustration) echo "Illustration.csv${tab}+|" ;;
    Production.Location) echo "Location.csv${tab}\t" ;;
    Production.ProductCategory) echo "ProductCategory.csv${tab}\t" ;;
    Production.ProductSubcategory) echo "ProductSubcategory.csv${tab}\t" ;;
    Production.ProductModel) echo "ProductModel.csv${tab}+|" ;;
    Production.ProductDescription) echo "ProductDescription.csv${tab}\t"; echo "ProductDescription-ai.csv${tab}\t"; echo "ProductDescription-ai-translations.csv${tab}|" ;;
    Production.ProductModelProductDescriptionCulture) echo "ProductModelProductDescriptionCulture.csv${tab}\t"; echo "ProductModelProductDescriptionCulture-ai.csv${tab}|" ;;
    Production.ProductModelIllustration) echo "ProductModelIllustration.csv${tab}\t" ;;
    Production.Product) echo "Product.csv${tab}\t" ;;
    Production.ProductReview) echo "ProductReview.csv${tab}\t"; echo "ProductReview-ai.csv${tab}\t" ;;
    Production.ProductCostHistory) echo "ProductCostHistory.csv${tab}\t" ;;
    Production.ProductListPriceHistory) echo "ProductListPriceHistory.csv${tab}\t" ;;
    Production.ProductInventory) echo "ProductInventory.csv${tab}\t" ;;
    Sales.SpecialOffer) echo "SpecialOffer.csv${tab}\t" ;;
    Sales.SpecialOfferProduct) echo "SpecialOfferProduct.csv${tab}\t" ;;
    Sales.SalesOrderHeader) echo "SalesOrderHeader.csv${tab}\t" ;;
    Sales.SalesOrderDetail) echo "SalesOrderDetail.csv${tab}\t" ;;
    Sales.SalesOrderHeaderSalesReason) echo "SalesOrderHeaderSalesReason.csv${tab}\t" ;;
    Sales.ShoppingCartItem) echo "ShoppingCartItem.csv${tab}\t" ;;
    Sales.CountryRegionCurrency) echo "CountryRegionCurrency.csv${tab}\t"; echo "CountryRegionCurrency-ai.csv${tab}\t" ;;
    Sales.SalesTaxRate) echo "SalesTaxRate.csv${tab}\t"; echo "SalesTaxRate-ai.csv${tab}\t" ;;
    Production.ScrapReason) echo "ScrapReason.csv${tab}\t" ;;
    HumanResources.Department) echo "Department.csv${tab}\t" ;;
    HumanResources.Shift) echo "Shift.csv${tab}\t" ;;
    HumanResources.EmployeeDepartmentHistory) echo "EmployeeDepartmentHistory.csv${tab}\t" ;;
    HumanResources.EmployeePayHistory) echo "EmployeePayHistory.csv${tab}\t" ;;
    Person.BusinessEntityContact) echo "BusinessEntityContact.csv${tab}+|" ;;
    Purchasing.Vendor) echo "Vendor.csv${tab}\t" ;;
    Purchasing.ProductVendor) echo "ProductVendor.csv${tab}\t" ;;
    Purchasing.PurchaseOrderHeader) echo "PurchaseOrderHeader.csv${tab}\t" ;;
    Purchasing.PurchaseOrderDetail) echo "PurchaseOrderDetail.csv${tab}\t" ;;
    Production.ProductPhoto) echo "ProductPhoto.csv${tab}+|" ;;
    Production.ProductProductPhoto) echo "ProductProductPhoto.csv${tab}\t"; echo "ProductProductPhoto-ai.csv${tab}\t" ;;
    Production.TransactionHistory) echo "TransactionHistory.csv${tab}\t" ;;
    Production.TransactionHistoryArchive) echo "TransactionHistoryArchive.csv${tab}\t" ;;
    Production.WorkOrder) echo "WorkOrder.csv${tab}\t" ;;
    Production.WorkOrderRouting) echo "WorkOrderRouting.csv${tab}\t" ;;
    Sales.SalesPersonQuotaHistory) echo "SalesPersonQuotaHistory.csv${tab}\t" ;;
    Sales.SalesTerritoryHistory) echo "SalesTerritoryHistory.csv${tab}\t" ;;
    *) echo "" ;;
  esac
}

# ---------------------------------------------------------------------------
# Embedded: entities that have binary/vector columns (field names).
# For these, compare only PK + non-binary; for binary/vector only flag if Clean empty and Known Good non-empty.
# ---------------------------------------------------------------------------
binary_vector_fields() {
  local entity="$1"
  case "$entity" in
    ProductPhoto) echo "ThumbNailPhoto LargePhoto" ;;
    ProductReview) echo "Comments CommentsEmbedding" ;;
    ProductDescription) echo "DescriptionEmbedding" ;;
    Document) echo "DocumentNode DocumentSummary Document" ;;
    ProductDocument) echo "DocumentNode" ;;
    *) echo "" ;;
  esac
}

# ---------------------------------------------------------------------------
# Setup: resolve Clean URL, create report file, fetch OpenAPI
# ---------------------------------------------------------------------------
setup() {
  if ! command -v curl &>/dev/null || ! command -v jq &>/dev/null; then
    echo "Error: curl and jq are required."
    exit 1
  fi

  echo "Loading Clean DAB URL from azd environment..."
  AZD_VALUES=$(azd env get-values 2>/dev/null) || true
  if [[ -z "$AZD_VALUES" ]]; then
    echo "Error: Could not get azd env values. Run 'azd env refresh' or ensure an environment is selected."
    exit 1
  fi
  CLEAN_BASE=$(echo "$AZD_VALUES" | grep -E '^API_URL=' | cut -d '=' -f 2- | tr -d '"')
  CLEAN_BASE="${CLEAN_BASE%/}"
  CLEAN_BASE="${CLEAN_BASE%/graphql}"
  CLEAN_BASE="${CLEAN_BASE%/graphql/}"
  if [[ -z "$CLEAN_BASE" ]]; then
    echo "Error: API_URL not found in azd env."
    exit 1
  fi

  mkdir -p "$REPORT_DIR"
  REPORT_FILE="${REPORT_DIR}/dab-seed-discrepancies-$(date +%Y%m%d-%H%M%S).md"
  touch "$REPORT_FILE"
  echo "Report file: $REPORT_FILE"
  echo "Clean API:   $CLEAN_BASE"
  echo "Known Good: $KNOWN_GOOD_BASE"
  echo ""

  OPENAPI_FILE="${REPORT_DIR}/.openapi-$$.json"
  if ! curl -sS --connect-timeout 15 --max-time 30 -o "$OPENAPI_FILE" "${CLEAN_BASE}/api/openapi"; then
    echo "Error: Failed to fetch OpenAPI from ${CLEAN_BASE}/api/openapi"
    exit 1
  fi
  if ! jq -e . "$OPENAPI_FILE" >/dev/null 2>&1; then
    echo "Error: OpenAPI response is not valid JSON."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Discover entities and primary keys from OpenAPI
# Paths: /EntityName (collection), /EntityName/.../.../{param} (by-key)
# ---------------------------------------------------------------------------
discover_entities() {
  local openapi="$1"
  # Collection paths: exactly two segments, e.g. /UnitMeasure (no {)
  jq -r '.paths | keys[] | select(startswith("/") and (split("/") | length == 2) and (test("\\{") | not)) | ltrimstr("/")' "$openapi" 2>/dev/null | sort -u
}

# Get primary key field names for an entity from OpenAPI (by-key path parameters)
get_pk_fields() {
  local openapi="$1"
  local entity="$2"
  # Find path that starts with /EntityName/ and contains {; extract {paramName} in order
  jq -r --arg e "$entity" '
    first(.paths | keys[] | select(startswith("/" + $e + "/") and test("\\{"))) // "" |
    if . == "" then "" else [scan("\\{([^}]+)\\}") | .[0]] | join(" ") end
  ' "$openapi" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Fetch all pages for one entity from a base URL (REST: value + nextLink)
# ---------------------------------------------------------------------------
fetch_entity_all_pages() {
  local base="$1"
  local entity="$2"
  local url="${base}/api/${entity}"
  local all="[]"
  while [[ -n "$url" ]]; do
    resp=$(curl -sS --connect-timeout 15 --max-time 60 "$url")
    if ! echo "$resp" | jq -e . >/dev/null 2>&1; then
      echo "[]"
      return 1
    fi
    values=$(echo "$resp" | jq -c '.value // []')
    all=$(echo "$all" | jq -c --argjson v "$values" '. + $v')
    url=$(echo "$resp" | jq -r '.nextLink // empty')
    if [[ -n "$url" && "$url" != "null" ]]; then
      # nextLink might be relative
      if [[ "$url" != http* ]]; then
        url="${base}${url}"
      fi
    else
      url=""
    fi
  done
  echo "$all"
}

# Build composite key string from record (order of keys as in pk_fields)
record_pk() {
  local record="$1"
  local pk_fields="$2"
  echo "$record" | jq -r --arg f "$pk_fields" '. as $r | [($f | split(" ")[] | $r[.] | tostring)] | join("|")'
}

# Normalize value for comparison (sort keys, exclude nulls for optional)
normalize_json() {
  echo "$1" | jq -c 'if type == "object" then with_entries(select(.value != null)) | to_entries | sort_by(.key) | from_entries else . end' 2>/dev/null || echo "$1"
}

# Check if a value is null or empty (for binary/vector field check)
is_empty_val() {
  local v="$1"
  [[ "$v" == "null" || "$v" == "" || "$v" == "[]" ]]
}

# Compare two records: return 0 if equal (for non-binary fields; binary only flag Clean empty + Known Good non-empty)
compare_records() {
  local known="$1"
  local clean="$2"
  local pk_fields="$3"
  local binary_fields="$4"
  # Compare all keys present in known; for binary_fields only check (clean empty && known not empty)
  local known_keys
  known_keys=$(echo "$known" | jq -r 'keys[]' | sort -u)
  while IFS= read -r k; do
    [[ -z "$k" ]] && continue
    local known_v clean_v
    known_v=$(echo "$known" | jq -r --arg key "$k" '.[$key] | tostring')
    clean_v=$(echo "$clean" | jq -r --arg key "$k" '.[$key] | tostring')
    if [[ " $binary_fields " == *" $k "* ]]; then
      if is_empty_val "$clean_v" && ! is_empty_val "$known_v"; then
        return 1
      fi
      continue
    fi
    if [[ "$known_v" != "$clean_v" ]]; then
      return 1
    fi
  done <<< "$known_keys"
  return 0
}

# Phase 1: fetch and compare one entity; append to report
phase1_entity() {
  local entity="$1"
  local openapi="$2"
  local report="$3"
  local pk_f
  pk_f=$(get_pk_fields "$openapi" "$entity")
  # Fallback: common single-column PK names if OpenAPI doesn't expose by-key path
  if [[ -z "$pk_f" ]]; then
    pk_f="${entity}ID"
    [[ "$entity" == "Person" ]] && pk_f="BusinessEntityID"
    [[ "$entity" == "Culture" ]] && pk_f="CultureID"
    [[ "$entity" == "Currency" ]] && pk_f="CurrencyCode"
    [[ "$entity" == "UnitMeasure" ]] && pk_f="UnitMeasureCode"
  fi
  local src
  src=$(entity_to_source "$entity")
  [[ -z "$src" ]] && return 0
  is_seed_table "$src" || return 0

  local known_json clean_json
  known_json=$(fetch_entity_all_pages "$KNOWN_GOOD_BASE" "$entity") || known_json="[]"
  clean_json=$(fetch_entity_all_pages "$CLEAN_BASE" "$entity") || clean_json="[]"

  local binary_f
  binary_f=$(binary_vector_fields "$entity")
  local missing=0 extra=0 mismatch=0
  local missing_keys=() mismatch_keys=() extra_keys=()

  # Build maps by PK
  declare -A known_map clean_map
  while IFS= read -r rec; do
    [[ -z "$rec" || "$rec" == "[]" ]] && continue
    key=$(record_pk "$rec" "$pk_f")
    [[ -z "$key" ]] && continue
    known_map["$key"]="$rec"
  done < <(echo "$known_json" | jq -c '.[]' 2>/dev/null)
  while IFS= read -r rec; do
    [[ -z "$rec" || "$rec" == "[]" ]] && continue
    key=$(record_pk "$rec" "$pk_f")
    [[ -z "$key" ]] && continue
    clean_map["$key"]="$rec"
  done < <(echo "$clean_json" | jq -c '.[]' 2>/dev/null)

  for key in "${!known_map[@]}"; do
    if [[ -z "${clean_map[$key]:-}" ]]; then
      ((missing++)) || true
      missing_keys+=("$key")
    else
      if ! compare_records "${known_map[$key]}" "${clean_map[$key]}" "$pk_f" "$binary_f"; then
        ((mismatch++)) || true
        mismatch_keys+=("$key")
      fi
    fi
  done
  for key in "${!clean_map[@]}"; do
    if [[ -z "${known_map[$key]:-}" ]]; then
      ((extra++)) || true
      extra_keys+=("$key")
    fi
  done

  # Append to report
  {
    echo "## Entity: $entity (source: $src)"
    echo "- missing_from_clean: $missing"
    echo "- extra_in_clean: $extra"
    echo "- value_mismatch: $mismatch"
    if [[ ${#missing_keys[@]} -gt 0 ]]; then
      echo "- missing PKs: ${missing_keys[*]}"
    fi
    if [[ ${#mismatch_keys[@]} -gt 0 ]]; then
      echo "- mismatch PKs: ${mismatch_keys[*]}"
    fi
    if [[ ${#extra_keys[@]} -gt 0 ]]; then
      echo "- extra PKs: ${extra_keys[*]}"
    fi
    echo ""
  } >> "$report"

  # Export for Phase 2: missing and mismatch PKs (tab-separated so PK can contain |)
  for key in "${missing_keys[@]}"; do
    printf '%s\t%s\t%s\t%s\n' "$entity" "$src" "$key" "missing_from_clean"
  done
  for key in "${mismatch_keys[@]}"; do
    printf '%s\t%s\t%s\t%s\n' "$entity" "$src" "$key" "value_mismatch"
  done
}

# Phase 2: check if PK exists in any CSV for the table
phase2_check_csv() {
  local entity="$1"
  local table="$2"
  local pk_key="$3"
  local csv_list
  csv_list=$(table_to_csvs "$table")
  local tab=$'\t'
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local file delim
    file=$(echo "$line" | cut -f1 -d"$tab")
    delim=$(echo "$line" | cut -f2 -d"$tab")
    [[ "$delim" == '\t' ]] && delim=$'\t'
    [[ -z "$file" ]] && continue
    local path="${SEED_SQL_DIR}/${file}"
    [[ ! -f "$path" ]] && continue
    # PK key is e.g. "val1" or "val1|val2"
    local search_vals
    IFS='|' read -ra search_vals <<< "$pk_key"
    # Heuristic: first column(s) in CSV often are PK; check if any line has first column = val1 (or first two = val1,val2)
    if [[ ${#search_vals[@]} -eq 1 ]]; then
      if awk -v d="$delim" -v v="${search_vals[0]}" 'BEGIN{FS=d} $1==v { exit 0 } END{ exit 1 }' "$path" 2>/dev/null; then
        echo "in_csv:${file}"
        return 0
      fi
    else
      # Multi-column PK: check first N columns match
      local pattern="${search_vals[0]}"
      for ((i=1;i<${#search_vals[@]};i++)); do pattern="${pattern}[${delim}]${search_vals[$i]}"; done
      if grep -qE "^${pattern}([${delim}]|$)" "$path" 2>/dev/null; then
        echo "in_csv:${file}"
        return 0
      fi
    fi
  done <<< "$csv_list"
  echo "not_in_csv"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  setup
  OPENAPI_FILE="${REPORT_DIR}/.openapi-$$.json"

  echo "Discovering entities from OpenAPI..."
  # Focus on tables where issues have been noticed (ProductReview, ProductPhoto, ProductProductPhoto)
  # To compare all seed entities, comment out the block below and uncomment the "all entities" block.
  FOCUS_ENTITIES=(ProductReview ProductPhoto ProductProductPhoto)
  ENTITIES=()
  for e in "${FOCUS_ENTITIES[@]}"; do
    src=$(entity_to_source "$e")
    [[ -z "$src" ]] && continue
    is_seed_table "$src" && ENTITIES+=("$e")
  done
  # All seed entities (comment out the FOCUS_ENTITIES block above and uncomment below):
  # ENTITIES=()
  # while IFS= read -r e; do
  #   [[ -z "$e" ]] && continue
  #   src=$(entity_to_source "$e")
  #   [[ -z "$src" ]] && continue
  #   is_seed_table "$src" && ENTITIES+=("$e")
  # done < <(discover_entities "$OPENAPI_FILE")

  echo "Entities to compare: ${#ENTITIES[@]} (${ENTITIES[*]:-none})"
  {
    echo "# DAB Seed Comparison Report"
    echo ""
    echo "Generated: $(date -Iseconds)"
    echo "Clean API: $CLEAN_BASE"
    echo "Known Good: $KNOWN_GOOD_BASE"
    echo ""
    echo "---"
    echo ""
  } >> "$REPORT_FILE"

  # Phase 1: run per-entity (sequential for simplicity; can parallelize later)
  DISCREPANCY_FILE="${REPORT_DIR}/.discrepancies-$$.txt"
  : > "$DISCREPANCY_FILE"
  for e in "${ENTITIES[@]}"; do
    echo "Phase 1: $e"
    phase1_entity "$e" "$OPENAPI_FILE" "$REPORT_FILE" >> "$DISCREPANCY_FILE" 2>/dev/null || true
  done

  # Phase 2: for each line in discrepancy file
  echo ""
  echo "Phase 2: CSV cross-check..."
  {
    echo "## Phase 2: CSV cross-check results"
    echo ""
  } >> "$REPORT_FILE"
  in_csv_count=0
  not_in_csv_count=0
  while IFS=$'\t' read -r entity table pk_key type; do
    [[ -z "$entity" ]] && continue
    result=$(phase2_check_csv "$entity" "$table" "$pk_key")
    if [[ "$result" == not_in_csv ]]; then
      ((not_in_csv_count++)) || true
    else
      ((in_csv_count++)) || true
    fi
    echo "- $entity PK=$pk_key ($type) -> $result" >> "$REPORT_FILE"
  done < "$DISCREPANCY_FILE"

  # Summary at top (rewrite header with counts)
  {
    echo "## Summary"
    echo "- Entities compared: ${#ENTITIES[@]}"
    echo "- In CSV but not in Clean DB (seed job bug signal): $in_csv_count"
    echo "- Not in any CSV: $not_in_csv_count"
    echo ""
  } >> "$REPORT_FILE"

  # Cleanup temp
  rm -f "$OPENAPI_FILE" "$DISCREPANCY_FILE"

  echo "Done. Report: $REPORT_FILE"
}

main "$@"
