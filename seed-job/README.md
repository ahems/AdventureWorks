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
- Approved generated manufacturing instruction/illustration overlays (imported and verified on every `azd up`)

The preup hook runs `python3 scripts/data-management/validate-manufacturing-assets.py` before Azure operations; postprovision repeats validation after Git LFS hydration and before the seed image build, and predeploy repeats it before frontend builds. This offline gate checks published CSV/SVG/metadata consistency and coverage, never generating content. Missing or inconsistent published assets stop deployment.

The post-provision hook waits for its **specific seed-job execution** to succeed before service deployment. An existing populated database is preserved: only the manufacturing overlays are imported. An empty database receives the full base seed first. No AI generation runs during deployment. Python 3 is required locally for the asset-validation hooks.

Fresh provisioning configures SQL with **public access disabled from creation** and makes a **dedicated seed/bootstrap user-assigned managed identity** (`av-seed-identity-*`) its Microsoft Entra administrator (`principalType: Application`, SID = identity object/principal ID). Only the existing seed job attaches this identity; runtime applications retain their separate existing identity. The seed job uses the dedicated identity for SQL authentication and ACR pull, reaches SQL through the existing Container Apps private network, and can initialize the empty database without host grants. This adds one identity and its ACR pull assignment, but no compute/service/job. Identity creation precedes SQL and job deployment; no dependency cycle is introduced.

`RuntimeDatabaseAccess.psm1` uses the Bicep-supplied runtime application/client ID and name to create its contained user via `CREATE USER ... WITH SID = ..., TYPE = E` (no Graph lookup). Azure SQL application-user SIDs use the client ID, unlike the server Entra administrator configuration, which uses the principal/object ID. Existing conflicting SID/type fails explicitly. On a fresh database it grants only `db_datareader`, `db_datawriter`, and `EXECUTE` initially. After schema creation and Change Tracking enablement, it grants `VIEW CHANGE TRACKING ON OBJECT::[Sales].[SalesOrderHeader]` (an object permission, not a database-wide grant). The existing-database path grants that permission only after checking that the table exists and is tracked; missing tracking fails explicitly. On an existing database those grants are additive/idempotent; all legacy role memberships and permissions are preserved, not revoked or audited by this task. Runtime identity initialization runs for normal fresh/incremental seed executions; explicit `-ManufacturingOverlaysOnly` remains restricted to overlay changes.

**Administrator audit note:** SQL supports one Entra administrator; dedicated seed identity replaces the deployer as that administrator. The shared runtime identity is not administrator and is not attached to the seed job. Deployment-user direct SQL administration is no longer automatic. An authorized operator must use an approved private-network administration path or deliberately change the administrator through Azure's control plane; there is no password, host-login fallback, impersonation command, or public-access enablement. Existing private deployments need IaC provisioning to establish the dedicated identity/admin/job configuration before using this bootstrap model; rerunning only the hook cannot create it.

The identity resource is named `av-seed-identity-${resourceToken}`. Provisioning exports `SEED_MANAGED_IDENTITY_NAME`, `SEED_MANAGED_IDENTITY_CLIENT_ID`, and `SEED_MANAGED_IDENTITY_PRINCIPAL_ID` to azd. Existing global `AZURE_CLIENT_ID`/`USER_MANAGED_IDENTITY_NAME` still identify the runtime UAMI; only the seed container receives its dedicated client ID/name under those container-local names. The container also receives runtime bootstrap inputs as `RUNTIME_MANAGED_IDENTITY_NAME` and `RUNTIME_MANAGED_IDENTITY_CLIENT_ID`.

When SQL has public network access disabled, postprovision preserves that setting and skips public firewall rules, public-IP discovery, and deployment-host SQL role/Change Tracking commands. Fresh deployments use the IaC-established administrator above; legacy databases can reuse their existing identity grants. Missing permissions cause the awaited seed execution to fail rather than opening public access. A legacy public-enabled server retains the existing temporary client-firewall/role setup. The hook fails closed if it cannot determine the network setting. Full fresh seeding enables Change Tracking inside the private-network job; the incremental overlay path does not migrate Change Tracking on an existing database.

If generation APIs themselves need deployment before full artifact publication, an operator may explicitly allow partial coverage for that **backend-only bootstrap**:

