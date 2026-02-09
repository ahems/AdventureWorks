# Product Description Translation Export

## Overview

This document describes how to export AI-generated product description translations to a CSV file for deployment with fresh AdventureWorks instances.

## Background

The AdventureWorks database includes product descriptions in 7 base cultures:

- ar (Arabic)
- en (English)
- es (Spanish)
- fr (French)
- he (Hebrew)
- th (Thai)
- zh-cht (Traditional Chinese)

We've added 16 additional cultures for broader language support:

- de (German)
- en-au (English - Australia)
- en-ca (English - Canada)
- en-gb (English - United Kingdom)
- en-ie (English - Ireland)
- en-nz (English - New Zealand)
- id (Indonesian)
- it (Italian)
- ja (Japanese)
- ko (Korean)
- nl (Dutch)
- pt (Portuguese)
- ru (Russian)
- tr (Turkish)
- vi (Vietnamese)
- zh (Simplified Chinese)

## Translation Process

Translations are generated using Azure Functions with Azure OpenAI:

1. Run the `TranslateProductDescriptions` Azure Function with all ProductModel IDs
2. Function translates each ProductModel's description into all 16 new cultures
3. Function creates NEW ProductDescription records (translated text) and ProductModelProductDescriptionCulture mappings
4. Expected result:
   - 2,048 culture mapping records (128 ProductModels × 16 cultures)
   - ~2,032 new ProductDescription records (actual translated text)

## Export Scripts

### 1. Export Translation Mappings

**Location**: `scripts/export-ai-translations.sh`

**Purpose**: Exports culture mappings to `seed-job/sql/ProductModelProductDescriptionCulture-ai.csv`

**Usage**:

```bash
cd scripts
./export-ai-translations.sh
```

**What it exports**:

- ProductModelID → ProductDescriptionID → CultureID mappings
- Records for 16 AI cultures only (excludes base 7)
- Expected: 2,048 mapping records

### 2. Export Translated Text Content

**Location**: `scripts/export-ai-product-descriptions.sh`

**Purpose**: Exports actual translated descriptions to `seed-job/sql/ProductDescription-ai-translations.csv`

**Usage**:

```bash
cd scripts
./export-ai-product-descriptions.sh
```

**What it exports**:

- ProductDescription records (ProductDescriptionID, Description text, ModifiedDate)
- Only NEW descriptions created for AI translations
- Expected: ~2,032 description records (may be less if translations share descriptions)

### Running the Export Scripts

**Run both scripts**:

```bash
cd scripts
./export-ai-translations.sh          # Export culture mappings
./export-ai-product-descriptions.sh   # Export translated text
```

**When to run**:

- **During translation**: Capture partial progress
- **After completion**: Capture all records for deployment

Both scripts overwrite their CSV files each time, so run them multiple times safely.

## Deployment Integration

The exported CSVs in `seed-job/sql/` are containerized and automatically loaded during `azd up`:

**Usage**:

```bash
cd scripts
./export-ai-translations.sh
```

**What it does**:

- Connects to Azure SQL database using credentials from `azd env get-values`
- Queries `Production.ProductModelProductDescriptionCulture` for non-base cultures
- Exports to CSV with pipe delimiter (`|`)
- Shows progress: `X / 2,048 records`

Both exported CSVs are loaded by the **seed-job** Container App Job during deployment:

**Configuration** (lines 667-678):

```powershell
$aiCsvBaseRecordCounts = @{
    ...
    'ProductDescription-ai-translations.csv' = 762
    'ProductModelProductDescriptionCulture-ai.csv' = 874
}
```

**Load configuration** (lines 591-595):

```powershell
# AI-translated product descriptions (actual text content for 16 new cultures)
@{ Table='Production.ProductDescription';
   File='ProductDescription-ai-translations.csv';
   Delimiter="`t";
   RowTerminator="`n";
   IsWideChar=$false }

# AI-translated product description culture mappings (16 additional cultures)
@{ Table='Production.ProductModelProductDescriptionCulture';
   File='ProductModelProductDescriptionCulture-ai.csv';
   Delimiter="`t";
   RowTerminator="`n";
   IsWideChar=$false }
