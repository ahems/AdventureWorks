---
title: GitHub workflows (.github/workflows/) — build checks and service-principal deployment
summary: Component README for the GitHub Actions workflows, including the offline build checker, the one-time OIDC service-principal setup and conditioned role grant for the azd up deployment workflow, running it, and recreating the local azd environment afterwards.
audience: [developer, operator, security-reviewer]
components: [ci-cd, infra]
related: [docs/operations/ci-cd.md, docs/AZD_DEPLOYER_PERMISSIONS.md, docs/operations/deployment.md, docs/testing/testing-strategy.md]
---

# GitHub workflows (`.github/workflows/`)

GitHub Actions workflows for the AdventureWorks demo. For an overview of inputs, steps
and what CI covers, see **[CI/CD workflows](../../docs/operations/ci-cd.md)**.

| Workflow | Trigger | Purpose |
|---|---|---|
| [`build-checker.yaml`](build-checker.yaml) | Manual or scheduled | Offline authentication assurance, offline tests and typechecks, container and Functions build checks, storefront SWA build |
| [`azd-up-service-principal.yml`](azd-up-service-principal.yml) | Manual | Full `azd up --no-prompt` as an Entra service principal over GitHub OIDC |

## build-checker.yaml

[Build-Checker](build-checker.yaml) runs four independent jobs:

- `auth-offline` restores the .NET, locked Node and assurance Python dependencies and
  runs `bash tests/scripts/validate-auth.sh --offline`, without Azure login, secrets or
  deployed API calls. Any assertion failure fails the job; exit code 2 is allowed only
  when every deterministic gate passes and the remaining live coverage is explicitly
  blocked. JSON, JUnit and TRX evidence is uploaded. It does not authorize live mutations.
- `build-check` runs `docker build` for `api`, `seed-job`, `api-mcp`,
  `app-admin`, `app-manufacturing`, `mcp-inspector`, `manufacturing-agent` and
  `.devcontainer`, and `dotnet publish` for `api-functions`.
- `offline-tests` runs `npm run typecheck` for the three frontends, the
  `app-admin` and `app-manufacturing` Vitest suites, the storefront and
  `mcp-inspector` `node --test` suites, the offline frontend harnesses in
  `tests/scripts`, `pytest tests/scripts`, the seed-job Python tests and a
  `manufacturing-agent` `dotnet build`. Every step runs; the last step reports all
  failures.
- `swa-build` runs `swa build` for the storefront.

## azd-up-service-principal.yml

This manually triggered workflow is an optional deployment terminal for the
same full `azd up --no-prompt` lifecycle used by the local quickstart. It
authenticates with GitHub OIDC as an Entra app registration's service principal;
it does not add a second provisioning or deployment implementation. Local
`azd up` remains the primary path.

The workflow runs only on `workflow_dispatch`, waits for the exact seed
execution it started, checks Functions/MCP readiness, confirms SQL and Key
Vault temporary network access was cleaned up, and writes the deployed URLs
and status to the run summary. It never uploads Azure credential caches or
prints all azd environment values.

For long runs, azd uses its GitHub OIDC credential provider, while a
workflow-only `az` wrapper renews the Azure CLI's short-lived GitHub assertion
throughout `azd up` and the subsequent checks. Concurrent CLI commands use
separate temporary profiles with Azure CLI telemetry disabled; an always-run
cleanup step removes them. Local `azd up` and local Azure CLI authentication
are unchanged. An individual long-running Azure CLI command cannot renew its
assertion after it starts, so it may still fail if it needs a new token after
the assertion expires.

### One-time Azure and GitHub setup

The following creates an Entra app registration and its service principal,
then allows GitHub Actions to authenticate to it without a client secret. The
app registration is in the target subscription's Entra tenant, not in the
disposable demo resource group. Only an application service principal is
supported for this workflow.

