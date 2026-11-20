# GitHub Actions Workflow for Service Principal Deployment

The optional manually triggered workflow uses a GitHub OIDC-federated Entra
app registration's service principal to run the existing `azd up` lifecycle.
Local `azd up` remains the primary deployment path.

See the [workflow instructions](workflows/README.md#azd-up-service-principalyml)
for the Owner-run setup commands, required permissions, GitHub Environment
variables, deployment inputs, and verification and cleanup guidance.
