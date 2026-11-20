# Deployer Permissions: Why Contributor Is Not Enough

This page is for **Azure subscription administrators** who have been asked to
grant someone the permissions needed to deploy the AdventureWorks demo with
`azd up`. It assumes no familiarity with the demo itself. For deployment from
GitHub Actions with a managed identity, see
[Deploying with a managed identity](#deploying-with-a-managed-identity-github-actions).

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

## Deploying with a managed identity (GitHub Actions)

Some subscriptions only allow deployment from a pipeline. For that optional
path, `azd up` runs in GitHub Actions, which signs in as an existing
**user-assigned managed identity** through a federated credential. No client
secret is involved.

The optional GitHub workflow sets `DEPLOYER_PRINCIPAL_TYPE=ServicePrincipal`.
The regular local `azd up` path defaults this setting to `User` and is
unchanged. See the [workflow instructions](../.github/workflows/README.md#azd-up-service-principalyml)
for configuring GitHub OIDC and running the deployment.

### Required permissions

The managed identity needs the **same two roles as a user**, on the target
subscription:

| Role | Scope | Notes |
| --- | --- | --- |
| Contributor | Target subscription | Creates the resource group and all resources. |
| Role Based Access Control Administrator (or the custom role above) | Target subscription | **With the allowlist condition.** Without the condition, this role can assign Owner to itself, which makes it equivalent to Owner. |

Nothing else is required. In particular, the identity does **not** need:

- Microsoft Graph API permissions, an Entra directory role such as Directory
  Readers, or permission to create app registrations. The deployment creates no
  Entra applications. Application sign-in is handled by the demo's own OAuth
  server.
- SQL administrator rights. SQL is private, and the seed job's own identity is
  its Entra administrator.
- Pre-granted data-plane roles. During deployment, the identity grants itself
  the allowlisted roles it needs on the resources it creates, such as
  Key Vault Certificates Officer and Azure AI Developer.
- Owner or User Access Administrator.

### Differences from granting a user

- Use the identity's **principal (object) ID**, not its client ID, and
  `--assignee-principal-type ServicePrincipal`.
- Every role assignment that this path creates targets a service principal:
  the deployer identity, the demo's runtime and seed identities, or Foundry's
  system-assigned identities. You can therefore add a principal-type
  restriction to the condition so that the identity cannot grant roles to users
  or groups. This is recommended.
- The identity must also have a federated identity credential that trusts the
  GitHub repository and environment. Creating it requires permission to manage
  the identity itself, for example Managed Identity Contributor on the
  identity's resource group.

### Granting the managed identity
role assignments. Requires Azure CLI and `jq`.

```bash
set +H  # avoid bash history expansion of "!" in the condition
SUB="<target-subscription-id>"
MI_SUB="<identity-subscription-id>"
MI_RG="<identity-resource-group>"
MI_NAME="<identity-name>"
GITHUB_REPO="<owner>/<repository>"
GITHUB_ENVIRONMENT="azure-demo"

DEPLOYER_OID=$(az identity show --name "$MI_NAME" --resource-group "$MI_RG" \
  --subscription "$MI_SUB" --query principalId -o tsv)

# 1. Contributor on the target subscription.
az role assignment create \
  --assignee-object-id "$DEPLOYER_OID" --assignee-principal-type ServicePrincipal \
  --role Contributor --scope "/subscriptions/$SUB"

# 2. Role Based Access Control Administrator, limited to the allowlisted roles
#    and to service-principal assignees.
ROLE_IDS=$(jq -r '[.roleDefinitionIds[]] | join(", ")' infra/azd-role-assignment-allowlist.json)
CONDITION="((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLE_IDS} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {$ROLE_IDS} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'}))"
az role assignment create \
  --assignee-object-id "$DEPLOYER_OID" --assignee-principal-type ServicePrincipal \
  --role f58310d9-a9f6-439a-9e8d-f62e7b41a168 --scope "/subscriptions/$SUB" \
  --condition "$CONDITION" --condition-version 2.0

# 3. Trust GitHub Actions runs that use the named GitHub Environment.
az identity federated-credential create \
  --name "github-${GITHUB_ENVIRONMENT}" \
  --identity-name "$MI_NAME" --resource-group "$MI_RG" --subscription "$MI_SUB" \
  --issuer "https://token.actions.githubusercontent.com" \
  --subject "repo:${GITHUB_REPO}:environment:${GITHUB_ENVIRONMENT}" \
  --audiences "api://AzureADTokenExchange"
```

To use the custom role instead, pass `--role "AdventureWorks Demo azd Deployer"`
in step 2, after creating that role as shown [above](#how-to-grant-it).

### Additional risk with a managed identity

On top of the [residual risk](#residual-risk-the-administrator-should-understand)
that applies to any deployer:

- **Anyone who can run the workflow acts as this identity.** That includes
  anyone who can change the workflow on an allowed branch. Protect the GitHub
  Environment with allowed branches and, where available, required reviewers.
- **Contributor can change managed identities, including their federated
  credentials.** If the deploying identity is in the target subscription, it
  can add federated credentials to itself or to other managed identities there.
  Keep the deploying identity in a different subscription where it has no
  roles. A separate resource group in the target subscription does not help,
  because Contributor covers every resource group there. A managed identity can
  hold roles in another subscription in the same tenant.
- **Keep the identity out of the demo's resource group.** Teardown deletes that
  resource group and everything in it.
