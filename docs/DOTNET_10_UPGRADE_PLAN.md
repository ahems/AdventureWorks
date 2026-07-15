# Plan: Upgrade .NET Projects to .NET 10

## TL;DR

Upgrade all 4 .NET projects from .NET 8.0 to .NET 10.0, updating target frameworks, Docker images, Bicep infrastructure, NuGet packages, dev container config, and documentation. The solution comprises `api-functions` (Azure Functions isolated worker), `api-mcp/AdventureWorks` (ASP.NET Core MCP server), `api-mcp/ServiceDefaults` (Aspire shared project), and `api-mcp/AppHost` (Aspire orchestrator). A phased approach ensures each layer is validated before moving on.

## Prerequisites Verified

- `mcr.microsoft.com/dotnet/sdk:10.0` — available (SDK v10.0.302)
- `mcr.microsoft.com/dotnet/aspnet:10.0` — available (runtime v10.0.10, LTS)
- `mcr.microsoft.com/azure-functions/dotnet-isolated:4-dotnet-isolated10.0` — available in MCR (verified July 2026, plus `-appservice` and `-azurelinux3` variants)

---

## Phase 1: SDK & Dev Environment Setup

1. **Create `global.json`** at repo root to pin .NET 10 SDK:
   - Content: `{ "sdk": { "version": "10.0.100", "rollForward": "latestFeature" } }`
   - This prevents accidental use of .NET 8 SDK going forward

2. **Update `.devcontainer/devcontainer.json`** (line 19):
   - Change `"version": "8.0"` → `"version": "10.0"` in the `ghcr.io/devcontainers/features/dotnet:2` feature
   - After this change, rebuild the dev container to get .NET 10 SDK on PATH

**Verification**: Run `dotnet --version` — should report 10.0.x

---

## Phase 2: Project Files & NuGet Packages

_All 4 steps in this phase can run in parallel._

### Step 3: Update `api-functions/api-functions.csproj`

