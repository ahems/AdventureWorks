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
authenticates with GitHub OIDC as an existing user-assigned managed identity;
it does not add a second provisioning or deployment implementation. Local
`azd up` remains the primary path.

The workflow runs only on `workflow_dispatch`, waits for the exact seed
execution it started, checks Functions/MCP readiness, confirms SQL and Key
Vault temporary network access was cleaned up, and writes the deployed URLs
and status to the run summary. It never uploads Azure credential caches or
prints all azd environment values.

### One-time Azure and GitHub setup

1. Use an existing **user-assigned managed identity** kept outside the demo
   subscription. Configure a federated identity credential with:
   - Issuer: `https://token.actions.githubusercontent.com`
   - Audience: `api://AzureADTokenExchange`
   - Subject: `repo:<owner>/<repository>:environment:azure-demo`
2. Grant that identity **Contributor** and **Role Based Access Control
   Administrator** on the target subscription. The RBAC Administrator
   assignment must use the allowlist condition and recommended
   `PrincipalType = ServicePrincipal` restriction described in
   [Deployer Permissions](../../docs/AZD_DEPLOYER_PERMISSIONS.md#deploying-with-a-managed-identity-github-actions).
   Do not grant unconditioned RBAC Administrator, Owner, or User Access
   Administrator.
3. Create a GitHub Environment named `azure-demo`, restrict its allowed
   deployment branches, and require reviewers where available.
4. Add these **environment variables** to `azure-demo` (they are identifiers,
   not credentials):

   | Variable | Value |
   | --- | --- |
   | `DEPLOYER_CLIENT_ID` | Managed identity client ID |
   | `DEPLOYER_OBJECT_ID` | Managed identity principal/object ID (not the client ID) |
   | `DEPLOYER_TENANT_ID` | Entra tenant ID |
   | `DEPLOYER_SUBSCRIPTION_ID` | Target subscription ID |

No client secret, Microsoft Graph permission, Entra directory role, SQL
administrator access, or pre-granted application data role is required.
`preup.sh` discovers Azure resource/model information; it does not create
Entra app registrations. The deployer creates the narrowly scoped application
role assignments during normal provisioning and hooks. See the permissions
document for the remaining role-assignment risk and complete setup commands.

### Run the workflow

1. In the fork, open **Actions** and select **Deploy demo with managed identity
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