```bash
MANUFACTURING_CONTENT_ALLOW_PARTIAL=true azd deploy api-functions --no-prompt
```

This command-scoped override makes only the global predeploy validator pass `--allow-partial`, with a warning. It does not skip validation or change the strict preup/postprovision gates. Do not persist it through `azd env set`, use it for frontend deployment, or use it for full `azd up`. After generation/publication completes, deploy normally without the override; default validation remains strict.

---

## Architecture

### Container Image

The seed job runs in a Docker container based on `mcr.microsoft.com/azure-powershell:latest`, which includes:

- PowerShell 7
- Azure PowerShell modules (Az.Accounts, Az.Resources, Az.Sql)
- SQL connectivity tools

### Authentication

The container uses **Managed Identity** (passwordless authentication) to connect to:

- **Azure SQL Database**: Uses the dedicated seed/bootstrap user-assigned managed identity configured as the server's Microsoft Entra administrator by Bicep; runtime identity receives reader/writer/EXECUTE/Change Tracking permissions only
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
    ├── date-shift-procedures.sql    # Time-shifts seed-era dates to yesterday
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

Main PowerShell script that orchestrates the entire seeding process:

**Key Features:**

- Comprehensive error handling and logging
- Managed identity authentication
- Progress tracking with elapsed time reporting
- CSV import with vector column support (VECTOR(1536) data type)
- Batch processing for large datasets
- Product image byte import into Azure SQL `Production.ProductPhoto`

**Execution Flow:**

1. Validates environment variables
2. Authenticates using managed identity
3. Waits for managed identity token availability
4. Validates all manufacturing artifacts. With `SEED_SKIP_EXISTING=true` (set by the deployment hook), an existing populated database takes the overlay-only path and exits; existing user tables without a populated ProductModel fail instead of being reset
5. For an empty database, executes SQL schema scripts (`AdventureWorks.sql`, `AdventureWorks-AI.sql`)
6. Imports CSV data files (base + AI-enhanced), including mandatory manufacturing overlays after the original model/illustration/mapping rows
7. Loads packaged product image bytes into `Production.ProductPhoto` in Azure SQL
8. Verifies data integrity with row counts
9. Deploys and runs `dbo.uspShiftDatesForward` (`date-shift-procedures.sql`) to bring all seed-era dates forward so recent activity appears to have occurred yesterday, and re-anchors pending PurchaseOrders, in-process WorkOrders, and open SalesOrders to near-future dates for realistic demo behaviour

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

  **Notable AI-enhanced files:**
  - `BillOfMaterials-ai.csv` — Adds top-level BOM entries (NULL `ProductAssemblyID`, `BOMLevel=0`) for 54 retail-only products (helmets, gloves, jerseys, accessories, etc.). These entries are required so the supply chain system (`SupplyChainService.GetVendorProductsFromSqlAsync`) includes retail products in its reorder catalog. Without them, purchased retail products would sell out with no automatic restocking path.

### Approved manufacturing overlays

`ManufacturingOverlays.psm1` imports only these headerless UTF-8 artifacts:

| File | Columns | Field / record terminator |
|---|---|---|
| `sql/ProductModelInstructions-ai.csv` | Existing ProductModelID, instruction XML | `+\|` / `&\|` |
| `sql/Illustration-ai.csv` | IllustrationID, diagram XML, ModifiedDate | `+\|` / `&\|` |
| `sql/ProductModelIllustration-ai.csv` | ProductModelID, IllustrationID, ModifiedDate | tab / newline |

Use the literal delimiters `+|` and `&|` (the backslashes in the table only escape Markdown). XML may contain embedded newlines but not those delimiters. ModifiedDate uses invariant `yyyy-MM-dd HH:mm:ss[.fffffff]` or the same format with `T`. There are **no ProductModel inserts**. All IDs must be positive SQL integers; duplicate keys, malformed XML/dates, LFS pointers, and partial artifact sets fail closed.

During full seeding the mandatory overlay runs after original Illustration, ProductModel, and ProductModelIllustration imports, in that dependency order. All three artifacts must be packaged, nonempty, and valid, even on a fresh seed; missing files fail before cleanup. The illustration/mapping AI files deliberately bypass the generic CSV inserter.

