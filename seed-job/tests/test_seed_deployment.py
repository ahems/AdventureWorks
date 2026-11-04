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

    def run_hook(self, status="Succeeded", scenario="normal", timeout="2400"):
        script = r'''
source "$1"
MOCK_STATUS="$2"
SCENARIO="$3"
export SEED_JOB_WAIT_TIMEOUT_SECONDS="$4"
az() {
    printf 'MOCK_AZ: %s\n' "$*" >&2
    case "$*" in
        "containerapp job start "*)
            [[ "$SCENARIO" != start-failure ]] || return 1
            [[ "$SCENARIO" != missing-name ]] || return 0
            printf 'seed-exact-123\r\n'
            ;;
        "containerapp job execution show "*)
            [[ "$SCENARIO" != observe-failure ]] || return 1
            printf '%s\n' "$MOCK_STATUS"
            ;;
        *) return 99 ;;
    esac
}
sleep() {
    if [[ "$SCENARIO" == timeout ]]; then
        SECONDS=$((SECONDS + 2401))
    else
        MOCK_STATUS=Succeeded
    fi
}
start_and_wait_for_seed_job seed-job test-rg
'''
        return subprocess.run(
            ["bash", "-c", script, "test-seed-hook", str(HELPER), status, scenario, timeout],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_waits_for_exact_execution_not_latest_job(self):
        result = self.run_hook("Running")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("seed-exact-123 succeeded", result.stdout)
        self.assertEqual(result.stderr.count("containerapp job execution show"), 2)
        self.assertIn("--job-execution-name seed-exact-123", result.stderr)
        self.assertIn("--query properties.status --output tsv", result.stderr)

    def test_immediate_success(self):
        self.assertEqual(self.run_hook().returncode, 0)

    def test_terminal_failure_statuses_are_not_success(self):
        for status in ("Failed", "Stopped", "Canceled", "Cancelled", "Degraded", "Surprise"):
            with self.subTest(status=status):
                result = self.run_hook(status)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ERROR:", result.stderr)

    def test_start_observation_and_timeout_failures(self):
        for scenario in ("start-failure", "missing-name", "observe-failure", "timeout"):
            with self.subTest(scenario=scenario):
                result = self.run_hook("Running", scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ERROR:", result.stderr)
                self.assertNotIn("succeeded", result.stdout)

    def test_invalid_timeout_never_starts_job(self):
        for timeout in ("0", "-1", "abc"):
            with self.subTest(timeout=timeout):
                result = self.run_hook(timeout=timeout)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("MOCK_AZ:", result.stderr)

    def test_actual_lifecycle_and_build_wiring(self):
        azure_yaml = (ROOT / "azure.yaml").read_text()
        hook = (ROOT / "scripts/hooks/postprovision.sh").read_text()
        dockerfile = (ROOT / "seed-job/dockerfile").read_text()
        self.assertIn("run: bash scripts/hooks/postprovision.sh", azure_yaml)
        self.assertIn('--set-env-vars SEED_SKIP_EXISTING=true', hook)
        self.assertIn('source "$(dirname "${BASH_SOURCE[0]}")/seed-job-execution.sh"', hook)
        self.assertIn('if ! start_and_wait_for_seed_job "$SEED_JOB_NAME" "$RESOURCE_GROUP"; then\n    exit 1', hook)
        self.assertLess(hook.index("az acr build"), hook.index("start_and_wait_for_seed_job"))
        self.assertIn("COPY ManufacturingOverlays.psm1 /app/ManufacturingOverlays.psm1", dockerfile)
        self.assertIn("COPY sql/ /app/sql/", dockerfile)

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

    def test_asset_validation_precedes_builds_and_azure_mutations(self):
        validator = "python3 scripts/data-management/validate-manufacturing-assets.py"
        preup = (ROOT / "scripts/hooks/preup.sh").read_text()
        predeploy = (ROOT / "scripts/hooks/predeploy.sh").read_text()
        provision = (ROOT / "scripts/hooks/postprovision.sh").read_text()
        self.assertLess(preup.index(validator), preup.index("get_azd_value()"))
        self.assertLess(predeploy.index(validator), predeploy.index("azd env get-value"))
        self.assertLess(provision.index("git lfs pull"), provision.index(validator))
        self.assertLess(provision.index(validator), provision.index("az acr build"))

    def test_invalid_assets_abort_actual_early_hooks_without_azure_calls(self):
        for hook in ("preup.sh", "predeploy.sh"):
            with self.subTest(hook=hook):
                script = r'''
python3() { printf 'MOCK_VALIDATOR: %s\n' "$*" >&2; return 73; }
az() { printf 'UNEXPECTED_AZURE_CALL\n' >&2; return 99; }
azd() { printf 'UNEXPECTED_AZURE_CALL\n' >&2; return 99; }
export -f python3 az azd
bash "$1"
'''
                result = subprocess.run(
                    ["bash", "-c", script, "test-asset-gate", str(ROOT / "scripts/hooks" / hook)],
                    cwd=ROOT, capture_output=True, text=True, check=False,
                )
                self.assertEqual(result.returncode, 73, result.stderr)
                self.assertIn("MOCK_VALIDATOR: scripts/data-management/validate-manufacturing-assets.py", result.stderr)
                self.assertNotIn("UNEXPECTED_AZURE_CALL", result.stderr)

    def test_partial_bootstrap_override_is_command_scoped_to_predeploy(self):
        for hook in ("preup.sh", "predeploy.sh"):
            with self.subTest(hook=hook):
                script = r'''
python3() { printf 'MOCK_VALIDATOR: %s\n' "$*" >&2; return 73; }
az() { printf 'UNEXPECTED_AZURE_CALL\n' >&2; return 99; }
azd() { printf 'UNEXPECTED_AZURE_CALL\n' >&2; return 99; }
export -f python3 az azd
export MANUFACTURING_CONTENT_ALLOW_PARTIAL=true
bash "$1"
'''
                result = subprocess.run(
                    ["bash", "-c", script, "test-partial-gate", str(ROOT / "scripts/hooks" / hook)],
                    cwd=ROOT, capture_output=True, text=True, check=False,
                )
                self.assertEqual(result.returncode, 73, result.stderr)
                self.assertNotIn("UNEXPECTED_AZURE_CALL", result.stderr)
                if hook == "predeploy.sh":
                    self.assertIn("--allow-partial", result.stderr)
                    self.assertIn("WARNING:", result.stderr)
                else:
                    self.assertNotIn("--allow-partial", result.stderr)
                    self.assertNotIn("WARNING:", result.stderr)
        provision = (ROOT / "scripts/hooks/postprovision.sh").read_text()
        self.assertNotIn("MANUFACTURING_CONTENT_ALLOW_PARTIAL", provision)
        self.assertNotIn("--allow-partial", provision)


if __name__ == "__main__":
    unittest.main()
