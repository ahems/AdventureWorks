#!/bin/bash
# Export all embeddings from database to CSV files compatible with VECTOR columns
# This script exports both ProductDescription and ProductReview embeddings

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "================================================"
echo "Exporting embeddings from Azure SQL to CSV"
echo "================================================"
echo ""

# Check if node is available
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    exit 1
fi

# Check if mssql package is installed
if ! node -e "require('mssql')" 2>/dev/null; then
    echo "Installing mssql package..."
    cd "$SCRIPT_DIR/.." && npm install mssql
fi

echo "Step 1: Exporting Product Description embeddings..."
echo "---------------------------------------------------"
node "$SCRIPT_DIR/export-product-description-embeddings.js"
echo ""

echo "Step 2: Exporting Product Review embeddings..."
echo "---------------------------------------------------"
node "$SCRIPT_DIR/export-product-review-embeddings.js"
echo ""

echo "================================================"
echo "✓ All embeddings exported successfully!"
echo "================================================"
echo ""
echo "Generated files:"
echo "  - $SCRIPT_DIR/sql/ProductDescription-ai.csv"
echo "  - $SCRIPT_DIR/sql/ProductReview-ai.csv"
echo ""
echo "These files are now compatible with VECTOR columns and can be"
echo "imported during the postprovision.ps1 script execution."
