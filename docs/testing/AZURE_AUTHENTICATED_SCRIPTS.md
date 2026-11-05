# Authenticated local scripts against the Azure deployment

Use [azure-auth.py](../../scripts/utilities/azure-auth.py) to authenticate as a
seeded internal user and call deployed DAB, Azure Functions, or MCP endpoints.
Requires Python 3 (standard library only), `azd`, and a completed `azd up`.
No additional identity provider, app registration, client secret, browser, or
local callback server is needed.

## Identity and permissions

The application authorization server is **OpenIddict hosted in api-mcp**, not
Microsoft Entra ID. It verifies email/password against `Person.EmailAddress` and
`Person.Password`, then resolves category, role, and scopes from the database.
`az account get-access-token` does **not** impersonate an AdventureWorks user.
Managed identity protects backend access to Azure SQL and other infrastructure;
it is distinct from application-user authorization.

The [seed job](../../seed-job/seed-database.ps1) sets these public demo credentials:

| Helper identity | Account | Demo password | Expected role | Use for |
| --- | --- | --- | --- | --- |
| `manufacturing` | peter0@adventure-works.com | Factory1234! | manufacturing-engineer | Manufacturing, work orders, inventory and supply-chain work |
| `admin` | ken0@adventure-works.com | Admin1234! | executive-admin | Administration, customers, orders, reporting and broader internal operations |

Prefer Peter when his permissions suffice; do not automatically escalate a denied
request to Ken. Ken has broad internal permissions, but neither identity bypasses
business rules, ownership checks, self-only password routes, or consumer portal
gating. Use a disposable consumer account for consumer-specific authorization tests.
These are demo accounts, **not a production identity pattern**.
If a canned password changed, supply `AZURE_AUTH_PASSWORD` via a secure environment
or a hidden prompt; never pass it as a command-line argument or commit it.

## Quick start

The helper resolves only relevant values with `azd env get-value --no-prompt`
from the repository root. It does not source/evaluate the `.env` or print all its
values. It uses the selected environment; `--environment NAME` selects another
existing environment for that invocation without changing the default.

```bash
# Read manufacturing Functions data as Peter.
python3 scripts/utilities/azure-auth.py request \
  --identity manufacturing --resource functions \
  --path /api/manufacturing/status

# DAB REST: the helper adds Bearer and X-MS-API-ROLE.
# Quote $first so the shell does not expand it; DAB does not support $top/$skip.
python3 scripts/utilities/azure-auth.py request \
  --identity manufacturing --resource dab \
  --path '/api/Product?$first=5'

# DAB GraphQL: API_URL already includes /graphql/, so do not append it twice.
python3 scripts/utilities/azure-auth.py request \
  --identity admin --resource dab --path /graphql --method POST \
  --data '{"query":"{ products(first: 5) { items { ProductID Name } } }"}'

# Admin-only Functions data as Ken.
python3 scripts/utilities/azure-auth.py request \
  --identity admin --resource functions --path /api/ai-job-queue/status
```

`request` logs in anew each invocation, keeps credentials/cookies/tokens in memory,
prints the API response to stdout, and returns nonzero on transport/HTTP errors
or a DAB GraphQL `errors` array (even HTTP 200). It never follows redirects,
including API redirects, and accepts only deployment-relative request paths.
Use `--data-file FILE` or `--data-file -` for request bodies, and
`--content-type TYPE` for non-JSON payloads. `--timeout` defaults to 180 seconds
per request to allow Azure cold starts. It does not retry mutations or token
exchanges automatically, since codes and refresh tokens are single-use.

## Use a token with curl or another local script

```bash
set -euo pipefail
FUNCTIONS_TOKEN=$(python3 scripts/utilities/azure-auth.py token \
  --identity manufacturing --resource functions)
FUNCTIONS_URL=$(azd env get-value API_FUNCTIONS_URL)

# Keep the token out of curl's process arguments by supplying headers on stdin.
printf 'Authorization: Bearer %s\n' "$FUNCTIONS_TOKEN" |
  curl --silent --show-error --fail-with-body \
    --connect-timeout 15 --max-time 180 --header @- \
    "${FUNCTIONS_URL%/}/api/manufacturing/status"
unset FUNCTIONS_TOKEN
```

For DAB, obtain `--resource dab` and also send
`X-MS-API-ROLE: manufacturing-engineer` or `executive-admin`, matching the chosen
identity's granted `roles` claim. A role header cannot grant permissions absent
from the JWT. Functions checks scope/category/ownership rather than this header.
For GraphQL, always inspect the `errors` array and use `.items` for list results.
DAB paginates lists; the first page does not establish the full table count.

Do not use `curl -v`, tracing, shell `set -x`, or log token/session variables.
Only send tokens to the selected deployment. Do not use `-L` to follow redirects.
The helper's default `token` output is deliberately a secret: capture it, do not
paste it into chat or logs. `request` is preferred when token export is unnecessary.

## OAuth flow and audience binding

The helper extracts the api-mcp base URL from `API_MCP_URL` (removing `/mcp`):

1. POST `/login` with the canned email/password and retain the session cookie.
2. POST `/authorize` using the corresponding registered public first-party client,
   a random state, an S256 PKCE challenge, requested scopes and a single `resource`.
