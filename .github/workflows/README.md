# GitHub Workflows

This directory contains GitHub Actions workflows for the AdventureWorks application.

## build-checker.yaml: offline authentication assurance

The existing manual/scheduled [Build-Checker](build-checker.yaml) includes an
`auth-offline` job. It restores the .NET, locked Node and assurance Python dependencies and runs
`bash tests/scripts/validate-auth.sh --offline`, without Azure login, secrets or
deployed API calls.

Any assertion failure fails the job. The current-run signed assertion,
Functions middleware, address/password/receipt ownership, all-consumer-handler
closure, guest-cart lifecycle and MCP
HTTP tool-dispatch and persisted task-ownership gates
must each pass exactly once. The profile's exit code 2 is allowed only when those
deterministic gates pass and no assertion fails; unresolved live coverage
remains explicitly blocked. JSON, JUnit and TRX evidence is uploaded for review.
This job does not build/deploy the private runner or authorize live mutations.

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

### One-time Azure and GitHub setup

The following creates an Entra app registration and its service principal,
then allows GitHub Actions to authenticate to it without a client secret. The
app registration is in the target subscription's Entra tenant, not in the
disposable demo resource group. Only an application service principal is
supported for this workflow.

If a suitably permitted service principal already exists, skip this section
and follow
[Authorizing another repository to use an existing service principal](../../docs/AZD_DEPLOYER_PERMISSIONS.md#authorizing-another-repository-to-use-an-existing-service-principal);
it only adds a federated credential for the repository.

**Prerequisites**

- An Azure subscription Owner on the target subscription, with permission in
  its Entra tenant to create app registrations, create the service principal,
  and configure federated credentials on the new app. Subscription Owner alone
  does **not** confer those Entra permissions; if tenant policy restricts app
  registration or service-principal creation, ask an Entra administrator.
- A GitHub fork and permission to configure its environment. Create a GitHub
  Environment named `azure-demo` under **Settings > Environments**, restrict
  its allowed deployment branches, and require reviewers where available.
- Azure CLI and `jq`; run the commands below from the repository root in a
  Bash shell. Sign in with `az login --tenant <tenant-id>` first.

**Choose the exact GitHub OIDC subject.** The deploy job uses the `azure-demo`
environment. For a repository using GitHub's default subject format:

- Name-based: `repo:<owner>/<repo>:environment:azure-demo`
- Immutable: `repo:<owner>@<owner-id>/<repo>@<repo-id>:environment:azure-demo`

GitHub.com repositories created after July 15, 2026 use immutable subjects by
default; older repositories can opt in, and renamed or transferred repositories
can switch formats. Customized OIDC subject templates can produce different
subjects. Check the fork's actual settings and configured subject in
[GitHub's OIDC reference](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims);
the subject must match exactly. Do not copy a GitHub token into logs or share it.

**Create the identity and grant access.** Replace the three placeholders below
with the target subscription ID, its tenant ID, and the exact subject for the
fork. Run this once in a dedicated Bash shell: `set -e` stops on errors.
If a command fails, inspect the partially created app and assignments before
retrying; rerunning the whole block can create duplicate registrations.

```bash
set -euo pipefail
set +H
SUBSCRIPTION_ID="<target-subscription-id>"
TENANT_ID="<target-tenant-id>"
OIDC_SUBJECT="<exact-subject-for-the-fork-and-azure-demo-environment>"
APP_NAME="AdventureWorks-GitHub-Deploy"

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
CLIENT_ID=$(az ad app create --display-name "$APP_NAME" \
  --sign-in-audience AzureADMyOrg --query appId --output tsv)
if [[ -z "$CLIENT_ID" ]]; then
  echo "App creation did not return a client ID." >&2
  exit 1
fi
PRINCIPAL_ID=$(az ad sp create --id "$CLIENT_ID" --query id --output tsv)
if [[ -z "$PRINCIPAL_ID" ]]; then
  echo "Service principal creation did not return an object ID." >&2
  exit 1
fi

FIC_JSON=$(jq -n --arg subject "$OIDC_SUBJECT" '{
  name: "github-azure-demo",
  issuer: "https://token.actions.githubusercontent.com",
  subject: $subject,
  audiences: ["api://AzureADTokenExchange"]
}')
az ad app federated-credential create --id "$CLIENT_ID" \
  --parameters "$FIC_JSON" --output none

az role assignment create --subscription "$SUBSCRIPTION_ID" \
  --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
  --role Contributor --scope "/subscriptions/$SUBSCRIPTION_ID" --output none

ROLE_IDS=$(jq -r '[.roleDefinitionIds[]] | join(", ")' infra/azd-role-assignment-allowlist.json)
if [[ -z "$ROLE_IDS" ]]; then
  echo "The role assignment allowlist is empty." >&2
  exit 1
fi
CONDITION="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLE_IDS} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLE_IDS} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'}))"
az role assignment create --subscription "$SUBSCRIPTION_ID" \
  --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
  --role f58310d9-a9f6-439a-9e8d-f62e7b41a168 \
  --scope "/subscriptions/$SUBSCRIPTION_ID" \
  --condition "$CONDITION" --condition-version 2.0 --output none

printf 'DEPLOYER_CLIENT_ID=%s\nDEPLOYER_OBJECT_ID=%s\nDEPLOYER_TENANT_ID=%s\nDEPLOYER_SUBSCRIPTION_ID=%s\n' \
  "$CLIENT_ID" "$PRINCIPAL_ID" "$TENANT_ID" "$SUBSCRIPTION_ID"
```

The second grant is **Role Based Access Control Administrator**, restricted
to the repository's allowlisted role definitions and service-principal
assignees. Without that condition it can grant Owner. Another unrestricted
role-assignment grant to the same principal can bypass the condition. The
remaining risks and role allowlist are explained in
[Deployer Permissions](../../docs/AZD_DEPLOYER_PERMISSIONS.md#residual-risk-the-administrator-should-understand).
RBAC propagation can take several minutes.

**Configure GitHub.** Add the four values printed above as **environment
variables** in `azure-demo` (not repository secrets; the workflow reads
environment variables):

   | Variable | Value |
   | --- | --- |
   | `DEPLOYER_CLIENT_ID` | App registration application/client ID |
   | `DEPLOYER_OBJECT_ID` | Service principal object ID (not the app registration object ID or client ID) |
   | `DEPLOYER_TENANT_ID` | Entra tenant ID |
   | `DEPLOYER_SUBSCRIPTION_ID` | Target subscription ID |

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

The runner uses the repository's existing lifecycle hooks and service deploy
definitions. The seed remains asynchronous for local deployments; only this
workflow waits for its own seed execution. Deployments with the same resolved
environment name are serialized; a running deployment is not canceled by a
new run, although GitHub may replace a pending run in the same group.

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
