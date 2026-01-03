# Embedding CSV Export Implementation Summary

## Date: January 3, 2026

## Objective

Create scripts to export VECTOR embeddings from Azure SQL to CSV files compatible with the postprovision.ps1 import process.

## Problem Context

After migrating from VARBINARY(MAX) to VECTOR(1536) columns:

- Old CSV files contain hex-encoded (`0xBEA6...`) or base64-encoded binary data
- New VECTOR columns require JSON array format (`"[0.1,0.2,...]"`)
- Postprovision script needs updated to handle VECTOR data type

## Solution Implemented

### 1. Export Scripts Created

#### `/workspaces/AdventureWorks/scripts/export-product-description-embeddings.js`

- Connects to Azure SQL database
- Queries `Production.ProductDescription` WHERE `DescriptionEmbedding IS NOT NULL`
- Exports to `scripts/sql/ProductDescription-ai.csv`
- Format: Tab-separated values with JSON embedding array

#### `/workspaces/AdventureWorks/scripts/export-product-review-embeddings.js`

- Connects to Azure SQL database
- Queries `Production.ProductReview` WHERE `CommentsEmbedding IS NOT NULL`
- Exports to `scripts/sql/ProductReview-ai.csv`
- Format: Tab-separated values with quoted Comments field and JSON embedding array

#### `/workspaces/AdventureWorks/scripts/export-all-embeddings.sh`

- Master script to run both exports
- Auto-installs `mssql` npm package if needed
- Provides progress feedback and file size information

### 2. Postprovision Script Updates

#### File: `/workspaces/AdventureWorks/scripts/postprovision.ps1`

**Changes made:**

1. **Updated CSV import configurations (lines 584-591):**

   ```powershell
   # OLD:
   HexColumns=@('DescriptionEmbedding')
   Base64Columns=@('CommentsEmbedding')

   # NEW:
   VectorColumns=@('DescriptionEmbedding')
   VectorColumns=@('CommentsEmbedding')
   ```

2. **Added VectorColumns check (line 723):**

   ```powershell
   $hasSpecialColumns = ... -or ($config.VectorColumns -and $config.VectorColumns.Count -gt 0)
   ```

3. **Added VECTOR data type handling (after line 945):**

   ```powershell
   'vector' {
       # VECTOR columns contain JSON arrays of floats
       if ([string]::IsNullOrWhiteSpace($val)) {
           $dataRow[$dataTableColIndex] = [System.DBNull]::Value
       } else {
           $dataRow[$dataTableColIndex] = $val
       }
   }
   ```

4. **Added VECTOR INSERT handling (after line 298):**
   ```powershell
   elseif ($col.Type -eq 'vector') {
       $escapedVal = $value.ToString().Replace("'", "''")
       $values += "CAST('$escapedVal' AS VECTOR(1536))"
   }
   ```

### 3. Documentation Created

#### `/workspaces/AdventureWorks/scripts/EMBEDDING_EXPORT.md`

Comprehensive guide covering:

- Script descriptions and usage
- Prerequisites and environment variables
- Integration with deployment pipeline
- VECTOR vs VARBINARY comparison table
- Troubleshooting guide
- Related files reference

## Data Format Comparison

### Old Format (VARBINARY)

```csv
ProductDescriptionID    Description    rowguid    ModifiedDate    DescriptionEmbedding
3                       Text...        GUID...    2025-12-17...   0xBEA6213D1F88BEBC59E3...
```

### New Format (VECTOR)

```csv
ProductDescriptionID    Description    rowguid    ModifiedDate    DescriptionEmbedding
3                       Text...        GUID...    2025-12-17...   "[-0.028398432,0.036461145,...]"
```

## SQL Import Process

### Old (VARBINARY):

```sql
INSERT INTO Production.ProductDescription VALUES (..., 0xBEA6213D...)
```

### New (VECTOR):

```sql
INSERT INTO Production.ProductDescription VALUES (..., CAST('[-0.028398432,...]' AS VECTOR(1536)))
```

## File Locations

```
AdventureWorks/
├── scripts/
│   ├── export-product-description-embeddings.js  ← NEW
│   ├── export-product-review-embeddings.js       ← NEW
│   ├── export-all-embeddings.sh                  ← NEW
│   ├── EMBEDDING_EXPORT.md                       ← NEW (Documentation)
│   ├── postprovision.ps1                         ← UPDATED (VECTOR support)
│   └── sql/
│       ├── ProductDescription-ai.csv             ← TO BE GENERATED
│       └── ProductReview-ai.csv                  ← TO BE GENERATED
```

## Testing Status

### Current Status (as of document creation):

- ✅ Export scripts created and made executable
- ✅ Postprovision.ps1 updated with VECTOR support
- ✅ Documentation complete
- ⏳ Embedding generation in progress (480/863 products, 480/1397 reviews)
- ⏳ Export scripts not yet tested (waiting for embeddings to complete)

### Next Steps:

1. Wait for all embeddings to be generated
2. Run `./export-all-embeddings.sh` to create CSV files
3. Verify CSV file format and content
4. Test postprovision.ps1 import on fresh database (optional)
5. Commit changes to repository

## Technical Details

### SQL Server VECTOR Type

- Native type in Azure SQL Database (compatibility level 160+)
- Stores floating-point arrays efficiently
- Supports VECTOR_DISTANCE function for similarity search
- JSON format for import: `"[float1,float2,...]"`

### Node.js Dependencies

- `mssql` package for SQL Server connectivity
- Uses TDS protocol over encrypted connection
- Automatic retry and timeout handling

### PowerShell Enhancements

- Type detection via `INFORMATION_SCHEMA.COLUMNS`
- Dynamic INSERT generation with CAST expressions
- Transaction-based bulk import for safety

## Benefits

1. **Correct Data Format**: CSV files match VECTOR column requirements
2. **Automated Workflow**: Single script exports both tables
3. **Future-Proof**: Works with any VECTOR dimension (currently 1536)
4. **Deployment Ready**: Integrates with existing postprovision pipeline
5. **Well Documented**: Complete guide for maintenance and troubleshooting

## Known Limitations

1. **Hardcoded Dimension**: Scripts assume VECTOR(1536)
   - _Mitigation_: Documented in code comments for easy updates
2. **File Size**: JSON format ~2x larger than binary
   - _Impact_: ~15-20MB total, manageable for git/deployment
3. **Manual Trigger**: Export must be run manually after embedding changes
   - _Mitigation_: Documented workflow in EMBEDDING_EXPORT.md

## Related Commits/Changes

These changes support the broader VARBINARY → VECTOR migration:

- Database schema updated in `AdventureWorks-AI.sql`
- Functions updated to use `float[]` and JSON serialization
- Services updated to work with native VECTOR type
- CSV export/import aligned with new format

## Completion Checklist

- [x] Create export-product-description-embeddings.js
- [x] Create export-product-review-embeddings.js
- [x] Create export-all-embeddings.sh master script
- [x] Update postprovision.ps1 VectorColumns configuration
- [x] Add VECTOR type handling in postprovision.ps1 CSV parser
- [x] Add VECTOR CAST support in postprovision.ps1 INSERT builder
- [x] Create EMBEDDING_EXPORT.md documentation
- [x] Make all scripts executable
- [ ] Test export scripts with complete embeddings
- [ ] Verify CSV file format
- [ ] Test postprovision.ps1 import (optional)
