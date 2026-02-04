#!/bin/bash
set -e

# Export AI-generated ProductDescription records
# These are the actual translated description texts created by Azure Functions

echo "Exporting AI-generated ProductDescription records..."

# Get database connection info from azd
SQL_SERVER=$(azd env get-values | grep "^SQL_SERVER_NAME=" | cut -d'=' -f2 | tr -d '"')
DB_NAME=$(azd env get-values | grep "^SQL_DATABASE_NAME=" | cut -d'=' -f2 | tr -d '"')
DB_USER=$(azd env get-values | grep "^SQL_ADMIN_USER=" | cut -d'=' -f2 | tr -d '"')
DB_PASSWORD=$(azd env get-values | grep "^SQL_ADMIN_PASSWORD=" | cut -d'=' -f2 | tr -d '"' | sed 's/\\!/!/g')

OUTPUT_FILE="$(dirname "$0")/sql/ProductDescription-ai-translations.csv"

echo "Database: ${SQL_SERVER}.database.windows.net / $DB_NAME"
echo "Output: $OUTPUT_FILE"
echo ""

# Strategy: Export ProductDescription records that are referenced by AI translations
# These are ProductDescriptionIDs that appear in ProductModelProductDescriptionCulture
# for the 16 AI cultures (de, en-au, en-ca, en-gb, en-ie, en-nz, id, it, ja, ko, nl, pt, ru, tr, vi, zh)
# but NOT in the base 7 cultures (ar, en, es, fr, he, th, zh-cht)

echo "Querying for AI-generated product descriptions..."

sqlcmd -S "${SQL_SERVER}.database.windows.net" -d "$DB_NAME" -U "$DB_USER" -P "$DB_PASSWORD" -C -h -1 -W -s"|" -Q \
"SET NOCOUNT ON;
-- Get ProductDescriptionIDs used only in AI translations (not in base cultures)
WITH AITranslationDescriptions AS (
    SELECT DISTINCT ProductDescriptionID
    FROM Production.ProductModelProductDescriptionCulture
    WHERE RTRIM(CultureID) NOT IN ('ar', 'en', 'es', 'fr', 'he', 'th', 'zh-cht')
),
BaseDescriptions AS (
    SELECT DISTINCT ProductDescriptionID
    FROM Production.ProductModelProductDescriptionCulture
    WHERE RTRIM(CultureID) IN ('ar', 'en', 'es', 'fr', 'he', 'th', 'zh-cht')
)
SELECT 
    pd.ProductDescriptionID,
    pd.Description,
    CONVERT(VARCHAR(23), pd.ModifiedDate, 121) as ModifiedDate
FROM Production.ProductDescription pd
INNER JOIN AITranslationDescriptions ai ON pd.ProductDescriptionID = ai.ProductDescriptionID
LEFT JOIN BaseDescriptions base ON pd.ProductDescriptionID = base.ProductDescriptionID
WHERE base.ProductDescriptionID IS NULL  -- Only NEW descriptions created for AI translations
ORDER BY pd.ProductDescriptionID" \
-o "$OUTPUT_FILE"

# Remove any extra whitespace and empty lines
sed -i '/^[[:space:]]*$/d' "$OUTPUT_FILE"

# Count records
RECORD_COUNT=$(wc -l < "$OUTPUT_FILE")

echo ""
echo "✅ Exported $RECORD_COUNT AI-generated product description records"
echo "   File: $OUTPUT_FILE"
echo ""
echo "Expected: ~2,048 descriptions (1 per ProductModel × culture combination)"
echo "Actual may be less if descriptions are shared across cultures."
echo ""
echo "This file will be loaded by postprovision.ps1 on fresh deployments."
echo ""

# Show sample of exported data
if [ $RECORD_COUNT -gt 0 ]; then
    echo "Sample records (first 3):"
    head -n 3 "$OUTPUT_FILE" | cut -c1-100
    echo ""
    echo "Total size:"
    ls -lh "$OUTPUT_FILE" | awk '{print "  " $5}'
fi
