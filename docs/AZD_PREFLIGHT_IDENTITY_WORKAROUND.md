# Workaround: azd 1.23.9 preflight validation error with user-assigned identity

## Error

When running `azd up` or `azd provision` with azd **1.23.9** you may see:

```text
ERROR: deployment failed: error deploying infrastructure: local preflight validation failed: parsing bicep snapshot: json: cannot unmarshal string into Go struct field armTemplateIdentity.predictedResources.identity.userAssignedIdentities of type map[string]bicep.armTemplateIdentityRef
```

## Cause

azd **1.23.9** (released 2026-03-13) added **local preflight validation** ([PR #7053](https://github.com/Azure/azure-dev/pull/7053)) that runs before Bicep deployment. It runs `bicep snapshot` and parses the result. The parser expects `identity.userAssignedIdentities` to be a JSON object (map) but the snapshot can emit it in a form that parses as a string, which triggers the Go unmarshal error.

This is a bug in azd’s handling of the Bicep snapshot output when templates use user-assigned managed identities (e.g. Container Apps, AI Foundry, Static Web App).

## Workaround: use azd 1.23.8

Use a version of azd **before** the preflight feature (e.g. **1.23.8**) so provision/deploy runs without the new validation.

### Linux (WSL / amd64)

The tarball extracts to a **file** named `azd-linux-amd64` (the binary), not a folder. Download and replace the `azd` binary with 1.23.8:

```bash
# Backup current azd (if needed)
sudo cp /usr/local/bin/azd /usr/local/bin/azd.1.23.9.bak

# Download azd 1.23.8 (Linux amd64)
curl -sL -o /tmp/azd-1.23.8.tar.gz \
  https://github.com/Azure/azure-dev/releases/download/azure-dev-cli_1.23.8/azd-linux-amd64.tar.gz
tar -xzf /tmp/azd-1.23.8.tar.gz -C /tmp

# The binary is /tmp/azd-linux-amd64 (no subfolder)
sudo mv /tmp/azd-linux-amd64 /usr/local/bin/azd
```

### macOS / other

Download the **1.23.8** asset for your platform from [azure-dev-cli_1.23.8](https://github.com/Azure/azure-dev/releases/tag/azure-dev-cli_1.23.8) and replace your `azd` binary (e.g. put it in `/usr/local/bin` or wherever your current `azd` lives).

### Verify

```bash
azd version
# Should show 1.23.8 (or another pre-1.23.9 version)
```

Then run `azd up` or `azd provision` as usual.

## Reporting the bug

If you want this fixed in azd:

1. Open an issue at [Azure/azure-dev issues](https://github.com/Azure/azure-dev/issues).
2. Include:
   - The exact error message above
   - `azd version` (e.g. 1.23.9)
   - That you use Bicep with user-assigned managed identities (Container Apps, AI services, etc.)
   - That the failure happens during “parsing bicep snapshot” in local preflight validation

## Infra change in this repo

The **identity** module in `infra/modules/identity.bicep` was changed from the Azure Verified Module (AVM) `avm/res/managed-identity/user-assigned-identity` to a direct `Microsoft.ManagedIdentity/userAssignedIdentities` resource. That change does **not** fix this azd bug (the error comes from how azd parses the snapshot, not from the identity module itself). The direct resource is still an improvement (simpler, no nested AVM template). The workaround above is what unblocks `azd up` / `azd provision` until azd fixes the parser.