3. Capture the callback `Location`, verify its exact registered destination and
   state, and reject OAuth errors. **Do not visit the callback.**
4. POST `/token` with the authorization code and PKCE verifier.
5. Inspect the returned JWT's issuer/audience/subject/expected seeded role and send
   it to the resource server, which performs actual cryptographic validation.

Clients are `adventureworks-admin` (callback
`http://localhost:5174/oauth/callback`) and `adventureworks-manufacturing`
(`http://localhost:5175/oauth/callback`). These localhost URLs are already registered
by [McpAuthorizationExtensions](../../api-mcp/AdventureWorks/Auth/McpAuthorizationExtensions.cs).
PKCE means no client secret is needed. The helper requests the client's business
scopes plus `offline_access`; the server intersects them with actual user grants.

| Resource option | Default token audience | Destination |
| --- | --- | --- |
| `dab` | `{api-mcp base}/dab` | `API_URL` for GraphQL, its base for REST |
| `functions` | `{api-mcp base}/functions` | `API_FUNCTIONS_URL` |
| `mcp` | `{api-mcp base}/mcp` | api-mcp `/mcp` |

Resource identifiers are **not necessarily API request URLs**. The helper honors
`DAB_RESOURCE_IDENTIFIER`, `FUNCTIONS_RESOURCE_IDENTIFIER`, or
`MCP_RESOURCE_IDENTIFIER` if explicitly present in the azd environment. If runtime
audiences are customized separately in Azure, keep those azd values synchronized.
All deployment endpoint URLs must use HTTPS; no hostname is hardcoded.

The established smoke-test flow uses the third-party `mcp-inspector` client and
explicit consent. This helper uses first-party clients to obtain renewable
sessions; it does not change the existing smoke-test assertions.

## Renewal and longer-running scripts

Access tokens default to about **10 minutes**; refresh tokens default to **12 hours
absolute lifetime**, without sliding expiry. Deployment can change these defaults.
Use `--json` to capture the full OAuth response plus helper metadata `_client_id`
and `_issuer`; `refresh` consumes this JSON on stdin and emits its replacement:

```bash
set -euo pipefail
SESSION=$(python3 scripts/utilities/azure-auth.py token \
  --identity manufacturing --resource dab --json)

# Can renew for the same resource or mint a different allowed resource.
SESSION=$(printf '%s' "$SESSION" |
  python3 scripts/utilities/azure-auth.py refresh \
    --identity manufacturing --resource functions)

# jq is optional; only needed by this extraction example.
FUNCTIONS_TOKEN=$(printf '%s' "$SESSION" | jq -er '.access_token')
unset SESSION FUNCTIONS_TOKEN
```

Refresh tokens **rotate**. Replace the session after every successful refresh,
including a resource switch. Never share one refresh token between concurrent
workers: serialize access, or give each worker its own login/session. Renewal
re-resolves user permissions, and cannot expand the original granted scopes.
Reauthenticate when renewal fails or the absolute session lifetime expires.
The helper rejects refresh sessions for a different identity or deployment.
It intentionally does not persist sessions or maintain a shared token cache.
If your script persists a session, use a private directory and mode-600 file
outside the repository; never commit or log it.

## Other grants, exceptions, and troubleshooting

- The custom e-shop credentials grant is restricted to consumer accounts and the
  e-shop client; it **cannot** authenticate these internal test users.
- The managed-identity assertion grant accepts only configured trusted Entra
  workload principal IDs. It currently issues MCP-resource service tokens, not
  arbitrary user impersonation or DAB/Functions user tokens.
- `/api/agent/chat` uses an **MCP-audience user token** for delegated tool calls.
  Obtain `--resource mcp` with `token`, then send it to that Functions endpoint.
  Do not use `request --resource functions` for delegated agent chat: that would
  mint the wrong audience. MCP Streamable HTTP also expects
  `Accept: application/json, text/event-stream`; `request --resource mcp` adds this
  automatically, or send it yourself when using exported tokens and curl.
- Public health, discovery, and explicitly anonymous routes need no token.
- `401`: missing/expired token, wrong issuer/audience, or signature/key mismatch.
- `403`: missing scope, wrong category/role, ownership or business-policy denial.
  Inspect the [Functions route matrix](../features/functions-oauth/ROUTE_SCOPE_MATRIX.md)
  or [MCP tool matrix](../features/mcp-oauth/TOOL_SCOPE_MATRIX.md) before changing identity.
- Login failure: confirm seeding completed and the canned password was not changed.
  The helper checks login redirects because `/login` can report rejection with 302.
- Network timeout: verify deployment health and retry manually after cold start.
  Do not disable TLS verification or weaken server authorization to make tests pass.

## Validation

Offline helper regression tests (no Azure calls or dependencies to install):

```bash
python3 -B -m unittest discover -s tests/scripts -p 'test_azure_auth.py'
```

Live verification uses the four read-only `request` examples above. Neither login
nor those reads modifies business data; writes, simulator starts and AI calls
require deliberate selection and may mutate data/incur costs.

Related: [OAuth server guide](../features/mcp-oauth/README.md),
[Functions OAuth guide](../features/functions-oauth/README.md),
[existing auth smoke tests](../../tests/scripts/auth-smoke-tests.sh).