#### Restoring everything after a fresh deployment

Generation and deployment are separate operations. Before deployment, publish/retain the reviewed outputs from the offline manufacturing generation/export workflow:

- The three CSV artifacts above, under `seed-job/sql/`.
- Their matching static SVG files under `app-manufacturing/public/illustrations/` and generated frontend metadata.

Do not delete those local artifacts when removing Azure resources. They must be present in the checkout used for the next deployment (including hydrated Git LFS content where applicable). `seed-job/dockerfile` copies the whole `sql/` directory plus the importer module. The existing manufacturing frontend Docker build copies its public assets into Vite's output; no separate SVG resource or infrastructure is required.

If you deliberately remove the environment, perform `azd down` **manually**, understanding that it destroys Azure data/resources. Then run `azd up --no-prompt` from this prepared checkout. The normal hooks rebuild the existing seed-job image, recreate the base data on the empty database, apply and verify **every record in the packaged overlays**, and wait for that execution to succeed before deploying services/static SVGs. `azd up` never calls the expensive AI instruction/diagram generation endpoints.

For an existing deployment, run `azd up --no-prompt` without removing anything: the hook sets `SEED_SKIP_EXISTING=true`, preserves existing base data, and imports/verifies the same overlays using the existing private-network seed job. Repeated identical imports report zero changes. Different non-NULL instructions/diagrams or conflicting mappings abort deployment rather than overwriting them. Existing user tables are not sufficient evidence of a base seed: `Production.ProductModel`, `Production.Product`, `Person.Person`, and `Sales.SalesOrderHeader` must all exist and contain data; otherwise deployment fails as an incomplete seed and never wipes it. The importer additionally requires every overlay model to exist. This is a conservative readiness guard, not a complete audit of every base table. Resolve a partial seed explicitly before retrying.

The hook checks the exact execution returned by `job start`, not an older successful execution. Start/observation errors, terminal failures, unknown statuses, or timeout fail the hook. The default wait limit is 2400 seconds (`SEED_JOB_WAIT_TIMEOUT_SECONDS` can override it with a positive integer); the existing job replica timeout remains 2000 seconds. A timeout does not stop the job: inspect its execution status and logs before retrying. This adds a synchronous seed wait to deployment instead of reporting success while seeding runs unseen.

All three artifacts share one serializable transaction with parameterized commands and update/range locks:

- Instructions fill **NULL only** on existing models. SQL validates incoming XML against `Production.ManuInstructionsSchemaCollection`. A missing model or different existing non-NULL instructions aborts the entire overlay; original instructions are never replaced.
- Existing illustrations must have identical SQL-serialized XML; differing or NULL diagrams conflict. New IDs use explicit identity insertion.
- Mapping illustrations must be in the illustration overlay. Mapping models normally belong to the instruction overlay; a supplemental mapping may instead target a model in the original `ProductModel.csv` whose original manufacturing instructions are nonempty and contain no `<diag>` references (model 44, Touring Front Wheel). The hydrated original CSV and XML are validated before any transaction. Supplemental models receive no instruction overlay writes; all original instructions remain covered by the protected snapshots. SQL still requires both mapping endpoints to exist in the database. Existing identical pairs are no-ops; an illustration already assigned to another model conflicts. Existing other illustrations linked to a model are preserved.

