---
title: CI/CD workflows
summary: The three GitHub Actions workflows (weekly build check, service-principal azd deployment and seed-job image publishing), what each one covers and what is deliberately not automated.
audience: [developer, operator, security-reviewer]
components: [github-actions, azd, seed-job, api-functions, api-mcp, app]
related:
  - .github/workflows/README.md
  - docs/operations/deployment.md
  - docs/testing/testing-strategy.md
  - docs/AZD_DEPLOYER_PERMISSIONS.md
---

# CI/CD workflows

The repository has three GitHub Actions workflows in [`.github/workflows/`](../../.github/workflows/), and every one is started manually or on a schedule. None runs on push or pull request, so contributors run local checks before opening a PR. One-time Azure and GitHub setup is covered in the [workflow README](../../.github/workflows/README.md).

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| [`build-checker.yaml`](../../.github/workflows/build-checker.yaml) | Manual, and weekly on Sunday at 06:00 UTC | Offline authentication assurance plus container, Functions and storefront builds |
| [`azd-up-service-principal.yml`](../../.github/workflows/azd-up-service-principal.yml) | Manual (`workflow_dispatch`) | Full `azd up --no-prompt` as an Entra service principal over GitHub OIDC |
| [`publish-seed-job.yml`](../../.github/workflows/publish-seed-job.yml) | Manual | Publishes the seed-job image to GitHub Container Registry |

## Build check

`build-checker.yaml` runs three independent jobs:

| Job | What it runs |
| --- | --- |
| `auth-offline` | `bash tests/scripts/validate-auth.sh --offline`. It needs no Azure login, secrets or deployed calls. The job fails if any assertion fails or if any required deterministic gate does not pass. Exit code 2 is accepted only for live coverage that is explicitly blocked. JSON, JUnit and TRX evidence is uploaded as the `authentication-offline` artifact. |
| `build-check` | `docker build` of `app`, `api`, `seed-job`, `api-mcp`, `app-admin`, `app-manufacturing` and `.devcontainer`, plus `dotnet publish` of `api-functions` |
| `swa-build` | `swa build adventure-eshop` for the storefront |

The workflow uses Node.js 20 and Python 3.12. It does not build `mcp-inspector` or `manufacturing-agent`, and it does not run linters or the unit test suites. Those are local checks; see [Testing strategy](../testing/testing-strategy.md).

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

## Seed-job image publishing

`publish-seed-job.yml` builds [`seed-job/`](../../seed-job/) and pushes `ghcr.io/<owner>/adventureworks-seed-job` with `sha` and `latest` tags and build provenance. The image is for reuse outside this repository. Deployments do **not** pull it, because `postprovision.sh` builds its own `seed-job:latest` in the environment's Azure Container Registry.

## Related

- [Workflow setup and runbook](../../.github/workflows/README.md)
- [Deployment lifecycle](deployment.md)
- [Testing strategy](../testing/testing-strategy.md)
- [Deployer permissions](../AZD_DEPLOYER_PERMISSIONS.md)
