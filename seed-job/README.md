# AdventureWorks Database Seed Job

This directory contains a containerized database seeding solution that runs as an **Azure Container App Job** during deployment. The seed job populates the Azure SQL database with the complete AdventureWorks schema, sample data, and product images.

**Execution Time:** ~8 minutes

---

## Overview

The seed job is automatically deployed and executed during `azd up` by the `postprovision.sh` hook. It runs as a containerized job in Azure Container Apps, providing a reliable and repeatable way to initialize the database with:

- Complete AdventureWorks database schema
- Original AdventureWorks sample data (customers, products, orders, etc.)
- AI-enhanced datasets (synthetic reviews, generated descriptions, translations)
- Vector embeddings for semantic search capabilities
- Product images (1,739 PNG files)

---

## Architecture

### Container Image

The seed job runs in a Docker container based on `mcr.microsoft.com/azure-powershell:latest`, which includes:

- PowerShell 7
- Azure PowerShell modules (Az.Accounts, Az.Resources, Az.Sql)
- SQL connectivity tools

### Authentication

The container uses **Managed Identity** (passwordless authentication) to connect to:

- **Azure SQL Database**: Uses the user-assigned managed identity with db_datareader, db_datawriter, and db_ddladmin roles
- **Azure Resources**: Authenticates via managed identity for Azure resource access

Environment variables required:
- `AZURE_RESOURCE_GROUP`
- `SQL_SERVER_NAME`
- `SQL_DATABASE_NAME`
- `USER_MANAGED_IDENTITY_NAME`
- `TENANT_ID`
- `AZURE_CLIENT_ID`

---

## Directory Structure

```
seed-job/
├── dockerfile              # Container definition (Azure PowerShell base image)
├── seed-database.ps1      # Main database seeding script
├── images/                # Product images (1,739 PNG files)
│   └── *.png
└── sql/                   # SQL scripts and CSV data
    ├── AdventureWorks.sql           # Core schema + data load
    ├── AdventureWorks-AI.sql        # AI-specific schema (vectors, etc.)
    ├── assign-database-roles.sql    # Managed identity permissions
    ├── *.csv                        # Original AdventureWorks data
    └── *-ai.csv                     # AI-augmented datasets
```

---

## Components

### 1. `dockerfile`

Defines the container image:

- Base: `mcr.microsoft.com/azure-powershell:latest`
- Includes all SQL scripts, CSV files, and product images
- Sets entrypoint to execute `seed-database.ps1`
- Configures environment variables for Azure authentication

### 2. `seed-database.ps1`

Main PowerShell script (~1,585 lines) that orchestrates the entire seeding process:

**Key Features:**
- Comprehensive error handling and logging
- Managed identity authentication
- Progress tracking with elapsed time reporting
- CSV import with vector column support (VECTOR(1536) data type)
- Batch processing for large datasets
- Product image upload to Azure Blob Storage

**Execution Flow:**
1. Validates environment variables
2. Authenticates using managed identity
3. Waits for managed identity token availability
4. Executes SQL schema scripts (`AdventureWorks.sql`, `AdventureWorks-AI.sql`)
5. Imports CSV data files (base + AI-enhanced)
6. Uploads product images to Azure Blob Storage
7. Verifies data integrity with row counts

### 3. `sql/` Directory

Contains database initialization files:

- **SQL Scripts:**
  - `AdventureWorks.sql` - Core schema (tables, views, stored procedures)
  - `AdventureWorks-AI.sql` - AI-specific extensions (vector columns, embeddings)
  - `assign-database-roles.sql` - Database role assignments for managed identity

- **CSV Data Files:**
  - **79 CSV files total** (base + AI-enhanced)
  - Pipe-delimited format (`|`)
  - Includes original AdventureWorks data and AI-augmented datasets
  - See [sql/README.md](sql/README.md) for complete data catalog

### 4. `images/` Directory

Product images for the catalog:

- **1,739 PNG files**
- Named `product_<ProductID>_photo_<2|3|4>.png` (and `_small.png` / `_thumb.png`); ProductPhotoIDs come from `ProductProductPhoto-ai.csv`
- Uploaded to Azure Blob Storage during seeding
- Referenced by `Production.ProductPhoto` table

---

## Deployment Process

The seed job is deployed automatically during `azd up`:

### 1. Infrastructure Provisioning

The Bicep template in `infra/modules/aca-seed-job.bicep` creates:

- Azure Container App Job resource
- Job configuration with managed identity
- Environment variable injection
- Volume mounts for logging

### 2. Image Build and Deploy

`postprovision.sh` performs:

```bash
# Build container image in Azure Container Registry
az acr build \
    --registry $ACR_NAME \
    --image seed-job:latest \
    --file seed-job/dockerfile \
    seed-job

# Update Container App Job with new image
az containerapp job update \
    --name $SEED_JOB_NAME \
    --resource-group $RESOURCE_GROUP \
    --image "$ACR_ENDPOINT/seed-job:latest"

# Start the job asynchronously
az containerapp job start \
    --name $SEED_JOB_NAME \
    --resource-group $RESOURCE_GROUP
```

### 3. Job Execution

Once started, the Container App Job:

1. Pulls the image from Azure Container Registry
2. Creates a container instance with managed identity
3. Runs `seed-database.ps1`
4. Executes for approximately **8 minutes**
5. Terminates upon completion

---

## Monitoring

### Check Job Execution Status

```bash
# List all executions
az containerapp job execution list \
    --name <seed-job-name> \
    --resource-group <resource-group>

# Get specific execution details
az containerapp job execution show \
    --name <execution-name> \
    --job-name <seed-job-name> \
    --resource-group <resource-group>
```

### View Logs

```bash
# Stream logs from the job
az containerapp job logs show \
    --name <seed-job-name> \
    --resource-group <resource-group>
```

Logs include:

- Environment validation
- Managed identity authentication status
- SQL script execution progress
- CSV import progress (with row counts)
- Image upload progress
- Total execution time

---

## Data Loaded

The seed job populates the database with:

### Core AdventureWorks Data

- **Person & Business Entities**: Customers, employees, contacts, addresses
- **Product Catalog**: 504 products across multiple categories
- **Sales Orders**: Historical sales transactions
- **Production Data**: Inventory, work orders, manufacturing details
- **Purchasing**: Vendors, purchase orders
- **Human Resources**: Departments, shifts, employee history

### AI-Enhanced Datasets

- **Product Descriptions**: AI-generated enhanced descriptions with embeddings
- **Product Reviews**: Synthetic reviews with sentiment embeddings
- **Translations**: Multi-language product descriptions (23 cultures)
- **Enhanced Reference Data**: Enriched currency, state/province, country/region data

### Vector Embeddings

- **DescriptionEmbedding**: VECTOR(1536) for product descriptions
- **CommentsEmbedding**: VECTOR(1536) for product reviews
- Enables semantic search via Azure SQL vector capabilities

**Backfilling base description embeddings from a source API:** To populate the 762 base rows with embeddings at seed time (instead of running GenerateProductEmbeddings later), run `scripts/utilities/export-product-description-embeddings-from-source-api.sh` to build `sql/ProductDescription-ai-embeddings.csv` from the source DAB REST API. The seed script will then apply those updates after the main CSV import.

---

## Customization

### Adding New CSV Data

1. Place CSV file in `sql/` directory
2. Use pipe delimiter (`|`)
3. Update `seed-database.ps1` to include the new file in the import configuration
4. Rebuild and redeploy: `azd deploy`

### Modifying Schema

1. Update `AdventureWorks.sql` or `AdventureWorks-AI.sql`
2. Test locally using the script
3. Redeploy seed job: `azd deploy`

### Changing Images

1. Replace/add PNG files in `images/` directory
2. Ensure filenames match `product_<ProductID>_photo_<2|3|4>.png` and that `ProductProductPhoto-ai.csv` lists the ProductPhotoIDs used by the PNG upload
3. Rebuild container and redeploy

---

## Troubleshooting

### Job Fails to Start

**Check:**
- Container App Job exists: `az containerapp job show --name <job-name> --resource-group <rg>`
- Managed identity is assigned
- Environment variables are set correctly

### Authentication Errors

**Symptoms:** "Failed to acquire managed identity token"

**Solutions:**
- Verify managed identity has db_datareader, db_datawriter, db_ddladmin roles
- Check SQL Server firewall allows Azure services
- Confirm `assign-database-roles.sql` was executed in `postprovision.sh`

### CSV Import Failures

**Symptoms:** Row count mismatches or import errors; log shows `✗ Failed to load ... from ...`

**How to find the error in the seed log:**
1. Search the log for **`ProductReview`** (or the table that failed) and **`Failed`** to locate the failure line.
2. The next log line is the exception message: **`✗ Failed to load Production.ProductReview from ProductReview.csv: <message>`**
3. On the next run, the script also logs **Inner** (if any), **Error type**, and the first 5 lines of **ScriptStackTrace** to narrow down where it failed.

**Common causes by file:**

| File | Delimiter | Common causes |
|------|-----------|----------------|
| Most CSVs | Tab (`\t`) | Wrong delimiter; BOM or CRLF vs LF; column count doesn’t match table |
| **ProductReview.csv** | Tab | **Comments** column must be **UTF-16 LE hex** (even length, 0-9A-F only). Invalid hex or odd length → "Hex string length must be even" or "Could not find any recognizable digits". Ensure no newlines inside a row. |
| ProductReview-ai.csv | Tab | **CommentsEmbedding** must be a JSON array of 1536 floats; plain text in Comments. |

