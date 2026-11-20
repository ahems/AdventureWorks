# Deployer Permissions: Why Contributor Is Not Enough

This page is for **Azure subscription administrators** who have been asked to
grant someone the permissions needed to deploy the AdventureWorks demo with
`azd up`. It assumes no familiarity with the demo itself. For deployment from
GitHub Actions with an Entra app registration, see the
[workflow setup instructions](../.github/workflows/README.md#one-time-azure-and-github-setup).

## Summary of the request

| Item | Value |
| --- | --- |
| Existing role the deployer already has | **Contributor** on the target subscription |
| Additional role requested | Custom role [azd-deployer-role.json](../infra/azd-deployer-role.json), or the built-in **Role Based Access Control Administrator** role |
| Permissions it adds | `Microsoft.Authorization/roleAssignments/write` and `Microsoft.Authorization/roleAssignments/delete` only |
| Permissions it does **not** add | Role *definition* create/update/delete, policy, locks, or any non-authorization action |
| Scope | The target subscription (azd creates a new resource group per environment) |
| Required safeguard | An Azure RBAC (ABAC) condition on the assignment that only permits assigning or removing the built-in roles in [azd-role-assignment-allowlist.json](../infra/azd-role-assignment-allowlist.json). Owner, User Access Administrator, Role Based Access Control Administrator and the custom role itself are not in that list. |

## Why the deployment needs to create role assignments

The demo uses **managed identities instead of passwords, keys or connection
string secrets**. Every service authenticates to the services it calls (SQL,
Storage, Key Vault, Azure OpenAI/Foundry, Web PubSub, Communication Services,
Container Registry) with an Entra ID identity, and Azure grants that access
only through role assignments. Storage shared-key access and other local
authentication are disabled by design, so there is no key-based fallback.

The Bicep templates and deployment hooks therefore create the identities and
then grant them narrowly scoped built-in roles on the specific resources they
use. Almost all assignments are scoped to an individual resource (one storage
account, one vault, one registry, one Foundry project), not to the resource
group or subscription.

Contributor explicitly excludes `Microsoft.Authorization/*/write` and
`Microsoft.Authorization/*/delete`, so a Contributor cannot create those grants.

## Why an administrator cannot simply create the assignments in advance

- **The principals do not exist before deployment.** The managed identities and
  target resources are created by the same deployment that needs to grant them
  access. Their object (principal) IDs are generated only when they are
  created, so an administrator has nothing to assign roles to beforehand.
- **The demo is designed to be torn down and recreated.** To avoid idle cost,
  users run `azd down` and later `azd up`, frequently under a new environment
  name. Each run creates a new resource group, new identities and new
  assignments. Pre-created or manually created assignments would be needed for
  every deployment.
- **Azure checks the caller's permission before the principals exist.** The
  authorization check for a role assignment is made against the deploying user
  and the assignment's *scope* (for example, a named storage account that the
  deployment will create), not against the identity that will receive it. The
  templates build each scope and assignment name from resource names known in
  advance. ARM can therefore reject the assignments during validation, before
  the identities or target resources are created. The principal ID is resolved
  only later, when the assignment is actually written.

## What breaks without it

### 1. Provisioning fails

With Contributor alone, `azd up` proceeds as follows:

1. The pre-up hook creates the resource group and the Microsoft Foundry account
   so that it can select available AI models and capacity. Contributor is
   sufficient for both.
