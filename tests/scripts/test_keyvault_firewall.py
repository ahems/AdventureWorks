import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HOOK = (ROOT / "scripts/hooks/postprovision.sh").read_text()
CERTIFICATE_SETUP = HOOK[
    HOOK.index('echo "Preparing the MCP OAuth signing certificate..."'):
    HOOK.index('echo "Configuring Azure SQL access..."')
]

MOCKS = r"""
set -e
RESOURCE_GROUP=demo-rg
azd() {
    case "$*" in
        *MCP_SIGNING_KEY_VAULT_NAME*) echo demo-vault ;;
        *MCP_SIGNING_CERTIFICATE_NAME*) echo mcp-signing ;;
        *AZURE_SUBSCRIPTION_ID*)
            if [ "$SCENARIO" != missing-subscription ]; then echo demo-subscription; fi ;;
        *) echo "Unexpected azd call: $*" >&2; return 90 ;;
    esac
}
curl() {
    echo curl >> "$CALL_LOG"
    [ "$SCENARIO" != discovery-failure ] || return 1
    echo 203.0.113.10
}
sleep() { :; }
mktemp() {
    local path
    path=$(command mktemp "$@")
    echo "$path" >> "$TEMP_LOG"
    echo "$path"
}
az() {
    echo "$*" >> "$CALL_LOG"
    case "$*" in
        "ad signed-in-user show "*) echo demo-user ;;
        "role assignment list "*) echo existing-role ;;
        "keyvault show "*)
            [ "$SCENARIO" != lookup-failure ] || return 1
            if [ "$SCENARIO" = existing-rule ]; then echo 203.0.113.10/32; fi
            ;;
        "keyvault network-rule add "*)
            [ "$SCENARIO" != add-failure ] || return 1
            ;;
        "keyvault network-rule remove "*)
            [ "$SCENARIO" != cleanup-failure ] || return 1
            ;;
        "keyvault certificate list "*)
            if [ "$SCENARIO" = list-failure ]; then
                echo "Certificate inventory unavailable" >&2
                return 1
            fi
            if [ "$SCENARIO" = list-transient ] && [ "$(grep -c '^keyvault certificate list ' "$CALL_LOG")" -lt 3 ]; then
                echo "Certificate inventory not yet available" >&2
                return 1
            fi
            case "$SCENARIO" in
                existing-certificate|existing-pending|list-transient)
                    echo '[{"id":"https://demo-vault.vault.azure.net/certificates/mcp-signing"}]' ;;
                many-certificates)
                    python3 -c 'import json; print(json.dumps([{"id": f"https://demo-vault.vault.azure.net/certificates/cert-{i}"} for i in range(30)] + [{"id": "https://demo-vault.vault.azure.net/certificates/MCP-SIGNING"}]))' ;;
                malformed-inventory)
                    echo '[{"id":"https://demo-vault.vault.azure.net/secrets/mcp-signing"}]' ;;
                *) echo '[]' ;;
            esac
            ;;
        "keyvault certificate show "*)
            [ "$SCENARIO" != readiness-failure ] || return 1
            if [ "$SCENARIO" = existing-pending ]; then
                [ "$(grep -c '^keyvault certificate show ' "$CALL_LOG")" -ge 3 ]
            fi
            ;;
        "keyvault certificate create "*)
            for arg in "$@"; do
                case "$arg" in
                    @*) echo "${arg#@}" >> "$TEMP_LOG"; test -f "${arg#@}" || return 91 ;;
                esac
            done
            if [ "$SCENARIO" = certificate-failure ]; then
                echo "Certificate creation denied" >&2
                return 1
            fi
            if [ "$SCENARIO" = interrupted ]; then
                kill -TERM "$BASHPID"
            fi
            ;;
        *) echo "Unexpected az call: $*" >&2; return 90 ;;
    esac
}
"""