- Change `<TargetFramework>net8.0</TargetFramework>` → `<TargetFramework>net10.0</TargetFramework>` (line 4)
- Update NuGet packages to .NET 10-compatible versions:
  - `Microsoft.Azure.Functions.Worker` — update from 2.51.0 to latest (check for v3.x)
  - `Microsoft.Azure.Functions.Worker.Sdk` — update from 2.0.7 to latest
  - `Microsoft.Azure.Functions.Worker.Extensions.Http.AspNetCore` — update from 2.1.0
  - `Microsoft.Azure.Functions.Worker.Extensions.Timer` — update from 4.3.1
  - `Microsoft.Azure.Functions.Worker.Extensions.Storage.Queues` — update from 5.5.3
  - `Microsoft.Azure.Functions.Worker.Extensions.Sql` — update from 3.0.534
  - `Microsoft.Azure.Functions.Worker.Extensions.DurableTask` — update from 1.11.0
  - `Microsoft.DurableTask.Client` — update from 1.18.0
  - `Aspire.Microsoft.Data.SqlClient` — update from 13.1.0 to .NET 10-compatible Aspire version
  - `Aspire.Azure.Storage.Blobs` — update from 13.1.0
  - `Aspire.Azure.Storage.Queues` — update from 13.1.0
  - `Microsoft.ApplicationInsights.WorkerService` — update from 2.23.0
  - **Remove `Swashbuckle.AspNetCore` (6.5.0)** — it is unused (no `AddSwaggerGen` / `UseSwagger` in Program.cs; custom OpenAPI function in `Functions/OpenApiFunction.cs` doesn't use it). If `Microsoft.OpenApi.Models` namespace is needed, add a direct reference to `Microsoft.OpenApi` package instead.
  - Azure SDK packages (`Azure.Identity`, `Azure.AI.*`, etc.) — update to latest stable/preview
- Run `dotnet restore` then `dotnet build` to validate

### Step 4: Update `api-mcp/AdventureWorks/AdventureWorks.csproj`

- Change `<TargetFramework>net8.0</TargetFramework>` → `<TargetFramework>net10.0</TargetFramework>` (line 4)
- Update NuGet packages:
  - `ModelContextProtocol.AspNetCore` — update from 0.9.0-preview.2 (check for stable or newer preview for .NET 10)
  - `Microsoft.Data.SqlClient` — update from 5.2.2
  - `Azure.Identity` — update from 1.21.0
  - `Azure.AI.OpenAI` — update from 2.8.0-beta.1
  - `Microsoft.Extensions.Localization` — change from `9.*` to `10.*` (or pin specific version)
  - `Microsoft.ApplicationInsights.AspNetCore` — update from 2.23.0
  - `Dapper` — update from 2.1.35 (also note: api-functions uses 2.1.66, consider aligning)
  - `Bogus` — update from 35.6.5
- Run `dotnet restore` then `dotnet build` to validate

### Step 5: Update `api-mcp/ServiceDefaults/ServiceDefaults.csproj`

- Change `<TargetFramework>net8.0</TargetFramework>` → `<TargetFramework>net10.0</TargetFramework>` (line 4)
- Update NuGet packages:
  - `Microsoft.Extensions.Http.Resilience` — change from `9.*` to `10.*` or latest pinned
  - `Microsoft.Extensions.ServiceDiscovery` — change from `9.*` to `10.*` or latest pinned
  - `OpenTelemetry.*` packages — update from `1.*` (check latest stable)
  - `Azure.Monitor.OpenTelemetry.AspNetCore` — update from `1.*`

### Step 6: Update `api-mcp/AppHost/AppHost.csproj`

- Change `<TargetFramework>net8.0</TargetFramework>` → `<TargetFramework>net10.0</TargetFramework>` (line 8)
- Update SDK import: `Aspire.AppHost.Sdk` from 13.1.0 to .NET 10-compatible version
- Update NuGet packages:
  - `Aspire.Hosting.AppHost` — update from 13.1.0
  - `Aspire.Hosting.Azure.Functions` — update from 13.1.0

**Verification**: Run `dotnet build AdventureWorks.sln` — all 4 projects must compile without errors.

---

## Phase 3: Docker Images (_depends on Phase 2_)

### Step 7: Update `api-functions/Dockerfile`

- Line 1: `mcr.microsoft.com/dotnet/sdk:8.0` → `mcr.microsoft.com/dotnet/sdk:10.0`
- Line 13: `mcr.microsoft.com/azure-functions/dotnet-isolated:4-dotnet-isolated8.0` → `4-dotnet-isolated10.0`

### Step 8: Update `api-mcp/Dockerfile`

- Line 2: `mcr.microsoft.com/dotnet/sdk:8.0` → `mcr.microsoft.com/dotnet/sdk:10.0`
- Line 22: `mcr.microsoft.com/dotnet/aspnet:8.0` → `mcr.microsoft.com/dotnet/aspnet:10.0`

### Step 9: Update `api/dockerfile` (DAB build stage)

- Line 1: `mcr.microsoft.com/dotnet/sdk:8.0` → `mcr.microsoft.com/dotnet/sdk:10.0`
- Note: The runtime image (`mcr.microsoft.com/azure-databases/data-api-builder`) is unversioned and managed by the DAB team — no change needed there.

**Verification**: Build each Docker image locally:

- `docker build -t test-api-functions api-functions/`
- `docker build -t test-api-mcp api-mcp/`
- `docker build -t test-api api/`

---

## Phase 4: Infrastructure (_parallel with Phase 3_)

### Step 10: Update `infra/modules/aca-api-functions.bicep`

- Line 7: `bootstrapImage` default from `mcr.microsoft.com/azure-functions/dotnet-isolated:4-dotnet-isolated8.0` → `4-dotnet-isolated10.0`

### Step 11: Update `infra/modules/aca-api-mcp.bicep`

- Line 7: `bootstrapImage` default from `mcr.microsoft.com/dotnet/aspnet:8.0` → `mcr.microsoft.com/dotnet/aspnet:10.0`

### Step 12: Update `infra/modules/flex-api-functions.bicep`

- Line 76: `version: '8.0'` → `version: '10.0'`

**Verification**: Run `az bicep build --file infra/main.bicep` to validate Bicep compiles.

---

## Phase 5: Documentation (_parallel with Phases 3-4_)

### Step 13: Update version references in documentation

- `README.md` (lines ~45, ~100): ".NET 8" → ".NET 10"
- `api-functions/README.md` (line ~3): ".NET 8" → ".NET 10"
- `.github/copilot-instructions.md` (line ~13): ".NET 8" → ".NET 10"
- `docs/features/ai-agent/AGENT_FRAMEWORK_MIGRATION.md` (line ~359): ".NET 8" → ".NET 10"
- `docs/features/internationalization/LANGUAGE_FILE_TRANSLATION.md` (line ~314): ".NET 8" → ".NET 10"

---

## Files Summary

### Must modify:

| File                                             | Change                                         |
| ------------------------------------------------ | ---------------------------------------------- |
| `global.json` (new)                              | Pin .NET 10 SDK                                |
| `.devcontainer/devcontainer.json`                | SDK feature version 8.0 → 10.0                 |
| `api-functions/api-functions.csproj`             | TFM + 15+ package updates + remove Swashbuckle |
| `api-mcp/AdventureWorks/AdventureWorks.csproj`   | TFM + 8 package updates                        |
| `api-mcp/ServiceDefaults/ServiceDefaults.csproj` | TFM + floating version updates                 |
| `api-mcp/AppHost/AppHost.csproj`                 | TFM + Aspire SDK/packages                      |
| `api-functions/Dockerfile`                       | 2 image tags                                   |
| `api-mcp/Dockerfile`                             | 2 image tags                                   |
| `api/dockerfile`                                 | 1 image tag (build stage only)                 |
| `infra/modules/aca-api-functions.bicep`          | bootstrapImage parameter                       |
| `infra/modules/aca-api-mcp.bicep`                | bootstrapImage parameter                       |
| `infra/modules/flex-api-functions.bicep`         | runtime version                                |
| 5 documentation files                            | Version text references                        |

### No changes needed:

- `host.json` — Azure Functions schema version independent of .NET version
- `azure.yaml` — Uses language specification, not .NET version
- `AdventureWorks.sln` — No version constraints
- `seed-job/dockerfile` — PowerShell-based, not .NET
- CI/CD workflows — Use `azd` abstractions
- `local.settings.example.json` — Worker type agnostic

---

## Verification Checklist

1. `dotnet --version` returns 10.0.x after dev container rebuild
2. `dotnet build AdventureWorks.sln` compiles all 4 projects with no errors
3. All 3 .NET Dockerfiles build successfully locally
4. `az bicep build --file infra/main.bicep` compiles without errors
5. Start `func: host start` task — Azure Functions host starts without errors
6. Run existing test scripts (`test-signup.sh`, `test-password-functions.sh`, etc.)
7. `azd deploy api-functions` and `azd deploy api-mcp` — validate containers start in Azure

---

## Decisions & Notes

- **Swashbuckle removal**: Remove unused `Swashbuckle.AspNetCore` 6.5.0 from `api-functions.csproj`. The custom OpenAPI function (`OpenApiFunction.cs`) uses `Microsoft.OpenApi.Models` directly — add `Microsoft.OpenApi` package reference if needed after removal.
- **global.json creation**: Create to pin SDK version and prevent accidental .NET 8 usage.
- **DAB dockerfile**: Update the build stage SDK tag (used only for `dotnet tool install`). The DAB runtime image is unversioned and independent.
- **Floating versions** (`9.*`, `1.*`): Update to target .NET 10-compatible ranges. Exact version pinning is preferred for reproducibility.
- **Azure Functions runtime image**: CONFIRMED available in MCR (`4-dotnet-isolated10.0`, plus `-appservice` and `-azurelinux3` variants).
- **Scope exclusions**: Node.js apps (`app/`, `app-admin/`, `app-manufacturing/`), PowerShell seed-job, and DAB runtime image are out of scope.

## Risks to Monitor

1. **Aspire version alignment** — all Aspire packages (currently 13.1.0) must move together to a .NET 10-compatible release. Check for v14.x+ availability.
2. **MCP SDK stability** — `ModelContextProtocol.AspNetCore` is at `0.9.0-preview.2`. Verify a .NET 10-compatible version exists or that the current preview works on net10.0.
3. **.NET Aspire dashboard** — The managed .NET Aspire Dashboard component in `infra/modules/aca.bicep` uses a version-less component — verify it auto-upgrades or needs explicit version bumping.
