#!/bin/bash
set -e

# Export AI-generated product description translations to CSV
# This exports translations for the 16 cultures added beyond base AdventureWorks data

echo "Exporting AI-generated product description translations..."

# Get database connection info from azd
SQL_SERVER=$(azd env get-values | grep "^SQL_SERVER_NAME=" | cut -d'=' -f2 | tr -d '"')
DB_NAME=$(azd env get-values | grep "^SQL_DATABASE_NAME=" | cut -d'=' -f2 | tr -d '"')
DB_USER=$(azd env get-values | grep "^SQL_ADMIN_USER=" | cut -d'=' -f2 | tr -d '"')
DB_PASSWORD=$(azd env get-values | grep "^SQL_ADMIN_PASSWORD=" | cut -d'=' -f2 | tr -d '"' | sed 's/\\!/!/g')

OUTPUT_FILE="$(dirname "$0")/sql/ProductModelProductDescriptionCulture-ai.csv"

echo "Database: ${SQL_SERVER}.database.windows.net / $DB_NAME"
echo "Output: $OUTPUT_FILE"

# Base AdventureWorks cultures (7): ar, en, es, fr, he, th, zh-cht
# AI-generated cultures (16): de, en-au, en-ca, en-gb, en-ie, en-nz, id, it, ja, ko, nl, pt, ru, tr, vi, zh

echo ""
echo "Querying database for AI translations..."

# Export only AI-generated translations (cultures not in base set)
# Note: CultureID is NCHAR(6) so includes trailing spaces
sqlcmd -S "${SQL_SERVER}.database.windows.net" -d "$DB_NAME" -U "$DB_USER" -P "$DB_PASSWORD" -C -h -1 -W -s"|" -Q \
"SET NOCOUNT ON;
SELECT 
    ProductModelID,
    ProductDescriptionID,
    CultureID,
    CONVERT(VARCHAR(23), ModifiedDate, 121) as ModifiedDate
FROM Production.ProductModelProductDescriptionCulture
WHERE RTRIM(CultureID) NOT IN ('ar', 'en', 'es', 'fr', 'he', 'th', 'zh-cht')
ORDER BY ProductModelID, CultureID" \
-o "$OUTPUT_FILE"

# Remove any extra whitespace and empty lines
sed -i '/^[[:space:]]*$/d' "$OUTPUT_FILE"

# Count records
RECORD_COUNT=$(wc -l < "$OUTPUT_FILE")

echo ""
echo "✅ Exported $RECORD_COUNT AI-generated translation records"
echo "   File: $OUTPUT_FILE"
echo ""
echo "Expected: 128 ProductModels × 16 AI cultures = 2,048 records"
echo "Current progress: $RECORD_COUNT / 2,048 records"
echo ""
echo "This file will be loaded by postprovision.ps1 on fresh deployments."
echo ""

# Show sample of exported data
if [ $RECORD_COUNT -gt 0 ]; then
    echo "Sample records:"
    head -n 3 "$OUTPUT_FILE"
fi
