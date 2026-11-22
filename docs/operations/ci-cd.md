---
title: CI/CD workflows
summary: The two GitHub Actions workflows (weekly build check and service-principal azd deployment), what each one covers and what is deliberately not automated.
audience: [developer, operator, security-reviewer]
components: [github-actions, azd, seed-job, api-functions, api-mcp, app]
related:
  - .github/workflows/README.md
  - docs/operations/deployment.md
  - docs/testing/testing-strategy.md
  - docs/AZD_DEPLOYER_PERMISSIONS.md
---

# CI/CD workflows

The repository has two GitHub Actions workflows in [`.github/workflows/`](../../.github/workflows/), and both are started manually or on a schedule. None runs on push or pull request, so contributors run local checks before opening a PR. One-time Azure and GitHub setup is covered in the [workflow README](../../.github/workflows/README.md).

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| [`build-checker.yaml`](../../.github/workflows/build-checker.yaml) | Manual, and weekly on Sunday at 06:00 UTC | Offline authentication assurance plus container, Functions and storefront builds |
| [`azd-up-service-principal.yml`](../../.github/workflows/azd-up-service-principal.yml) | Manual (`workflow_dispatch`) | Full `azd up --no-prompt` as an Entra service principal over GitHub OIDC |

## Build check

`build-checker.yaml` runs four independent jobs:

| Job | What it runs |
| --- | --- |
| `auth-offline` | `bash tests/scripts/validate-auth.sh --offline`. It needs no Azure login, secrets or deployed calls. The job fails if any assertion fails or if any required deterministic gate does not pass. Exit code 2 is accepted only for live coverage that is explicitly blocked. JSON, JUnit and TRX evidence is uploaded as the `authentication-offline` artifact. |
| `build-check` | `docker build` of `api`, `seed-job`, `api-mcp`, `app-admin`, `app-manufacturing`, `mcp-inspector`, `manufacturing-agent` and `.devcontainer`, plus `dotnet publish` of `api-functions` |
| `offline-tests` | `npm run typecheck` for the three frontends, `app-admin` and `app-manufacturing` Vitest, storefront and `mcp-inspector` `node --test`, the offline frontend harnesses in `tests/scripts`, `pytest tests/scripts`, seed-job Python tests and `dotnet build` of `manufacturing-agent`. Each step runs even if an earlier one fails; the final step fails the job and names every failed step. |
| `swa-build` | `swa build adventure-eshop` for the storefront |

The workflow uses Node.js 20 and Python 3.12 and needs no Azure credentials. It does not run linters, the seed PowerShell tests or any deployed check; see [Testing strategy](../testing/testing-strategy.md#what-ci-covers).

## Deploy workflow

`azd-up-service-principal.yml` gives the user a second way to start the same lifecycle that `azd up` runs locally. It runs the existing hooks and does not reimplement provisioning. Starting it creates a new disposable demo environment, so treat it like a user-run `azd up`.

**Inputs**

| Input | Default | Notes |
| --- | --- | --- |
| `environment_name` | Random `adventureworks001`–`999` | Optional; must be a new environment |
| `azure_location` | `eastus2` | Region for the main resources |
| `foundry_location` | `swedencentral` | Region for Microsoft Foundry |
| `validate_auth_infra` | `false` | Runs the read-only `validate-auth.sh --infra` profile after readiness |

**Configuration.** The deploy job uses the GitHub Environment `adventureworks-demo`. That environment holds the variables `DEPLOYER_CLIENT_ID`, `DEPLOYER_OBJECT_ID`, `DEPLOYER_TENANT_ID` and `DEPLOYER_SUBSCRIPTION_ID`, plus the optional `CHAT_MODEL_NAME_REGEX`. The service principal needs the permissions described in [Deployer permissions](../AZD_DEPLOYER_PERMISSIONS.md#deploying-with-a-service-principal-github-actions).

**Steps**

1. Logs in to Azure CLI and azd with GitHub OIDC; no client secret is stored. A workflow-only wrapper (`scripts/utilities/github-oidc-az.py`) renews the short-lived assertion during long runs.
2. Installs azd 1.39.1 and the `azure.ai.agents` 1.2.0 extension, which the hosted manufacturing agent requires.
3. Sets `DEPLOYER_PRINCIPAL_TYPE=ServicePrincipal` and runs `azd up --no-prompt`.
4. Waits for the specific seed execution started by this run, using the `seed_execution_name` step output.
5. Runs `bash tests/scripts/test-health-diagnostics.sh` and confirms that the temporary SQL and Key Vault network access has been removed.
6. Optionally runs `validate-auth.sh --infra` and uploads its report.
7. Removes the temporary Azure CLI credentials in an always-run step.

The workflow never uploads credential caches or prints the complete azd environment. To work with the resulting environment locally, rebuild it with `recover-azd-env.py`. See [Deployment lifecycle](deployment.md#environments-created-by-github-actions).

## Related

- [Workflow setup and runbook](../../.github/workflows/README.md)
- [Deployment lifecycle](deployment.md)
- [Testing strategy](../testing/testing-strategy.md)
- [Deployer permissions](../AZD_DEPLOYER_PERMISSIONS.md)
