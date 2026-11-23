---
title: Troubleshooting
summary: Symptom, cause and policy-compliant fix for the problems most often seen when deploying, testing and developing the AdventureWorks demo.
audience: [developer, operator, demo-presenter, ai-agent]
components: [azd, seed-job, api, api-functions, api-mcp, app, app-admin, app-manufacturing, infra]
related:
  - docs/operations/deployment.md
  - docs/operations/monitoring.md
  - docs/features/monitoring/HEALTH_DIAGNOSTICS.md
  - docs/features/mcp-oauth/README.md
  - docs/services/seed-job.md
---

# Troubleshooting

This page lists common problems as symptom, cause and fix. Every fix follows the [demo/POC policy](../../.github/copilot-instructions.md#azure-environment-policy-demopoc-only):

- Diagnose with read-only tools.
- Fix the source, Bicep, seed script or hook.
- Redeploy with `azd deploy --no-prompt`.
- When infrastructure or data must change, ask the user to [recreate the environment](deployment.md#recreating-the-environment).

Never repair deployed resources by hand.

## Deployment

| Symptom | Cause | Fix |
| --- | --- | --- |
| Pages are empty, or `/health` shows seed data as not ready, right after `azd up` | The seed job runs asynchronously for about 15 minutes after `azd up` returns | Wait. Track progress on the storefront `/health` page or with the read-only `az containerapp job execution list --name <seed-job-name> --resource-group <resource-group>`. |
| The seed execution failed | Usually a CSV/schema problem or SQL identity propagation | Read the execution logs and check [Seed job troubleshooting](../services/seed-job.md). Fix the seed scripts or CSVs, then ask the user to recreate the environment. Do not re-run or patch the job in place. |
| `azd deploy` finished but data or schema did not change | `azd deploy` does not run `postprovision.sh` or the seed job, and the seed uses `SEED_SKIP_EXISTING=true` | Seed and schema changes need a user-run recreation. |
| `azd up` fails on the `manufacturing-agent` service or reports a missing extension | The hosted agent requires the `azure.ai.agents` azd extension | Install or upgrade the extension. CI pins azd 1.39.1 with `azure.ai.agents` 1.2.0; see [CI/CD](ci-cd.md#deploy-workflow). |
| Provisioning fails with `AuthorizationFailed` on `roleAssignments/write` | The deployer has Contributor only | An administrator grants the constrained role described in [Deployer permissions](../AZD_DEPLOYER_PERMISSIONS.md). |
| `Deploy-Application-Insights` fails with workspace `ResourceNotFound` even though the workspace later exists | A workspace property was read before its creating module completed | Export the customer ID through the workspace module's `logAnalyticsWorkspaceId` output, not an independent `existing` resource property read. This dependency is covered by the compiled-template regression test. Use the corrected source in a fresh user-run deployment; do not repair the partial environment in place. |
| A remote-build service or the hosted `manufacturing-agent` fails with `CS2001: Source file '.../../...' could not be found` | ACR remote builds and hosted-agent code packages receive only the service's `project` folder, so a project file linked from outside it is missing | Keep shared source inside the remote-built service (for example `api-mcp`) and link it from directly published projects such as `api-functions`. The hosted agent keeps byte-identical copies of the shared telemetry files. `tests/scripts/test_remote_build_contexts.py` guards both rules. |
| `postprovision` fails with `Failed to upsert memory store ... (HTTP 000)` | The new Foundry endpoint was briefly unreachable from the runner; HTTP 000 means no response was received | Agent setup requests retry transient failures (DNS, timeouts, refused connections, 408/429/5xx) for about a minute. If it still fails, start a fresh user-run deployment; do not create agents or memory stores by hand. |
| `preup` fails creating the Foundry account with `(InternalServerError) Internal Server Error` | A transient service error during account creation, which can leave the account `Failed` | `preup.sh` resends the idempotent create up to three times and also recreates an account an earlier attempt left `Failed`. If it still fails, start a fresh user-run deployment. |
| `preup.sh` finds no chat model with enough capacity | Regional quota or model availability | Change `CHAT_MODEL_NAME_REGEX`, `CHAT_MODEL_COST_TIER` or `CHAT_MODEL_MIN_CAPACITY` in the azd environment, or choose another `FOUNDRY_LOCATION`. All of these are user decisions before `azd up`. |
| A Key Vault name or Foundry account already exists after recreation | A soft-deleted resource from the previous environment | Recreate with the documented command, which purges. Do not purge or recover resources manually. |
| Local `azd` has no environment for a deployment made by GitHub Actions | The workflow ran `azd up` on a runner | Run `python3 scripts/utilities/recover-azd-env.py --environment <name>`. See [Deployment](deployment.md#environments-created-by-github-actions). |
| A container image built on Apple Silicon or another ARM64 machine fails at runtime | Container Apps needs `linux/amd64` images | Use azd's remote ACR build, which `azure.yaml` sets with `remoteBuild: true`. For local test builds, pass `docker build --platform linux/amd64`. |

## Authentication and authorization

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401 Unauthorized` from Functions, DAB or `/mcp` | The token is missing, expired, or has the wrong audience. DAB, Functions and MCP each need a token issued for their own resource. | Get a fresh token for the correct resource with [`azure-auth.py`](../testing/AZURE_AUTHENTICATED_SCRIPTS.md). An unauthenticated `POST /mcp` returns 401 with a `WWW-Authenticate` header that points to the protected-resource metadata. |
| `403 Forbidden` | The token is valid, but the user lacks the scope, the category (internal versus consumer), or ownership of the record | This is expected. Use an identity whose role grants the scope. Do not silently retry as a more privileged identity. See the [Functions OAuth](../features/functions-oauth/README.md) and [MCP scope matrix](../features/mcp-oauth/TOOL_SCOPE_MATRIX.md) docs. |
| `/api/agent/chat` returns 401 with a valid Functions token | The chat route requires an **MCP-audience** token, which it forwards to the MCP server | Request the token with `--resource mcp`. |
| `invalid_request` at `/authorize` | The redirect URI does not match a registered one. Deployed apps use `<app URL>/oauth/callback`; `azure-auth.py` uses the loopback callbacks `http://localhost:5174` (admin) and `5175` (manufacturing), which only capture the code from the `Location` header. | Check the app URL settings that `postdeploy.sh` wires into api-mcp, then redeploy. |
| Signing certificate or Key Vault errors in api-mcp | Missing certificate, RBAC propagation or private DNS | See [MCP OAuth troubleshooting](../features/mcp-oauth/README.md#troubleshooting). |

## Services

| Symptom | Cause | Fix |
| --- | --- | --- |
| The DAB container restarts repeatedly or logs `Timed out waiting for Managed Identity token` | `api/entrypoint.sh` waits for the managed-identity endpoint before starting DAB and exits after `MI_FAILURE_THRESHOLD` attempts (default 60) | Check the Container App's identity assignment read-only. If the wait is too short, change the threshold in source and run `azd deploy api --no-prompt`. |
| DAB `/health` reports `Unhealthy` | Its anonymous probes hit entities that require a role | This is expected. Use authenticated queries and Functions `/api/health/readiness` instead; see [Monitoring](monitoring.md#health-and-readiness). |
| DAB GraphQL returns HTTP 200 with an `errors` array | A permission or schema error for the selected role | Check `errors`, the `X-MS-API-ROLE` header and the entity's permissions in [`dab-config.json`](../../api/dab-config.json). |
| A list seems to stop at 100 rows | DAB pages default to 100 items | Follow `hasNextPage`/`endCursor`, or REST `nextLink` with `$first`/`$after`. `$top` and `$skip` are not supported. |
| `Address` data is not available in DAB | `Person.Address` has a `geography` column that DAB does not support | Use the `AddressFunctions` routes. |
| Manufacturing `WorkOrder` reads return 500 with SQL `10928` | The database worker limit was reached | See [Monitoring](monitoring.md#diagnostic-queries). |
| Functions readiness fails on a queue or table | The storage resource is missing from infrastructure | Add it to `infra/modules/storage.bicep` and the `DependencyHealthService.Application*` lists, then ask the user to recreate the environment. Runtime code must never create storage resources. |

## Real-time updates

| Symptom | Cause | Fix |
| --- | --- | --- |
| The app shows "live updates unavailable" | Negotiation failed: no token, no `realtime.connect` scope, or Web PubSub is unreachable | Sign in again. Check Functions `GET /api/webpubsub/negotiate` with a Functions-audience token. |
| The browser console reports a CSP violation for `wss://*.webpubsub.azure.com` | The static site's `connect-src` does not allow Web PubSub | Fix `staticwebapp.config.json` and its template, then run `azd deploy app --no-prompt`. See [Monitoring](monitoring.md#web-pubsub-blocked-by-content-security-policy). |
| Updates stop during heavy simulation | The Web PubSub Free tier allows 20 concurrent connections and 20,000 messages per day | Reduce simulator rates. Focusing the window again triggers React Query's normal refetch. Do not add polling. |
| A new mutation does not refresh other users' screens | The producer or consumer side is not wired | Publish with `WebPubSubService.SendToGroupAsync` and register the query key or DOM listener. See [Real-time eventing](../architecture/realtime-eventing.md). |

## Dev container and test scripts

| Symptom | Cause | Fix |
| --- | --- | --- |
| A script cannot connect to SQL | Deployed SQL has public access disabled | Use the deployed DAB or Functions APIs. Do not reopen SQL networking. |
| Azure SDK calls fail with credential errors | The Azure CLI login has expired | Run `az login` again. Application API tokens are separate and come from api-mcp OAuth. |
| A test script reports a missing URL | azd values are not exported into the shell, and no azd environment is selected | Run `azd env select <name>` or set the variable the script names. Test scripts have no localhost fallback. |

## Related

- [Deployment lifecycle](deployment.md)
- [Monitoring](monitoring.md)
- [Health diagnostics](../features/monitoring/HEALTH_DIAGNOSTICS.md)
- [Testing strategy](../testing/testing-strategy.md)