> [!TIP]
> **Already have a service principal with the required permissions?** Skip
> the rest of this section. Follow
> [Authorizing this repository to use an existing service principal](../../docs/AZD_DEPLOYER_PERMISSIONS.md#authorizing-this-repository-to-use-an-existing-service-principal),
> which only grants this repository permission to use it.

**Prerequisites**

- An Azure subscription Owner on the target subscription, with permission in
  its Entra tenant to create app registrations, create the service principal,
  and configure federated credentials on the new app. Subscription Owner alone
  does **not** confer those Entra permissions; if tenant policy restricts app
  registration or service-principal creation, ask an Entra administrator.
- A GitHub repository and permission to configure its environment. Create a
  GitHub Environment named `adventureworks-demo` under **Settings >
  Environments**, restrict its allowed deployment branches, and require
  reviewers where available. This is the GitHub deployment protection/approval
  environment, not the azd environment name or Azure resource-group name.
- **Recommended: [Azure Cloud Shell](https://shell.azure.com) (Bash).** It is
  already signed in and includes Azure CLI and `jq`. The script below is
  self-contained: it does not need a clone of this repository or any other
  file. From another Bash shell, install Azure CLI and `jq` and sign in with
  `az login --tenant <tenant-id>` first.

**Choose the exact GitHub OIDC subject.** The deploy job uses the
`adventureworks-demo` GitHub Environment. Its name is part of the OIDC subject
and must match exactly in the federated credential. It is distinct from the azd
environment name, which is generated as `adventureworks001` through
`adventureworks999` unless you provide one, and from the resource group name
`rg-<azd-environment-name>`. For a repository using GitHub's default subject
format:

- Name-based: `repo:<owner>/<repo>:environment:adventureworks-demo`
- Immutable: `repo:<owner>@<owner-id>/<repo>@<repo-id>:environment:adventureworks-demo`

Use the immutable form only if the repository actually uses immutable subject
claims. GitHub.com repositories created after July 15, 2026 use them by
default; older repositories use the name-based form unless they opt in, and
customized OIDC subject templates produce other subjects. See
[GitHub's OIDC reference](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims).
If unsure, start with the name-based form.

> [!TIP]
> If the workflow's **Azure login** step fails with `AADSTS700213: No matching
> federated identity record found for presented assertion subject '...'`, the
> quoted value is the exact subject GitHub sent. Either copy it into
> `OIDC_SUBJECT` and rerun the script below (it updates the existing
> credential), or, if the credential already uses the immutable form, turn on
> immutable subjects for the repository as described next. Then rerun the
> workflow. Do not copy a GitHub token into logs or share it.

**Optional: turn on immutable subjects for an older repository.** The immutable
form is recommended because the trust cannot be reused by someone who later
claims the same owner or repository name. Repositories created before July 15,
2026 can opt in. This requires admin access to the repository; `gh` is
preinstalled in Cloud Shell (run `gh auth login` first if needed). Replace
`OWNER/REPO`, for example `username/adventureworks`:

```bash
REPO="OWNER/REPO"

# 1. Print the immutable subject for this repository. Use it as OIDC_SUBJECT,
#    or compare it with the subject of an existing federated credential.
gh api "repos/$REPO" \
  --jq '"repo:\(.owner.login)@\(.owner.id)/\(.name)@\(.id):environment:adventureworks-demo"'

# 2. Opt the repository in. use_default=true keeps GitHub's standard subject
#    layout and only adds the owner and repository IDs.
gh api -X PUT "repos/$REPO/actions/oidc/customization/sub" \
  -F use_default=true -F use_immutable_subject=true

# 3. Confirm: the output should include "use_immutable_subject": true.
gh api "repos/$REPO/actions/oidc/customization/sub"
```

You can make the same change in the repository's Actions OIDC settings
instead of the API. New workflow runs use the immutable subject immediately,
so make sure the federated credential's subject matches exactly, including
letter case, before rerunning the workflow. The setting applies to every OIDC
workflow in the repository, so any other cloud trust configured with
name-based subjects for this repository stops working. An organization-level
subject template can also change the result. To revert, run step 2 with
`use_immutable_subject=false` and use the name-based subject again. See
GitHub's
[OIDC REST API](https://docs.github.com/en/rest/actions/oidc#set-the-customization-template-for-an-oidc-subject-claim-for-a-repository).

**Create the identity and grant access.** In Cloud Shell (Bash), create a
script file, for example with `code create-github-deployer.sh`, and paste the
block below into it. Replace the three placeholders with the target
subscription ID, its tenant ID, and the exact subject for the fork. Save the
file, then run it with `bash create-github-deployer.sh`. Running it as a file
means a failed check stops the script without closing the Cloud Shell session.

The script is safe to rerun, for example after a partial failure. It reuses
the single app registration named `AdventureWorks-GitHub-Deploy`, its service
principal, a federated credential with the same subject, and existing
subscription-scope grants, creating only what is missing. To correct the
subject, edit `OIDC_SUBJECT` and rerun: the script replaces the subject of its
`github-adventureworks-demo` credential, so the old subject stops working. It
stops instead of changing anything if several apps share that name, or if an
existing RBAC Administrator grant has a different condition.

```bash
#!/usr/bin/env bash
# Self-contained and rerunnable: creates or completes the AdventureWorks
# GitHub deployer service principal. No repository clone or other files needed.
set -euo pipefail
set +H
SUBSCRIPTION_ID="<target-subscription-id>"
TENANT_ID="<target-tenant-id>"
OIDC_SUBJECT="<exact-subject-for-the-fork-and-adventureworks-demo-environment>"
APP_NAME="AdventureWorks-GitHub-Deploy"
CREDENTIAL_NAME="github-adventureworks-demo"
ISSUER="https://token.actions.githubusercontent.com"
SCOPE="/subscriptions/$SUBSCRIPTION_ID"
CONTRIBUTOR_ROLE_ID="b24988ac-6180-42a0-ab88-20f7382dd24c"
RBAC_ADMIN_ROLE_ID="f58310d9-a9f6-439a-9e8d-f62e7b41a168"

if [[ -z "$OIDC_SUBJECT" || "$OIDC_SUBJECT" == *"<"* || "$OIDC_SUBJECT" == *">"* ]]; then
  echo "Set OIDC_SUBJECT to the fork's exact GitHub Actions subject." >&2
  exit 1
fi
az account set --subscription "$SUBSCRIPTION_ID"
if [[ "$(az account show --query tenantId --output tsv)" != "$TENANT_ID" ]]; then
  echo "The target subscription is not in the specified tenant." >&2
  exit 1
fi

# The application client ID and the service principal object ID are different.
mapfile -t APP_IDS < <(az ad app list --display-name "$APP_NAME" --query "[].appId" --output tsv)
if (( ${#APP_IDS[@]} > 1 )); then
  echo "Several app registrations are named $APP_NAME; delete the extras or change APP_NAME." >&2
  exit 1
elif (( ${#APP_IDS[@]} == 1 )); then
  CLIENT_ID=${APP_IDS[0]}
  echo "Reusing app registration $APP_NAME ($CLIENT_ID)."
else
  CLIENT_ID=$(az ad app create --display-name "$APP_NAME" \
    --sign-in-audience AzureADMyOrg --query appId --output tsv)
  echo "Created app registration $APP_NAME ($CLIENT_ID)."
fi
if [[ -z "$CLIENT_ID" ]]; then
  echo "Could not determine the app's client ID." >&2
  exit 1
fi

PRINCIPAL_ID=$(az ad sp list --filter "appId eq '$CLIENT_ID'" --query "[0].id" --output tsv)
if [[ -z "$PRINCIPAL_ID" ]]; then
  PRINCIPAL_ID=$(az ad sp create --id "$CLIENT_ID" --query id --output tsv)
  echo "Created service principal $PRINCIPAL_ID."
else
  echo "Reusing service principal $PRINCIPAL_ID."
fi
if [[ -z "$PRINCIPAL_ID" ]]; then
  echo "Could not determine the service principal object ID." >&2
  exit 1
fi

CREDENTIALS=$(az ad app federated-credential list --id "$CLIENT_ID" --output json)
FIC_JSON=$(jq -n --arg name "$CREDENTIAL_NAME" --arg issuer "$ISSUER" --arg subject "$OIDC_SUBJECT" \
  '{name: $name, issuer: $issuer, subject: $subject, audiences: ["api://AzureADTokenExchange"]}')
OLD_SUBJECT=$(jq -r --arg name "$CREDENTIAL_NAME" \
  'map(select(.name == $name)) | if length == 1 then .[0].subject else "" end' <<<"$CREDENTIALS")
if jq -e --arg subject "$OIDC_SUBJECT" --arg issuer "$ISSUER" \
  'any(.[]; .subject == $subject and .issuer == $issuer)' <<<"$CREDENTIALS" >/dev/null; then
  echo "Federated credential for $OIDC_SUBJECT already exists."
elif [[ -n "$OLD_SUBJECT" ]]; then
  # The script owns this credential name, so a new subject replaces the old one.
  az ad app federated-credential update --id "$CLIENT_ID" \
    --federated-credential-id "$CREDENTIAL_NAME" --parameters "$FIC_JSON" --output none
  echo "Updated federated credential $CREDENTIAL_NAME: $OLD_SUBJECT -> $OIDC_SUBJECT."
else
  az ad app federated-credential create --id "$CLIENT_ID" \
    --parameters "$FIC_JSON" --output none
  echo "Created federated credential for $OIDC_SUBJECT."
fi

# Prints the JSON conditions of this principal's grants of a role at $SCOPE.
existing_grants() {
  az role assignment list --assignee "$PRINCIPAL_ID" --scope "$SCOPE" --output json |
    jq -c --arg role "$1" --arg scope "$SCOPE" \
      '[.[] | select((.roleDefinitionId | ascii_downcase | endswith("/" + $role))
              and ((.scope | ascii_downcase) == ($scope | ascii_downcase))) | .condition]'
}

if [[ "$(existing_grants "$CONTRIBUTOR_ROLE_ID")" != "[]" ]]; then
  echo "Contributor is already assigned."
else
  az role assignment create --subscription "$SUBSCRIPTION_ID" \
    --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
    --role Contributor --scope "$SCOPE" --output none
  echo "Assigned Contributor."
fi

# Built-in roles that azd provisioning and its hooks assign. This is a copy of
# infra/azd-role-assignment-allowlist.json; do not add roles without review.
ALLOWED_ROLE_IDS=(
  09976791-48a7-449e-bb21-39d1a415f350 # Communication and Email Service Owner
  0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3 # Storage Table Data Contributor
  0c867c2a-1d8c-454a-a3db-ab2ea1bdc8bb # Storage File Data SMB Share Contributor
  12cf5a90-567b-43ae-8102-96cf46c7d9b4 # Web PubSub Service Owner
  19c28022-e58e-450d-a464-0b2a53034789 # Cognitive Services Data Contributor (Preview)
  43d0d8ad-25c7-4714-9337-8ba259a9fe05 # Monitoring Reader (resource-scoped queries)
  4633458b-17de-408a-b874-0445c86b69e6 # Key Vault Secrets User
  5e0bd9bd-7b93-4f28-af87-19fc36ad61bd # Cognitive Services OpenAI User
  64702f94-c441-49e6-a78b-ef80e0188fee # Azure AI Developer
  73c42c96-874c-492b-b04d-ab87d138a893 # Log Analytics Reader (demo workspace only)
  7f951dda-4ed3-4680-a7ca-43fe172d538d # AcrPull
  974c5e8b-45b9-4653-ba55-5f855dd0fb88 # Storage Queue Data Contributor
  a001fd3d-188f-4b5d-821b-7da978bf7442 # Cognitive Services OpenAI Contributor
  a235d3ee-5935-4cfb-8cc5-a3303ad5995e # Storage File Data SMB MI Admin
  a4417e6f-fecd-4de8-b567-7b0420556985 # Key Vault Certificates Officer
  acdd72a7-3385-48ef-bd42-f606fba81ae7 # Reader
  b7e6dc6d-f1e8-4753-8033-0f276bb0955b # Storage Blob Data Owner
  b8eda974-7b85-4f76-af95-65846b26df6d # Storage File Data Privileged Reader
  ba92f5b4-2d11-453d-a403-e96b0029c9fe # Storage Blob Data Contributor
)
ROLE_IDS=$(printf '%s, ' "${ALLOWED_ROLE_IDS[@]}")
ROLE_IDS=${ROLE_IDS%, }
CONDITION="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLE_IDS} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLE_IDS} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'}))"
RBAC_ADMIN_GRANTS=$(existing_grants "$RBAC_ADMIN_ROLE_ID")
if [[ "$RBAC_ADMIN_GRANTS" == "[]" ]]; then
  az role assignment create --subscription "$SUBSCRIPTION_ID" \
    --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
    --role f58310d9-a9f6-439a-9e8d-f62e7b41a168 \
    --scope "/subscriptions/$SUBSCRIPTION_ID" \
    --condition "$CONDITION" --condition-version 2.0 --output none
  echo "Assigned the conditioned RBAC Administrator role."
elif jq -e --arg condition "$CONDITION" '. == [$condition]' <<<"$RBAC_ADMIN_GRANTS" >/dev/null; then
  echo "The conditioned RBAC Administrator role is already assigned."
else
  echo "An RBAC Administrator grant with a different or missing condition exists; remove it and rerun." >&2
  exit 1
fi

printf 'DEPLOYER_CLIENT_ID=%s\nDEPLOYER_OBJECT_ID=%s\nDEPLOYER_TENANT_ID=%s\nDEPLOYER_SUBSCRIPTION_ID=%s\n' \
  "$CLIENT_ID" "$PRINCIPAL_ID" "$TENANT_ID" "$SUBSCRIPTION_ID"
```

The second grant is **Role Based Access Control Administrator**, restricted
to the repository's allowlisted role definitions and service-principal
assignees. The script's `ALLOWED_ROLE_IDS` is a copy of
[azd-role-assignment-allowlist.json](../../infra/azd-role-assignment-allowlist.json);
an offline test (`tests/auth/test_validate.py`) fails if the two differ.
Without that condition it can grant Owner. Another unrestricted
role-assignment grant to the same principal can bypass the condition. The
remaining risks and role allowlist are explained in
[Deployer Permissions](../../docs/AZD_DEPLOYER_PERMISSIONS.md#residual-risk-the-administrator-should-understand).
RBAC propagation can take several minutes.

**Configure GitHub.** Add the four values printed above as **environment
variables** in `adventureworks-demo` (not repository secrets; the workflow reads
environment variables):

   | Variable | Value |
   | --- | --- |
   | `DEPLOYER_CLIENT_ID` | App registration application/client ID |
   | `DEPLOYER_OBJECT_ID` | Service principal object ID (not the app registration object ID or client ID) |
   | `DEPLOYER_TENANT_ID` | Entra tenant ID |
   | `DEPLOYER_SUBSCRIPTION_ID` | Target subscription ID |

Optionally add `CHAT_MODEL_NAME_REGEX` (for example `^gpt-6\.2-astra$`) to pin
the chat model that `preup.sh` would otherwise rank automatically from available
quota. Use it when a newly available model variant is not yet compatible with
the Foundry Responses calls used by the AI features.

The deployment service principal itself needs no client secret, Microsoft Graph
application permission, Entra directory role, SQL administrator access, or
pre-granted application data role. The human creating the app does need the
Entra permissions described above. `preup.sh` does not create app registrations;
normal provisioning and hooks create the application role assignments.
Protect app ownership and credential management: anyone who can add another
credential to the app can authenticate as this deployer.

After signing in, the workflow reads its own service-principal record from
Microsoft Graph to verify its type and the supplied client and object IDs.
[Microsoft documents](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-get?view=graph-rest-1.0#permissions)
that a service principal can read its own details without an application
permission. The runner must be able to reach Microsoft Graph; an unsuccessful
lookup or an identity mismatch stops deployment.

### Run the workflow

1. In the fork, open **Actions** and select **Deploy demo with service principal
   (azd up)**.
2. Choose **Run workflow**. Optionally provide a new azd environment name and
   change the default regions (`eastus2`, `swedencentral`). If no name is
   provided, the workflow randomly selects `adventureworks001` through
   `adventureworks999` and logs the selected name.
3. The workflow derives the resource group as `rg-<environment-name>`. Use a
   new name for each fresh demo environment. If the selected resource group
   already exists, the workflow stops without deploying; retry or specify an
   unused name.
4. Wait for the run summary to report seed completion and readiness. A green
   `azd up` step alone is not considered demo-ready.
5. Optionally set **validate_auth_infra** to run the read-only authentication
   infrastructure checks (`tests/scripts/validate-auth.sh --infra`) as the
   service principal after deployment. They verify RBAC-only data access,
   disabled local keys, the role-assignment allowlist, and the conditioned RBAC
   Administrator grant (`infra:deployer-access-management`). The SP grant is
   recorded as `infra:deployer-service-principal-rbac-admin`, an accepted
   exception. The run summary lists the status counts, and the
   artifact (`auth-infra-<environment-name>`) contains only a sanitized
   `summary.md` with those counts. The detailed Markdown/JUnit reports and
   `report.json` (which includes resource inventory and check details) are not
   uploaded. Any `FAIL` fails the step. `BLOCKED` checks do not fail the
   workflow, but remain assurance gaps (for example, when Azure cannot return
   effective role assignments or definitions).
   Application, MCP and agent checks need local azd access and the demo logins,
   so this step does not run them. See
   [End-to-end authentication](../../docs/features/authentication/END_TO_END_AUTHENTICATION.md#service-principal-github-actions-deployment-path).

The runner uses the repository's existing lifecycle hooks and service deploy
definitions. Before `azd up`, it installs the `azure.ai.agents` azd extension
(pinned to 1.2.0, with its dependencies) required by the hosted
`manufacturing-agent` service; a local `azd up` offers to install it instead.
The runner uses Node.js 22 for the storefront build and checks that the Azure
CLI's built-in `containerapp` commands are available. The seed remains
asynchronous for local deployments; only this workflow waits for its own seed
execution. Deployments with the same resolved
environment name are serialized; a running deployment is not canceled by a
new run, although GitHub may replace a pending run in the same group.

### Recreate the local azd environment after a GitHub deployment

The runner's azd environment is discarded, but local testing (for example
`scripts/utilities/azure-auth.py`) and later `azd deploy` runs read deployment
values from a local azd environment. After the workflow succeeds, sign in with
an account that can read the resource group and its Function App settings
(Reader is not enough for app settings; Contributor or Website Contributor is).
Then recreate the environment:

```bash
az login
python3 scripts/utilities/recover-azd-env.py \
  --environment adventureworks042 \
  --subscription <subscription-id> \
  --dry-run   # lists the keys it would write; remove to create the environment
```

Use the azd environment name logged by the workflow run (not the GitHub
Environment `adventureworks-demo`). The script makes only read-only Azure
calls and refuses to overwrite an existing local azd environment. It creates
and selects the azd environment, then writes:

- the non-secret outputs of the latest successful `infra/main.bicep` deployment
  for that environment in `rg-<environment-name>` (`--resource-group` overrides),
  using the exported deployment template to restore their original casing;
- the azd inputs from `infra/main.parameters.json`, recovered from that
  deployment's parameters (model selections, `OBJECT_ID`,
  `DEPLOYER_PRINCIPAL_TYPE`, and so on);
- `AZURE_*`, `TENANT_ID`, and the hook-derived `VITE_API_URL` and
  `VITE_API_FUNCTIONS_URL`;
- the `AI_AGENT_*_ID` and `MANUFACTURING_AGENT_ENDPOINT` values copied to the
  Function App during deployment. The script refuses normal recovery if the
  required agent settings are missing, which can indicate an incomplete
  deployment. `--skip-app-settings` explicitly omits them for partial recovery.

It deliberately does not write the Static Web App deployment token or
`FOUNDRY_AGENT_CONFIG_HASH`, and it cannot recover the `AI_AGENT_*_MEMORY_STORE`
values. They are not needed for testing; the first local `azd deploy` re-applies
the checked-out Foundry agent definitions and restores them. `OBJECT_ID`
remains the deployer service principal's ID, matching the deployed state.

### Scope, failures, and cleanup

- This is a demo/POC deployment and incurs the same Azure, AI and other service
  costs as local `azd up`. It does not run on pushes or pull requests.
- The hosted runner's azd state is temporary. The workflow is intended for a
  **fresh demo environment**, not as a stateful redeploy, repair, migration or
  takeover mechanism.
- On failure, inspect the failed workflow step and the Azure resources in the
  derived resource group. Do not treat a partial deployment or a green deploy
  step without successful seed/readiness checks as ready. Re-run only after
  understanding the partial state; use a different environment name for a new
  demo.
- The workflow never runs `azd down` or deletes resources. Teardown remains a
  deliberate, user-run action; `azd down --no-prompt` permanently deletes the
  selected demo environment and its data.
- If an organization's network policy blocks the GitHub-hosted runner or the
  normal hook access, do not weaken that policy. A separately approved
  self-hosted/private runner may be needed.
