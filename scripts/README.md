# AdventureWorks Scripts

This directory contains automation scripts for the AdventureWorks project, organized by purpose.

## Directory Structure

```
scripts/
├── hooks/              # Azure Developer CLI (azd) lifecycle hooks
├── data-management/    # Database export and data management tools
├── generators/         # AI content and test data generators
├── utilities/          # Development and maintenance utilities
└── sql/               # SQL scripts and seed data
```

## 📌 Hooks (azd Lifecycle)

**Location:** `hooks/`

These scripts are automatically executed during `azd` operations:

| Script                | Runs During        | Purpose                                        | Duration          |
| --------------------- | ------------------ | ---------------------------------------------- | ----------------- |
| **preup.ps1**         | Before `azd up`    | Creates Entra ID apps, discovers OpenAI models | ~2-3 min          |
| **postprovision.sh**  | After provisioning | Database role assignments, seed-job deployment | ~2-3 min (hook) + ~8 min (seed-job async) |
| **postup.ps1**        | After `azd up`     | Final configuration                            | < 1 min           |
| **predeploy.sh**      | Before deployment  | Build preparation                              | ~1-2 min          |
| **postdeploy.ps1**    | After deployment   | CORS config, redirect URIs                     | < 1 min           |
| **postdown.ps1**      | After `azd down`   | Cleanup operations                             | < 1 min           |

**Total `azd up` time:** ~29 minutes (includes ~21 minutes for infrastructure provisioning + ~8 minutes for seed-job data loading)

**⚠️ Important:** These scripts are referenced in `azure.yaml`. Do not move or rename without updating the configuration.

For detailed information on what each hook does, see the comments in the hook files themselves or refer to the [AdventureWorks instructions](../.github/copilot-instructions.md) for the complete deployment workflow.

For details on the database seeding process, see [seed-job/README.md](../seed-job/README.md).

## 📊 Data Management

**Location:** `data-management/`

Scripts for exporting and managing AdventureWorks data:

### Export Scripts

- **export-all-embeddings.sh** - Export all product and review embeddings to JSON
- **export-ai-product-descriptions.sh** - Export AI-generated product descriptions
- **export-ai-translations.sh** - Export translated product descriptions
- **export-product-description-embeddings.js** - Node.js script for description embeddings
- **export-product-review-embeddings.js** - Node.js script for review embeddings
- **export-product-reviews.js** - Export product reviews data

### Monitoring

- **monitor-orchestration.sh** - Monitor Durable Functions orchestration status

### Documentation

See [../docs/data-management/](../docs/data-management/) for:

- Embedding export formats and limitations
- Translation export procedures
- Azure Blob Storage integration

## 🎲 Generators

**Location:** `generators/`

Scripts for generating AI content and test data:

- **generate-reviews-with-embeddings.sh** - Generate product reviews with vector embeddings
- **generate-telemetry.sh** - Generate sample telemetry data for Application Insights

These are typically used during development or for populating demo environments.

## 🛠️ Utilities

**Location:** `utilities/`

Development and maintenance utilities:

- **batch-translate-language-file.sh** - Batch translate UI language files
- **check-product-photo-duplicates.sh** - Detect duplicate product photos in database
- **dab-seed-comparison.sh** - Compare Known Good vs Clean (seed) DAB deployment; cross-check discrepancies with seed CSVs
- **download-large-images.ps1** - Download large product images from Azure
- **playwright-quick-ref.sh** - Quick reference commands for Playwright tests

## 🗄️ SQL Scripts

**Location:** `sql/`

Database scripts and seed data (CSV files, initialization scripts, schema updates).

## Usage Examples

### Running Data Exports

```bash
# Export all embeddings
./scripts/data-management/export-all-embeddings.sh

# Export AI-enhanced descriptions
./scripts/data-management/export-ai-product-descriptions.sh

# Monitor durable function
./scripts/data-management/monitor-orchestration.sh <orchestration-id>
```

### Running Generators

```bash
# Generate product reviews
./scripts/generators/generate-reviews-with-embeddings.sh

# Generate telemetry for testing
./scripts/generators/generate-telemetry.sh
```

### Running Utilities

```bash
# Check for duplicate photos
./scripts/utilities/check-product-photo-duplicates.sh

# Translate language files
./scripts/utilities/batch-translate-language-file.sh <language-code>
```

## Prerequisites

Different scripts have different requirements:

- **PowerShell scripts** (.ps1) - PowerShell 7+ (`pwsh`)
- **Shell scripts** (.sh) - Bash shell
- **Node.js scripts** (.js) - Node.js 18+
- **Azure CLI** - Most scripts require Azure authentication (`az login`)
- **jq** - JSON parsing for many shell scripts
- **azd environment** - Scripts use `azd env` for configuration

## Environment Configuration

Most scripts read configuration from `azd` environment:

```bash
# Refresh environment
azd env refresh

# View current values
azd env get-values

# Load into current shell (bash)
source <(azd env get-values)
```

## Test Scripts

**Test scripts have been moved** to [/tests/scripts/](../tests/scripts/) for better organization.

This includes all API tests, integration tests, and validation scripts.

## Related Documentation

- [Data Management Docs](../docs/data-management/) - Export and import procedures
- [Test Scripts Guide](../tests/scripts/README.md) - Test script documentation
- [Main Documentation](../docs/) - Feature documentation organized by topic
- [Azure Deployment Workflow](../.github/copilot-instructions.md) - Complete azd lifecycle documentation
