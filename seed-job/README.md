---
title: Database seed job (seed-job/) — Azure Container Apps job that builds and loads AdventureWorks
summary: Component README for the PowerShell seed job that creates the AdventureWorks schema, loads sample and AI-generated data and images, applies manufacturing overlays, real-time outbox setup and runtime SQL grants over the private network; files, modes, logs, troubleshooting and tests.
audience: [developer, operator, ai-agent]
components: [seed-job, infra]
related: [docs/services/seed-job.md, seed-job/sql/README.md, docs/operations/seed-data-generation.md, docs/operations/deployment.md]
---

# Database seed job (`seed-job/`)

The seed job builds and loads the AdventureWorks Azure SQL database for each new demo
environment. It creates the schema (including `VECTOR(1536)` embedding columns), loads
the original AdventureWorks data plus AI-generated reviews, descriptions, translations
and embeddings, imports 1,770 product images into `Production.ProductPhoto`, applies the
approved manufacturing instruction/illustration overlays, sets up the real-time
notification outbox and grants the runtime managed identity its database access. For the
service overview, see **[docs/services/seed-job.md](../docs/services/seed-job.md)**.

**Tech and hosting:** PowerShell 7 in an `mcr.microsoft.com/azure-powershell` image,
built in ACR and run as an **Azure Container Apps job** (manual trigger, 2,000-second
timeout, no retries). It is not an azd service: `scripts/hooks/postprovision.sh` builds
the image, sets `SEED_SKIP_EXISTING=true` and starts an execution without waiting for it
to finish. Seed failures show in the job logs and on the storefront `/health` page, not
in the `azd up` result.

## Files

| Path | Purpose |
|---|---|
| `seed-database.ps1` | Entry point: schema, CSV loads, images, overlays, date shift, Change Tracking, outbox, grants |
| `RuntimeDatabaseAccess.psm1` | Creates the runtime identity's SQL user by SID and grants runtime access |
| `ManufacturingOverlays.psm1` | Validated, transactional import of the approved manufacturing overlays |
| `SeedTelemetry.psm1` | Sparse `Seed.Started`, deduplicated `Seed.Stage`, `Seed.Failed`/`Seed.Completed` lifecycle events plus `Sql.SessionPrincipal` hashed identity evidence; two-second best-effort sends and console/system-log fallback; no SQL text, tokens or row data |
| `sql/` | Schema scripts and CSV data ([catalog](sql/README.md)) |
| `images/` | 1,770 product PNG files |
| `tests/` | Pester and Python tests |
| `dockerfile` | Container image |

## Identity and runtime grants

The job uses a dedicated **seed managed identity** (`av-seed-identity-*`), which Bicep
makes the SQL server's Microsoft Entra administrator. It reaches SQL through the Container
Apps private network; public SQL access is never needed. `RuntimeDatabaseAccess.psm1`
creates the runtime identity's contained user (`CREATE USER ... WITH SID = ..., TYPE = E`)
and grants `db_datareader`, `db_datawriter`, `EXECUTE`, `VIEW CHANGE TRACKING` on
`Sales.SalesOrderHeader`, access to the manufacturing XML schema collection and
object-level `VIEW DEFINITION` on tables with default or computed columns. The runtime
identity never needs `db_owner` or `db_ddladmin`. The job also pre-creates the
`dbo.RealtimeNotificationOutbox`, its DML triggers and the `az_func` lease tables for the
Functions SQL listeners.

### Persistent seed logs: managed-identity SMB mount (preview)

The Azure Files share `seed-job-logs` is mounted at `/logs`, and each execution writes
`/logs/seed-<timestamp>.log`. The mount uses no Storage account key: it authenticates
with the runtime user-assigned identity attached to the Container Apps environment,
while the seed container keeps using its separate seed identity for SQL and ACR.

- [`storage.bicep`](../infra/modules/storage.bicep) enables SMB OAuth
  (`azureFilesIdentityBasedAuthentication.smbOAuthSettings.isSmbOAuthEnabled`), permits
  Kerberos, defaults to OAuth and disables Shared Key access.
- [`aca.bicep`](../infra/modules/aca.bicep) assigns **Storage File Data SMB MI Admin** to
  the environment identity at Storage account scope and configures the `seed-job`
  storage definition with `azureFile.identity` (preview API `2026-03-02-preview`).
