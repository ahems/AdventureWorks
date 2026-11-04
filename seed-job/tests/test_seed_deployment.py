"""Offline tests for the actual azd seed hook; all Azure CLI calls are shell mocks."""

import pathlib
import subprocess
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/hooks/seed-job-execution.sh"


class SeedExecutionTests(unittest.TestCase):
    def run_sql_setup(self, network="Disabled", query_failure=False):
        hook = (ROOT / "scripts/hooks/postprovision.sh").read_text()
        start = hook.index("# Get required values\nSQL_SERVER_NAME=")
        end = hook.index('echo "Preparing the database seed job..."', start)
        script = r'''
set -e
RESOURCE_GROUP=test-rg
MOCK_NETWORK="$1"
MOCK_QUERY_FAILURE="$2"
azd() { printf 'configured-value\n'; }
az() {
    printf 'MOCK_AZ: %s\n' "$*" >&2
    case "$*" in
        "sql server show "*)
            [[ "$MOCK_QUERY_FAILURE" != true ]] || return 1
            printf '%s\r\n' "$MOCK_NETWORK"
            ;;
        *) printf 'UNEXPECTED_MUTATION\n' >&2; return 91 ;;
    esac
}
curl() { printf 'UNEXPECTED_IP_DISCOVERY\n' >&2; return 92; }
pwsh() { printf 'UNEXPECTED_HOST_SQL\n' >&2; return 93; }
''' + hook[start:end]
        return subprocess.run(
            ["bash", "-c", script, "test-sql-setup", network, str(query_failure).lower()],
            capture_output=True, text=True, check=False,
        )

    def test_private_sql_skips_all_public_and_host_sql_setup(self):
        result = self.run_sql_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("preserving private-only networking", result.stdout)
        self.assertIn("existing managed-identity database permissions", result.stdout)
        self.assertNotIn("UNEXPECTED_", result.stderr)
        self.assertEqual(result.stderr.count("MOCK_AZ:"), 1)

    def test_unknown_sql_network_state_fails_closed(self):
        for network, failed in (("", False), ("Surprise", False), ("Disabled", True)):
            with self.subTest(network=network, failed=failed):
                result = self.run_sql_setup(network, failed)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ERROR:", result.stderr)
                self.assertNotIn("UNEXPECTED_", result.stderr)

    def test_public_sql_retains_existing_host_setup(self):
        result = self.run_sql_setup("Enabled")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("UNEXPECTED_IP_DISCOVERY", result.stderr)
        self.assertNotIn("preserving private-only networking", result.stdout)

    def run_hook(self, scenario="normal"):
        script = r'''
source "$1"
SCENARIO="$2"
az() {
    printf 'MOCK_AZ: %s\n' "$*" >&2
    case "$*" in
        "containerapp job start "*)
            [[ "$SCENARIO" != start-failure ]] || return 1
            case "$SCENARIO" in
                missing-name) return 0 ;;
                null-name) printf 'null\n' ;;
                none-name) printf 'None\n' ;;
                *) printf 'seed-exact-123\r\n' ;;
            esac
            ;;
        *) return 99 ;;
    esac
}
sleep() { printf 'UNEXPECTED_WAIT\n' >&2; return 98; }
start_seed_job seed-job test-rg
'''
        return subprocess.run(
            ["bash", "-c", script, "test-seed-hook", str(HELPER), scenario],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_starts_exact_execution_without_waiting_or_polling(self):
        result = self.run_hook()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Started seed-job execution seed-exact-123", result.stdout)
        self.assertIn("without waiting for completion", result.stdout)
        self.assertIn("Database readiness is separate", result.stdout)
        self.assertEqual(result.stderr.count("MOCK_AZ:"), 1)
        self.assertIn("--query name --output tsv", result.stderr)
        self.assertNotIn("execution show", result.stderr)
        self.assertNotIn("UNEXPECTED_WAIT", result.stderr)
        self.assertNotIn("succeeded", result.stdout)

    def test_start_failure_or_missing_execution_fails_hook(self):
        for scenario in ("start-failure", "missing-name", "null-name", "none-name"):
            with self.subTest(scenario=scenario):
                result = self.run_hook(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ERROR:", result.stderr)
                self.assertNotIn("Started seed-job", result.stdout)

    def test_actual_lifecycle_and_build_wiring(self):
        azure_yaml = (ROOT / "azure.yaml").read_text()
        hook = (ROOT / "scripts/hooks/postprovision.sh").read_text()
        dockerfile = (ROOT / "seed-job/dockerfile").read_text()
        self.assertIn("run: bash scripts/hooks/postprovision.sh", azure_yaml)
        self.assertIn('--set-env-vars SEED_SKIP_EXISTING=true', hook)
        self.assertIn('source "$(dirname "${BASH_SOURCE[0]}")/seed-job-execution.sh"', hook)
        self.assertIn('if ! start_seed_job "$SEED_JOB_NAME" "$RESOURCE_GROUP"; then\n    exit 1', hook)
        self.assertLess(hook.index("az acr build"), hook.index("start_seed_job"))
        self.assertIn("COPY ManufacturingOverlays.psm1 /app/ManufacturingOverlays.psm1", dockerfile)
        self.assertIn("COPY sql/ /app/sql/", dockerfile)

    def test_final_status_does_not_claim_seed_completion(self):
        hook = (ROOT / "scripts/hooks/postup.sh").read_text()
        self.assertIn("Seeding runs independently and may still be in progress", hook)
        self.assertNotIn("were verified before service deployment", hook)

    def test_fresh_private_sql_bootstraps_with_existing_seed_identity(self):
        database = (ROOT / "infra/modules/database.bicep").read_text()
        seed_job = (ROOT / "infra/modules/aca-seed-job.bicep").read_text()
        main = (ROOT / "infra/main.bicep").read_text()
        seed = (ROOT / "seed-job/seed-database.ps1").read_text()
        self.assertIn("publicNetworkAccess: 'Disabled'", database)
        self.assertIn("login: seedIdentity.name", database)
        self.assertIn("sid: seedIdentity.properties.principalId", database)
        self.assertIn("principalType: 'Application'", database)
        self.assertNotIn("sid: aadAdminObjectId", database)
        self.assertIn("value: seedIdentity.properties.clientId", seed_job)
        self.assertIn("'${seedIdentity.id}': {}", seed_job)
        self.assertNotIn("'${azidentity.id}': {}", seed_job)
        self.assertIn("value: azidentity.properties.clientId", seed_job)
        self.assertIn("name: 'RUNTIME_MANAGED_IDENTITY_CLIENT_ID'", seed_job)
        self.assertNotIn("name: 'RUNTIME_MANAGED_IDENTITY_PRINCIPAL_ID'", seed_job)
        self.assertIn("resource seedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities", main)
        self.assertIn("seedIdentityName: seedIdentity.name", main)
        self.assertIn("identity: seedIdentity.id", seed_job)
        self.assertIn("resource seedAcrPull", seed_job)
        self.assertIn("module database 'modules/database.bicep'", main)
        self.assertIn("module containerAppSeedJob 'modules/aca-seed-job.bicep'", main)
        self.assertIn('ALTER DATABASE [$sqlDatabaseName] SET CHANGE_TRACKING', seed)
        self.assertLess(seed.index("Initialize-RuntimeDatabaseAccess"), seed.index("Dropping ALL user objects"))

    def test_image_seed_uses_same_dedicated_sql_identity_not_blob_storage(self):
        seed = (ROOT / "seed-job/seed-database.ps1").read_text()
        self.assertIn("-ArgumentList $connectionString, $PSScriptRoot, $scriptStartTime, $azureClientId, $tenantId", seed)
        self.assertIn("Connect-AzAccount -Identity -AccountId $accountId -TenantId $tenantId", seed)
        self.assertIn("Get-AzAccessToken -ResourceUrl 'https://database.windows.net/'", seed)
        self.assertIn("INSERT INTO Production.ProductPhoto", seed)
        self.assertIn("@ThumbBytes, @ThumbFileName, @LargeBytes", seed)
        for absent in (
            "Set-AzStorageBlobContent", "New-AzStorageContext", "Get-AzStorageAccount",
            "BlobServiceClient", "https://storage.azure.com", "STORAGE_ACCOUNT_NAME",
        ):
            self.assertNotIn(absent, seed)

    def test_deployment_hooks_do_not_run_offline_manufacturing_validation(self):
        for path in (ROOT / "scripts/hooks").glob("*.sh"):
            with self.subTest(hook=path.name):
                hook = path.read_text()
                self.assertNotIn("validate-manufacturing-assets.py", hook)
                self.assertNotIn("MANUFACTURING_CONTENT_ALLOW_PARTIAL", hook)


if __name__ == "__main__":
    unittest.main()