2. azd submits the Bicep deployment. Before creating any resources, ARM
   validates it, including the caller's `roleAssignments/write` permission at
   each assignment's scope (see
   [above](#why-an-administrator-cannot-simply-create-the-assignments-in-advance)).
3. Validation fails with an error similar to:

   ```text
   InvalidTemplateDeployment: ... does not have permission to perform action
   'Microsoft.Authorization/roleAssignments/write' at scope '.../providers/
   Microsoft.Authorization/roleAssignments/<guid>'
   ```

   An `InvalidTemplateDeployment` error means that the deployment was rejected
   at validation. None of the resources in that deployment are created,
   including the identities, vault and registry. Only the resource group and
   the Foundry account from step 1 exist.
4. Provisioning stops, so the post-provision hook (SQL users, signing
   certificate, data seeding, Foundry agents), application deployment and
   post-deploy wiring never run.

ARM cannot fully validate a nested module whose inputs depend on values
available only at runtime. It checks that module when it starts, so some
resources may already have been created before the same authorization error
stops the deployment. In both cases the environment is incomplete and unusable.
Even if the Bicep deployment succeeded, the post-provision hook would fail,
because it also creates role assignments itself with the Azure CLI (see the
table below).

### 2. Even if the assignments were removed, the application would not work

The table below shows what each group of assignments enables. Removing any of
them leaves a deployment that provisions but fails at runtime.

| Built-in role(s) | Granted to | Scope | What fails without it |
| --- | --- | --- | --- |
| AcrPull | Runtime and seed-job identities | Container registry | Container Apps (API, MCP/OAuth server, admin and manufacturing apps, seed job) cannot pull their images and never start. |
| Storage Blob Data Owner, Queue Data Contributor, Table Data Contributor, File Data Privileged Reader | Runtime identity | Storage account | Azure Functions cannot start (its host storage uses identity-based access), and queues, tables, receipts, translations and seed-status reads fail. |
| Storage File Data SMB MI Admin | Runtime identity | Storage account | The seed job cannot mount its log share, so the database load cannot run or report status. |
| Key Vault Secrets User | Runtime identity | Key Vault | The OAuth server cannot read its token-signing certificate, so **no user can sign in** to any app or API. |
| Key Vault Certificates Officer | Deployer | Key Vault | The deployment hook cannot create the signing certificate; provisioning stops. |
| Cognitive Services OpenAI User, Azure AI Developer, Cognitive Services Data Contributor (Preview) | Runtime identity | Foundry account / project | All AI features (chat, agents, recommendations, generated reviews, shopping simulator) fail with 401/403. |
| Web PubSub Service Owner | Runtime identity | Web PubSub resource | Real-time updates cannot be negotiated or sent; the apps show "live updates unavailable". |
| Communication and Email Service Owner | Runtime identity | Communication Services resource | Email (receipts, password reset) cannot be sent. |
| Reader | Runtime identity | Application Insights | Health and telemetry diagnostics cannot read monitoring data. |
| Storage data roles, Reader, Azure AI Developer, Cognitive Services OpenAI Contributor, Cognitive Services Data Contributor (Preview) | Deployer (user) | Individual resources | The deployer cannot use local developer tools against storage, monitoring or AI. If the post-provision hook cannot grant the Foundry project roles, Foundry agents are not created. |

Setting `SKIP_LOCAL_DEV_ROLE_ASSIGNMENTS=true` in the azd environment removes
the deployer-targeted grants from the Bicep templates only. The deployment
hooks still create the grants they need to finish (Key Vault certificates and
Foundry project roles), and managed-identity grants are always required, so the
role-assignment permission is still needed.

The Aspire Dashboard does not require an extra role assignment when the deployer
already has Contributor on the subscription. The post-provision hook checks the
deployer's effective `Microsoft.App/managedEnvironments/write` permission at
the environment, including inherited access. If that optional check cannot
confirm access, it warns and continues; it does not grant Contributor or block
deployment.

## Why this role, and not Owner or User Access Administrator

| Option | Assessment |
| --- | --- |
| Owner | Grants full control, including assigning any role to anyone. Not required. |
| User Access Administrator | Can create role assignments for any role, including Owner, and also manage role definitions. Not required. |
| Role Based Access Control Administrator (built-in, `f58310d9-a9f6-439a-9e8d-f62e7b41a168`) | Equivalent assignment permissions to the custom role. Acceptable **with the same condition** if you prefer not to create a custom role. |
| Custom role in [azd-deployer-role.json](../infra/azd-deployer-role.json) | Only role-assignment write and delete. Recommended **with the condition**. |

The templates intentionally do **not** create custom role definitions, so
`roleDefinitions/write` is not needed. Granting it would let the holder define
an Owner-equivalent role, which the condition below cannot prevent.

## Residual risk the administrator should understand

The condition restricts *which roles* can be assigned or removed. It does
**not** restrict *who* receives them or *where* within the subscription.
Within the subscription, the deployer could therefore:

- Grant any allowlisted role to any user, group or service principal, including
  data-plane roles such as Storage Blob Data Owner on other storage accounts.
- Remove allowlisted role assignments created by others.

The allowlist deliberately excludes Contributor as well as Owner, User Access
Administrator, Role Based Access Control Administrator, and any role not in the
list. The deployer cannot use this role to grant those general-purpose roles or
create or modify role definitions. Use a dedicated sandbox or demo subscription
if the remaining role-assignment risk is unacceptable in a shared subscription.

The deployment assumes a fresh demo environment. If one already exists, the
user must run `azd down` before `azd up` to recreate it. Teardown permanently
deletes that environment and its data.

## How to grant it

Run as a user who can create custom roles and conditional role assignments
(for example, Owner or User Access Administrator) from the repository root.
Requires Azure CLI and `jq`.

```bash
set +H  # avoid bash history expansion of "!" in the condition
SUB="<target-subscription-id>"
DEPLOYER_OID="<deployer-object-id>"
ROLE_NAME="AdventureWorks Demo azd Deployer"

# 1. Create the custom role for the target subscription.
jq --arg s "/subscriptions/$SUB" '.AssignableScopes = [$s]' \
  infra/azd-deployer-role.json > /tmp/azd-deployer-role.json
az role definition create --role-definition /tmp/azd-deployer-role.json

# 2. Build the condition from the allowlist.
ROLE_IDS=$(jq -r '[.roleDefinitionIds[]] | join(", ")' infra/azd-role-assignment-allowlist.json)
CONDITION="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLE_IDS})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLE_IDS}))"

# 3. Assign it with the condition (role propagation can take a few minutes).
az role assignment create \
  --assignee-object-id "$DEPLOYER_OID" --assignee-principal-type User \
  --role "$ROLE_NAME" --scope "/subscriptions/$SUB" \
  --condition "$CONDITION" --condition-version 2.0
rm /tmp/azd-deployer-role.json
```

### Without a copy of the repository

The same steps with everything written out, so they can be run without cloning
the repository or installing `jq`. Replace `<target-subscription-id>` (three
places in step 1, two in step 2) and `<deployer-object-id>`. The role IDs in the
condition are a copy of
[azd-role-assignment-allowlist.json](../infra/azd-role-assignment-allowlist.json);
if they differ, the JSON file is authoritative.

```bash
set +H  # avoid bash history expansion of "!" in the condition

# 1. Create the custom role for the target subscription.
az role definition create \
  --subscription "<target-subscription-id>" \
  --role-definition '{
  "Name": "AdventureWorks Demo azd Deployer",
  "IsCustom": true,
  "Description": "Manages AdventureWorks Demo role assignments for the demo AI App at [https://github.com/3cloud-sandbox/AdventureWorks](https://github.com/3cloud-sandbox/AdventureWorks)",
  "Actions": [
    "Microsoft.Authorization/roleAssignments/write",
    "Microsoft.Authorization/roleAssignments/delete"
  ],
  "NotActions": [],
  "DataActions": [],
  "NotDataActions": [],
  "AssignableScopes": [
    "/subscriptions/<target-subscription-id>"
  ]
}'

# Confirm the role exists (it can take a few minutes to appear).
az role definition list --name "AdventureWorks Demo azd Deployer" \
  --scope "/subscriptions/<target-subscription-id>" -o table

# 2. Assign it with the allowlist condition.
az role assignment create \
  --subscription "<target-subscription-id>" \
  --assignee-object-id "<deployer-object-id>" \
  --assignee-principal-type User \
  --role "AdventureWorks Demo azd Deployer" \
  --scope "/subscriptions/<target-subscription-id>" \
  --condition-version 2.0 \
  --condition "((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {09976791-48a7-449e-bb21-39d1a415f350, 0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3, 0c867c2a-1d8c-454a-a3db-ab2ea1bdc8bb, 12cf5a90-567b-43ae-8102-96cf46c7d9b4, 19c28022-e58e-450d-a464-0b2a53034789, 4633458b-17de-408a-b874-0445c86b69e6, 5e0bd9bd-7b93-4f28-af87-19fc36ad61bd, 64702f94-c441-49e6-a78b-ef80e0188fee, 7f951dda-4ed3-4680-a7ca-43fe172d538d, 974c5e8b-45b9-4653-ba55-5f855dd0fb88, a001fd3d-188f-4b5d-821b-7da978bf7442, a235d3ee-5935-4cfb-8cc5-a3303ad5995e, a4417e6f-fecd-4de8-b567-7b0420556985, acdd72a7-3385-48ef-bd42-f606fba81ae7, b7e6dc6d-f1e8-4753-8033-0f276bb0955b, b8eda974-7b85-4f76-af95-65846b26df6d, ba92f5b4-2d11-453d-a403-e96b0029c9fe})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {09976791-48a7-449e-bb21-39d1a415f350, 0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3, 0c867c2a-1d8c-454a-a3db-ab2ea1bdc8bb, 12cf5a90-567b-43ae-8102-96cf46c7d9b4, 19c28022-e58e-450d-a464-0b2a53034789, 4633458b-17de-408a-b874-0445c86b69e6, 5e0bd9bd-7b93-4f28-af87-19fc36ad61bd, 64702f94-c441-49e6-a78b-ef80e0188fee, 7f951dda-4ed3-4680-a7ca-43fe172d538d, 974c5e8b-45b9-4653-ba55-5f855dd0fb88, a001fd3d-188f-4b5d-821b-7da978bf7442, a235d3ee-5935-4cfb-8cc5-a3303ad5995e, a4417e6f-fecd-4de8-b567-7b0420556985, acdd72a7-3385-48ef-bd42-f606fba81ae7, b7e6dc6d-f1e8-4753-8033-0f276bb0955b, b8eda974-7b85-4f76-af95-65846b26df6d, ba92f5b4-2d11-453d-a403-e96b0029c9fe}))"
```

Custom role names are unique per tenant. If the role already exists for another
subscription, add this subscription to its `AssignableScopes` with
`az role definition update` instead of creating it again. To use the built-in
Role Based Access Control Administrator instead, skip step 1 and pass
`--role f58310d9-a9f6-439a-9e8d-f62e7b41a168` in step 3.

The allowlist must be reviewed whenever the demo adds a new role assignment.
See [Azure role assignments and deployer limits](../infra/README.md#azure-role-assignments-and-deployer-limits)
for the technical details of the condition.

## Deploying with a service principal (GitHub Actions)

The optional GitHub Actions path signs in with an Entra app registration's
service principal and a GitHub OIDC federated credential. It requires Contributor
and condition-restricted Role Based Access Control Administrator (or the custom
role above) on the target subscription. The condition also limits role
assignments to service principals.

The workflow sets `DEPLOYER_PRINCIPAL_TYPE=ServicePrincipal`; local `azd up`
continues to default to `User`. See the [workflow instructions](../.github/workflows/README.md#azd-up-service-principalyml)
for the Owner-run setup commands, GitHub Environment protections, and the
Microsoft Graph self-check performed before deployment.

### Authorizing this repository to use an existing service principal

Use this when an app registration and service principal already hold the
permissions above on the target subscription, and only the repository
containing the demo (for example, a new fork) needs to use it. Do not create
another app registration, service principal or role assignment. Add one
**federated identity credential** that trusts the repository's
`adventureworks-demo` GitHub Environment. This is the GitHub Actions
deployment environment (for approvals and branch restrictions), not the
separately generated azd environment name or Azure resource-group name.

**Who can run it.** Adding a federated credential changes the app
registration, so subscription Owner alone is not enough. Use an owner of the
app registration, or an Entra Application Administrator or Cloud Application
Administrator. The role checks below also need read access to the
subscription's role assignments, which Owner and Reader provide.

**Before you start.**

- Get the existing app's **application (client) ID**, the target subscription
  and tenant IDs, and the repository's exact OIDC subject. The subject format
  depends on the repository; see
  [Choose the exact GitHub OIDC subject](../.github/workflows/README.md#one-time-azure-and-github-setup).
- Choose a federated credential name that is unique within the app, for
  example `github-<owner>-<repo>-adventureworks-demo`. Use letters, numbers
  and hyphens. The name cannot be changed later.
- An app registration can have at most 20 federated credentials.

**Example.** To authorize the repository
`https://github.com/username/adventureworks`, take the owner (`username`) and
repository name (`adventureworks`) from the URL, then set:

```bash
# Name-based subject (GitHub's default for older repositories):
OIDC_SUBJECT="repo:username/adventureworks:environment:adventureworks-demo"
CREDENTIAL_NAME="github-username-adventureworks-adventureworks-demo"
```

If the repository uses immutable subjects, include the numeric owner and
repository IDs instead. Look them up with the GitHub CLI:

```bash
gh api repos/username/adventureworks --jq '"owner id: \(.owner.id), repo id: \(.id)"'
# owner id: 1234567, repo id: 890123456
OIDC_SUBJECT="repo:username@1234567/adventureworks@890123456:environment:adventureworks-demo"
```

The subject must match the one GitHub issues exactly. A mismatch makes the
workflow's Azure sign-in fail with `AADSTS700213` (no matching federated
identity record).

Run the following from the root of a checkout of this repository, in Bash,
with the Azure CLI and `jq`, after `az login --tenant <tenant-id>`. The
checks stop without making changes if the principal is not an application
service principal, its conditional role does not cover the current
[role allowlist](../infra/azd-role-assignment-allowlist.json), or the subject
is already trusted.

```bash
set -euo pipefail
SUBSCRIPTION_ID="<target-subscription-id>"
TENANT_ID="<target-tenant-id>"
CLIENT_ID="<existing-app-client-id>"
OIDC_SUBJECT="<exact-subject-for-the-repo-and-adventureworks-demo-environment>"
CREDENTIAL_NAME="<unique-name-such-as-github-owner-repo-adventureworks-demo>"

for value in "$OIDC_SUBJECT" "$CREDENTIAL_NAME"; do
  if [[ -z "$value" || "$value" == *"<"* || "$value" == *">"* ]]; then
    echo "Replace every placeholder before running." >&2
    exit 1
  fi
done
az account set --subscription "$SUBSCRIPTION_ID"
if [[ "$(az account show --query tenantId --output tsv)" != "$TENANT_ID" ]]; then
  echo "The target subscription is not in the specified tenant." >&2
  exit 1
fi

# 1. Confirm the identity is an app registration's service principal.
PRINCIPAL_ID=$(az ad sp show --id "$CLIENT_ID" --query id --output tsv)
SP_TYPE=$(az ad sp show --id "$CLIENT_ID" --query servicePrincipalType --output tsv)
if [[ "$SP_TYPE" != "Application" ]]; then
  echo "The workflow supports only an app registration's service principal (found: $SP_TYPE)." >&2
  exit 1
fi

# 2. Confirm the existing subscription-scope grants.
ASSIGNMENTS=$(az role assignment list --assignee "$PRINCIPAL_ID" \
  --scope "/subscriptions/$SUBSCRIPTION_ID" --output json)
jq -r '.[] | [.roleDefinitionName, .scope, (if .condition then "conditional" else "unconditional" end)] | @tsv' <<< "$ASSIGNMENTS"
if ! jq -e --arg scope "/subscriptions/$SUBSCRIPTION_ID" \
  'any(.[]; .roleDefinitionName == "Contributor" and (.scope | ascii_downcase) == ($scope | ascii_downcase))' \
  <<< "$ASSIGNMENTS" >/dev/null; then
  echo "Contributor on the target subscription is missing." >&2
  exit 1
fi
if ! jq -e --slurpfile allow infra/azd-role-assignment-allowlist.json \
  'any(.[]; (.condition // "") as $c | $c != "" and
       ($c | contains("ServicePrincipal")) and
       all($allow[0].roleDefinitionIds[]; . as $id | $c | ascii_downcase | contains($id | ascii_downcase)))' \
  <<< "$ASSIGNMENTS" >/dev/null; then
  echo "No conditional role-assignment grant covers the current allowlist; update it as described above." >&2
  exit 1
fi

# 3. Trust the repository's adventureworks-demo environment, unless already trusted.
if [[ -n "$(az ad app federated-credential list --id "$CLIENT_ID" \
  --query "[?subject=='$OIDC_SUBJECT'].name" --output tsv)" ]]; then
  echo "This subject is already trusted; no credential was added."
else
  FIC_JSON=$(jq -n --arg name "$CREDENTIAL_NAME" --arg subject "$OIDC_SUBJECT" '{
    name: $name,
    issuer: "https://token.actions.githubusercontent.com",
    subject: $subject,
    audiences: ["api://AzureADTokenExchange"]
  }')
  az ad app federated-credential create --id "$CLIENT_ID" \
    --parameters "$FIC_JSON" --output none
fi

printf 'DEPLOYER_CLIENT_ID=%s\nDEPLOYER_OBJECT_ID=%s\nDEPLOYER_TENANT_ID=%s\nDEPLOYER_SUBSCRIPTION_ID=%s\n' \
  "$CLIENT_ID" "$PRINCIPAL_ID" "$TENANT_ID" "$SUBSCRIPTION_ID"
```

The role check reports only the subscription-scope assignments it can see; it
does not check inherited management-group roles. Review the listed roles: an
unconditional Owner, User Access Administrator, or Role Based Access Control
Administrator grant to the same principal bypasses the allowlist condition.

**Then, in the repository:**

1. Under **Settings > Environments**, create the `adventureworks-demo` environment.
   Restrict its deployment branches and, where available, require reviewers.
2. Add the four printed values as **environment variables** in `adventureworks-demo`,
   as described in [Configure GitHub](../.github/workflows/README.md#one-time-azure-and-github-setup).
   `DEPLOYER_OBJECT_ID` is the service principal's object ID, not the app
   registration's object ID.
3. Run the workflow as described in
   [Run the workflow](../.github/workflows/README.md#run-the-workflow).

**What this means for security.** Every repository with a trusted subject
can deploy to the subscription with the same permissions, so a workflow run in
any of them acts as this one deployer. Each repository's `adventureworks-demo` environment
protections therefore matter. To revoke a repository, delete only its credential:

```bash
az ad app federated-credential delete --id "$CLIENT_ID" \
  --federated-credential-id "$CREDENTIAL_NAME"
```