The published manufacturing coverage target is **61 manufactured product models**: six with original instructions plus 55 with generated instructions (the three previously approved models and 52 newly covered models). The complete library contains 63 generated diagrams and 63 model/illustration mappings. Only original model 44 needs supplemental generated figures. Originally instructed models 53, 66, and 67 have no manufactured variants; preserve their original XML, exclude them from manufactured coverage, and do not require a supplemental diagram for purchased-only model 53. All nine original instruction documents remain unchanged. The offline cross-surface validator owns manufactured-model coverage checks; the importer independently validates supplemental original-instruction provenance and preserves originals.
- XML equality first converts the source string with SQL `CONVERT(xml, @xml, 0)`, stripping insignificant whitespace, then assigns instructions to `xml(Production.ManuInstructionsSchemaCollection)` for the same typed validation/normalization as the destination column. Both destination and normalized source are serialized via `CONVERT(nvarchar(max), ...)` and compared as `varbinary(max)` (exact UTF-16 bytes, with no collation/trailing-space ambiguity). Illustrations use the same path without a schema collection. Replaying a source written by this importer compares identically, including typed numeric normalization. This is intentionally conservative, not full XML canonicalization: different namespace prefixes, attribute order, significant text whitespace, or existing whitespace-preserving XML can still conflict. Such conflicts never overwrite data.
- ModifiedDate is insert-only metadata, ignored when checking an existing illustration or mapping. Instruction updates preserve the model's other columns, including ModifiedDate.
- A conflict, SQL schema-validation error, or command failure rolls back every instruction, illustration, and mapping change. Replaying identical artifacts is idempotent.
- Before writes, SQL snapshots **every** ProductModel ID and its nullable SHA-256 instruction hash under transaction-held update/range locks. After writes it rechecks the full model count/IDs and hashes for every originally non-NULL instruction (including targeted models) and every non-target model (including NULL instructions). Only originally NULL instructions on source model IDs may change.
- A second read-only pass executes the same typed XML/diagram/mapping guards for **every source record** before commit. Missing or conflicting source records fail; original snapshot differences fail. A final SQL query joins the complete parameterized source ID/pair sets to the live tables, verifies actual database counts equal all three source counts, and returns those database counts. Logs report artifact SHA-256s, model/illustration IDs, source and database-verified counts, actual updated/inserted counts, unchanged counts, protected snapshot counts, and matching `ProtectedInstructionsBeforeSha256`/`ProtectedInstructionsAfterSha256` digests of the protected ID/hash snapshot. Counts describe these artifacts, not total table sizes. A second identical import must report zero updates/inserts and all records unchanged.

#### Incremental import into an existing live database

For a standalone import independent of `azd up`, use the explicit switch:

```powershell
pwsh -NoLogo -NoProfile -File /app/seed-database.ps1 -ManufacturingOverlaysOnly
# Read-only database verification (fails if any source record is missing/different):
pwsh -NoLogo -NoProfile -File /app/seed-database.ps1 -ManufacturingOverlaysOnly -VerifyOnly
```

Run this command as an **execution override of the existing seed Container App Job**, using an image that contains this module and the three approved artifacts. The override's container `command` must be `["pwsh"]` and `args` must be `["-NoLogo","-NoProfile","-File","/app/seed-database.ps1","-ManufacturingOverlaysOnly"]`. Preserve that job container's image, resources, environment variables, volume mounts, identity, and networking. This explicit mode never takes the full-seed path, regardless of `SEED_SKIP_EXISTING`. **Without either this switch or `SEED_SKIP_EXISTING=true`, the default entrypoint still drops user objects; never use that configuration against a live database.**

The existing job reaches the private Azure SQL endpoint through its existing Container Apps environment. The script reuses the same `Connect-AzAccount -Identity -AccountId $env:AZURE_CLIENT_ID`, SQL access-token acquisition, and Microsoft.Data.SqlClient/System.Data.SqlClient connection as full seeding. The targeted branch occurs immediately after SQL connection and before cleanup/schema scripts, CSV seeding, image jobs, date shifting, or change-tracking setup. No schema, infrastructure, or resource changes are needed. Missing artifacts or conflicts fail the execution; success logs artifact record counts (not counts of newly inserted rows).

`-VerifyOnly` requires `-ManufacturingOverlaysOnly` on the seed entrypoint; using it alone fails before authentication rather than accidentally falling through to full seeding. The module also accepts `-VerifyOnly`. Verification uses a serializable transaction and locks but executes no data mutations or identity changes; it is not an offline dry run and still needs SQL access.

#### Operator commands: existing job, execution override only

The following are **operator-run commands**, not part of local validation. Run from the repository root with `ACR_NAME`, `RESOURCE_GROUP`, and `SEED_JOB_NAME` set to the existing registry, resource group, and job. The build context is exactly `seed-job`; the Dockerfile is `seed-job/dockerfile` (lowercase). Use a new immutable tag per approved export:

```bash
set -euo pipefail
IMAGE_TAG="manufacturing-overlays-$(date -u +%Y%m%dT%H%M%SZ)"
ACR_ENDPOINT=$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)
IMAGE="$ACR_ENDPOINT/seed-job:$IMAGE_TAG"
az acr build --registry "$ACR_NAME" --image "seed-job:$IMAGE_TAG" \
  --file seed-job/dockerfile seed-job

# Copy the existing template so env/resources/volume mounts are preserved.
# This file is JSON, which is valid YAML for --yaml.
TEMPLATE="seed-job/manufacturing-execution-$IMAGE_TAG.json"
az containerapp job show --name "$SEED_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --query properties.template -o json > "$TEMPLATE"
python3 - "$TEMPLATE" "$IMAGE" <<'PY'
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
template = json.loads(path.read_text())
if len(template["containers"]) != 1:
    raise SystemExit("Expected the existing single-container seed job; refusing ambiguous override")
container = template["containers"][0]
container["image"] = sys.argv[2]
container["command"] = ["pwsh"]
container["args"] = ["-NoLogo", "-NoProfile", "-File", "/app/seed-database.ps1",
                     "-ManufacturingOverlaysOnly"]
path.write_text(json.dumps(template, indent=2))
PY

# Existing template declares replicaTimeout=2000 seconds (~33 minutes),
# replicaRetryLimit=0. Inspect the live value; no timeout/resource change needed.
az containerapp job show --name "$SEED_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --query properties.configuration.replicaTimeout -o tsv

az containerapp job start --name "$SEED_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --yaml "$TEMPLATE"
# Wait for this execution to succeed and inspect its verification/count log.
# Then run the identical start command again: updates/inserts must all be zero.
az containerapp job start --name "$SEED_JOB_NAME" --resource-group "$RESOURCE_GROUP" \
  --yaml "$TEMPLATE"
```

Do not run the two starts concurrently. Each successful import log must show artifact counts matching the complete packaged files, equal database verification counts, and their sum as `SourceRecordsVerified`. (The original three-model sample was 3 instructions, 4 illustrations, 4 mappings, 11 verified records; full coverage is larger.) A first import into NULL/absent targets reports updated/inserted counts; a pre-existing identical subset legitimately lowers these counts. On the second import all three mutation counts must be zero and unchanged counts must equal the corresponding artifact counts. Both executions verify protected snapshots before commit. `ProtectedInstructionSnapshotsVerified` can increase after the first import because those instructions are now non-NULL and protected on replay.

For a separate verification-only execution, append `"-VerifyOnly"` to the generated template's `args` and start it with the same `--yaml` mechanism. Remove the local execution template when finished. Execution overrides leave the stored job definition unchanged; use them instead of changing the job template for a standalone import.

Each SQL command has a 120-second timeout. The import performs two passes across every source record, plus snapshot/preservation checks; large artifact sets and database blocking affect elapsed time. The existing job retains its 2000-second timeout. A killed execution cannot commit a partial SQL transaction; check execution status and logs before retrying.

For reuse from an already authenticated PowerShell process inside that job:

```powershell
Import-Module /app/ManufacturingOverlays.psm1
Import-ManufacturingOverlays -Connection $openSqlConnection -SqlFolder /app/sql
```

The connection must be open and have no existing transaction. Approval is an upstream export/review responsibility: this importer trusts only the named artifacts packaged in the image, not arbitrary ProductModel rows or a generic update file.

Local tests (no Azure, SQL connection, or external test modules):

```bash
pwsh -NoLogo -NoProfile -File seed-job/tests/Test-ManufacturingOverlays.ps1
# Also parse/exercise the actual generated artifacts through the fake SQL driver:
pwsh -NoLogo -NoProfile -File seed-job/tests/Test-ManufacturingOverlays.ps1 \
  -ArtifactsFolder seed-job/sql
pwsh -NoLogo -NoProfile -File seed-job/tests/Test-SeedLifecycle.ps1
pwsh -NoLogo -NoProfile -File seed-job/tests/Test-RuntimeDatabaseAccess.ps1
python3 -m unittest discover -s seed-job/tests -p 'test_seed_deployment.py'
```