- The administrator-level file data role is a **preview platform requirement**. It applies
  across the account's file shares; keep it explicit in IAM reviews and do not substitute
  ordinary SMB Share Contributor/Reader roles. Role propagation can delay the first mount.

See Microsoft's [Container Apps mount guidance](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts#azure-files-volume)
and [managed-identity Azure Files requirements](https://learn.microsoft.com/en-us/azure/storage/files/files-managed-identities).

To verify logging without seeding:

```bash
python3 tests/scripts/test-seed-log-mount.py --environment <azd-environment>
python3 -m unittest discover -s seed-job/tests -p 'test_seed*.py'
```

The live verifier starts two execution overrides of the existing job that only write,
read and delete one uniquely named probe file under `/logs`; it never runs the seed
script, SQL, email or AI, and refuses to start while a seed execution may be active.
Evidence is written under the git-ignored `.auth-results/`. See the
[test script guide](../tests/scripts/README.md#seed-log-mount-authentication).

## Seed modes

- **Fresh database:** full seed (drops user objects, then creates and loads everything).
- **Existing database** (`SEED_SKIP_EXISTING=true`, set by the hook): if `ProductModel`,
  `Product`, `Person` and `SalesOrderHeader` all contain data, base data is kept and only
  the guest-cart schema, overlays and grants are applied. A partially seeded
  database fails rather than being wiped.
- **Targeted modes:** `-ManufacturingOverlaysOnly` (optionally with `-VerifyOnly`),
  `-RealtimeNotificationsOnly` and `-GuestCartsOnly`, used for tests and content
  publication. Do not use them to repair a deployed demo; seed changes reach Azure
  through a recreated environment.

Telemetry labels each run's mode as `full` (fresh or existing database), `guest-carts`,
`realtime-notifications`, `manufacturing-overlays` or `manufacturing-overlays-verify`.
See [seed-job monitoring](../docs/services/seed-job.md#monitoring).

### Approved manufacturing overlays

`ManufacturingOverlays.psm1` imports `sql/ProductModelInstructions-ai.csv`,
`sql/Illustration-ai.csv`, `sql/ProductModelIllustration-ai.csv` and the optional pair
`sql/Document-ai.csv` / `sql/ProductDocument-ai.csv`. The import runs in one serializable
transaction: it only fills NULL instructions on existing models, never overwrites
different existing content, validates XML against
`Production.ManuInstructionsSchemaCollection`, verifies every source record before
commit and is idempotent (a second identical import reports zero changes). See
[manufacturing content](../docs/features/manufacturing/manufacturing-content.md).

## Troubleshooting

- **CSV import failures:** search the log for the table name and `Failed`. Most CSVs are
  tab-delimited UTF-8 with LF line endings; `ProductReview.csv` stores `Comments` as
  UTF-16 LE hex (see [`sql/README.md`](sql/README.md)).
- **Runtime access errors:** runtime grants come from this job (`RuntimeDatabaseAccess.psm1`),
  not from `postprovision.sh`; check the latest seed log.
- **Missing images:** images are inserted into SQL, not Blob Storage; check the image
  worker's SQL errors and `ProductProductPhoto-ai.csv`.
- **Status:** open the storefront `/health` page or run
  `az containerapp job execution list --name "$(azd env get-value SERVICE_SEED_JOB_NAME --no-prompt)" --resource-group "$(azd env get-value AZURE_RESOURCE_GROUP --no-prompt)" -o table`.

Do not start concurrent seed executions.

## Tests

```bash
pwsh -NoLogo -NoProfile -File seed-job/tests/Test-SeedLifecycle.ps1
pwsh -NoLogo -NoProfile -File seed-job/tests/Test-RuntimeDatabaseAccess.ps1
pwsh -NoLogo -NoProfile -File seed-job/tests/Test-ManufacturingOverlays.ps1 -ArtifactsFolder seed-job/sql
pwsh -NoLogo -NoProfile -File seed-job/tests/Test-SeedTelemetry.ps1
python3 -m unittest discover -s seed-job/tests -p 'test_*.py'
```

## Related docs

- [Seed job service guide](../docs/services/seed-job.md)
- [SQL scripts and CSV catalog](sql/README.md)
- [Seed data generation](../docs/operations/seed-data-generation.md)
- [Deployment](../docs/operations/deployment.md)
- [Data stores](../docs/architecture/data-stores.md)
- [Health diagnostics](../docs/features/monitoring/HEALTH_DIAGNOSTICS.md)
