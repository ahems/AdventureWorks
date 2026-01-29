# Embedding Export Scripts

This directory contains scripts to export embeddings from the Azure SQL database to CSV files compatible with VECTOR columns.

## Overview

After migrating from VARBINARY(MAX) to VECTOR(1536) columns, embeddings need to be exported in JSON array format rather than hex/base64-encoded binary format.

## Scripts

### `export-product-description-embeddings.js`

Exports product description embeddings to `sql/ProductDescription-ai.csv`.

**Output format:**

```
ProductDescriptionID    Description    rowguid    ModifiedDate    DescriptionEmbedding
3                       Text...        GUID...    2025-12-17...   "[0.1,0.2,0.3,...]"
```

### `export-product-review-embeddings.js`

Exports product review embeddings to `sql/ProductReview-ai.csv`.

**Output format:**

```
ProductReviewID    ProductID    ReviewerName    ReviewDate    EmailAddress    Rating    Comments    ModifiedDate    CommentsEmbedding    Approved
5                  680          Emily C...      2014-10-20... email@...       5         "Text..."   2026-01-03...   "[0.1,0.2,...]"     1
```

### `export-all-embeddings.sh`

Master script that runs both export scripts in sequence.

## Usage

### Prerequisites

- Node.js installed
- `mssql` npm package (will be auto-installed by export-all-embeddings.sh)
- SQL Server credentials set in environment or using defaults:
  - `SQL_SERVER` (default: av-sql-ewphuc52etkbc.database.windows.net)
  - `SQL_DATABASE` (default: AdventureWorks)
  - `SQL_USER` (default: CloudSA7d3784da)
  - `SQL_PASSWORD` (default: TempP@ssw0rd123!)

### Export All Embeddings

```bash
cd /workspaces/AdventureWorks/scripts
./export-all-embeddings.sh
```

### Export Individual Files

```bash
# Product descriptions only
node export-product-description-embeddings.js

# Reviews only
node export-product-review-embeddings.js
```

## Integration with Deployment

The exported CSV files are used by `postprovision.ps1` during Azure deployment:

1. **AdventureWorks-AI.sql** creates tables with VECTOR(1536) columns
2. **postprovision.ps1** imports CSV files with these configurations:

   ```powershell
   @{ Table='Production.ProductDescription'; File='ProductDescription-ai.csv';
      VectorColumns=@('DescriptionEmbedding') }

   @{ Table='Production.ProductReview'; File='ProductReview-ai.csv';
      VectorColumns=@('CommentsEmbedding') }
   ```

3. VECTOR columns are imported using:
   ```sql
   CAST('[0.1,0.2,...]' AS VECTOR(1536))
   ```

## When to Re-Export

Re-run these scripts whenever:

- Embeddings are regenerated with new models
- Embedding dimensions change (requires updating CAST statements)
- Setting up a new environment with pre-populated embeddings

## VECTOR vs VARBINARY

| Aspect     | Old (VARBINARY)          | New (VECTOR)                  |
| ---------- | ------------------------ | ----------------------------- |
| Storage    | Hex/Base64 encoded bytes | JSON float array              |
| Size       | ~6KB per embedding       | ~12KB per embedding           |
| Queries    | Binary comparison        | Native VECTOR_DISTANCE        |
| CSV Format | `0xBEA6213D...`          | `"[0.12,-0.05,...]"`          |
| SQL Cast   | Not needed               | `CAST(@Json AS VECTOR(1536))` |

## Troubleshooting

### "Cannot connect to database"

- Verify SQL credentials
- Check firewall rules allow your IP
- Ensure database exists

### "No embeddings found"

- Run embedding generation functions first
- Check `WHERE DescriptionEmbedding IS NOT NULL`
- Verify VECTOR columns exist (not VARBINARY)

### "CSV file too large"

- Normal - VECTOR JSON format is ~2x larger than binary
- Product descriptions: ~5-10 MB
- Reviews: ~15-20 MB
- Use git-lfs if committing to repository

## Related Files

- `../scripts/sql/AdventureWorks-AI.sql` - Schema with VECTOR columns
- `../scripts/postprovision.ps1` - Deployment script
- `../api-functions/Services/ProductService.cs` - Embedding generation
- `../api-functions/Services/ReviewService.cs` - Embedding generation