class KeyVaultFirewallTests(unittest.TestCase):
    def run_setup(self, scenario="success", client_ip="", sql_client_ip=""):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "calls"
            temp_log = Path(directory) / "temp-files"
            env = {
                **os.environ,
                "CALL_LOG": str(log),
                "TEMP_LOG": str(temp_log),
                "SCENARIO": scenario,
                "KEY_VAULT_CLIENT_IP": client_ip,
                "SQL_CLIENT_IP": sql_client_ip,
            }
            result = subprocess.run(
                ["bash", "-c", MOCKS + CERTIFICATE_SETUP + '\necho "continued to SQL"\n'],
                env=env, text=True, capture_output=True, timeout=10,
            )
            calls = log.read_text() if log.exists() else ""
            if temp_log.exists():
                for path in temp_log.read_text().splitlines():
                    self.assertFalse(Path(path).exists(), f"Temporary policy left behind: {path}")
            return result, calls

    def test_temporary_rule_wraps_certificate_access_and_is_removed_before_sql(self):
        result, calls = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(calls.index("network-rule add"), calls.index("certificate list"))
        self.assertIn("--include-pending true", calls)
        self.assertLess(calls.index("certificate list"), calls.index("certificate create"))
        self.assertLess(calls.index("certificate create"), calls.index("certificate show"))
        self.assertLess(calls.index("certificate show"), calls.index("network-rule remove"))
        self.assertIn("--ip-address 203.0.113.10/32", calls)
        for line in calls.splitlines():
            if line.startswith(("keyvault ", "role assignment ")):
                self.assertIn("--subscription demo-subscription", line)
        self.assertIn("continued to SQL", result.stdout)
        self.assertLess(result.stdout.index("Removed temporary"), result.stdout.index("continued to SQL"))

    def test_existing_certificate_still_removes_temporary_rule(self):
        result, calls = self.run_setup("existing-certificate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("certificate create", calls)
        self.assertIn("network-rule remove", calls)

    def test_existing_client_rule_is_never_removed(self):
        result, calls = self.run_setup("existing-rule")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("network-rule add", calls)
        self.assertNotIn("network-rule remove", calls)
        self.assertIn("certificate create", calls)

    def test_certificate_failure_and_interruption_remove_rule_and_stop_hook(self):
        for scenario in ("certificate-failure", "interrupted"):
            with self.subTest(scenario=scenario):
                result, calls = self.run_setup(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("network-rule remove", calls)
                self.assertNotIn("continued to SQL", result.stdout)
                if scenario == "certificate-failure":
                    self.assertIn("Certificate creation denied", result.stderr)
                    self.assertEqual(calls.count("certificate create"), 1)

    def test_inventory_failure_or_malformed_result_never_creates_a_certificate(self):
        for scenario in ("list-failure", "malformed-inventory"):
            with self.subTest(scenario=scenario):
                result, calls = self.run_setup(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("certificate create", calls)
                self.assertIn("network-rule remove", calls)
                self.assertNotIn("continued to SQL", result.stdout)
                if scenario == "list-failure":
                    self.assertEqual(calls.count("certificate list"), 12)
                    self.assertIn("Certificate inventory unavailable", result.stderr)

    def test_transient_inventory_and_pending_certificate_never_rotate_an_existing_key(self):
        for scenario in ("list-transient", "existing-pending", "many-certificates"):
            with self.subTest(scenario=scenario):
                result, calls = self.run_setup(scenario)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("certificate create", calls)
                self.assertIn("network-rule remove", calls)
                self.assertEqual(calls.count("certificate list"), 3 if scenario == "list-transient" else 1)
                self.assertEqual(calls.count("certificate show"), 3 if scenario == "existing-pending" else 1)

    def test_unreadable_certificate_stops_without_another_create(self):
        result, calls = self.run_setup("readiness-failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls.count("certificate create"), 1)
        self.assertEqual(calls.count("certificate show"), 12)
        self.assertIn("no additional create was attempted", result.stderr)
        self.assertIn("network-rule remove", calls)
        self.assertNotIn("continued to SQL", result.stdout)

    def test_firewall_errors_stop_hook_and_attempt_cleanup_after_add_failure(self):
        for scenario in ("lookup-failure", "add-failure", "cleanup-failure"):
            with self.subTest(scenario=scenario):
                result, calls = self.run_setup(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("continued to SQL", result.stdout)
                if scenario == "lookup-failure":
                    self.assertNotIn("network-rule", calls)
                else:
                    self.assertIn("network-rule remove", calls)
                if scenario == "cleanup-failure":
                    self.assertIn("Could not remove", result.stderr)

    def test_ip_overrides_skip_discovery_and_invalid_ip_stops_before_firewall(self):
        for overrides in ({"client_ip": "203.0.113.10"}, {"sql_client_ip": "203.0.113.10"}):
            with self.subTest(overrides=overrides):
                result, calls = self.run_setup(**overrides)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("curl", calls)
                self.assertIn("--ip-address 203.0.113.10/32", calls)
        result, calls = self.run_setup(client_ip="203.0.113.999")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a valid IPv4", result.stderr)
        self.assertNotIn("network-rule", calls)

    def test_ip_discovery_failure_stops_before_firewall_changes(self):
        result, calls = self.run_setup("discovery-failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not discover", result.stderr)
        self.assertNotIn("network-rule", calls)

    def test_missing_azd_subscription_stops_before_role_or_firewall_changes(self):
        result, calls = self.run_setup("missing-subscription")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("AZURE_SUBSCRIPTION_ID is missing", result.stderr)
        self.assertNotIn("role assignment", calls)
        self.assertNotIn("keyvault ", calls)


@unittest.skipUnless(shutil.which("az"), "Azure CLI and an installed Bicep compiler are required")
class KeyVaultPrivateLinkTemplateTests(unittest.TestCase):
    def test_compiled_vault_uses_existing_vnet_private_endpoint_dns_and_rbac(self):
        version = subprocess.run(["az", "bicep", "version"], capture_output=True, text=True, timeout=30)
        if version.returncode:
            self.skipTest("An installed Bicep compiler is required")
        result = subprocess.run(
            ["az", "bicep", "build", "--file", str(ROOT / "infra/main.bicep"), "--stdout"],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        template = json.loads(result.stdout)
        module = template["resources"]["keyvault"]
        self.assertIn("sqlPrivateNetwork", module["dependsOn"])
        parameters = module["properties"]["parameters"]
        self.assertIn("sqlPrivateNetwork", parameters["virtualNetworkId"]["value"])
        self.assertIn("sqlPrivateNetwork", parameters["privateEndpointSubnetId"]["value"])
        nested = module["properties"]["template"]
        self.assertIn("environment().suffixes.keyvaultDns", nested["variables"]["privateDnsZoneName"])
        self.assertIn("privatelink.vaultcore.", nested["variables"]["privateDnsZoneName"])
        resources = {resource["type"]: resource for resource in nested["resources"]}
        vault = resources["Microsoft.KeyVault/vaults"]["properties"]
        self.assertTrue(vault["enableRbacAuthorization"])
        self.assertEqual(vault["networkAcls"]["defaultAction"], "Deny")
        self.assertEqual(vault["publicNetworkAccess"], "Enabled")
        endpoint = resources["Microsoft.Network/privateEndpoints"]
        self.assertIn("privateEndpointSubnetId", endpoint["properties"]["subnet"]["id"])
        connection = endpoint["properties"]["privateLinkServiceConnections"]
        self.assertEqual(len(connection), 1)
        self.assertEqual(connection[0]["properties"]["groupIds"], ["vault"])
        self.assertIn("Microsoft.KeyVault/vaults", connection[0]["properties"]["privateLinkServiceId"])
        self.assertTrue(any("virtualNetworkLinks" in item for item in endpoint["dependsOn"]))
        link = resources["Microsoft.Network/privateDnsZones/virtualNetworkLinks"]["properties"]
        self.assertFalse(link["registrationEnabled"])
        self.assertIn("virtualNetworkId", link["virtualNetwork"]["id"])
        group = resources["Microsoft.Network/privateEndpoints/privateDnsZoneGroups"]["properties"]
        self.assertEqual(len(group["privateDnsZoneConfigs"]), 1)
        self.assertIn("Microsoft.Network/privateDnsZones",
                      group["privateDnsZoneConfigs"][0]["properties"]["privateDnsZoneId"])
        role = resources["Microsoft.Authorization/roleAssignments"]
        self.assertIn("Microsoft.KeyVault/vaults", role["scope"])
        self.assertIn("keyVaultSecretsUserRoleId", role["properties"]["roleDefinitionId"])


if __name__ == "__main__":
    unittest.main()