```

**Behavior**:

- Only loads if table has exactly **874 base records** (7 cultures × ~125 models)
- Adds the 2,048 AI-translated records on top of base data
- Skips loading if AI data already exists (idempotent)

## Database Schema

**Table**: `Production.ProductModelProductDescriptionCulture`

**Structure**:

- `ProductModelID` (int) - Links to Production.ProductModel
- `ProductDescriptionID` (int) - Links to Production.ProductDescription
- `CultureID` (nchar(6)) - 6-character culture code (padded with spaces)
- `ModifiedDate` (datetime) - Last modification timestamp

**Record counts**:

- Base AdventureWorks: 874 records (7 cultures)
- AI additions: 2,048 records (16 cultures)
- Total after enhancement: 2,922 records (23 cultures)

## Verification

**Check translation progress**:

```bash
# Count German translations (de)
curl -s -X POST "https://av-api-[your-env].azurecontainerapps.io/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ productModelProductDescriptionCultures(filter: { CultureID: { eq: \"de\" } }) { items { ProductModelID } } }"}' \
  | jq '.data.productModelProductDescriptionCultures.items | length'

# Expected: 128 when complete
```

**Check base record count** (for postprovision validation):

```bash
sqlcmd -S [server].database.windows.net -d AdventureWorks -U [user] -P [password] -C \
  -Q "SELECT COUNT(*) FROM Production.ProductModelProductDescriptionCulture
      WHERE RTRIM(CultureID) IN ('ar', 'en', 'es', 'fr', 'he', 'th', 'zh-cht')"

# Should return: 874
```

## Cost Optimization

Generating translations via Azure Functions + OpenAI is expensive. This CSV export allows:

1. **One-time translation**: Translate once in your development environment
2. **Export to CSV**: Capture translations for version control
3. **Deploy everywhere**: Load pre-translated data on all new deployments
4. **Avoid retranslation**: Skip expensive API calls on every provision

## Workflow

**Initial setup** (one-time):

```bash
# 1. Deploy infrastructure
azd up

# 2. Run translation function
curl -X POST "https://av-func-[env].azurecontainerapps.io/api/TranslateProductDescriptions_HttpStart" \
  -H "Content-Type: application/json" \
  -d '{"productModelIds": [1,2,3,...,128]}'

# 3. Wait for completion (~30 minutes)

# 4. Export translations
cd scripts && ./export-ai-translations.sh

# 5. Commit CSV file
git add sql/ProductModelProductDescriptionCulture-ai.csv
git commit -m "Add AI-generated product description translations"
```

**Subsequent deployments**:

```bash
# Just provision - translations load automatically
azd provision
```

## Files Modified

1. **`scripts/export-ai-translations.sh`** - Export script (NEW)
2. **`seed-job/sql/ProductModelProductDescriptionCulture-ai.csv`** - Exported data (GENERATED)
3. **`seed-job/seed-database.ps1`** - Database seeding script that loads these CSV files in the container

For complete details on how the seed-job processes these files, see [seed-job/README.md](../../seed-job/README.md).

## Notes

- **CultureID padding**: Database stores CultureID as `NCHAR(6)` with trailing spaces
- **API pagination**: DAB API limits results to 100 items - use GraphQL filters for full data
- **Idempotency**: Script can be run multiple times safely (overwrites file)
- **Progress tracking**: German (de) culture used as indicator for monitoring
- **Future proofing**: Add new cultures by:
  1. Adding to `Production.Culture` table
  2. Running translation function with new culture codes
  3. Re-exporting CSV with updated script

## Related Documentation

- [Translation Quickstart](../TRANSLATION_QUICKSTART.md) - UI translation process
- [Language Translation Implementation](../LANGUAGE_TRANSLATION_IMPLEMENTATION.md) - Overall translation architecture
- [DAB Naming Conventions](../docs/DAB_NAMING_CONVENTIONS.md) - GraphQL API patterns