These cover multiline/Unicode parsing, malformed artifacts, duplicate/cross-reference failures, parameter binding, SQL guard contracts, transaction commit/disposal, simulated SQL failures/rollback, fresh/existing/partial seed selection, mandatory overlay placement, actual hook/build wiring, and exact-execution monitoring success/failure/timeout paths. Actual typed-schema acceptance and database rollback/conflict behavior require a SQL Server integration environment; local fake drivers do not emulate SQL Server.

### 4. `images/` Directory

Product images for the catalog:

- **1,739 PNG files**
- Named `product_<ProductID>_photo_<2|3|4>.png` (and `_small.png` / `_thumb.png`); ProductPhotoIDs come from `ProductProductPhoto-ai.csv`
- Imported into Azure SQL `Production.ProductPhoto` during seeding using the same dedicated SQL identity (including background image workers); no Blob Storage calls or ARM storage discovery occur
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
    --image "$ACR_ENDPOINT/seed-job:latest" \
    --set-env-vars SEED_SKIP_EXISTING=true

# The hook calls seed-job-execution.sh to start and await this exact execution.
# It fails deployment unless the execution succeeds.
az containerapp job start \
    --name $SEED_JOB_NAME \
    --resource-group $RESOURCE_GROUP
```

### 3. Job Execution

Once started, the Container App Job:

1. Pulls the image from Azure Container Registry
2. Creates a container instance with managed identity
3. Runs `seed-database.ps1`
4. Executes the full seed for an empty database (approximately **8 minutes**), or only manufacturing overlays for an existing populated database
5. Terminates upon completion; `postprovision.sh` verifies execution success before returning

---

## Monitoring

### Health Page

The **Health page** (`/health`) in the web app shows Seed Job status by reading the latest log from the `seed-job-logs` Azure File Share via the `GET /api/seed/status` Azure Function. When the job is running, the page displays “Running for X minutes Y seconds” (derived from the `Start Time:` line in the log). When the job has completed or failed, the status card reflects that. No need to run CLI commands to see whether the seed has finished.

### Check Job Execution Status

```bash
# List all executions
az containerapp job execution list \
    --name <seed-job-name> \
    --resource-group <resource-group>

# Get specific execution details
az containerapp job execution show \
    --name <seed-job-name> \
    --job-execution-name <execution-name> \
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
4. Rebuild and redeploy: `azd up --no-prompt` (existing base tables are preserved; only manufacturing overlays are applied)

### Modifying Schema

1. Update `AdventureWorks.sql` or `AdventureWorks-AI.sql`
2. Test locally using the script
3. Schema changes require an explicitly planned migration or deliberate fresh reset. `azd up` does not replay schema scripts against a populated database

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

| File                  | Delimiter  | Common causes                                                                                                                                                                                                        |
| --------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Most CSVs             | Tab (`\t`) | Wrong delimiter; BOM or CRLF vs LF; column count doesn’t match table                                                                                                                                                 |
| **ProductReview.csv** | Tab        | **Comments** column must be **UTF-16 LE hex** (even length, 0-9A-F only). Invalid hex or odd length → "Hex string length must be even" or "Could not find any recognizable digits". Ensure no newlines inside a row. |
| ProductReview-ai.csv  | Tab        | **CommentsEmbedding** must be a JSON array of 1536 floats; plain text in Comments.                                                                                                                                   |

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

- Check the background image job's SQL token acquisition and connection errors.
- Confirm packaged `images/` files and `ProductProductPhoto-ai.csv` mappings are present.
- Image bytes are inserted into SQL `Production.ProductPhoto`, not uploaded to Blob Storage; the dedicated seed identity does not require Storage Blob roles or storage-account discovery permissions.

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

After `azd up`, this job retains `SEED_SKIP_EXISTING=true`, so manual starts preserve populated base data and replay manufacturing overlays. To reset base data, deliberately recreate the environment manually, or explicitly configure a destructive seed only after reviewing the data-loss implications. A job that has never been updated by the hook might not have this safety setting; use `-ManufacturingOverlaysOnly` for a guaranteed targeted import.

Do not start concurrent seed executions.

---

## Best Practices

1. **Idempotency**: Automatic deployments preserve populated base data and replay manufacturing overlays idempotently; full seeding without `SEED_SKIP_EXISTING=true` remains destructive
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