**ProductReview.csv specifics:**
- Loaded with `HexColumns=@('Comments')`: the 7th column is decoded from hex to Unicode before INSERT.
- Validate hex locally: each row’s Comments field must be an even-length string of hex digits (no spaces, no 0x prefix in the CSV). Re-run `scripts/utilities/clean-product-review-csv.py` if the source was plain text or had newlines.

**General:**
- Delimiter: most seed CSVs use **tab**, not pipe (see `seed-database.ps1` `Delimiter` per file).
- Encoding: UTF-8 expected; avoid BOM if the script doesn’t strip it.
- Line endings: script uses `RowTerminator="\n"`; CRLF can cause extra columns if not normalized.

### Image Upload Failures

**Symptoms:** Images not appearing in application

**Solutions:**
- Verify Storage Account exists and is accessible
- Check managed identity has Storage Blob Data Contributor role
- Confirm STORAGE_ACCOUNT_NAME environment variable is set

### Missing Product Description Embeddings

**Symptoms:** Query shows many finished-goods descriptions with `DescriptionEmbedding IS NULL` (e.g. ~1764 of 6175).

**Cause:** The seed loads 762 base rows from `ProductDescription.csv` (no embeddings) and adds 1848 rows from `ProductDescription-ai.csv` (with embeddings). The base 762 never receive embeddings during seed. `ProductDescription-ai-translations.csv` only updates `Description`/`ModifiedDate` and correctly does not overwrite `DescriptionEmbedding`.

**Solutions:**
1. **Source API CSV (recommended for repeatable seed):** Run `scripts/utilities/export-product-description-embeddings-from-source-api.sh` to generate `sql/ProductDescription-ai-embeddings.csv`; the seed job will apply these updates after import.
2. **Post-seed backfill:** Run the **GenerateProductEmbeddings** Azure Function (or equivalent) after seeding to backfill descriptions where `DescriptionEmbedding IS NULL`.

---

## Performance

**Typical Execution Times:**

- Environment setup: ~30 seconds
- Schema creation: ~1 minute
- CSV data import: ~5 minutes
- Image upload: ~2 minutes
- **Total: ~8 minutes**

**Resource Usage:**

- CPU: 0.25 cores
- Memory: 0.5 GB
- Storage: ~200 MB (container image)

---

## Related Documentation

- [SQL Scripts and Data Catalog](sql/README.md) - Complete CSV file reference
- [Database Schema Documentation](../docs/architecture/) - Database design details
- [Deployment Guide](../QUICKSTART.md) - Full deployment walkthrough
- [Infrastructure Documentation](../infra/README.md) - Bicep configuration
- [Scripts Documentation](../scripts/README.md) - Hook execution details

---

## Development

### Testing Locally

The seed job can be tested locally using Docker:

```bash
# Build the container
docker build -t seed-job:local -f dockerfile .

# Run with environment variables
docker run \
  -e AZURE_RESOURCE_GROUP="your-rg" \
  -e SQL_SERVER_NAME="your-server" \
  -e SQL_DATABASE_NAME="your-db" \
  -e USER_MANAGED_IDENTITY_NAME="your-mi" \
  -e TENANT_ID="your-tenant" \
  -e AZURE_CLIENT_ID="your-client-id" \
  seed-job:local
```

**Note:** Local execution requires Azure CLI authentication (`az login`) and appropriate permissions.

### Manual Execution in Azure

Trigger the job manually:

```bash
az containerapp job start \
    --name <seed-job-name> \
    --resource-group <resource-group>
```

This is useful for:
- Resetting the database to initial state
- Testing schema changes
- Re-importing data after modifications

---

## Best Practices

1. **Idempotency**: The seed script is designed to be idempotent - it can be run multiple times safely
2. **Error Handling**: Comprehensive error logging helps diagnose issues quickly
3. **Progress Tracking**: Real-time progress updates during execution
4. **Managed Identity**: No secrets or connection strings in code
5. **Container Isolation**: Runs in isolated environment with no impact on other services
6. **Version Control**: All data and scripts are version-controlled for reproducibility

---

## Security Considerations

- **No Credentials**: Uses managed identity exclusively (no passwords, keys, or connection strings)
- **Least Privilege**: Managed identity has only required database roles
- **Network Isolation**: Runs within Azure Container Apps Environment virtual network
- **Audit Trail**: All operations logged with timestamps
- **Secret-Free**: No sensitive data in environment variables or configuration files
