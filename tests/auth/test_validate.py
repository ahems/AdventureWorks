import importlib.util
import base64
import copy
from datetime import datetime, timezone
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location("validate_auth", Path(__file__).with_name("validate.py"))
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)


class ContractTests(unittest.TestCase):
    def test_functions_host_gate_rejects_partial_stale_or_unsafe_evidence(self):
        from functions_host import expected_case_ids, inventory_digest

        inventory = [
            {"Name": "Protected", "Route": "protected", "Methods": ["GET"],
             "Triggers": ["HttpTriggerAttribute"],
             "Policy": {"FunctionName": "Protected", "IsAnonymous": False,
                        "Mode": "InternalOnly", "RequiredScope": "admin.read"}},
            {"Name": "Timer", "Route": None, "Methods": None,
             "Triggers": ["TimerTriggerAttribute"], "Policy": None},
        ]
        document = {
            "schemaVersion": 1, "complete": True, "network": "loopback-only",
            "inventorySha256": inventory_digest(inventory), "workerSha256": "a" * 64,
            "disabledNonHttpFunctions": ["Timer"],
            "cases": [{"id": name, "status": "PASS"} for name in expected_case_ids(inventory)],
        }
        self.assertTrue(auth.valid_functions_host_evidence(inventory, document))
        variants = []
        missing_case = copy.deepcopy(document)
        missing_case["cases"].pop()
        variants.append(missing_case)
        duplicate_case = copy.deepcopy(document)
        duplicate_case["cases"][-1] = duplicate_case["cases"][0]
        variants.append(duplicate_case)
        failed_case = copy.deepcopy(document)
        failed_case["cases"][0]["status"] = "FAIL"
        variants.append(failed_case)
        stale = copy.deepcopy(document)
        stale["inventorySha256"] = "b" * 64
        variants.append(stale)
        enabled_trigger = copy.deepcopy(document)
        enabled_trigger["disabledNonHttpFunctions"] = []
        variants.append(enabled_trigger)
        unsafe_network = copy.deepcopy(document)
        unsafe_network["network"] = "host"
        variants.append(unsafe_network)
        malformed_digest = copy.deepcopy(document)
        malformed_digest["workerSha256"] = None
        variants.append(malformed_digest)
        for variant in variants:
            with self.subTest(variant=variant):
                self.assertFalse(auth.valid_functions_host_evidence(inventory, variant))

    def test_functions_readiness_reports_real_probes_without_promoting_configuration(self):
        required = ["sql", "blobs", "queues", "tables", "mcp", "mcp-ready", "oauth"]
        optional = ["webpubsub-service", "files", "foundry"]
        checks = [{"id": name, "required": name in required,
                   "status": "timeout" if name in {"mcp", "mcp-ready", "oauth"} else
                   "configured" if name == "foundry" else "healthy",
                   "message": "private diagnostic must not be exported"}
                  for name in [*required, *optional]]
        document = {"status": "unhealthy", "checkedAt": datetime.now(timezone.utc).isoformat(), "checks": checks}
        deployment = SimpleNamespace(required=lambda _: "https://functions.example.test/")

        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            with patch.object(auth, "http", return_value=(503, {}, json.dumps(document).encode())) as request:
                auth.functions_dependency_readiness(report, deployment)
            request.assert_called_once_with("GET", "https://functions.example.test/api/health/readiness")
            results = {check["id"]: check["status"] for check in report.checks}
            self.assertEqual(len(results), 15)
            self.assertTrue(all(results["infra:functions-dependency:" + name] == "PASS"
                                for name in ["sql", "blobs", "queues", "tables", "files", "webpubsub-service"]))
            self.assertTrue(all(results["infra:functions-dependency:" + name] == "BLOCKED"
                                for name in ["mcp", "mcp-ready", "oauth"]))
            self.assertEqual(results["infra:functions-sql-principal"], "BLOCKED")
            self.assertTrue(all(results["infra:functions-" + service + "-principal"] == "BLOCKED"
                                for service in ["blob", "queue", "table", "file", "webpubsub"]))
            foundry = next(item for item in report.inventory["functionsDependencyReadiness"]["checks"]
                           if item["id"] == "foundry")
            self.assertEqual(foundry["evidence"], "configuration-only")
            self.assertNotIn("private diagnostic", json.dumps({"checks": report.checks, "inventory": report.inventory}))

        for case in ["healthy", "required-unhealthy", "new-dependency"]:
            value = copy.deepcopy(document)
            if case == "healthy":
                value["status"] = "healthy"
                for item in value["checks"]:
                    if item["required"]:
                        item["status"] = "healthy"
            elif case == "required-unhealthy":
                value["checks"][0]["status"] = "unhealthy"
            else:
                value["checks"].append({"id": "future-service", "required": False, "status": "healthy"})
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                report = auth.Report(Path(directory))
                with patch.object(auth, "http", return_value=(
                        200 if case == "healthy" else 503, {}, json.dumps(value).encode())):
                    auth.functions_dependency_readiness(report, deployment)
                results = {check["id"]: check["status"] for check in report.checks}
                if case == "healthy":
                    self.assertTrue(all(status == "PASS" for name, status in results.items()
                                        if name.startswith("infra:functions-dependency:")))
                    self.assertEqual(results["infra:functions-sql-principal"], "BLOCKED")
                elif case == "required-unhealthy":
                    self.assertEqual(results["infra:functions-dependency:sql"], "FAIL")
                else:
                    self.assertEqual(results["infra:functions-dependency:future-service"], "BLOCKED")

        for defect in ["duplicate", "missing", "required", "overall", "status", "stale", "unknown"]:
            bad = copy.deepcopy(document)
            if defect == "duplicate":
                bad["checks"].append(copy.deepcopy(bad["checks"][0]))
            elif defect == "missing":
                bad["checks"] = [item for item in bad["checks"] if item["id"] != "sql"]
            elif defect == "required":
                bad["checks"][0]["required"] = False
            elif defect == "overall":
                bad["status"] = "healthy"
            elif defect == "status":
                bad["checks"][0]["status"] = []
            elif defect == "stale":
                bad["checkedAt"] = "2000-01-01T00:00:00Z"
            else:
                bad["checks"][0]["id"] = "../untrusted"
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                report = auth.Report(Path(directory))
                with patch.object(auth, "http", return_value=(503, {}, json.dumps(bad).encode())), \
                        self.assertRaises(auth.EvidenceError):
                    auth.functions_dependency_readiness(report, deployment)
                self.assertEqual(report.checks, [])

    def test_functions_sql_principal_requires_selected_binding_and_recognized_current_probe(self):
        required = ["sql", "blobs", "queues", "tables", "mcp", "mcp-ready", "oauth"]
        checks = [{"id": name, "required": True, "status": "healthy", "message": "sanitized"}
                  for name in required]
        checks.extend({"id": name, "required": False, "status": "healthy", "message": "sanitized"}
                      for name in ["webpubsub-service", "files"])
        document = {"status": "healthy", "checkedAt": datetime.now(timezone.utc).isoformat(), "checks": checks}
        deployment = SimpleNamespace(required=lambda _: "https://functions.example.test/")
        for binding, state, message, expected in [
                ("PASS", "healthy", "SQL principal matches the configured managed identity.", "PASS"),
                ("PASS", "unhealthy", "SQL principal does not match the configured managed identity.", "FAIL"),
                ("PASS", "unhealthy", "Dependency unavailable or access denied. See Application Insights.", "BLOCKED"),
                ("PASS", "unknown", "SQL principal identity could not be verified.", "BLOCKED"),
                ("PASS", "healthy", "unrecognized message", "BLOCKED"),
                ("FAIL", "healthy", "SQL principal matches the configured managed identity.", "BLOCKED"),
                (None, "healthy", "SQL principal matches the configured managed identity.", "BLOCKED")]:
            with self.subTest(binding=binding, state=state, message=message):
                current = copy.deepcopy(document)
                current["checks"].append({"id": "sql-identity", "required": False,
                                          "status": state, "message": message})
                report = auth.Report(Path("."))
                if binding:
                    report.add("infra:functions-identity", "infra", binding, "binding")
                with patch.object(auth, "http", return_value=(200, {}, json.dumps(current).encode())):
                    auth.functions_dependency_readiness(report, deployment)
                result = next(item for item in report.checks if item["id"] == "infra:functions-sql-principal")
                self.assertEqual(result["status"], expected)
                identity_inventory = next(item for item in report.inventory["functionsDependencyReadiness"]["checks"]
                                          if item["id"] == "sql-identity")
                self.assertEqual(identity_inventory["evidence"], "runtime-probe")
                self.assertNotIn(message, json.dumps(report.inventory))

    def test_function_runtime_identity_requires_binding_target_and_exact_fresh_probe(self):
        required = ["sql", "blobs", "queues", "tables", "mcp", "mcp-ready", "oauth"]
        checks = [{"id": name, "required": True, "status": "healthy"} for name in required]
        checks.extend({"id": name, "required": False, "status": "healthy"}
                      for name in ["webpubsub-service", "files"])
        document = {"status": "healthy", "checkedAt": datetime.now(timezone.utc).isoformat(), "checks": checks}
        deployment = SimpleNamespace(required=lambda _: "https://functions.example.test/")
        success = "A read succeeded using the configured managed identity."
        mismatch = "The service token does not match the configured managed identity."
        for service in ["blob", "queue", "table", "file", "webpubsub"]:
            for binding, target, state, message, expected in [
                    ("PASS", "PASS", "healthy", success, "PASS"),
                    ("PASS", "PASS", "unhealthy", mismatch, "FAIL"),
                    ("PASS", "PASS", "unhealthy", "Dependency unavailable.", "BLOCKED"),
                    ("PASS", "PASS", "unknown", "Unverifiable.", "BLOCKED"),
                    ("PASS", "PASS", "healthy", "unrecognized", "BLOCKED"),
                    ("FAIL", "PASS", "healthy", success, "BLOCKED"),
                    ("PASS", "FAIL", "healthy", success, "BLOCKED"),
                    (None, None, "healthy", success, "BLOCKED")]:
                with self.subTest(service=service, binding=binding, target=target, state=state):
                    current = copy.deepcopy(document)
                    current["checks"].append({"id": service + "-identity", "required": False,
                                              "status": state, "message": message})
                    report = auth.Report(Path("."))
                    if binding:
                        report.add("infra:functions-identity", "infra", binding, "binding")
                    if target:
                        report.add("infra:functions-" + service + "-target", "infra", target, "target")
                    with patch.object(auth, "http", return_value=(200, {}, json.dumps(current).encode())):
                        auth.functions_dependency_readiness(report, deployment)
                    result = next(item for item in report.checks
                                  if item["id"] == "infra:functions-" + service + "-principal")
                    self.assertEqual(result["status"], expected)
                    probe = next(item for item in report.inventory["functionsDependencyReadiness"]["checks"]
                                 if item["id"] == service + "-identity")
                    self.assertEqual(probe["evidence"], "runtime-probe")
                    self.assertNotIn(message, json.dumps(report.inventory))

    def test_function_runtime_identity_targets_must_match_selected_resources(self):
        account = {"name": "selected", "primaryEndpoints": {
            service: f"https://selected.{service}.core.windows.net/"
            for service in ["blob", "queue", "table", "file"]}}
        settings = {"AzureWebJobsStorage__accountName": "selected"}
        for service in ["blob", "queue", "table", "file"]:
            key = "AzureWebJobsStorage__" + service + "ServiceUri"
            self.assertTrue(auth.function_storage_target_is_valid(settings, account, service))
            self.assertTrue(auth.function_storage_target_is_valid(
                {**settings, key: account["primaryEndpoints"][service]}, account, service))
            for bad in ["https://other.example/", "http://selected.example/",
                        account["primaryEndpoints"][service] + "private",
                        account["primaryEndpoints"][service] + "?query=secret", ""]:
                self.assertFalse(auth.function_storage_target_is_valid({**settings, key: bad}, account, service))
            self.assertFalse(auth.function_storage_target_is_valid(
                {**settings, "AzureWebJobsStorage__accountName": "other"}, account, service))
        self.assertFalse(auth.function_storage_target_is_valid(settings, {"primaryEndpoints": []}, "blob"))
        self.assertTrue(auth.function_webpubsub_target_is_valid(
            {"WEB_PUBSUB_HOST_NAME": "selected.example"}, "selected.example"))
        for bad in ["other.example", "selected.example/path", "selected.example?secret=1", ""]:
            self.assertFalse(auth.function_webpubsub_target_is_valid(
                {"WEB_PUBSUB_HOST_NAME": bad}, "selected.example"))
        endpoint = "https://selected.communication.azure.com"
        self.assertTrue(auth.function_communication_target_is_valid(
            {"COMMUNICATION_SERVICE_ENDPOINT": endpoint + "/"}, endpoint))
        for bad in ["https://other.example", "http://selected.communication.azure.com",
                    endpoint + "/path", endpoint + "?secret=1", ""]:
            self.assertFalse(auth.function_communication_target_is_valid(
                {"COMMUNICATION_SERVICE_ENDPOINT": bad}, endpoint))

    def test_key_vault_private_link_requires_approved_same_vnet_dns_and_private_record(self):
        vault = {"id": "/subscriptions/s/resourceGroups/g/providers/Microsoft.KeyVault/vaults/demo-vault"}
        zone = {"id": "/subscriptions/s/resourceGroups/g/providers/Microsoft.Network/privateDnsZones/"
                      "privatelink.vaultcore.azure.net"}
        network = "/subscriptions/s/resourceGroups/g/providers/Microsoft.Network/virtualNetworks/demo"
        endpoint_id = "/subscriptions/s/resourceGroups/g/providers/Microsoft.Network/privateEndpoints/demo-vault"
        nic_id = "/subscriptions/s/resourceGroups/g/providers/Microsoft.Network/networkInterfaces/demo-vault"
        environment_id = "/subscriptions/s/resourceGroups/g/providers/Microsoft.App/managedEnvironments/demo"
        endpoint = {
            "id": endpoint_id,
            "provisioningState": "Succeeded",
            "subnet": {"id": network + "/subnets/private-endpoints"},
            "networkInterfaces": [{"id": nic_id}],
            "privateLinkServiceConnections": [{
                "privateLinkServiceId": vault["id"], "groupIds": ["vault"],
                "privateLinkServiceConnectionState": {"status": "Approved"},
            }],
        }
        group = {"name": "default", "provisioningState": "Succeeded", "privateDnsZoneConfigs": [{
            "name": "vault", "privateDnsZoneId": zone["id"],
            "recordSets": [{"recordSetName": "demo-vault", "recordType": "A", "ipAddresses": ["10.42.3.8"]}],
        }]}
        link = {"virtualNetwork": {"id": network}, "registrationEnabled": False,
                "virtualNetworkLinkState": "Completed"}
        environment = {"id": environment_id, "properties": {"vnetConfiguration": {
            "infrastructureSubnetId": network + "/subnets/container-apps"}}}
        app = {"properties": {"managedEnvironmentId": environment_id}}
        nic = {"id": nic_id, "provisioningState": "Succeeded", "privateEndpoint": {"id": endpoint_id},
               "ipConfigurations": [{"privateIPAddress": "10.42.3.8",
                                     "subnet": {"id": network + "/subnets/private-endpoints"}}]}
        fixture = [vault, endpoint, zone, group, link, environment, app, nic]
        self.assertTrue(auth.key_vault_private_link_is_valid("demo-vault", *fixture))
        for defect in ["foreign-vault", "pending-approval", "wrong-group", "wrong-subnet", "wrong-zone",
                       "wrong-vnet", "wrong-app-environment", "foreign-nic", "registration", "missing-record",
                       "public-record", "reserved-record", "different-private-record",
                       "failed-endpoint", "failed-zone-group", "malformed"]:
            with self.subTest(defect=defect):
                vault, endpoint, zone, group, link, environment, app, nic = copy.deepcopy(fixture)
                connection = endpoint["privateLinkServiceConnections"][0]
                config = group["privateDnsZoneConfigs"][0]
                if defect == "foreign-vault":
                    connection["privateLinkServiceId"] += "-other"
                elif defect == "pending-approval":
                    connection["privateLinkServiceConnectionState"]["status"] = "Pending"
                elif defect == "wrong-group":
                    connection["groupIds"] = ["blob"]
                elif defect == "wrong-subnet":
                    endpoint["subnet"]["id"] = network + "/subnets/container-apps"
                elif defect == "wrong-zone":
                    config["privateDnsZoneId"] += "-other"
                elif defect == "wrong-vnet":
                    link["virtualNetwork"]["id"] += "-other"
                elif defect == "wrong-app-environment":
                    app["properties"]["managedEnvironmentId"] += "-other"
                elif defect == "foreign-nic":
                    nic["privateEndpoint"]["id"] += "-other"
                elif defect == "registration":
                    link["registrationEnabled"] = True
                elif defect == "missing-record":
                    config["recordSets"] = []
                elif defect == "public-record":
                    config["recordSets"][0]["ipAddresses"] = ["8.8.8.8"]
                elif defect == "reserved-record":
                    config["recordSets"][0]["ipAddresses"] = ["203.0.113.5"]
                elif defect == "different-private-record":
                    config["recordSets"][0]["ipAddresses"] = ["10.42.3.9"]
                elif defect == "failed-endpoint":
                    endpoint["provisioningState"] = "Failed"
                elif defect == "failed-zone-group":
                    group["provisioningState"] = "Failed"
                else:
                    config["recordSets"][0]["recordSetName"] = None
                self.assertFalse(auth.key_vault_private_link_is_valid(
                    "demo-vault", vault, endpoint, zone, group, link, environment, app, nic))

    def test_key_vault_network_checks_derive_selected_cloud_and_fail_on_missing_endpoint(self):
        for uri, zone in [
                ("https://demo-vault.vault.azure.net/", "privatelink.vaultcore.azure.net"),
                ("https://demo-vault.vault.usgovcloudapi.net/", "privatelink.vaultcore.usgovcloudapi.net")]:
            self.assertEqual(auth.key_vault_private_dns_zone_name("demo-vault", uri), zone)
        for uri in ["https://other.vault.azure.net/", "http://demo-vault.vault.azure.net/",
                    "https://demo-vault.vault.azure.net/extra", "https://u@demo-vault.vault.azure.net/"]:
            with self.subTest(uri=uri), self.assertRaises(auth.EvidenceError):
                auth.key_vault_private_dns_zone_name("demo-vault", uri)

        values = {"MCP_SIGNING_KEY_VAULT_NAME": "demo-vault",
                  "MCP_SIGNING_KEY_VAULT_URI": "https://demo-vault.vault.azure.net/"}
        vault = {"id": "/vault", "properties": {"vaultUri": values["MCP_SIGNING_KEY_VAULT_URI"],
                 "networkAcls": {"defaultAction": "Deny"}, "publicNetworkAccess": "Enabled"}}
        deployment = SimpleNamespace(
            group="group", required=values.__getitem__, arm=lambda *args: vault,
            azure=lambda *args: [])
        report = auth.Report(Path("."))
        auth.key_vault_network_evidence(report, deployment)
        self.assertEqual([(item["id"], item["status"]) for item in report.checks], [
            ("infra:keyvault-firewall", "PASS"), ("infra:keyvault-private-link", "FAIL")])
        vault["properties"]["networkAcls"]["defaultAction"] = "Allow"
        report = auth.Report(Path("."))
        auth.key_vault_network_evidence(report, deployment)
        self.assertEqual(report.checks[0]["status"], "FAIL")

    def test_mcp_signing_configuration_matches_selected_vault_certificate_and_identity(self):
        settings = {"MCP_SIGNING_KEY_VAULT_URI": "https://demo.vault.azure.net/",
                    "MCP_SIGNING_CERTIFICATE_NAME": "mcp-signing",
                    "MCP_KEYVAULT_MANAGED_IDENTITY_CLIENT_ID": "runtime-client"}
        args = ("https://demo.vault.azure.net", "mcp-signing", "runtime-client")
        self.assertTrue(auth.mcp_keyvault_configuration_is_valid(settings, *args))
        for key in settings:
            changed = dict(settings, **{key: "wrong"})
            self.assertFalse(auth.mcp_keyvault_configuration_is_valid(changed, *args))
        self.assertFalse(auth.mcp_keyvault_configuration_is_valid(None, *args))
        self.assertFalse(auth.mcp_keyvault_configuration_is_valid(settings, "", *args[1:]))

    def test_dab_role_header_denials_cover_all_ungranted_source_roles_in_both_protocols(self):
        config = {"entities": {"Employee": {"permissions": [
            {"role": role} for role in ["anonymous", "authenticated", "consumer",
                                      "executive-admin", "manufacturing-engineer", "new-role"]]}}}
        consumers = [SimpleNamespace(label="A", token=lambda *args: "consumer-token")]
        helper = SimpleNamespace(claims=lambda token: {"roles": {
            "admin-token": ["executive-admin"],
            "manufacturing-token": "manufacturing-engineer",
            "consumer-token": ["consumer"],
        }[token]})
        calls = []

        def request(method, url, *, token, headers, **kwargs):
            calls.append((method, url, token, headers["X-MS-API-ROLE"], kwargs))
            return 403, {}, b'{"error":{"code":"Forbidden"}}'

        report = auth.Report(Path("."))
        with patch.object(auth.Path, "read_text", return_value=json.dumps(config)), \
                patch.object(auth, "dab_inventory"), patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "http", side_effect=request):
            auth.dab_role_header_denials(
                report, SimpleNamespace(required=lambda key: "https://dab.example.invalid/graphql/"),
                "admin-token", "manufacturing-token", consumers)
        self.assertEqual(len(calls), 18)
        self.assertTrue(all(check["status"] == "PASS" for check in report.checks))
        for token in ["admin-token", "manufacturing-token", "consumer-token"]:
            selected = [call for call in calls if call[2] == token]
            granted = helper.claims(token)["roles"]
            granted = {granted} if isinstance(granted, str) else set(granted)
            self.assertEqual(len(selected), 6)
            self.assertTrue(all(call[3] not in granted for call in selected))
            self.assertEqual({call[3] for call in selected},
                             {"consumer", "executive-admin", "manufacturing-engineer", "new-role"} -
                             granted)
            self.assertEqual({call[0] for call in selected}, {"GET", "POST"})
        self.assertTrue(all("new-role" in row["ungrantedRoles"]
                            for row in report.inventory["dabRoleHeaderDecisions"]))

    def test_dab_role_header_denials_reject_non_authorization_responses_and_invalid_claims(self):
        config = {"entities": {"Employee": {"permissions": [
            {"role": "executive-admin"}, {"role": "manufacturing-engineer"}]}}}
        for status, raw in [(200, b'{"data":{"employees":{"items":[]}}}'),
                            (401, b""), (500, b'{"error":"unavailable"}'),
                            (403, b'{"data":{"employees":{"items":[{"BusinessEntityID":42}]}}}'),
                            (403, b"<html>failure</html>")]:
            with self.subTest(status=status, raw=raw):
                report = auth.Report(Path("."))
                helper = SimpleNamespace(claims=lambda token: {"roles": ["executive-admin"]})
                with patch.object(auth.Path, "read_text", return_value=json.dumps(config)), \
                        patch.object(auth, "dab_inventory"), \
                        patch.object(auth, "load_auth_helper", return_value=helper), \
                        patch.object(auth, "http", return_value=(status, {}, raw)):
                    with self.assertRaises(auth.EvidenceError):
                        auth.dab_role_header_denials(
                            report, SimpleNamespace(required=lambda key: "https://dab.example.invalid/graphql/"),
                            "admin-token", "manufacturing-token", [])
                self.assertEqual(report.checks[-1]["status"], "FAIL")
                self.assertNotIn("BusinessEntityID", json.dumps(report.checks))
        for roles in [None, [], ["unknown"], [42]]:
            with self.subTest(roles=roles), \
                    patch.object(auth.Path, "read_text", return_value=json.dumps(config)), \
                    patch.object(auth, "dab_inventory"), \
                    patch.object(auth, "load_auth_helper",
                                 return_value=SimpleNamespace(claims=lambda token: {"roles": roles})), \
                    patch.object(auth, "http") as request:
                with self.assertRaises(auth.EvidenceError):
                    auth.dab_role_header_denials(
                        auth.Report(Path(".")),
                        SimpleNamespace(required=lambda key: "https://dab.example.invalid/graphql/"),
                        "admin-token", "manufacturing-token", [])
                request.assert_not_called()

    def test_consumer_handler_gate_requires_all_registered_routes_and_two_owner_cases(self):
        names = {
            "CreateAddress", "DeleteAddress", "GetAddressById", "GetAddresses", "GetPersonAddresses",
            "SetAddressType", "UpdateAddress", "SetPassword", "VerifyPassword", "CheckOrderReceipt",
            "DownloadOrderReceipt", "GenerateAndSendReceipt", "GetPaymentMethods", "CreateOrderDetail",
            "GetOwnedOrderDetails", "CreateOrderHeader", "MergeGuestCart",
        }
        cases = {
            f"ApiFunctions.Tests.PaymentMethodFunctionsTests.Reads_only_the_signed_person_even_with_foreign_query_and_headers(owner: {owner})"
            for owner in [71, 72]}
        cases.update(f"ApiFunctions.Tests.{name}(owner: {owner})" for owner in [7, 8] for name in [
            "OrderDetailFunctionsTests.Consumer_order_detail_uses_the_validated_customer_claim",
            "OrderDetailFunctionsTests.Other_owner_order_is_denied_without_a_success_response",
            "OrderDetailFunctionsTests.Consumer_reads_only_signed_owner_even_with_forged_inputs",
            "OrderDetailFunctionsTests.Consumer_cannot_read_other_or_mixed_orders",
            "OwnedCartFunctionsTests.Valid_consumer_resolves_owner_from_signed_claim_not_query",
            "OwnedCartFunctionsTests.Merge_binds_both_signed_owners_and_hashed_guest_proof"])
        for customer, person, address in [(7, 71, 101), (8, 72, 102)]:
            cases.update("ApiFunctions.Tests.OrderHeaderFunctionsTests." + name +
                         f"(customer: {customer}, person: {person})" for name in [
                             "Consumer_header_uses_signed_customer_and_person_not_forged_inputs",
                             "Foreign_address_or_customer_binding_returns_denial"])
            cases.add("ApiFunctions.Tests.OrderHeaderServiceTests."
                      "Customer_and_both_addresses_are_checked_before_insert_in_one_transaction" +
                      f"(customer: {customer}, person: {person}, address: {address})")
        cases.update("ApiFunctions.Tests.OrderHeaderServiceTests.Invalid_customer_address_or_ship_method_never_inserts" +
                     f'(defect: "{defect}")' for defect in
                     ["customer", "billing", "shipping", "missing-address", "ship-method"])
        cases.add("ApiFunctions.Tests.OrderHeaderServiceTests.Insert_failure_rolls_back_the_guarded_transaction")
        for scenario, expected in [("complete", "PASS"), ("new-route", "BLOCKED"),
                                   ("missing-owner", "BLOCKED"), ("duplicate", "BLOCKED"),
                                   ("skipped", "BLOCKED"), ("failed", "FAIL"),
                                   ("missing-gate", "BLOCKED"), ("failed-gate", "FAIL")]:
            with self.subTest(scenario=scenario):
                report = auth.Report(Path("."))
                report.inventory["functions"] = [
                    {"Name": name, "Policy": {"Tier": "Consumer"}} for name in names]
                for check_id in ["required:functions-worker-middleware", "required:address-handler-ownership",
                                 "required:password-handler-ownership", "required:receipt-handler-ownership"]:
                    report.add(check_id, "required", "PASS", "Current evidence")
                results = {name: ["Passed"] for name in cases}
                selected = sorted(cases)[0]
                if scenario == "new-route":
                    report.inventory["functions"].append({"Name": "Unreviewed", "Policy": {"Tier": "Consumer"}})
                elif scenario == "missing-owner":
                    del results[selected]
                elif scenario == "duplicate":
                    results[selected].append("Passed")
                elif scenario == "skipped":
                    results[selected] = ["NotExecuted"]
                elif scenario == "failed":
                    results[selected] = ["Failed"]
                elif scenario == "missing-gate":
                    report.checks.pop()
                elif scenario == "failed-gate":
                    report.checks[-1]["status"] = "FAIL"
                with patch.object(auth, "current_test_evidence", return_value=(results, {"current.trx": "hash"})):
                    auth.consumer_handler_evidence(report)
                self.assertEqual(report.checks[-1]["status"], expected)

    def test_interrupted_guest_browser_explicitly_fails_unverified_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            deployment = SimpleNamespace(
                required=lambda key: {"SERVICE_APP_NAME": "site", "AZURE_RESOURCE_GROUP": "group",
                                      "API_FUNCTIONS_URL": "https://functions.example.test",
                                      "API_URL": "https://dab.example.test/graphql",
                                      "API_MCP_URL": "https://mcp.example.test/mcp"}[key],
                azure=lambda *args: {"defaultHostname": "site.example.test"})

            def interrupted(*args, **kwargs):
                (Path(directory) / "guest-cart-browser.json").write_text(json.dumps({
                    "checks": [], "bootstrapRequested": True,
                    "cart": {"cartId": "guest-" + "a" * 32, "expiresAt": "2026-01-01T00:00:00Z"},
                    "consumer": {"mutationPossible": True},
                }))
                raise auth.EvidenceError("Browser command was interrupted")

            with patch.object(auth, "command", side_effect=interrupted), \
                    patch.object(auth, "http", side_effect=AssertionError("No blind cleanup request")):
                auth.guest_cart_browser(report, deployment)
            for name in ["browser:guest-cart:cleanup", "browser:consumer-cart:cleanup",
                         "browser:guest-cart:complete"]:
                self.assertEqual(next(check["status"] for check in report.checks if check["id"] == name), "FAIL")

    def test_receipt_reads_use_existing_metadata_and_redact_any_foreign_response(self):
        deployment = SimpleNamespace(required=lambda key: {
            "API_URL": "https://dab.example.test/graphql/",
            "API_FUNCTIONS_URL": "https://functions.example.test",
        }[key])
        token = "header." + base64.urlsafe_b64encode(b'{"customer_id":71}').decode().rstrip("=") + ".signature"
        consumers = [SimpleNamespace(label=label, token=lambda *_: token) for label in ["A", "B"]]
        for scenario in ["valid-missing", "valid-pdf", "valid-unbound", "foreign-allowed", "bad-status", "no-order"]:
            claims = b'{"customer_id":"0"}' if scenario == "valid-unbound" else b'{"customer_id":71}'
            token = "header." + base64.urlsafe_b64encode(claims).decode().rstrip("=") + ".signature"
            calls = []

            def request(method, url, *, token=None, **kwargs):
                calls.append((method, url, token))
                if method == "POST":
                    self.assertTrue(url.endswith("/api/orders/generate-and-send-receipt"))
                    self.assertEqual(kwargs["data"], {"salesOrderId": 0, "customerId": 0, "emailAddressId": 0})
                    return 400, {}, b'{"error":"SalesOrderId is required and must be greater than 0"}'
                self.assertEqual(method, "GET")
                if url.startswith("https://dab.example.test/"):
                    return 200, {}, json.dumps({"value": [] if scenario == "no-order" else [
                        {"SalesOrderID": 900, "CustomerID": 99}]}).encode()
                if token == "admin":
                    if url.endswith("-status"):
                        return 200, {}, json.dumps({
                            "exists": 0 if scenario == "bad-status" else scenario == "valid-pdf"}).encode()
                    if scenario == "valid-pdf":
                        return 200, {"Content-Type": "application/pdf",
                                     "Content-Disposition": 'attachment; filename="receipt-SO900.pdf"'}, b"%PDF-fixture"
                    return 404, {}, b'{"error":"Receipt has not been generated yet."}'
                self.assertIn("customerId=0", url)
                self.assertEqual(kwargs["headers"]["X-MS-API-ROLE"], "executive-admin")
                if scenario == "foreign-allowed":
                    return 200, {}, b"private-receipt-payload"
                return 403, {}, b'{"error":"Order access is not allowed."}'

            report = auth.Report(Path("."))
            with self.subTest(scenario=scenario), patch.object(auth, "http", side_effect=request):
                if scenario.startswith("valid"):
                    auth.receipt_reads(report, deployment, "admin", "dab-admin", consumers)
                    self.assertEqual(len(calls), 8)
                    self.assertEqual([check["status"] for check in report.checks], ["PASS"] * 7 + ["BLOCKED"])
                else:
                    with self.assertRaises(auth.EvidenceError):
                        auth.receipt_reads(report, deployment, "admin", "dab-admin", consumers)
                    if scenario != "no-order":
                        self.assertIn("FAIL", [check["status"] for check in report.checks])
                self.assertNotIn("private-receipt-payload", json.dumps(report.checks))
                self.assertNotIn("signature", json.dumps(report.checks))

    def test_receipt_gate_rejects_missing_duplicate_skipped_failed_or_unclassified_cases(self):
        prefix = "ApiFunctions.Tests.ReceiptOwnershipTests."
        cases = [
            "Internal_receipt_requests_still_bind_order_to_customer_and_recipient",
            "Queue_failure_never_returns_accepted_and_invalid_JSON_never_enqueues",
        ]
        cases += [f"Both_owners_read_only_their_own_receipt_before_any_blob_access(owner: {owner}, download: {download})"
                  for owner in [71, 72] for download in ["False", "True"]]
        cases += [f"Email_generation_binds_signed_customer_order_and_recipient_before_enqueue(owner: {owner})"
                  for owner in [71, 72]]
        cases += [
            'Untrusted_or_unbound_receipt_callers_reach_neither_SQL_nor_storage' +
            f'(owner: {owner}, category: "{category}", authenticated: {authenticated})'
            for owner, category, authenticated in [
                ("null", "consumer", "True"), ("0", "consumer", "True"), ("-1", "consumer", "True"),
                ("71", "unknown", "True"), ("71", "consumer", "False")]]
        cases += [
            f'Worker_revalidates_queued_order_customer_and_email_before_receipt_or_email_access(order: "{order}", customer: 71, email: {email})'
            for order, email in [("SO1072", 2071), ("SO1071", 2072), ("SO01071", 2071)]]
        cases += [
            f"Authorized_missing_and_failed_storage_have_distinct_sanitized_responses(download: {download}, storageStatus: {status}, expected: {outcome})"
            for download, status, outcome in [
                ("False", 404, "OK"), ("True", 404, "NotFound"),
                ("False", 503, "InternalServerError"), ("True", 503, "InternalServerError")]]
        for scenario, expected in [("complete", "PASS"), ("missing", "BLOCKED"), ("duplicate", "BLOCKED"),
                                   ("skipped", "BLOCKED"), ("failed", "FAIL"), ("extra", "BLOCKED")]:
            with self.subTest(scenario=scenario):
                results = {prefix + name: ["Passed"] for name in cases}
                selected = prefix + cases[0]
                if scenario == "missing":
                    del results[selected]
                elif scenario == "duplicate":
                    results[selected].append("Passed")
                elif scenario == "skipped":
                    results[selected] = ["NotExecuted"]
                elif scenario == "failed":
                    results[selected] = ["Failed"]
                elif scenario == "extra":
                    results[prefix + "Unclassified"] = ["Passed"]
                report = auth.Report(Path("."))
                with patch.object(auth, "current_test_evidence", return_value=(results, {"current.trx": "hash"})):
                    auth.receipt_ownership_evidence(report)
                self.assertEqual(report.checks[0]["status"], expected)

    def test_guest_cleanup_telemetry_distinguishes_execution_absence_failures_and_invalid_evidence(self):
        for scenario, values, expected in [
                ("success", [6, 6, 0, "2026-11-14T01:50:00Z"], "PASS"),
                ("fractional-ticks", [6, 6, 0, "2026-11-14T01:50:00.0071013Z"], "PASS"),
                ("failure", [6, 5, 1, "2026-11-14T01:50:00Z"], "FAIL"),
                ("absent", [0, 0, 0, None], "BLOCKED"),
                ("unknown-status", [1, 0, 0, "2026-11-14T01:50:00Z"], "BLOCKED"),
                ("inconsistent", [1, 2, 0, "2026-11-14T01:50:00Z"], None),
                ("boolean", [True, 1, 0, "2026-11-14T01:50:00Z"], None),
                ("invalid-time", [1, 1, 0, "not-a-date"], None)]:
            result = {"tables": [{"columns": [{"name": name} for name in
                                             ["invocations", "successes", "failures", "latest"]],
                                   "rows": [values]}]}
            deployment = SimpleNamespace(required=lambda _: "selected-group",
                                         azure=unittest.mock.Mock(side_effect=[["/selected/insights"], result]))
            report = auth.Report(Path("."))
            with self.subTest(scenario=scenario):
                if expected is None:
                    with self.assertRaises(auth.EvidenceError):
                        auth.guest_cart_cleanup_telemetry(report, deployment)
                    self.assertEqual(report.checks, [])
                else:
                    auth.guest_cart_cleanup_telemetry(report, deployment)
                    self.assertEqual(report.checks[0]["status"], expected)
                    self.assertEqual(report.inventory["guestCartCleanupTimer"]["invocations"], values[0])
                query = deployment.azure.call_args_list[-1].args[-1]
                self.assertIn("ago(24h)", query)
                self.assertIn("name == 'CleanupExpiredGuestCarts'", query)
                self.assertNotIn("customDimensions", query)

    def test_cart_lifecycle_gate_requires_every_current_run_case_exactly_once(self):
        prefix = "ApiFunctions.Tests.OwnedCartLifecycleTests."
        names = {
            prefix + "Guest_read_enforces_exact_expiry_without_extending_lifetime" +
            f"(ticks: {ticks}, allowed: {allowed})"
            for ticks, allowed in [(-1, "True"), (0, "False"), (1, "False")]
        }
        names.update(
            prefix + name + f'(operation: "{operation}")'
            for name in [
                "Expiry_during_cart_lock_stops_before_data_access_or_mutation",
                "Retired_session_cannot_be_reused_before_expiry",
            ]
            for operation in ["READ", "DELETE", "RETIRE", "MERGE"]
        )
        names.update(
            prefix + "Merge_retry_is_idempotent_only_for_same_owner_before_expiry" +
            f"(owner: {owner}, ticks: {ticks}, allowed: {allowed})"
            for owner, ticks, allowed in [(7, -1, "True"), (8, -1, "False"), (7, 0, "False")]
        )
        names.update(prefix + name for name in [
            "Merge_rechecks_expiry_after_waiting_for_the_account_lock",
            "New_session_has_fixed_lifetime_and_persists_only_hashed_proof",
            "Expected_cart_mismatch_is_denied_before_lock_or_data_access",
        ])
        for scenario, expected_status in [
                ("complete", "PASS"), ("missing", "BLOCKED"), ("duplicate", "BLOCKED"),
                ("skipped", "BLOCKED"), ("failed", "FAIL"), ("absent", "BLOCKED")]:
            with self.subTest(scenario=scenario):
                results = {name: ["Passed"] for name in names}
                selected = sorted(names)[0]
                if scenario == "missing":
                    del results[selected]
                elif scenario == "duplicate":
                    results[selected].append("Passed")
                elif scenario == "skipped":
                    results[selected] = ["NotExecuted"]
                elif scenario == "failed":
                    results[selected] = ["Failed"]
                elif scenario == "absent":
                    results = {}
                report = auth.Report(Path("."))
                with patch.object(auth, "current_test_evidence", return_value=(results, {"current.trx": "hash"})):
                    auth.cart_lifecycle_evidence(report)
                self.assertEqual(report.checks[0]["status"], expected_status)

    def test_mcp_dispatch_evidence_requires_exact_current_registry_cases(self):
        prefix = "AdventureWorks.Tests.McpToolDispatchTests."
        expected = {
            prefix + "Every_tool_denial_stops_real_http_dispatch" +
            f'(name: "get_customer_orders", reason: "{reason}")'
            for reason in ["anonymous", "missing-business-scope", "wrong-audience"]
        }
        expected.add(prefix + "Every_tool_with_issued_service_scope_reaches_dispatch_once" +
                     '(name: "get_customer_orders")')
        expected.add(prefix + "Denied_task_opt_in_returns_authorization_error_not_a_background_task" +
                     '(name: "get_customer_orders")')
        expected.add(prefix + "Authorized_task_opt_in_preserves_background_dispatch")
        expected.update(prefix + "Catalogue_only_service_cannot_dispatch_purchase_history_recommendations" +
                        f"(task: {task})" for task in ["False", "True"])
        expected.update(
            prefix + "Task_handlers_bind_owner_and_recheck_scope_before_reads_updates_or_cancellation" +
            f"(owner: {owner})" for owner in [71, 72])
        expected.update(
            prefix + "Consumer_owner_is_injected_before_dispatch_and_foreign_owner_never_dispatches" +
            f'(name: "get_customer_orders", owner: {owner})' for owner in [71, 72])
        for scenario, status in [
                ("complete", "PASS"), ("missing", "BLOCKED"), ("duplicate", "BLOCKED"),
                ("skipped", "BLOCKED"), ("failed", "FAIL"), ("extra", "BLOCKED"),
                ("no-registry", "BLOCKED")]:
            with self.subTest(scenario=scenario):
                report = auth.Report(Path("."))
                report.inventory["mcp"] = [{
                    "Name": "get_customer_orders", "Policy": {"Mode": "SelfOrInternal"},
                }]
                results = {name: ["Passed"] for name in expected}
                selected = sorted(expected)[0]
                if scenario == "missing":
                    del results[selected]
                elif scenario == "duplicate":
                    results[selected].append("Passed")
                elif scenario == "skipped":
                    results[selected] = ["NotExecuted"]
                elif scenario == "failed":
                    results[selected] = ["Failed"]
                elif scenario == "extra":
                    results[prefix + "Unclassified_case"] = ["Passed"]
                elif scenario == "no-registry":
                    report.inventory["mcp"] = []
                    results = {}
                with patch.object(auth, "current_test_evidence", return_value=(results, {"current.trx": "hash"})):
                    auth.mcp_dispatch_evidence(report)
                self.assertEqual(report.checks[0]["status"], status)

    def test_task_store_ownership_evidence_rejects_incomplete_and_failed_current_runs(self):
        prefix = "AdventureWorks.Tests.McpTaskOwnershipTests."
        names = {prefix + name for name in [
            "Creation_without_tool_authority_never_writes_a_table_entity",
            "In_memory_tasks_enforce_the_same_owner_and_scope_boundary",
        ]}
        names.update(prefix + "Table_task_owner_and_scope_survive_recreation_and_block_all_foreign_operations" +
                     f"(owner: {owner})" for owner in [71, 72])
        names.update(prefix + "Table_tasks_fail_closed_for_lost_authority_and_unowned_legacy_state" +
                     f'(scenario: "{scenario}")' for scenario in ["application", "scope", "category", "policy", "unbound", "legacy"])
        for scenario, expected_status in [
                ("complete", "PASS"), ("missing", "BLOCKED"), ("duplicate", "BLOCKED"),
                ("skipped", "BLOCKED"), ("failed", "FAIL")]:
            results = {name: ["Passed"] for name in names}
            selected = sorted(names)[0]
            if scenario == "missing":
                del results[selected]
            elif scenario == "duplicate":
                results[selected].append("Passed")
            elif scenario == "skipped":
                results[selected] = ["NotExecuted"]
            elif scenario == "failed":
                results[selected] = ["Failed"]
            with self.subTest(scenario=scenario), patch.object(
                    auth, "current_test_evidence", return_value=(results, {"current.trx": "hash"})):
                report = auth.Report(Path("."))
                auth.mcp_task_ownership_evidence(report)
                self.assertEqual(report.checks[0]["status"], expected_status)

    def test_consumer_mcp_session_uses_resource_bound_refresh_not_credentials_grant(self):
        deployment = SimpleNamespace(values={}, required=lambda _: "https://mcp.example.test/mcp")
        session = auth.ConsumerSession(deployment, "A", "fixture@example.invalid", "fixture-password", 7)
        payload = auth.base64.urlsafe_b64encode(json.dumps({
            "category": "consumer", "aud": "https://mcp.example.test/mcp",
        }).encode()).decode().rstrip("=")
        token = "fixture." + payload + ".signature"
        calls = []

        def exchange(method, url, **kwargs):
            calls.append(kwargs["form"])
            document = {"refresh_token": "fixture-refresh"} if len(calls) == 1 else {
                "access_token": token, "expires_in": 600,
            }
            return 200, {}, json.dumps(document).encode()

        with patch.object(auth, "http", side_effect=exchange):
            self.assertEqual(token, session.token("mcp"))
            self.assertEqual(token, session.token("mcp"))
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["resource"], "https://mcp.example.test/functions")
        self.assertIn("offline_access", calls[0]["scope"].split())
        self.assertEqual(calls[1], {
            "grant_type": "refresh_token", "client_id": "adventureworks-eshop",
            "refresh_token": "fixture-refresh", "resource": "https://mcp.example.test/mcp",
        })

    def test_consumer_mcp_session_fails_closed_without_refresh_or_with_wrong_audience(self):
        deployment = SimpleNamespace(values={}, required=lambda _: "https://mcp.example.test/mcp")
        payload = auth.base64.urlsafe_b64encode(json.dumps({
            "category": "consumer", "aud": "https://mcp.example.test/functions",
        }).encode()).decode().rstrip("=")
        for responses in [
            [(403, {}, b"{}")],
            [(200, {}, b"{}")],
            [(200, {}, b'{"refresh_token":""}')],
            [(200, {}, b'{"refresh_token":"fixture-refresh"}'), (200, {}, json.dumps({
                "access_token": "fixture." + payload + ".signature", "expires_in": 600,
            }).encode())],
        ]:
            with self.subTest(responses=responses), patch.object(auth, "http", side_effect=responses):
                session = auth.ConsumerSession(deployment, "A", "fixture@example.invalid", "fixture-password", 7)
                with self.assertRaises(auth.EvidenceError):
                    session.token("mcp")

    def test_customer_chat_tool_contract_rejects_internal_or_unavailable_scopes(self):
        configured = {"eshop-chat-agent": ["availability", "orders"]}
        policies = [
            {"Name": "availability", "Policy": {"Mode": "Public", "RequiredScope": "products.read"}},
            {"Name": "orders", "Policy": {"Mode": "SelfOrInternal", "RequiredScope": "orders.read"}},
        ]
        for selected, inventory, expected in [
                (configured, policies, "PASS"),
                (configured, [policies[0], {"Name": "orders", "Policy": {
                    "Mode": "InternalOnly", "RequiredScope": "orders.read"}}], "FAIL"),
                (configured, [policies[0], {"Name": "orders", "Policy": {
                    "Mode": "Public", "RequiredScope": "inventory.read"}}], "FAIL"),
                (configured, policies[:1], "FAIL"),
                ({"eshop-chat-agent": []}, policies, "FAIL"),
                ({}, policies, "FAIL")]:
            with self.subTest(expected=expected, selected=selected, inventory=inventory):
                report = auth.Report(Path("."))
                auth.consumer_chat_tool_contract(report, selected, inventory)
                self.assertEqual(report.checks[0]["status"], expected)

    def test_consumer_mcp_read_matrix_distinguishes_profile_blockers_and_owner_denials(self):
        deployment = SimpleNamespace(required=lambda _: "https://mcp.example.test/mcp")
        consumer = SimpleNamespace(label="A", token=lambda resource, scopes=None: (
            "scope-only" if scopes == "mcp.access" else
            "products-only" if scopes == "mcp.access products.read" else "scoped"))
        for scenario, expected_status in [
                ("complete", "PASS"), ("no-profile", "BLOCKED"),
                ("owner-allowed", "FAIL"), ("empty-catalogue", "FAIL"),
                ("availability-extra", "FAIL"), ("availability-wrong-id", "FAIL"),
                ("availability-not-in-stock", "FAIL"), ("availability-not-json", "FAIL"),
                ("availability-missing-extra", "FAIL"), ("availability-missing-not-null", "FAIL"),
                ("availability-scope-allowed", "FAIL"), ("inventory-details-allowed", "FAIL")]:
            with self.subTest(scenario=scenario):
                calls = []

                def request(method, url, *, token, data, **kwargs):
                    name = data["params"]["name"]
                    calls.append(name)
                    if name == "get_categories_with_products":
                        error = False
                        message = "AdventureWorks Product Catalogue\nProductID=1: test"
                        if scenario == "empty-catalogue":
                            message = "AdventureWorks Product Catalogue"
                    elif name == "get_product_availability":
                        if token == "scope-only":
                            error = scenario != "availability-scope-allowed"
                            message = "This operation requires the 'products.read' scope, which your account does not have."
                        elif data["params"]["arguments"]["productId"] == 0:
                            error = False
                            result = {"productId": 0, "inStock": False if scenario == "availability-missing-not-null" else None}
                            if scenario == "availability-missing-extra":
                                result["quantity"] = 20
                            message = json.dumps(result)
                        else:
                            error = False
                            result = {"productId": 2 if scenario == "availability-wrong-id" else 1,
                                      "inStock": scenario != "availability-not-in-stock"}
                            if scenario == "availability-extra":
                                result["quantity"] = 20
                            message = "invalid" if scenario == "availability-not-json" else json.dumps(result)
                    elif name == "check_inventory_availability":
                        error = scenario != "inventory-details-allowed"
                        message = "This operation requires the 'inventory.read' scope, which your account does not have."
                    elif name == "search_customers":
                        error, message = True, "This operation is restricted to internal users."
                    elif token == "scope-only" or token == "products-only" and name == "get_personalized_recommendations":
                        scope = "orders.read"
                        error, message = True, f"This operation requires the '{scope}' scope, which your account does not have."
                    else:
                        error = scenario != "owner-allowed"
                        message = ("No customer profile is associated with your account." if scenario == "no-profile"
                                   else "You can only access your own records.")
                    return 200, {}, json.dumps({
                        "jsonrpc": "2.0", "id": data["id"],
                        "result": {"isError": error, "content": [{"type": "text", "text": message}]},
                    }).encode()

                report = auth.Report(Path("."))
                with patch.object(auth, "http", side_effect=request), \
                        patch.object(auth, "customer_availability_out_of_stock"):
                    available = auth.consumer_mcp_owner_denials(report, deployment, [consumer])
                self.assertEqual({*calls}, {
                    "get_categories_with_products", "get_product_availability", "check_inventory_availability",
                    "search_customers", "get_customer_orders", "get_order_details", "get_personalized_recommendations",
                })
                statuses = {check["status"] for check in report.checks}
                self.assertIn(expected_status, statuses)
                if scenario == "complete":
                    self.assertEqual(statuses, {"PASS"})
                    self.assertEqual(available, {"A": 1})
                if scenario == "no-profile":
                    self.assertNotIn("FAIL", statuses)
                    self.assertEqual(sum(check["status"] == "BLOCKED" for check in report.checks), 12)

    def test_out_of_stock_oracle_requires_complete_finished_product_inventory(self):
        deployment = SimpleNamespace(required=lambda _: "https://dab.example.test/graphql/")

        def request(method, url, **kwargs):
            self.assertEqual(method, "GET")
            parsed = urllib.parse.urlsplit(url)
            query = urllib.parse.parse_qs(parsed.query)
            if parsed.path == "/api/Product":
                body = {"value": [
                    {"ProductID": 1, "FinishedGoodsFlag": True},
                    {"ProductID": 2, "FinishedGoodsFlag": True},
                ]}
            elif query["$filter"] == ["ProductID eq 1"]:
                body = {"value": [{"ProductID": 1, "LocationID": 1, "Quantity": 3}]}
            elif "$after" not in query:
                body = {"value": [{"ProductID": 2, "LocationID": 1, "Quantity": 0}],
                        "nextLink": "/api/ProductInventory?%24filter=ProductID+eq+2&%24after=next"}
            else:
                body = {"value": [{"ProductID": 2, "LocationID": 2, "Quantity": 0}]}
            return 200, {}, json.dumps(body).encode()

        with patch.object(auth, "http", side_effect=request):
            self.assertEqual(auth.out_of_stock_finished_product(deployment), 2)

    def test_out_of_stock_oracle_rejects_unproven_or_unsafe_inventory(self):
        deployment = SimpleNamespace(required=lambda _: "https://dab.example.test/graphql/")
        for defect in ["unfinished", "wrong-row", "cross-origin", "wrong-filter",
                       "repeated-cursor", "later-positive", "malformed", "none-available"]:
            with self.subTest(defect=defect):
                def request(method, url, **kwargs):
                    parsed = urllib.parse.urlsplit(url)
                    query = urllib.parse.parse_qs(parsed.query)
                    if parsed.path == "/api/Product":
                        body = {"value": [{"ProductID": 2, "FinishedGoodsFlag": defect != "unfinished"}]}
                    elif defect == "malformed":
                        body = {"value": "not a list"}
                    elif defect == "wrong-row":
                        body = {"value": [{"ProductID": 3, "LocationID": 1, "Quantity": 0}]}
                    elif defect == "none-available" or defect == "later-positive" and "$after" in query:
                        body = {"value": [{"ProductID": 2, "LocationID": 1, "Quantity": 1}]}
                    else:
                        link = "/api/ProductInventory?%24filter=ProductID+eq+2&%24after=next"
                        if defect == "cross-origin":
                            link = "https://other.example.test" + link
                        elif defect == "wrong-filter":
                            link = "/api/ProductInventory?%24filter=ProductID+eq+3&%24after=next"
                        body = {"value": [], "nextLink": link}
                    return 200, {}, json.dumps(body).encode()

                with patch.object(auth, "http", side_effect=request), self.assertRaises(auth.EvidenceError):
                    auth.out_of_stock_finished_product(deployment)

    def test_out_of_stock_mcp_response_must_match_the_independent_oracle(self):
        consumers = [
            SimpleNamespace(label=label, token=lambda resource, scopes=None: f"{resource}:{scopes}")
            for label in ["A", "B"]
        ]
        for defect in [None, "allowed-error", "true", "missing", "extra", "wrong-product", "invalid-json"]:
            with self.subTest(defect=defect):
                def call(name, token, arguments):
                    self.assertEqual((name, token, arguments),
                                     ("get_product_availability", "mcp:mcp.access products.read", {"productId": 2}))
                    body = {"productId": 3 if defect == "wrong-product" else 2,
                            "inStock": True if defect == "true" else None if defect == "missing" else False}
                    if defect == "extra":
                        body["quantity"] = 0
                    return defect == "allowed-error", ["invalid" if defect == "invalid-json" else json.dumps(body)]

                report = auth.Report(Path("."))
                with patch.object(auth, "out_of_stock_finished_product", return_value=2), \
                        patch.object(auth, "out_of_stock_product_still_valid", return_value=True):
                    auth.customer_availability_out_of_stock(report, object(), consumers, call)
                self.assertEqual(report.checks[0]["status"], "PASS")
                self.assertEqual([item["status"] for item in report.checks[1:]],
                                 ["PASS", "PASS"] if defect is None else ["FAIL", "FAIL"])

    def test_out_of_stock_result_is_blocked_if_fixture_changes_during_calls(self):
        consumer = SimpleNamespace(label="A", token=lambda *args: "token")
        report = auth.Report(Path("."))
        with patch.object(auth, "out_of_stock_finished_product", return_value=2), \
                patch.object(auth, "out_of_stock_product_still_valid", return_value=False):
            report.guarded("scenario", "live-allows", lambda: auth.customer_availability_out_of_stock(
                report, object(), [consumer],
                lambda *args: (False, ['{"productId":2,"inStock":false}'])))
        self.assertEqual([(item["id"], item["status"]) for item in report.checks], [("scenario", "BLOCKED")])

    def test_out_of_stock_recheck_requires_current_finished_product_and_inventory(self):
        deployment = SimpleNamespace(required=lambda _: "https://dab.example.test/graphql/")
        for rows, inventory, expected in [
                ([{"ProductID": 2, "FinishedGoodsFlag": True}], True, True),
                ([{"ProductID": 2, "FinishedGoodsFlag": True}], False, False),
                ([{"ProductID": 2, "FinishedGoodsFlag": False}], True, False),
                ([], True, False)]:
            with self.subTest(rows=rows, inventory=inventory):
                with patch.object(auth, "http", return_value=(200, {}, json.dumps({"value": rows}).encode())), \
                        patch.object(auth, "no_positive_product_inventory", return_value=inventory):
                    self.assertEqual(auth.out_of_stock_product_still_valid(deployment, 2), expected)

    def test_consumer_mcp_read_matrix_rejects_mismatched_or_malformed_protocol_evidence(self):
        deployment = SimpleNamespace(required=lambda _: "https://mcp.example.test/mcp")
        consumer = SimpleNamespace(label="A", token=lambda *args: "fixture-token")
        for result, request_id in [
            ({"isError": False, "content": [{"type": "text", "text": "catalogue"}]}, 2),
            ({"isError": "false", "content": [{"type": "text", "text": "catalogue"}]}, 1),
            ({"isError": False, "content": [{"type": "image", "text": "catalogue"}]}, 1),
            ({"isError": False, "content": [{"type": "text", "text": "catalogue"}, {}]}, 1),
        ]:
            body = json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}).encode()
            with self.subTest(result=result, request_id=request_id), patch.object(
                    auth, "http", return_value=(200, {}, body)):
                with self.assertRaises(auth.EvidenceError):
                    auth.consumer_mcp_owner_denials(auth.Report(Path(".")), deployment, [consumer])

    def test_live_task_scope_denial_cannot_pass_when_task_creation_precedes_authorization(self):
        deployment = SimpleNamespace(required=lambda _: "https://mcp.example.test/mcp")
        denial = {"isError": True, "content": [{
            "type": "text",
            "text": "This operation requires the 'sales.read' scope, which your account does not have.",
        }]}
        for result, expected in [(denial, "PASS"), ({"taskId": "fixture-task"}, "FAIL"),
                                 ({**denial, "taskId": "fixture-task"}, "FAIL")]:
            body = json.dumps({"jsonrpc": "2.0", "id": 43, "result": result}).encode()
            for task in [False, True]:
                with self.subTest(result=result, task=task), patch.object(
                        auth, "http", return_value=(200, {}, body)) as request:
                    report = auth.Report(Path("."))
                    auth.mcp_task_scope_denial(report, deployment, "fixture-token", task=task)
                    self.assertEqual(report.checks[0]["status"], expected)
                    params = request.call_args.kwargs["data"]["params"]
                    self.assertEqual("io.modelcontextprotocol/tasks" in
                                     params["_meta"]["io.modelcontextprotocol/clientCapabilities"]["extensions"], task)

    def test_live_task_ownership_requires_both_owners_all_controls_and_completed_output(self):
        deployment = SimpleNamespace(required=lambda _: "https://mcp.example.test/mcp")
        consumers = [SimpleNamespace(label=label, token=lambda _, scope, label=label: f"{label}:{scope}")
                     for label in ["A", "B"]]
        for scenario in ["complete", "foreign-allowed", "scope-allowed", "tool-error", "missing-output"]:
            calls = []

            def request(method, url, *, token=None, data=None, **kwargs):
                params, rpc_method = data["params"], data["method"]
                calls.append((rpc_method, token))
                self.assertEqual(url, "https://mcp.example.test/mcp")
                self.assertIn("io.modelcontextprotocol/tasks",
                              params["_meta"]["io.modelcontextprotocol/clientCapabilities"]["extensions"])
                task_id = ("1" if token.startswith("A:") else "2") * 32
                if rpc_method == "tools/call":
                    self.assertEqual(params["name"], "get_categories_with_products")
                    result = {"taskId": task_id}
                else:
                    task_id = params["taskId"]
                    owner = "A" if task_id == "1" * 32 else "B"
                    foreign = not token.startswith(owner + ":")
                    reduced = token.endswith(":mcp.access")
                    if ((foreign and scenario != "foreign-allowed") or
                            (reduced and scenario != "scope-allowed")):
                        return 200, {}, json.dumps({
                            "jsonrpc": "2.0", "id": data["id"],
                            "error": {"code": -32602, "message": "Task is not available."},
                        }).encode()
                    result = {"taskId": task_id, "status": "completed", "result": {
                        "isError": scenario == "tool-error", "content": [{
                            "type": "text", "text": "AdventureWorks Product Catalogue\nProductID=1: fixture",
                        }],
                    }}
                    if scenario == "missing-output":
                        del result["result"]
                return 200, {}, json.dumps({"jsonrpc": "2.0", "id": data["id"], "result": result}).encode()

            with self.subTest(scenario=scenario), patch.object(auth, "http", side_effect=request):
                report = auth.Report(Path("."))
                auth.mcp_task_ownership_live(report, deployment, consumers)
                self.assertEqual(len(report.checks), 16)
                self.assertEqual(len(calls), 16)
                self.assertEqual(len(report.inventory["mcpTaskFixtures"]), 2)
                self.assertEqual({check["status"] for check in report.checks},
                                 {"PASS"} if scenario == "complete" else {"PASS", "FAIL"})

    def test_live_task_creation_uncertainty_never_retries_or_claims_owned_history(self):
        deployment = SimpleNamespace(required=lambda _: "https://mcp.example.test/mcp")
        consumers = [SimpleNamespace(label=label, token=lambda *_: "fixture") for label in ["A", "B"]]
        for result, request_id in [({}, 101), ({"taskId": "1" * 32}, 102)]:
            body = json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}).encode()
            with self.subTest(result=result), patch.object(auth, "http", return_value=(200, {}, body)) as request:
                report = auth.Report(Path("."))
                with self.assertRaises(auth.EvidenceError):
                    auth.mcp_task_ownership_live(report, deployment, consumers)
                self.assertEqual(request.call_count, 1)
                self.assertEqual(report.inventory["mcpTaskFixtures"], [])
                self.assertEqual(report.checks, [])

    def test_task_requirement_needs_current_offline_gates_and_complete_deployed_proof(self):
        ids = ["required:mcp-tool-http-dispatch", "required:mcp-task-ownership-offline",
               "mcp-task:scope-before-create"]
        for label in ["A", "B"]:
            ids.extend(f"mcp-task:{label}:{step}" for step in ["created", "completed"])
            ids.extend(f"mcp-task:{label}:{authority}:{method}"
                       for authority in ["other-owner", "missing-scope"]
                       for method in ["tasks/get", "tasks/update", "tasks/cancel"])
            ids.extend(f"mcp-personalized:{label}:products-only:{task}" for task in [False, True])
        for scenario in ["complete", "missing", "duplicate", "blocked", "failed", "offline-missing",
                         "fixtures-missing", "same-task", "unfinished", "wrong-owners"]:
            with self.subTest(scenario=scenario):
                report = auth.Report(Path("."))
                report.add("required:mcp-task-ownership", "required", "BLOCKED", "Unverified")
                for check_id in ids:
                    report.add(check_id, "required" if check_id.startswith("required:") else "live",
                               "PASS", "Current evidence")
                report.inventory["mcpTaskFixtures"] = [
                    {"label": label, "taskId": digit * 32, "status": "completed"}
                    for label, digit in [("A", "1"), ("B", "2")]]
                if scenario in {"missing", "offline-missing"}:
                    del report.checks[-1 if scenario == "missing" else 1]
                elif scenario == "duplicate":
                    report.checks.append(dict(report.checks[-1]))
                elif scenario in {"blocked", "failed"}:
                    report.checks[-1]["status"] = "BLOCKED" if scenario == "blocked" else "FAIL"
                elif scenario == "fixtures-missing":
                    report.inventory.clear()
                elif scenario == "same-task":
                    report.inventory["mcpTaskFixtures"][1]["taskId"] = "1" * 32
                elif scenario == "unfinished":
                    report.inventory["mcpTaskFixtures"][1]["status"] = "working"
                elif scenario == "wrong-owners":
                    report.inventory["mcpTaskFixtures"][1]["label"] = "A"
                auth.reconcile_mcp_task_requirement(report)
                self.assertEqual(report.checks[0]["status"],
                                 "PASS" if scenario == "complete" else
                                 "FAIL" if scenario == "failed" else "BLOCKED")

    def address_read_checks(self, scenario):
        callers = [SimpleNamespace(label=label, business_id=owner, token=lambda _, value=token: value)
                   for label, owner, token in [("A", 7, "A-token"), ("B", 8, "B-token")]]
        calls = []

        def request(method, url, *, token=None, data=None):
            calls.append((method, url, token, data))
            owner = 7 if token == "A-token" else 8
            address = 101 if owner == 7 else 102
            if method == "GET":
                if "limit=100" in url:
                    payload = [] if scenario == "empty" else [{"addressID": address}]
                    if scenario == "invalid-list":
                        payload = [{"addressID": "101"}]
                    return 200, {}, json.dumps(payload).encode()
            if "person-addresses" in url:
                payload = [{"businessEntityID": 99 if scenario == "foreign-person" else owner}]
                status = 200
            else:
                requested = int(url.rsplit("/", 1)[1])
                status = 200 if requested == address or scenario == "owner-leak" else 403
                payload = {"addressID": requested} if status == 200 else {
                    "error": "Unrelated denial" if scenario == "wrong-error" else
                    f"Address {requested} is not owned by the current user."}
                if requested == address and scenario == "bad-own-read":
                    payload = {"addressID": 999}
            return status, {}, b"not JSON" if scenario == "invalid-json" else json.dumps(payload).encode()
        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            with patch.object(auth, "http", side_effect=request):
                report.guarded("addresses:scenario", "ownership", lambda: auth.consumer_address_reads(
                    report, SimpleNamespace(required=lambda _: "https://functions.example.invalid"), callers))
            return report, report.checks, calls

    def test_address_two_owner_reads_use_only_get_and_require_exact_record_and_denial(self):
        _, checks, calls = self.address_read_checks("complete")
        self.assertEqual(len(checks), 8)
        self.assertTrue(all(check["status"] == "PASS" for check in checks), checks)
        self.assertEqual(len(calls), 8)
        self.assertNotIn("A-token", str(checks))
        self.assertNotIn("B-token", str(checks))

    def test_address_empty_fixtures_do_not_prove_ownership(self):
        report, checks, calls = self.address_read_checks("empty")
        self.assertEqual(sum(check["status"] == "BLOCKED" for check in checks), 2)
        self.assertTrue(all(call[0] == "GET" for call in calls))
        self.assertEqual(len(calls), 4)
        self.assertNotIn("consumerAddressFixtures", report.inventory)

    def test_address_invalid_or_unauthorized_data_cannot_pass(self):
        for scenario in ["foreign-person", "invalid-list", "invalid-json",
                         "owner-leak", "wrong-error", "bad-own-read"]:
            with self.subTest(scenario=scenario):
                _, checks, _ = self.address_read_checks(scenario)
                self.assertTrue(any(check["status"] in {"FAIL", "BLOCKED"} for check in checks), checks)

    def test_address_handler_evidence_requires_exact_current_run_success(self):
        prefix = "ApiFunctions.Tests.AddressOwnershipTests."
        service_prefix = "ApiFunctions.Tests.AddressServiceOwnershipTests."
        names = {prefix + name for name in [
            "Missing_consumer_owner_never_reads_global_addresses",
            "Internal_listing_preserves_global_pagination",
            "Internal_address_delete_keeps_the_existing_service_path",
            "Internal_address_update_keeps_the_existing_service_path",
        ]}
        for owner, address in [(7, 101), (8, 102)]:
            names.update([
                prefix + f"Consumer_listing_scopes_sql_before_pagination(owner: {owner}, expectedAddress: {address})",
                prefix + f"Own_address_read_succeeds(owner: {owner}, address: {address})",
                prefix + f"Own_address_update_uses_atomic_owner_bound_service(owner: {owner}, address: {address})",
                prefix + f"Shared_address_update_returns_conflict_without_mutation(owner: {owner}, address: {address})",
                prefix + f"Own_address_delete_uses_atomic_owner_bound_service(owner: {owner}, address: {address})",
                prefix + f"Create_and_person_queries_override_supplied_other_owner(owner: {owner})",
                prefix + f"Own_type_update_ignores_supplied_other_owner(owner: {owner}, address: {address})",
            ])
            names.update(prefix + f'Other_owner_address_never_reaches_data_or_mutation(owner: {owner}, '
                         f'address: {102 if owner == 7 else 101}, operation: "{operation}")'
                         for operation in ["GET", "PUT", "DELETE", "TYPE"])
        names.update(prefix + f'Missing_owner_denied_before_even_ownership_lookup(operation: "{operation}")'
                     for operation in ["GET", "PUT", "DELETE", "TYPE"])
        for owner in [0, -1]:
            names.add(prefix + f"Nonpositive_consumer_owner_cannot_list_create_or_query_people(owner: {owner})")
            names.update(prefix + f'Nonpositive_consumer_owner_denied_before_data(owner: {owner}, operation: "{operation}")'
                         for operation in ["GET", "PUT", "DELETE", "TYPE"])
        names.add(service_prefix + "Delete_failure_does_not_commit_unlinking")
        names.add(service_prefix + "Unchanged_shared_address_can_still_be_saved_without_physical_mutation")
        names.add(service_prefix + "Removed_owner_before_update_cannot_mutate_and_rolls_back")
        names.add(service_prefix + "Update_failure_does_not_commit")
        names.update(service_prefix + f"Delete_removes_only_the_signed_owners_links_and_unreferenced_address(owner: {owner}, address: {address})"
                     for owner, address in [(7, 101), (8, 102)])
        names.update(service_prefix + f"Foreign_or_missing_address_rolls_back_without_changes(owner: {owner}, address: {address})"
                     for owner, address in [(8, 101), (7, 102), (7, 999)])
        names.update(service_prefix + f"Shared_or_order_referenced_address_is_retained(shared: {shared})"
                     for shared in ["True", "False"])
        names.update(service_prefix + f"Single_read_filters_in_the_address_query(owner: {owner}, address: {address}, allowed: {allowed})"
                     for owner, address, allowed in [(7, 101, "True"), (8, 102, "True"),
                                                     (7, 102, "False"), (8, 101, "False")])
        names.update(service_prefix + f"Owned_update_checks_links_and_orders_in_one_serializable_transaction(owner: {owner}, address: {address})"
                     for owner, address in [(7, 101), (8, 102)])
        names.update(service_prefix + f"Foreign_or_missing_update_never_mutates(owner: {owner}, address: {address})"
                     for owner, address in [(8, 101), (7, 102), (7, 999)])
        names.update(service_prefix + f'Shared_link_or_other_order_blocks_physical_update(sharing: "{sharing}")'
                     for sharing in ["link", "foreign-order", "unbound-order"])
        self.assertEqual(len(names), 63)
        for scenario, expected in [("complete", "PASS"), ("missing", "BLOCKED"), ("skipped", "BLOCKED"),
                                   ("failed", "FAIL"), ("duplicate", "BLOCKED"), ("new", "BLOCKED"),
                                   ("absent", "BLOCKED")]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                output = Path(directory)
                (output / "dotnet").mkdir()
                tree = ET.Element("TestRun")
                results = ET.SubElement(tree, "Results")
                for index, name in enumerate(sorted(names)):
                    if scenario == "missing" and index == 0:
                        continue
                    outcome = "Failed" if scenario == "failed" and index == 0 else (
                        "NotExecuted" if scenario == "skipped" and index == 0 else "Passed")
                    ET.SubElement(results, "UnitTestResult", testName=name, outcome=outcome)
                    if scenario == "duplicate" and index == 0:
                        ET.SubElement(results, "UnitTestResult", testName=name, outcome="Passed")
                if scenario == "new":
                    ET.SubElement(results, "UnitTestResult", testName=prefix + "Unreconciled_case", outcome="Passed")
                if scenario != "absent":
                    ET.ElementTree(tree).write(output / "dotnet" / "current.trx")
                report = auth.Report(output)
                auth.address_ownership_evidence(report)
                self.assertEqual(report.checks[0]["status"], expected)

    def run_native_dab_mcp(self, scenario):
        calls = []
        cleanup_attempts = 0
        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            deployment = SimpleNamespace(required=lambda _: "https://dab.example.invalid/graphql/")

            def http(method, url, *, token=None, data=None, headers=None, opener=None):
                nonlocal cleanup_attempts
                self.assertEqual(url, "https://dab.example.invalid/mcp")
                calls.append((method, token, data, dict(headers), opener))
                if method == "DELETE":
                    cleanup_attempts += 1
                    self.assertEqual(headers["Mcp-Session-Id"], "owned-protocol-session")
                    if scenario == "cleanup-timeout-once" and cleanup_attempts == 1:
                        raise auth.EvidenceError("Network/TLS/timeout failure")
                    if scenario == "cleanup-timeout-twice":
                        raise auth.EvidenceError("Network/TLS/timeout failure")
                    return (500 if scenario == "cleanup-failure" else 200), {}, b""
                self.assertEqual(method, "POST")
                self.assertIn(data["method"], {"initialize", "notifications/initialized", "tools/list", "tools/call"})
                if data["method"] != "initialize":
                    self.assertEqual(headers["Mcp-Session-Id"], "owned-protocol-session")
                    self.assertEqual(headers["MCP-Protocol-Version"], "2025-03-26")
                if data["method"] == "notifications/initialized":
                    self.assertNotIn("id", data)
                    return 202, {}, b""
                if token in {"invalid-auth-validation-token", "functions-token"}:
                    return 401, {}, b""
                if headers.get("X-MS-API-ROLE") == "executive-admin":
                    return 403, {}, b""
                if headers.get("Origin") == "https://untrusted.example.invalid":
                    return 403, {}, b""
                response_headers = {}
                if data["method"] == "initialize":
                    response_headers["Mcp-Session-Id"] = "owned-protocol-session"
                    if scenario == "missing-session":
                        response_headers.clear()
                    cookie_handler = next(handler for handler in opener.handlers if isinstance(
                        handler, auth.urllib.request.HTTPCookieProcessor))
                    cookie_handler.cookiejar.set_cookie(auth.cookiejar.Cookie(
                        0, "aca-affinity", "replica", None, False, "dab.example.invalid", False, False,
                        "/", True, False, None, True, None, None, {}, False))
                    result = {"protocolVersion": "2025-03-26"}
                elif data["method"] == "tools/list":
                    cookie_handler = next(handler for handler in opener.handlers if isinstance(
                        handler, auth.urllib.request.HTTPCookieProcessor))
                    self.assertTrue(any(cookie.name == "aca-affinity" for cookie in cookie_handler.cookiejar))
                    requirements = {
                        "aggregate_records": ["entity", "function"], "create_record": ["entity", "data"],
                        "delete_record": ["entity", "keys"], "describe_entities": [],
                        "execute_entity": ["entity"], "read_records": ["entity"],
                        "update_record": ["entity", "keys", "fields"],
                    }
                    tools = [{"name": name, "inputSchema": {"type": "object", "required": required,
                              "properties": {field: {} for field in required}}}
                             for name, required in requirements.items()]
                    if scenario == "duplicate-tools":
                        tools[-1] = tools[0]
                    if scenario == "invalid-required":
                        tools[0]["inputSchema"]["required"] = None
                    result = {"tools": tools}
                else:
                    self.assertEqual(data["params"]["name"], "read_records")
                    arguments = data["params"]["arguments"]
                    self.assertEqual(arguments["first"], 1)
                    entity, field = arguments["entity"], arguments["select"]
                    self.assertIn((entity, field), {
                        ("Product", "ProductID"), ("WorkOrder", "WorkOrderID"), ("Employee", "BusinessEntityID"),
                    })
                    denied = entity == "Employee" or token is None and scenario != "session-authority-leak"
                    if denied:
                        payload = {"status": "error", "error": {"type": (
                            "ValidationError" if scenario == "not-a-permission-denial" else "PermissionDenied")}}
                    else:
                        payload = {"status": "success", "entity": entity, "result": {"value": [{field: 1}]}}
                    result = {"content": [{"type": "text", "text": json.dumps(payload)}]}
                    if denied:
                        result["isError"] = True
                    if scenario == "invalid-read-content":
                        result["content"][0]["text"] = "{invalid-json"
                response = {"jsonrpc": "2.0", "id": data["id"], "result": result}
                if scenario == "mismatched-id" and data["method"] == "tools/list":
                    response["id"] = 99999
                return 200, response_headers, json.dumps(response).encode()

            with patch.object(auth, "http", side_effect=http):
                report.guarded("dab-mcp:scenario", "live-allows", lambda: auth.native_dab_mcp(
                    report, deployment, "dab-token", "functions-token", "manufacturing-engineer"))
            return report.checks, calls

    def test_native_dab_mcp_requires_real_read_shape_auth_denials_and_exact_session_cleanup(self):
        checks, calls = self.run_native_dab_mcp("complete")
        self.assertEqual(len(checks), 13)
        self.assertTrue(all(check["status"] == "PASS" for check in checks), checks)
        self.assertEqual(calls[-1][0], "DELETE")
        self.assertEqual(len([call for call in calls if call[0] == "DELETE"]), 1)
        self.assertFalse(any("owned-protocol-session" in str(check) for check in checks))
        opener = calls[0][4]
        self.assertIsNotNone(opener)
        self.assertTrue(any(isinstance(handler, auth.urllib.request.HTTPCookieProcessor)
                            for handler in opener.handlers))
        self.assertTrue(all(call[4] is opener for call in calls))

    def test_native_dab_mcp_failures_never_count_as_permission_evidence_and_cleanup_still_runs(self):
        for scenario in ["session-authority-leak", "not-a-permission-denial", "cleanup-failure",
                         "cleanup-timeout-twice", "missing-session", "duplicate-tools", "invalid-required"]:
            with self.subTest(scenario=scenario):
                checks, calls = self.run_native_dab_mcp(scenario)
                self.assertTrue(any(check["status"] == "FAIL" for check in checks), checks)
                if scenario != "missing-session":
                    self.assertEqual(calls[-1][0], "DELETE")
                if scenario in {"duplicate-tools", "invalid-required", "missing-session"}:
                    self.assertFalse(any(call[2] and call[2]["method"] == "tools/call" for call in calls))

    def test_native_dab_mcp_retries_exact_session_delete_once_after_network_uncertainty(self):
        checks, calls = self.run_native_dab_mcp("cleanup-timeout-once")
        self.assertTrue(all(check["status"] == "PASS" for check in checks), checks)
        deletes = [call for call in calls if call[0] == "DELETE"]
        self.assertEqual(len(deletes), 2)
        self.assertEqual(deletes[0][3]["Mcp-Session-Id"], deletes[1][3]["Mcp-Session-Id"])
        self.assertFalse(any("owned-protocol-session" in str(check) for check in checks))

    def test_native_dab_mcp_malformed_rpc_is_blocked_and_terminates_only_its_session(self):
        for scenario in ["mismatched-id", "invalid-read-content"]:
            with self.subTest(scenario=scenario):
                checks, calls = self.run_native_dab_mcp(scenario)
                self.assertTrue(any(check["status"] == "BLOCKED" for check in checks), checks)
                self.assertEqual(calls[-1][0], "DELETE")

    def run_dab_startup(self, values):
        with tempfile.TemporaryDirectory() as directory:
            for name in ["dab", "dotnet"]:
                executable = Path(directory) / name
                executable.write_text('#!/bin/sh\nprintf "MCP_HOST=%s\\n" "$DAB_MCP_ALLOWED_HOST"\n')
                executable.chmod(0o700)
            environment = {
                "PATH": directory + os.pathsep + os.defpath,
                "DB_PERIOD_SECONDS": "0",
                **values,
            }
            return subprocess.run(
                ["sh", "-c", 'cd() { :; }; . "$1"', "startup-test", str(auth.ROOT / "api/entrypoint.sh")],
                env=environment, capture_output=True, text=True, timeout=5)

    def test_dab_mcp_startup_derives_canonical_not_revision_host_and_preserves_exact_override(self):
        for values, expected in [
            ({}, "localhost"),
            ({"CONTAINER_APP_NAME": "test-api", "CONTAINER_APP_ENV_DNS_SUFFIX": "env.example.invalid",
              "CONTAINER_APP_HOSTNAME": "test-api--revision.env.example.invalid"}, "test-api.env.example.invalid"),
            ({"DAB_MCP_ALLOWED_HOST": "custom.example.invalid"}, "custom.example.invalid"),
        ]:
            with self.subTest(values=values):
                result = self.run_dab_startup(values)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("MCP_HOST=" + expected + "\n", result.stdout)

    def test_dab_mcp_startup_fails_before_launch_for_incomplete_platform_or_unsafe_host(self):
        cases = [{"CONTAINER_APP_NAME": "test-api"},
                 {"CONTAINER_APP_ENV_DNS_SUFFIX": "env.example.invalid"},
                 {"IDENTITY_ENDPOINT": "http://identity.invalid"}]
        cases += [{"DAB_MCP_ALLOWED_HOST": value} for value in [
            "*", "*.example.invalid", "https://host.example.invalid", "host.example.invalid:443",
            "host example.invalid", "host\n.example.invalid", "-host", "host..example.invalid",
        ]]
        for values in cases:
            with self.subTest(values=values):
                result = self.run_dab_startup(values)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("MCP_HOST=", result.stdout)
                self.assertIn("MCP trusted host", result.stdout)

    def test_dab_mcp_config_preserves_exact_host_validation_and_oauth(self):
        config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
        self.assertEqual(config["runtime"]["mcp"]["allowed-hosts"], ["@env('DAB_MCP_ALLOWED_HOST')"])
        self.assertTrue(config["runtime"]["mcp"]["enabled"])
        self.assertEqual(config["runtime"]["host"]["authentication"], {
            "provider": "AzureAD",
            "jwt": {"audience": "@env('DAB_JWT_AUDIENCE')", "issuer": "@env('DAB_JWT_ISSUER')"},
        })

    def test_local_internal_browser_requires_exact_complete_tap_summary(self):
        complete = "# tests 12\n# suites 0\n# pass 12\n# fail 0\n"
        cases = [
            (complete, "PASS"),
            ("# tests 11\n# pass 11\n# fail 0\n", "FAIL"),
            (complete + "# fail 1\n", "FAIL"),
            ("# tests 12\n# pass 12\n", "FAIL"),
        ]
        for output, status in cases:
            with self.subTest(output=output), patch.object(auth, "command", return_value=output):
                report = auth.Report(Path("."))
                auth.internal_session_browser(report)
                self.assertEqual(report.checks[-1]["status"], status)

    def test_internal_browser_requires_complete_nonduplicated_real_scenarios(self):
        scenarios = [
            "anonymous-gate-no-data", "pkce-resource-role-owner", "resource-server-read", "real-refresh-exchange",
            "renewal-preserves-route", "logout-clears-resource-sessions", "logout-gates-deep-link", "no-business-mutations",
            "renewal-resource-role-owner", "renewed-resource-server-read",
            "same-origin-second-tab-owner", "same-origin-second-tab-resource-read", "no-token-to-untrusted-origin",
            "same-origin-second-tab-signout", "same-user-new-generation-owner",
            "same-user-new-generation-resource-read", "stale-second-tab-no-adoption",
        ]
        checks = [{"name": app + ":" + scenario, "status": "PASS"}
                  for app in ["admin", "manufacturing"] for scenario in scenarios]
        checks.extend({"name": "manufacturing:" + scenario, "status": "PASS"} for scenario in [
            "reorder-progress-current-generation", "reorder-progress-isolated-after-login"])
        for scenario, expected in [("complete", "PASS"), ("missing", "FAIL"), ("missing-transition", "FAIL"),
                                   ("missing-reorder", "FAIL"), ("duplicate", "FAIL"),
                                   ("anonymous-request", "FAIL"),
                                   ("process-failure", "FAIL"), ("blocked", "BLOCKED"),
                                   ("read-timeout", "FAIL"), ("forbidden", "FAIL"), ("mutation", "FAIL"),
                                   ("read-duplicate", "FAIL"), ("wrong-policy", "FAIL"),
                                   ("slow-renewal", "FAIL"), ("over-budget", "FAIL"),
                                   ("deadline-boundary", "PASS"), ("invalid-body", "FAIL"),
                                   ("body-timeout", "FAIL"), ("token-origin", "FAIL")]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                report = auth.Report(root)
                selected = [dict(item) for item in checks]
                anonymous_requests = []
                if scenario == "missing":
                    selected.pop()
                if scenario == "missing-transition":
                    selected = [item for item in selected if item["name"] != "admin:stale-second-tab-no-adoption"]
                if scenario == "missing-reorder":
                    selected = [item for item in selected
                                if item["name"] != "manufacturing:reorder-progress-isolated-after-login"]
                if scenario == "duplicate":
                    selected[-1] = dict(selected[0])
                if scenario == "anonymous-request":
                    next(item for item in selected
                         if item["name"] == "manufacturing:anonymous-gate-no-data")["status"] = "FAIL"
                    anonymous_requests = [{
                        "site": "manufacturing", "service": "functions", "method": "GET",
                    }]
                if scenario == "blocked":
                    selected = [{"name": "browser-prerequisites", "status": "BLOCKED"}]
                deployment = SimpleNamespace(required=lambda key: "https://deployment.example.invalid",
                                             values={})
                policy = json.loads((Path(__file__).with_name("browser-policy.json")).read_text())
                reads = [{"site": app, "phase": app + ":" + phase, "status": 200, "valid": True,
                          "durationMs": 130000 if phase == "real-dab-read" else 60,
                          "timeoutMs": 240000 if phase == "real-dab-read" else 90000,
                          "startupEligible": phase == "real-dab-read", "slow": phase == "real-dab-read"}
                         for app in ["admin", "manufacturing"]
                         for phase in ["real-dab-read", "renewal", "same-origin-second-tab",
                                       "same-user-new-generation"]]
                if scenario in {"process-failure", "read-timeout"}:
                    reads[0].update(status=0, valid=False, durationMs=240001, error="timeout")
                if scenario == "forbidden":
                    reads[0]["status"] = 403
                if scenario == "read-duplicate":
                    reads[-1] = dict(reads[0])
                if scenario == "slow-renewal":
                    reads[1].update(durationMs=90001, slow=True)
                if scenario in {"over-budget", "deadline-boundary"}:
                    reads[0]["durationMs"] = 240000 if scenario == "deadline-boundary" else 240001
                if scenario in {"invalid-body", "body-timeout"}:
                    reads[0]["valid"] = False
                if scenario == "body-timeout":
                    reads[0]["error"] = "timeout"

                def command(arguments, *, environment, timeout):
                    self.assertEqual(arguments[:2], ["node", "tests/scripts/test-internal-browser-auth.mjs"])
                    self.assertEqual(timeout, 1200)
                    self.assertEqual(environment["AUTH_BROWSER_ADMIN_EMAIL"], "admin@example.invalid")
                    (root / "internal-browser.json").write_text(json.dumps({
                        "phase": "complete", "checks": selected,
                        "anonymousRequests": anonymous_requests,
                        "error": {"category": "timeout"} if scenario == "process-failure" else None,
                        "reads": reads, "readPolicy": {} if scenario == "wrong-policy" else policy,
                        "blockedMutations": 1 if scenario == "mutation" else 0,
                        "tokenOriginViolations": 1 if scenario == "token-origin" else 0,
                        "transport": [
                            {"site": "admin", "method": "GET", "event": "failed", "elapsedMs": 90001,
                             "reason": "net::ERR_ABORTED", "corsFailure": True, "protocol": "h2",
                             "timingMs": {"sendStart": 1, "receiveHeadersEnd": 76000,
                                          "private-value-must-not-be-exported": 1}},
                            {"site": "admin", "method": "GET", "event": "failed", "elapsedMs": 90001,
                             "reason": "private-value-must-not-be-exported"},
                            {"site": "admin", "method": "GET", "event": "private-value-must-not-be-exported",
                             "elapsedMs": 1},
                        ] if scenario == "process-failure" else [],
                    }))
                    if scenario == "process-failure":
                        raise auth.EvidenceError("Browser failed")
                    return ""

                helper = SimpleNamespace(IDENTITIES={
                    "admin": ("admin@example.invalid", "fixture-password"),
                    "manufacturing": ("manufacturing@example.invalid", "fixture-password"),
                })
                with patch.object(auth, "load_auth_helper", return_value=helper), \
                        patch.object(auth, "command", side_effect=command):
                    auth.internal_browser(report, deployment)
                self.assertEqual(report.checks[-1]["status"], expected)
                self.assertIn("slow read; startup cause not established", report.checks[-1]["detail"])
                self.assertIn("deadline 240000ms", report.checks[-1]["detail"])
                if scenario == "process-failure":
                    self.assertIn("sanitized failure category: timeout", report.checks[-1]["detail"])
                    self.assertIn("admin GET failed 90001ms CORS failure net::ERR_ABORTED",
                                  report.checks[-1]["detail"])
                    self.assertIn("h2 sendStart=1ms receiveHeadersEnd=76000ms", report.checks[-1]["detail"])
                    self.assertNotIn("private-value-must-not-be-exported", report.checks[-1]["detail"])
                if scenario == "anonymous-request":
                    self.assertIn("anonymous API request attempts: manufacturing/functions/GET",
                                  report.checks[-1]["detail"])

    def test_all_sites_browser_requirement_needs_all_complete_site_evidence(self):
        evidence_ids = [
            "browser:internal:complete",
            "browser:inspector:complete",
            "browser:guest-cart:complete",
        ]
        for statuses, expected in [
                (["PASS", "PASS", "PASS"], "PASS"),
                (["PASS", "BLOCKED", "PASS"], "BLOCKED"),
                (["PASS", "FAIL", "PASS"], "FAIL")]:
            with self.subTest(statuses=statuses), tempfile.TemporaryDirectory() as directory:
                report = auth.Report(Path(directory))
                report.add("required:browser-real-login-all-sites", "required", "BLOCKED", "Pending browser evidence")
                for check_id, status in zip(evidence_ids, statuses):
                    report.add(check_id, "frontend", status, "fixture")
                auth.reconcile_browser_auth_requirement(report)
                required = next(item for item in report.checks
                                if item["id"] == "required:browser-real-login-all-sites")
                self.assertEqual(required["status"], expected)

    def test_inspector_browser_requires_exact_complete_read_only_current_process_evidence(self):
        helper = SimpleNamespace(IDENTITIES={"manufacturing": ("engineer@example.invalid", "fixture-password"),
                                            "admin": ("admin@example.invalid", "fixture-password")})
        deployment = SimpleNamespace(required=lambda _: "https://deployment.example.invalid")
        for scenario, expected in [("complete", "PASS"), ("missing", "FAIL"), ("duplicate", "FAIL"),
                                   ("mutation", "FAIL"), ("failed", "FAIL"), ("blocked", "BLOCKED"),
                                   ("old-matrix", "FAIL"), ("over-budget", "FAIL"), ("wrong-status", "FAIL"),
                                   ("missing-startup", "FAIL"), ("wrong-policy", "FAIL"), ("slow-flag", "FAIL")]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                report = auth.Report(root)
                checks = [{"name": name, "status": "PASS"} for name in sorted(auth.INSPECTOR_BROWSER_CHECKS)]
                if scenario == "missing":
                    checks.pop()
                if scenario == "duplicate":
                    checks[-1] = dict(checks[0])
                if scenario == "blocked":
                    checks = [{"name": "browser-prerequisites", "status": "BLOCKED"}]
                if scenario == "old-matrix":
                    checks = [check for check in checks if check["name"] not in {
                        "same-context-second-tab-authenticated", "independent-admin-session"}]
                policy = json.loads((Path(auth.__file__).with_name("browser-policy.json")).read_text())
                startup = {"status": 401, "durationMs": 100, "timeoutMs": policy["startupReadTimeoutMs"], "slow": False}
                if scenario == "over-budget":
                    startup["durationMs"] = policy["startupReadTimeoutMs"] + 1
                    startup["slow"] = True
                if scenario == "wrong-status":
                    startup["status"] = 200
                if scenario == "missing-startup":
                    startup = None
                if scenario == "slow-flag":
                    startup["slow"] = True

                def command(arguments, *, environment, timeout):
                    self.assertEqual(arguments[:2], ["node", "tests/scripts/test-inspector-browser-auth.mjs"])
                    self.assertEqual(environment["AUTH_BROWSER_MANUFACTURING_EMAIL"], "engineer@example.invalid")
                    self.assertEqual(environment["AUTH_BROWSER_ADMIN_EMAIL"], "admin@example.invalid")
                    self.assertEqual(timeout, 1200)
                    (root / "inspector-browser.json").write_text(json.dumps({
                        "phase": "complete", "checks": checks, "blockedMutations": 1 if scenario == "mutation" else 0,
                        "startupRead": startup, "policy": {} if scenario == "wrong-policy" else policy,
                    }))
                    if scenario == "failed":
                        raise auth.EvidenceError("Browser failed after writing partial evidence")
                    return ""

                with patch.object(auth, "load_auth_helper", return_value=helper), \
                        patch.object(auth, "command", side_effect=command):
                    auth.inspector_browser(report, deployment)
                self.assertEqual(report.checks[-1]["status"], expected)

    def test_deployed_functions_denials_require_status_policy_error_and_exact_metadata(self):
        for defect in [None, "status", "error", "metadata", "not-json", "transport"]:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                report = auth.Report(Path(directory))
                report.inventory["functions"] = [
                    {"Name": name, "Route": route, "Methods": ["GET"], "Policy": {"IsAnonymous": False}}
                    for name, route in [("GetManufacturingAgentQueueStatus", "manufacturing/agent-queue-status"),
                                        ("AIJobQueue_Status", "ai-job-queue/status")]]
                report.inventory["functions"].append({
                    "Name": "CreateOrderDetail",
                    "Route": "orders/{salesOrderId:int}/details",
                    "Methods": ["POST"],
                    "Policy": {"IsAnonymous": False},
                })
                report.inventory["functions"].append({
                    "Name": "CreateOrderHeader",
                    "Route": "orders",
                    "Methods": ["POST"],
                    "Policy": {"IsAnonymous": False},
                })
                deployment = SimpleNamespace(required=lambda key: "https://selected.example.invalid/mcp" if
                                             key == "API_MCP_URL" else "https://functions.example.invalid")
                calls = []

                def http(method, url, *, token=None, headers=None, data=None):
                    if url.endswith("/api/orders/1/details"):
                        self.assertEqual(method, "POST")
                        self.assertEqual(data, {
                            "productId": 0, "orderQty": 0, "unitPrice": 0, "unitPriceDiscount": 0})
                    elif url.endswith("/api/orders"):
                        self.assertEqual(method, "POST")
                        self.assertEqual(data, {
                            "billToAddressId": 0, "shipToAddressId": 0, "shipMethodId": 0, "subTotal": -1})
                    else:
                        self.assertEqual(method, "GET")
                    self.assertTrue(url.startswith("https://functions.example.invalid/api/"))
                    calls.append((method, url, token, headers, data))
                    invalid = token in {None, "invalid-auth-validation-token", "dab-token", "mcp-token"}
                    status = 401 if invalid else 403
                    error = ("missing_token" if token is None else "invalid_token") if invalid else "insufficient_scope"
                    if defect == "transport":
                        raise auth.EvidenceError("Network failure; not an authorization denial")
                    metadata = "https://selected.example.invalid/.well-known/oauth-protected-resource"
                    if defect == "metadata":
                        metadata = metadata.replace("/.well-known", "//.well-known")
                    return (200 if defect == "status" else status), {
                        "WWW-Authenticate": f'Bearer resource_metadata="{metadata}", error="{error}"'
                    }, b"bad-json" if defect == "not-json" else json.dumps(
                        {"error": "wrong-error" if defect == "error" else error}).encode()

                consumer = SimpleNamespace(token=lambda resource: "consumer-token")
                with patch.object(auth, "http", side_effect=http):
                    auth.functions_host_read_denials(report, deployment,
                        {"dab": "dab-token", "mcp": "mcp-token", "functions": "manufacturing-token"}, consumer)
                self.assertEqual(len(calls), 11)
                expected = "PASS" if defect is None else "BLOCKED" if defect in {"not-json", "transport"} else "FAIL"
                self.assertTrue(all(check["status"] == expected for check in report.checks))
                forged_headers = next(call[3] for call in calls
                                      if call[3] and call[3].get("X-MS-API-ROLE"))
                self.assertEqual(forged_headers["X-MS-API-ROLE"], "executive-admin")

    def test_dab_order_write_denials_use_both_owners_and_require_auth_not_found_errors(self):
        report = auth.Report(Path("."))
        deployment = SimpleNamespace(required=lambda _: "https://dab.example.invalid/graphql/")
        consumers = [
            SimpleNamespace(label=label, business_id=owner,
                            token=lambda resource, label=label: label + "-" + resource)
            for label, owner in [("A", 7), ("B", 8)]
        ]
        calls = []

        def http(method, url, *, token=None, headers=None, data=None):
            calls.append((method, url, token, headers, data))
            field = "updateSalesOrderHeader" if "updateSalesOrderHeader" in data["query"] else "createSalesOrderDetail"
            return 200, {}, json.dumps({
                "data": {field: None},
                "errors": [{
                    "message": "The current user is not authorized to access this resource.",
                    "path": [field],
                    "extensions": {"code": "AUTH_NOT_AUTHORIZED"},
                }],
            }).encode()

        with patch.object(auth, "http", side_effect=http):
            auth.dab_order_write_denials(report, deployment, consumers)
        self.assertEqual([check["status"] for check in report.checks], ["PASS"] * 4)
        self.assertEqual([call[2] for call in calls], ["A-dab", "A-dab", "B-dab", "B-dab"])
        self.assertTrue(all(call[3] == {"X-MS-API-ROLE": "consumer"} for call in calls))
        self.assertTrue(all("SalesOrderID: 0" in call[4]["query"] or
                            "SalesOrderID: -1" in call[4]["query"] for call in calls))

    def test_dab_order_write_denial_does_not_accept_database_or_validation_errors(self):
        report = auth.Report(Path("."))
        deployment = SimpleNamespace(required=lambda _: "https://dab.example.invalid/graphql/")
        consumer = SimpleNamespace(label="A", business_id=7, token=lambda resource: "consumer-dab")
        response = {
            "data": {"updateSalesOrderHeader": None},
            "errors": [{"message": "Foreign key violation", "path": ["updateSalesOrderHeader"],
                        "extensions": {"code": "SQL_ERROR"}}],
        }
        with patch.object(auth, "http", return_value=(200, {}, json.dumps(response).encode())):
            with self.assertRaises(auth.EvidenceError):
                auth.dab_order_write_denials(report, deployment, [consumer, SimpleNamespace(
                    label="B", business_id=8, token=lambda resource: "other-dab")])
        self.assertEqual(report.checks[0]["status"], "FAIL")

    def test_live_function_denials_only_request_exact_reviewed_get_routes(self):
        report = auth.Report(Path("."))
        entries = [
            ("GetManufacturingAgentQueueStatus", "manufacturing/agent-queue-status", ["GET"]),
            ("AIJobQueue_Status", "ai-job-queue/changed", ["GET"]),
            ("FutureFunction", "future", ["GET"]),
            ("ArchiveTransactionHistoryHttp", "archive/trigger", ["GET"]),
            ("OrderDelivery_HttpTrigger", "orders/delivery/trigger", ["GET"]),
            ("ManufacturingStatus", "manufacturing/status", ["GET"]),
            ("TranslateLanguageFile_Terminate", "TranslateLanguageFile_Terminate", ["GET", "POST"]),
            ("MergeGuestCart", "cart/merge", ["POST"]),
            ("GetAddresses", "addresses", ["GET", "POST"]),
            ("FutureHead", "future-head", ["HEAD"]),
        ]
        report.inventory["functions"] = [
            {"Name": name, "Route": route, "Methods": methods, "Policy": {"IsAnonymous": False}}
            for name, route, methods in entries
        ]
        with patch.object(auth, "http", return_value=(401, {}, b"")) as http:
            obligations = auth.function_denial_obligations(report, "https://functions.example.invalid")
            auth.live_denial_probes(report, obligations)
        self.assertEqual(http.call_count, 2)
        self.assertEqual({call.args[1] for call in http.call_args_list},
                         {"https://functions.example.invalid/api/manufacturing/agent-queue-status"})
        statuses = {check["id"]: check["status"] for check in report.checks}
        self.assertEqual(statuses["functions:GetManufacturingAgentQueueStatus:GET:anonymous"], "PASS")
        self.assertEqual(statuses["functions:GetManufacturingAgentQueueStatus:GET:forged"], "PASS")
        for name, _, methods in entries[1:]:
            for method in methods:
                self.assertEqual(statuses[f"functions:{name}:{method}:deny"], "BLOCKED")

    def test_live_function_denials_reject_duplicate_inventory_before_any_request(self):
        report = auth.Report(Path("."))
        function = {"Name": "GetAddresses", "Route": "addresses", "Methods": ["GET"],
                    "Policy": {"IsAnonymous": False}}
        report.inventory["functions"] = [function, copy.deepcopy(function)]
        with patch.object(auth, "http") as http, self.assertRaises(auth.EvidenceError):
            auth.function_denial_obligations(report, "https://functions.example.invalid")
        http.assert_not_called()

    def test_host_denial_probes_require_reviewed_get_only_routes_before_any_request(self):
        for defect in ["missing", "mutation", "anonymous", "parameterized", "changed"]:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                report = auth.Report(Path(directory))
                report.inventory["functions"] = [
                    {"Name": name, "Route": route, "Methods": ["GET"], "Policy": {"IsAnonymous": False}}
                    for name, route in [("GetManufacturingAgentQueueStatus", "manufacturing/agent-queue-status"),
                                        ("AIJobQueue_Status", "ai-job-queue/status")]]
                if defect == "missing":
                    report.inventory["functions"].pop()
                elif defect == "mutation":
                    report.inventory["functions"][0]["Methods"] = ["POST"]
                elif defect == "anonymous":
                    report.inventory["functions"][0]["Policy"]["IsAnonymous"] = True
                elif defect == "parameterized":
                    report.inventory["functions"][0]["Route"] = "manufacturing/{id}"
                else:
                    report.inventory["functions"][0]["Route"] = "manufacturing/status"
                deployment = SimpleNamespace(required=lambda _: "https://selected.example.invalid")
                with patch.object(auth, "http") as http, self.assertRaises(auth.EvidenceError):
                    auth.functions_host_read_denials(report, deployment,
                        {"dab": "dab-token", "mcp": "mcp-token", "functions": "manufacturing-token"})
                http.assert_not_called()

    def test_scope_read_matrix_requires_exact_denials_and_never_calls_unreviewed_routes(self):
        deployment = SimpleNamespace(values={}, required=lambda key: {
            "API_MCP_URL": "https://mcp.example.invalid/mcp",
            "API_FUNCTIONS_URL": "https://functions.example.invalid",
        }[key])
        claims = {
            "aud": "https://mcp.example.invalid/functions", "category": "consumer",
            "business_entity_id": "7", "scope": "mcp.access", "exp": int(auth.time.time()) + 600,
        }
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        token = "header." + payload + ".signature"
        consumer = SimpleNamespace(label="A", business_id=7, token=lambda resource, scopes: token)
        functions = [
            ("AIJobQueue_Status", "ai-job-queue/status", ["GET"], "admin.read"),
            ("GetAddresses", "addresses", ["GET"], "customers.read"),
            ("ArchiveTransactionHistoryHttp", "archive/trigger", ["GET"], "admin.write"),
            ("GetScrapConfig", "manufacturing/reset", ["GET"], "manufacturing.read"),
            ("TranslateLanguageFile_Terminate", "TranslateLanguageFile_Terminate", ["GET", "POST"], "admin.write"),
            ("WarehouseMetrics", "warehouse/metrics", ["GET"], None),
        ]
        report = auth.Report(Path("."))
        report.add("addresses:A:list", "ownership", "PASS", "Real consumer read.")
        report.inventory["functions"] = [
            {"Name": name, "Route": route, "Methods": methods,
             "Policy": {"IsAnonymous": False, "FunctionName": name, "RequiredScope": scope}}
            for name, route, methods, scope in functions
        ]
        calls = []

        def http(method, url, *, token=None):
            calls.append((method, url, token))
            scope = "admin.read" if url.endswith("/ai-job-queue/status") else "customers.read"
            body = {"error": "insufficient_scope",
                    "error_description": f"The token is missing the required scope '{scope}'."}
            challenge = ('Bearer resource_metadata="https://mcp.example.invalid/.well-known/'
                         'oauth-protected-resource", error="insufficient_scope", scope="' + scope + '"')
            return 403, {"WWW-Authenticate": challenge}, json.dumps(body).encode()

        with patch.object(auth, "http", side_effect=http):
            auth.functions_scope_read_denials(report, deployment, consumer)
        self.assertEqual({call[1] for call in calls}, {
            "https://functions.example.invalid/api/ai-job-queue/status",
            "https://functions.example.invalid/api/addresses",
        })
        self.assertTrue(all(call[0] == "GET" and call[2] == token for call in calls))
        statuses = {check["id"]: check["status"] for check in report.checks}
        self.assertEqual(statuses["functions-scope:AIJobQueue_Status"], "PASS")
        self.assertEqual(statuses["functions-scope:GetAddresses"], "PASS")
        for name, _, _, _ in functions[2:]:
            self.assertEqual(statuses["functions-scope:" + name], "BLOCKED")
        self.assertNotIn(token, json.dumps(report.checks))

    def test_scope_read_matrix_fails_closed_for_invalid_controls_tokens_and_denials(self):
        deployment = SimpleNamespace(values={}, required=lambda key: {
            "API_MCP_URL": "https://mcp.example.invalid/mcp",
            "API_FUNCTIONS_URL": "https://functions.example.invalid",
        }[key])
        for defect in ["missing-control", "failed-control", "scope", "category", "owner", "audience", "expiry",
                       "status", "error", "metadata", "challenge-scope", "leak", "not-json", "server", "transport"]:
            with self.subTest(defect=defect):
                claims = {
                    "aud": "https://mcp.example.invalid/functions", "category": "consumer",
                    "business_entity_id": "7", "scope": "mcp.access", "exp": int(auth.time.time()) + 600,
                }
                if defect == "scope":
                    claims["scope"] = "mcp.access admin.read"
                elif defect == "category":
                    claims["category"] = "internal"
                elif defect == "owner":
                    claims["business_entity_id"] = "8"
                elif defect == "audience":
                    claims["aud"] = "https://other.example.invalid/functions"
                elif defect == "expiry":
                    claims["exp"] = int(auth.time.time())
                payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
                consumer = SimpleNamespace(label="A", business_id=7,
                                           token=lambda resource, scopes: "header." + payload + ".signature")
                report = auth.Report(Path("."))
                if defect != "missing-control":
                    report.add("addresses:A:list", "ownership", "FAIL" if defect == "failed-control" else "PASS",
                               "Consumer read.")
                report.inventory["functions"] = [{
                    "Name": "AIJobQueue_Status", "Route": "ai-job-queue/status", "Methods": ["GET"],
                    "Policy": {"IsAnonymous": False, "FunctionName": "AIJobQueue_Status",
                               "RequiredScope": "admin.read"},
                }]
                metadata = ("https://other.example.invalid/.well-known/oauth-protected-resource"
                            if defect == "metadata" else
                            "https://mcp.example.invalid/.well-known/oauth-protected-resource")
                scope = "sales.read" if defect == "challenge-scope" else "admin.read"
                body = {"error": "wrong" if defect == "error" else "insufficient_scope",
                        "error_description": "The token is missing the required scope 'admin.read'."}
                if defect == "leak":
                    body["private"] = "SENTINEL-PRIVATE"
                response = (200 if defect == "status" else 503 if defect == "server" else 403,
                            {"WWW-Authenticate": f'Bearer resource_metadata="{metadata}", '
                             f'error="insufficient_scope", scope="{scope}"'},
                            b"invalid" if defect == "not-json" else json.dumps(body).encode())
                with patch.object(auth, "http", side_effect=auth.EvidenceError("Network unavailable")
                                  if defect == "transport" else None, return_value=response) as http:
                    if defect in {"missing-control", "failed-control", "scope", "category", "owner",
                                  "audience", "expiry"}:
                        with self.assertRaises(auth.EvidenceError):
                            auth.functions_scope_read_denials(report, deployment, consumer)
                        http.assert_not_called()
                    else:
                        auth.functions_scope_read_denials(report, deployment, consumer)
                        http.assert_called_once()
                        self.assertEqual(report.checks[-1]["status"],
                                         "BLOCKED" if defect in {"server", "transport"} else "FAIL")
                self.assertNotIn("SENTINEL-PRIVATE", json.dumps(report.checks))

    def test_subcategory_read_only_post_denials_require_real_positive_and_complete_evidence(self):
        cases = ["anonymous", "forged", "dab-audience", "mcp-audience",
                 "manufacturing", "manufacturing-spoofed", "consumer-A", "consumer-B"]
        deployment = SimpleNamespace(required=lambda key: {
            "API_MCP_URL": "https://mcp.example.invalid/mcp",
            "API_FUNCTIONS_URL": "https://functions.example.invalid",
            "API_URL": "https://dab.example.invalid/graphql/"}[key])
        consumers = [SimpleNamespace(business_id=owner, token=lambda resource, label=label: label)
                     for owner, label in [(1, "consumer-A"), (2, "consumer-B")]]
        for defect in [None, "admin", "missing-subcategory", "status", "error", "challenge",
                       "count-leak", "not-json", "transport", "failed-then-transport", "route", "policy", "missing-control",
                       "failed-control", "wrong-control-group", "existing-fail"]:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                report = auth.Report(Path(directory))
                report.inventory["functions"] = [{"Name": "GetSubcategoryProductCount",
                    "Route": "Other" if defect == "route" else "GetSubcategoryProductCount",
                    "Methods": ["POST"], "Policy": {"IsAnonymous": False, "Mode": "InternalOnly",
                        "RequiredScope": "products.read" if defect == "policy" else "admin.read"}}]
                report.add("functions:GetSubcategoryProductCount:POST:deny", "live-denials",
                           "FAIL" if defect == "existing-fail" else "BLOCKED",
                           "Mutation denial probe requires reviewed per-operation safe fixture; no resets/queue clears")
                for control in ["allow:manufacturing:functions", "allow:manufacturing:dab",
                                "allow:manufacturing:mcp", "fixture:consumer:A", "fixture:consumer:B"]:
                    if defect == "missing-control" and control == "allow:manufacturing:dab":
                        continue
                    group = "fixtures" if control.startswith("fixture:") else "live-allows"
                    if defect == "wrong-control-group" and control == "allow:manufacturing:dab":
                        group = "fixtures"
                    status = "FAIL" if defect == "failed-control" and control == "allow:manufacturing:dab" else "PASS"
                    report.add(control, group, status, "Positive identity control.")
                calls = []

                def http(method, url, *, token=None, data=None, headers=None):
                    calls.append((method, url, token, data, headers))
                    if method == "GET":
                        return 200, {}, json.dumps({"value": [] if defect == "missing-subcategory" else
                                                   [{"ProductSubcategoryID": 3}]}).encode()
                    self.assertEqual(data, {"id": 3})
                    if token == "admin":
                        return 200, {}, json.dumps({"totalProducts": 0 if defect == "admin" else 4,
                                                   "modelGroupCount": 1}).encode()
                    if defect == "transport" or defect == "failed-then-transport" and len(calls) == 4:
                        raise auth.EvidenceError("network unavailable")
                    expected = "missing_token" if token is None else (
                        "invalid_token" if token in {"invalid-auth-validation-token", "dab", "mcp"}
                        else "insufficient_scope")
                    status = 401 if expected != "insufficient_scope" else 403
                    body = {"error": "incorrect" if defect == "error" else expected}
                    if defect == "count-leak":
                        body["totalProducts"] = 4
                    challenge = ('Bearer resource_metadata="https://mcp.example.invalid/.well-known/'
                                 f'oauth-protected-resource", error="{expected}"')
                    if defect == "challenge":
                        challenge = "Bearer"
                    return (200 if defect == "status" or defect == "failed-then-transport" else status), \
                        {"WWW-Authenticate": challenge}, \
                        b"not-json" if defect == "not-json" else json.dumps(body).encode()

                with patch.object(auth, "http", side_effect=http):
                    report.guarded("subcategory-count:scenario", "live-denials",
                        lambda: auth.subcategory_count_authorization(
                            report, deployment, "admin", {"dab": "dab", "mcp": "mcp", "functions": "manufacturing"},
                            consumers))
                gate = report.checks[0]
                self.assertEqual(gate["status"], "PASS" if defect is None else
                                 "FAIL" if defect == "existing-fail" else "BLOCKED")
                if defect is None:
                    self.assertEqual(len(calls), 10)
                    self.assertEqual({c["id"] for c in report.checks[6:]},
                                     {"subcategory-count:admin-control"} |
                                     {"subcategory-count:" + case for case in cases})
                    self.assertTrue(all(c["status"] == "PASS" for c in report.checks))
                    self.assertEqual(calls[-3][4]["X-MS-API-ROLE"], "executive-admin")
                if defect in {"route", "policy", "missing-subcategory", "admin", "missing-control",
                              "failed-control", "wrong-control-group"}:
                    self.assertLessEqual(len(calls), 2)
                if defect == "failed-then-transport":
                    result = {item["id"]: item for item in report.checks}
                    self.assertEqual(result["subcategory-count:anonymous"]["status"], "FAIL")
                    self.assertEqual(result["subcategory-count:scenario"]["status"], "BLOCKED")

    def test_worker_middleware_coverage_requires_current_exact_passing_policy_cases(self):
        prefix = "ApiFunctions.Tests.FunctionsAuthorizationMiddlewareTests."
        cases = [
            "Every_protected_policy_denies_missing_token_before_handler",
            "Every_protected_policy_denies_wrong_scope_before_handler",
            "Every_protected_policy_accepts_matching_internal_token_and_projects_signed_owner",
            "Consumer_category_follows_actual_policy_not_forged_internal_headers",
        ]
        expected = [prefix + name + '(function: "Protected")' for name in cases]
        expected.append(prefix + 'Explicit_public_policies_remain_public_even_with_unusable_token(function: "Public")')
        expected += [prefix + 'Cryptographic_and_configuration_denials_never_reach_handler(defect: "' + defect + '")'
                     for defect in ["mcp", "dab", "issuer", "expired", "signature", "category", "malformed", "unconfigured"]]
        expected.append(prefix + "Unclassified_http_function_is_denied_even_with_valid_admin_token")
        expected += [prefix + "Explicit_non_enforcing_modes_and_non_http_triggers_preserve_passthrough(mode: " +
                     mode + ", http: " + http + ")" for mode, http in [
                         ("Disabled", "True"), ("Audit", "True"), ("Enforced", "False")]]
        for scenario, status in [("complete", "PASS"), ("missing", "BLOCKED"), ("duplicate", "BLOCKED"),
                                 ("skipped", "BLOCKED"), ("failed", "FAIL"), ("new-policy", "BLOCKED"),
                                 ("no-inventory", "BLOCKED"), ("unknown-failure", "FAIL")]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                report = auth.Report(root)
                report.inventory["functions"] = [
                    {"Name": "Protected", "Policy": {"IsAnonymous": False}},
                    {"Name": "Public", "Policy": {"IsAnonymous": True}},
                    {"Name": "Timer", "Policy": None},
                ]
                if scenario == "new-policy":
                    report.inventory["functions"].append({"Name": "New", "Policy": {"IsAnonymous": False}})
                if scenario == "no-inventory":
                    report.inventory.clear()
                selected = list(expected)
                if scenario == "missing":
                    selected.pop()
                if scenario == "duplicate":
                    selected.append(expected[0])
                if scenario == "unknown-failure":
                    selected.append(prefix + "NewCase")
                run = ET.Element("TestRun")
                results = ET.SubElement(run, "Results")
                for index, name in enumerate(selected):
                    outcome = "NotExecuted" if scenario == "skipped" and index == 0 else \
                        "Failed" if scenario == "failed" and index == 0 or \
                        scenario == "unknown-failure" and name.endswith(".NewCase") else "Passed"
                    ET.SubElement(results, "UnitTestResult", testName=name, outcome=outcome)
                (root / "dotnet").mkdir()
                ET.ElementTree(run).write(root / "dotnet/current.trx")
                auth.middleware_evidence(report)
                self.assertEqual(report.checks[-1]["status"], status)
                self.assertIn("current.trx", report.checks[-1]["detail"])
                self.assertIn("not a running host", report.checks[-1]["detail"])

    def test_signed_assertion_coverage_requires_current_complete_passing_trx(self):
        prefix = "AdventureWorks.Tests.ManagedIdentityAssertionValidatorTests."
        names = [
            f'{prefix}Real_validator_rejects_cryptographic_claim_and_lifetime_negatives(negative: "{case}")'
            for case in ["issuer", "tenant", "audience", "signature", "unsigned", "expired", "future",
                         "missing-expiry", "missing-oid", "untrusted-oid", "malformed"]
        ]
        names += [
            f"{prefix}Real_signature_accepts_only_supported_issuer_and_audience_forms(v1: {v1}, uri: {uri})"
            for v1 in ["False", "True"] for uri in ["False", "True"]
        ]
        names += [prefix + name for name in [
            "Disabled_and_empty_grants_do_not_fetch_keys",
            "Keys_are_cached_and_unknown_key_refresh_is_throttled_then_accepts_rotation",
            "Expired_key_cache_is_not_an_unbounded_outage_fallback",
            "Unknown_key_refresh_outage_can_retain_only_still_fresh_keys",
            "Invalid_jwks_is_rejected_without_using_an_empty_key_set",
            "Concurrent_first_use_fetches_keys_once",
            "Caller_cancellation_is_propagated",
            "Real_assertions_are_enforced_through_token_endpoint_and_issued_token_signature",
        ]]
        self.assertEqual(len(names), 23)
        for scenario, status in [("complete", "PASS"), ("missing", "BLOCKED"), ("duplicate", "BLOCKED"),
                                 ("skipped", "BLOCKED"), ("failed", "FAIL"), ("unrelated", "BLOCKED")]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "dotnet").mkdir()
                run = ET.Element("TestRun")
                results = ET.SubElement(run, "Results")
                for index, name in enumerate(names):
                    if scenario == "missing" and index == 0:
                        continue
                    if scenario == "unrelated":
                        name = name.replace("ManagedIdentityAssertionValidatorTests", "FakeGrantTests")
                    outcome = "NotExecuted" if scenario == "skipped" and index == 0 else (
                        "Failed" if scenario == "failed" and index == 0 else "Passed")
                    ET.SubElement(results, "UnitTestResult", testName=name, outcome=outcome)
                if scenario == "duplicate":
                    ET.SubElement(results, "UnitTestResult", testName=names[0], outcome="Passed")
                ET.ElementTree(run).write(root / "dotnet/current.trx")
                report = auth.Report(root)
                auth.assertion_evidence(report)
                self.assertEqual(report.checks[0]["status"], status)
                if status == "PASS":
                    self.assertIn("current.trx", report.checks[0]["detail"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = auth.Report(root)
            auth.assertion_evidence(report)
            self.assertEqual(report.checks[0]["status"], "BLOCKED")
            (root / "dotnet").mkdir()
            (root / "dotnet/broken.trx").write_text("<invalid")
            with self.assertRaises(auth.EvidenceError):
                auth.assertion_evidence(auth.Report(root))

    def test_email_management_exception_is_exact_not_a_name_only_allowlist(self):
        scope = "/subscriptions/test/resourceGroups/demo/providers/Microsoft.Communication/communicationServices/comms"
        definition = {"roleName": "AdventureWorks Email Sender demo", "assignableScopes": [scope],
                      "permissions": [{"actions": ["Microsoft.Communication/communicationServices/read",
                                                   "Microsoft.Communication/communicationServices/write"],
                                       "dataActions": [], "notActions": [], "notDataActions": []}]}
        assignment = {"scope": scope, "principalId": "runtime"}
        self.assertTrue(auth.reviewed_email_sender(definition, assignment, scope, "runtime"))
        for key, value in [("scope", scope.rsplit("/providers/", 1)[0]), ("principalId", "other"),
                           ("condition", "unknown"), ("conditionVersion", "2.0")]:
            with self.subTest(key=key):
                self.assertFalse(auth.reviewed_email_sender(definition, {**assignment, key: value}, scope, "runtime"))
        for block in [{"actions": ["Microsoft.Communication/*"]},
                      {"actions": definition["permissions"][0]["actions"] + ["Microsoft.Communication/communicationServices/listKeys/action"]},
                      {**definition["permissions"][0], "dataActions": ["*"]},
                      {**definition["permissions"][0], "notActions": ["*/delete"]},
                      {"actions": "*"}]:
            with self.subTest(block=block):
                self.assertFalse(auth.reviewed_email_sender({**definition, "permissions": [block]}, assignment, scope, "runtime"))
        self.assertFalse(auth.reviewed_email_sender({**definition, "assignableScopes": [scope, "/subscriptions/test"]},
                                                   assignment, scope, "runtime"))

    def test_webpubsub_runtime_role_requires_exact_resource_principal_and_permissions(self):
        scope = "/subscriptions/test/resourceGroups/demo/providers/Microsoft.SignalRService/webPubSub/pubsub"
        actions = json.loads(auth.CONTRACTS.read_text())["runtimeWebPubSubRole"]["dataActions"]
        block = {"actions": [], "notActions": [], "dataActions": actions, "notDataActions": []}
        definition = {"roleName": "AdventureWorks Web PubSub Runtime demo", "roleType": "CustomRole",
                      "assignableScopes": [scope], "permissions": [block]}
        assignment = {"scope": scope, "principalId": "runtime"}
        self.assertTrue(auth.reviewed_webpubsub_runtime(definition, assignment, scope, "runtime"))
        self.assertTrue(auth.reviewed_webpubsub_runtime(
            {**definition, "permissions": [{**block, "dataActions": [action.lower() for action in actions]}]},
            {**assignment, "scope": scope.upper(), "principalId": "RUNTIME"}, scope, "runtime"))
        for variant in [
                {**definition, "roleType": "BuiltInRole"},
                {**definition, "roleName": "Web PubSub Service Owner"},
                {**definition, "assignableScopes": [scope, "/subscriptions/test"]},
                {**definition, "permissions": [block, block]},
                {**definition, "permissions": [{**block, "actions": ["*"]}]},
                {**definition, "permissions": [{**block, "actions": None}]},
                {**definition, "permissions": [{**block, "dataActions": actions[:-1]}]},
                {**definition, "permissions": [{**block, "dataActions": actions + ["*"]}]},
                {**definition, "permissions": [{**block, "dataActions": actions[:-1] + [actions[0]]}]},
                {**definition, "permissions": [{**block, "notDataActions": ["*/delete"]}]},
                {**definition, "permissions": [{**block, "condition": "unknown"}]},
        ]:
            with self.subTest(definition=variant):
                self.assertFalse(auth.reviewed_webpubsub_runtime(variant, assignment, scope, "runtime"))
        for variant in [{**assignment, "scope": "/subscriptions/test"},
                        {**assignment, "principalId": "other"},
                        {**assignment, "principalId": None},
                        {**assignment, "condition": "unknown"},
                        {**assignment, "conditionVersion": "2.0"}]:
            with self.subTest(assignment=variant):
                self.assertFalse(auth.reviewed_webpubsub_runtime(definition, variant, scope, "runtime"))

    def test_webpubsub_unreviewed_grants_and_inherited_or_child_scopes(self):
        allowed = json.loads(auth.CONTRACTS.read_text())["runtimeWebPubSubRole"]["dataActions"]
        definition = {"permissions": [{"dataActions": allowed, "notDataActions": []}]}
        self.assertEqual(auth.unreviewed_webpubsub_data_grants(definition, reviewed_role=True), [])
        self.assertCountEqual(auth.unreviewed_webpubsub_data_grants(definition), allowed)
        for action in ["*", "Microsoft.SignalRService/WebPubSub/*",
                       "Microsoft.SignalRService/*", "*/chat/*",
                       "Microsoft.SignalRService/WebPubSub/user/send/action"]:
            with self.subTest(action=action):
                definition = {"permissions": [{"dataActions": [action], "notDataActions": []}]}
                self.assertEqual(auth.unreviewed_webpubsub_data_grants(definition), [action])
                self.assertEqual(auth.unreviewed_webpubsub_data_grants(definition, reviewed_role=True), [action])
        definition = {"permissions": [{"dataActions": ["Microsoft.CognitiveServices/*",
                                                       "Microsoft.SignalRService/SignalR/*"],
                                       "notDataActions": []}]}
        self.assertEqual(auth.unreviewed_webpubsub_data_grants(definition), [])
        for invalid in [{}, {"permissions": [None]}, {"permissions": [{"dataActions": "*"}]},
                        {"permissions": [{"dataActions": [], "notDataActions": None}]},
                        {"permissions": [{"dataActions": ["* "], "notDataActions": []}]}]:
            with self.subTest(invalid=invalid), self.assertRaises(auth.EvidenceError):
                auth.unreviewed_webpubsub_data_grants(invalid)
        root = "/subscriptions/test/resourceGroups/demo"
        target = root + "/providers/Microsoft.SignalRService/webPubSub/pubsub"
        for scope in ["/", "/subscriptions/test", root, target, target + "/hubs/adventureworks",
                      "/providers/Microsoft.Management/managementGroups/demo"]:
            with self.subTest(scope=scope):
                self.assertTrue(auth.role_scope_overlaps(scope, target))
        self.assertFalse(auth.role_scope_overlaps(root + "/providers/Microsoft.Storage/storageAccounts/a", target))
        for scope in ["", None]:
            with self.subTest(scope=scope), self.assertRaises(auth.EvidenceError):
                auth.role_scope_overlaps(scope, target)

    @unittest.skipUnless(shutil.which("az"), "Azure CLI is required to compile Bicep")
    def test_webpubsub_bicep_assigns_the_exact_reviewed_role(self):
        version = subprocess.run(["az", "bicep", "version"], capture_output=True, text=True, timeout=30)
        if version.returncode:
            self.skipTest("An installed Bicep compiler is required")
        result = subprocess.run(
            ["az", "bicep", "build", "--file", str(auth.ROOT / "infra/modules/webpubsub.bicep"), "--stdout"],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        resources = {resource["type"]: resource for resource in json.loads(result.stdout)["resources"]}
        service = resources["Microsoft.SignalRService/webPubSub"]["properties"]
        self.assertTrue(service["disableLocalAuth"])
        self.assertFalse(service["disableAadAuth"])
        role = resources["Microsoft.Authorization/roleDefinitions"]
        assignment = resources["Microsoft.Authorization/roleAssignments"]
        self.assertEqual(role["properties"]["type"], "customRole")
        self.assertEqual(role["properties"]["assignableScopes"], [assignment["scope"]])
        self.assertIn("Microsoft.SignalRService/webPubSub", assignment["scope"])
        self.assertIn(role["name"].strip("[]"), assignment["properties"]["roleDefinitionId"])
        block = role["properties"]["permissions"][0]
        self.assertEqual(len(role["properties"]["permissions"]), 1)
        self.assertEqual(block["actions"], [])
        self.assertEqual(block["notActions"], [])
        self.assertEqual(block["notDataActions"], [])
        self.assertCountEqual(
            block["dataActions"], json.loads(auth.CONTRACTS.read_text())["runtimeWebPubSubRole"]["dataActions"])

    def test_role_permissions_detect_custom_wildcards_and_case_insensitive_key_access(self):
        grants = auth.sensitive_management_grants({"permissions": [{
            "actions": ["microsoft.storage/storageaccounts/*"], "notActions": ["*/delete"]}]})
        self.assertIn("Microsoft.Storage/storageAccounts/listKeys/action", grants)
        self.assertIn("Microsoft.Storage/storageAccounts/write", grants)
        self.assertNotIn("Microsoft.Storage/storageAccounts/delete", grants)
        self.assertEqual(auth.sensitive_management_grants({"permissions": [{
            "actions": ["Microsoft.ContainerRegistry/registries/pull/read"], "notActions": []}]}), [])
        pubsub = auth.sensitive_management_grants({"permissions": [{
            "actions": ["Microsoft.SignalRService/WebPubSub/*"], "notActions": []}]})
        self.assertIn("Microsoft.SignalRService/webPubSub/listKeys/action", pubsub)
        self.assertIn("Microsoft.SignalRService/webPubSub/write", pubsub)

    def test_not_actions_are_not_global_denies_across_role_permission_blocks(self):
        operation = "Microsoft.Storage/storageAccounts/listKeys/action"
        self.assertEqual(auth.sensitive_management_grants({"permissions": [
            {"actions": ["Microsoft.Storage/storageAccounts/*"], "notActions": ["*"]},
            {"actions": [operation], "notActions": []}]}), [operation])
        for definition in [{}, {"permissions": []}, {"permissions": [None]},
                           {"permissions": [{"actions": "*"}]},
                           {"permissions": [{"actions": [None]}]},
                           {"permissions": [{"actions": [], "notActions": "*"}]}]:
            with self.subTest(definition=definition), self.assertRaises(auth.EvidenceError):
                auth.sensitive_management_grants(definition)

    def test_role_management_checks_respect_resource_scope_and_extension_roles(self):
        definition = {"permissions": [{"actions": ["*"], "notActions": ["Microsoft.Authorization/*/write"]}]}
        root = "/subscriptions/test/resourceGroups/demo"
        acr = root + "/providers/Microsoft.ContainerRegistry/registries/registry"
        grants = auth.sensitive_management_grants(definition, acr)
        self.assertIn("Microsoft.ContainerRegistry/registries/listCredentials/action", grants)
        self.assertNotIn("Microsoft.Storage/storageAccounts/listKeys/action", grants)
        self.assertNotIn("Microsoft.Resources/deployments/write", grants)
        self.assertNotIn("Microsoft.Authorization/roleAssignments/write", grants)
        self.assertIn("Microsoft.Authorization/roleAssignments/delete", grants)
        project = root + "/providers/Microsoft.CognitiveServices/accounts/account/projects/project"
        self.assertNotIn("Microsoft.CognitiveServices/accounts/write",
                         auth.sensitive_management_grants(definition, project))
        for scope in [root, "/subscriptions/test", "/providers/Microsoft.Management/managementGroups/demo", "/"]:
            self.assertIn("Microsoft.Storage/storageAccounts/listKeys/action",
                          auth.sensitive_management_grants(definition, scope))
        for scope in [7, "unknown", root + "/providers/Microsoft.Storage/storageAccounts"]:
            with self.subTest(scope=scope), self.assertRaises(auth.EvidenceError):
                auth.sensitive_management_grants(definition, scope)

    def test_foundry_management_probes_detect_narrowed_role_regressions_and_respect_scope(self):
        root = "/subscriptions/test/resourceGroups/demo"
        account = root + "/providers/Microsoft.CognitiveServices/accounts/account"
        project = account + "/projects/project"
        operations = {
            f"Microsoft.CognitiveServices/accounts/{resource}/{action}"
            for resource in ["deployments", "raiPolicies", "commitmentplans"]
            for action in ["write", "delete"]
        }
        contributor = {"permissions": [{"actions": list(operations), "notActions": []}]}
        user = {"permissions": [{"actions": ["Microsoft.CognitiveServices/*/read"], "notActions": []}]}
        self.assertEqual(set(auth.sensitive_management_grants(contributor, account)), operations)
        self.assertEqual(auth.sensitive_management_grants(user, account), [])
        self.assertEqual(auth.sensitive_management_grants(contributor, project), [])
        self.assertEqual(set(auth.sensitive_management_grants(contributor, root)), operations)
        for operation in operations:
            with self.subTest(operation=operation):
                narrowed = {"permissions": [{"actions": ["Microsoft.CognitiveServices/accounts/*"],
                                             "notActions": [operation]}]}
                self.assertNotIn(operation, auth.sensitive_management_grants(narrowed, account))

    def test_oauth_form_is_encoded_without_json_and_rejects_mixed_bodies(self):
        requests = []
        form = {"scope": "orders.read orders.write", "username": "fixture+test@example.invalid",
                "password": "test&only=value"}
        response = io.BytesIO(b'{"ok":true}')
        response.status, response.headers = 200, {}

        def open_request(request, **kwargs):
            requests.append(request)
            return response

        with patch.object(auth.urllib.request, "build_opener",
                          return_value=SimpleNamespace(open=open_request)):
            status, _, _ = auth.http("POST", "https://issuer.example.test/token", form=form)
            with self.assertRaises(auth.EvidenceError):
                auth.http("POST", "https://issuer.example.test/token", form=form, data={})
        self.assertEqual(status, 200)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].get_header("Content-type"), "application/x-www-form-urlencoded")
        self.assertEqual(auth.urllib.parse.parse_qs(requests[0].data.decode()),
                         {key: [value] for key, value in form.items()})

    def test_consumer_scenario_preserves_existing_rows_after_partial_mutation_failure(self):
        snapshots = {"7": [{"ShoppingCartItemID": 88, "ShoppingCartID": "7", "ProductID": 99, "Quantity": 1}],
                     "8": [{"ShoppingCartItemID": 89, "ShoppingCartID": "8", "ProductID": 98, "Quantity": 4}]}
        carts = {owner: list(items) for owner, items in snapshots.items()}
        deletes = []
        users = [SimpleNamespace(label=label, business_id=owner, token=lambda *args: "test-consumer-token")
                 for label, owner in [("A", 7), ("B", 8)]]
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_URL": "https://dab.example.test/graphql/"}[key])

        def fake_http(method, url, **kwargs):
            parsed = auth.urllib.parse.urlsplit(url)
            owner = auth.urllib.parse.parse_qs(parsed.query).get("cartId", [None])[0]
            status = 200
            if parsed.path == "/api/Product":
                body = {"value": [{"ProductID": 1}]}
            elif method == "GET":
                body = carts[owner]
            elif method == "POST" and owner == "7":
                body = {"ShoppingCartItemID": 90, "ShoppingCartID": "7", "ProductID": 1, "Quantity": 2}
                carts[owner].append(body)
            elif method == "POST":
                status, body = 400, {"error": "rejected"}
            elif method == "DELETE":
                deletes.append((owner, parsed.path))
                self.assertEqual((owner, parsed.path), ("7", "/api/cart/items/90"))
                carts[owner] = [row for row in carts[owner] if row["ShoppingCartItemID"] != 90]
                body = {"deleted": True}
            else:
                self.fail("Unexpected scenario request")
            return status, {}, json.dumps(body).encode()

        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            with patch.object(auth, "http", side_effect=fake_http), self.assertRaises(auth.EvidenceError):
                auth.consumer_cart_live(report, deployment, users)
            ledger = json.loads((Path(directory) / "consumer-cart-ledger.json").read_text())
        self.assertEqual(carts, snapshots)
        self.assertEqual(len(deletes), 1)
        self.assertEqual(ledger["productId"], 1)
        self.assertTrue(any(check["id"] == "consumer-cart:add-B" and check["status"] == "FAIL"
                            for check in report.checks))
        for label in ["A", "B"]:
            self.assertTrue(any(check["id"] == "consumer-cart:cleanup:" + label and check["status"] == "PASS"
                                for check in report.checks))

    def test_consumer_cleanup_refuses_to_race_an_unconfirmed_account_write(self):
        for defect in ["timeout", "server-error", "accepted", "request-timeout", "throttled", "invalid-json"]:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                carts = {"7": [], "8": []}
                deletes = []
                users = [SimpleNamespace(label=label, business_id=owner, token=lambda *args: "private-token")
                         for label, owner in [("A", 7), ("B", 8)]]
                deployment = SimpleNamespace(required=lambda key: {
                    "API_FUNCTIONS_URL": "https://functions.example.test",
                    "API_URL": "https://dab.example.test/graphql/"}[key])

                def fake_http(method, url, **kwargs):
                    parsed = auth.urllib.parse.urlsplit(url)
                    owner = auth.urllib.parse.parse_qs(parsed.query).get("cartId", [None])[0]
                    if parsed.path == "/api/Product":
                        return 200, {}, b'{"value":[{"ProductID":1}]}'
                    if method == "GET":
                        return 200, {}, json.dumps(carts[owner]).encode()
                    if method == "DELETE":
                        deletes.append(url)
                        return 200, {}, b'{"deleted":true}'
                    item = {"ShoppingCartItemID": 90 if owner == "7" else 91, "ShoppingCartID": owner,
                            "ProductID": 1, "Quantity": 2 if owner == "7" else 4}
                    carts[owner].append(item)
                    if owner == "7":
                        return 200, {}, json.dumps(item).encode()
                    if defect == "timeout":
                        raise auth.EvidenceError("Network/TLS/timeout failure; not an authorization denial")
                    if defect == "server-error":
                        return 503, {}, b'{"error":"unavailable"}'
                    if defect in {"accepted", "request-timeout", "throttled"}:
                        status = {"accepted": 202, "request-timeout": 408, "throttled": 429}[defect]
                        return status, {}, json.dumps(item).encode()
                    return 200, {}, b'not-json'

                report = auth.Report(Path(directory))
                with patch.object(auth, "http", side_effect=fake_http), self.assertRaises(auth.EvidenceError):
                    auth.consumer_cart_live(report, deployment, users)
                raw = (Path(directory) / "consumer-cart-ledger.json").read_text()
                ledger = json.loads(raw)
                self.assertEqual(deletes, [])
                self.assertEqual([len(carts[owner]) for owner in ["7", "8"]], [1, 1])
                self.assertEqual([item["state"] for item in ledger["accountWrites"]], ["responded", "uncertain"])
                self.assertNotIn("private-token", raw)
                for label in ["A", "B"]:
                    self.assertTrue(any(check["id"] == "consumer-cart:cleanup:" + label and check["status"] == "FAIL"
                                        for check in report.checks))

    def test_consumer_cleanup_stops_after_an_uncertain_deletion(self):
        carts = {"7": [], "8": []}
        deletes = []
        users = [SimpleNamespace(label=label, business_id=owner,
                                 token=lambda *args, value=str(owner): value)
                 for label, owner in [("A", 7), ("B", 8)]]
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_URL": "https://dab.example.test/graphql/"}[key])

        def fake_http(method, url, **kwargs):
            parsed = auth.urllib.parse.urlsplit(url)
            owner = auth.urllib.parse.parse_qs(parsed.query).get("cartId", [None])[0]
            if parsed.path == "/api/Product":
                return 200, {}, b'{"value":[{"ProductID":1}]}'
            if method == "GET":
                if owner == "8" and kwargs.get("token") == "7":
                    raise auth.EvidenceError("Read timed out")
                return 200, {}, json.dumps(carts[owner]).encode()
            if method == "POST":
                item = {"ShoppingCartItemID": 90 if owner == "7" else 91, "ShoppingCartID": owner,
                        "ProductID": 1, "Quantity": 2 if owner == "7" else 4}
                carts[owner].append(item)
                return 200, {}, json.dumps(item).encode()
            deletes.append(owner)
            raise auth.EvidenceError("Deletion timed out")

        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            with patch.object(auth, "http", side_effect=fake_http), self.assertRaises(auth.EvidenceError):
                auth.consumer_cart_live(report, deployment, users)
            ledger = json.loads((Path(directory) / "consumer-cart-ledger.json").read_text())
        self.assertEqual(deletes, ["7"])
        self.assertEqual(ledger["accountWrites"][-1]["state"], "uncertain")
        for label in ["A", "B"]:
            self.assertTrue(any(check["id"] == "consumer-cart:cleanup:" + label and check["status"] == "FAIL"
                                for check in report.checks))

    def test_reusable_consumers_are_created_once_and_never_serialize_credentials(self):
        accounts = {}
        signup_calls = []
        values = {"API_MCP_URL": "https://issuer.example.test/mcp",
                  "API_FUNCTIONS_URL": "https://functions.example.test"}
        deployment = SimpleNamespace(values=values, environment=None, required=lambda key: values[key])

        def fake_http(method, url, **kwargs):
            if url.endswith("/signup"):
                email = kwargs["data"]["email"]
                signup_calls.append(email)
                self.assertTrue(email.endswith("@example.invalid"))
                self.assertLessEqual(len(email), 50)
                accounts[email] = len(accounts) + 7
                return 201, {}, json.dumps({"businessEntityId": accounts[email]}).encode()
            form = kwargs["form"]
            if form["username"] not in accounts:
                return 400, {}, b'{"error":"invalid_grant"}'
            payload = base64.urlsafe_b64encode(json.dumps({
                "category": "consumer", "aud": form["resource"],
                "business_entity_id": str(accounts[form["username"]])}).encode()).decode().rstrip("=")
            return 200, {}, json.dumps({"access_token": "header." + payload + ".signature", "expires_in": 600}).encode()

        def persist(d, updated):
            d.values.update({key: str(value) for key, value in updated.items()})

        with patch.object(auth, "http", side_effect=fake_http), patch.object(auth, "persist_fixture_values", side_effect=persist):
            first_report, second_report = auth.Report(Path(".")), auth.Report(Path("."))
            first = auth.consumer_fixtures(first_report, deployment)
            second = auth.consumer_fixtures(second_report, deployment)
        self.assertEqual(len(signup_calls), 2)
        self.assertEqual([item.business_id for item in first], [7, 8])
        self.assertEqual([item.business_id for item in second], [7, 8])
        for item in first:
            serialized = json.dumps({"checks": first_report.checks, "inventory": first_report.inventory})
            self.assertNotIn(item.password, serialized)
            self.assertNotIn(item.email, serialized)

    def test_fixture_persistence_uses_private_file_not_secret_command_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / ".azure" / "test" / ".env"
            path.parent.mkdir(parents=True)
            path.write_text("")
            calls, content = [], []

            def fake_command(args, **kwargs):
                calls.append(args)
                if "--file" in args:
                    temporary = Path(args[args.index("--file") + 1])
                    self.assertEqual(temporary.stat().st_mode & 0o777, 0o600)
                    content.append(temporary.read_text())
                return ""

            deployment = SimpleNamespace(environment="test", values={})
            with patch.object(auth, "ROOT", root), patch.object(auth, "json_command", return_value=[
                    {"Name": "other", "IsDefault": True, "HasLocal": True, "DotEnvPath": str(path)},
                    {"Name": "test", "IsDefault": False, "HasLocal": True, "DotEnvPath": str(path)}]), \
                    patch.object(auth, "command", side_effect=fake_command):
                auth.persist_fixture_values(deployment, {"AUTH_TEST_CONSUMER_A_PASSWORD": "private-fixture-value"})
            self.assertIn("private-fixture-value", content[0])
            self.assertNotIn("private-fixture-value", json.dumps(calls))
            self.assertEqual(calls[-1][calls[-1].index("--environment") + 1], "test")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(Path(calls[-1][calls[-1].index("--file") + 1]).exists())
            with self.assertRaisesRegex(auth.EvidenceError, "pinned azd environment"):
                auth.persist_fixture_values(SimpleNamespace(environment=None, values={}), {})

    def test_guest_expiry_accepts_dotnet_precision_and_requires_timezone(self):
        self.assertEqual(auth.guest_expiry("2026-11-10T18:02:07.1644355+00:00"),
                         auth.guest_expiry("2026-11-10T18:02:07.164435Z"))
        for value in [None, "invalid", "2026-11-10T18:02:07", "2026-99-10T18:02:07Z"]:
            with self.subTest(value=value), self.assertRaises(auth.EvidenceError):
                auth.guest_expiry(value)

    def test_guest_scenario_retires_known_fixture_after_later_bootstrap_failure(self):
        proof = "A" * 64
        cart = "guest-" + "a" * 32
        expiry = auth.datetime.fromtimestamp(
            auth.datetime.now(auth.timezone.utc).timestamp() + 86400, auth.timezone.utc).isoformat()
        calls = []

        def fake_http(method, url, **kwargs):
            calls.append((method, url, kwargs))
            if "/api/Product?" in url:
                return 200, {}, b'{"value":[{"ProductID":1}]}'
            if method == "POST":
                if sum(item[0] == "POST" for item in calls) > 1:
                    raise auth.EvidenceError("Network/TLS/timeout failure; not an authorization denial")
                return 200, {}, json.dumps({"token": proof, "cartId": cart, "expiresAt": expiry}).encode()
            if method == "DELETE":
                self.assertEqual(kwargs["headers"]["X-Guest-Cart-Session"], proof)
                return 200, {}, b'{"retired":true}'
            if not any(item[0] == "DELETE" for item in calls):
                return 200, {}, b'[]'
            return 401, {}, b'{"error":"guest_session_expired_or_invalid"}'

        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            deployment = SimpleNamespace(required=lambda key: {
                "API_FUNCTIONS_URL": "https://functions.example.test",
                "API_URL": "https://dab.example.test/graphql/"}[key])
            with patch.object(auth, "http", side_effect=fake_http), self.assertRaises(auth.EvidenceError):
                auth.guest_cart_live(report, deployment)
            ledger = (Path(directory) / "guest-cart-ledger.json").read_text()
            self.assertNotIn(proof, ledger)
            self.assertTrue(json.loads(ledger)["sessions"][0]["retired"])
            self.assertEqual(sum(call[0] == "DELETE" for call in calls), 1)
            self.assertTrue(any(check["id"] == "guest-cart:retired-proof:0" and check["status"] == "PASS"
                                for check in report.checks))

    def test_guest_cleanup_refuses_to_race_an_unconfirmed_dab_write(self):
        expiry = auth.datetime.fromtimestamp(
            auth.datetime.now(auth.timezone.utc).timestamp() + 86400, auth.timezone.utc).isoformat()
        sessions = [{"token": char.upper() * 64, "cartId": "guest-" + char * 32, "expiresAt": expiry}
                    for char in ["a", "b"]]
        items = {session["cartId"]: [] for session in sessions}
        calls = []

        def fake_http(method, url, **kwargs):
            parsed = auth.urllib.parse.urlsplit(url)
            calls.append((method, parsed.path))
            if parsed.hostname == "dab.example.test":
                if parsed.path == "/api/Product":
                    return 200, {}, b'{"value":[{"ProductID":1}]}'
                if method == "GET":
                    return 403, {}, b'{"error":"forbidden"}'
                raise auth.EvidenceError("DAB write timed out")
            if parsed.path == "/api/cart/session" and method == "POST":
                return 200, {}, json.dumps(sessions[sum(path == parsed.path for _, path in calls) - 1]).encode()
            if parsed.path == "/api/cart/session" and method == "DELETE":
                self.fail("An uncertain DAB write must not race guest retirement")
            proof = kwargs.get("headers", {}).get("X-Guest-Cart-Session")
            session = next((value for value in sessions if value["token"] == proof), None)
            expected = auth.urllib.parse.parse_qs(parsed.query).get("cartId", [None])[0]
            if session is None or kwargs.get("headers", {}).get("Authorization"):
                return 401, {}, b'{"error":"unauthorized"}'
            if expected != session["cartId"]:
                return 403, {}, b'{"error":"forbidden"}'
            if method == "POST":
                quantity = kwargs["data"]["Quantity"]
                item = {"ShoppingCartID": expected, "ShoppingCartItemID": 91 if quantity == 2 else 92,
                        "ProductID": 1, "Quantity": quantity}
                items[expected].append(item)
                return 200, {}, json.dumps(item).encode()
            if method in {"PATCH", "DELETE"}:
                return 404, {}, b'{"error":"not found"}'
            return 200, {}, json.dumps(items[expected]).encode()

        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            deployment = SimpleNamespace(required=lambda key: {
                "API_FUNCTIONS_URL": "https://functions.example.test",
                "API_URL": "https://dab.example.test/graphql/"}[key])
            with patch.object(auth, "http", side_effect=fake_http), self.assertRaises(auth.EvidenceError):
                auth.guest_cart_live(report, deployment)
            raw = (Path(directory) / "guest-cart-ledger.json").read_text()
            ledger = json.loads(raw)
        self.assertEqual(ledger["dabWrites"], [{"operation": "POST cart", "state": "uncertain"}])
        self.assertFalse(any(method == "DELETE" and path == "/api/cart/session" for method, path in calls))
        self.assertTrue(all(any(check["id"] == f"guest-cart:cleanup:{index}" and check["status"] == "FAIL"
                                for check in report.checks) for index in [0, 1]))
        for session in sessions:
            self.assertNotIn(session["token"], raw)

    def test_browser_gate_requires_exact_assertions_and_distinguishes_missing_prerequisites(self):
        names = ["guest-add-persists", "guest-cart-survives-reload", "checkout-requires-signin",
                 "no-non-cart-function-mutations", "exact-browser-fixture-retired"]
        consumer = SimpleNamespace(tokens={}, email="fixture@example.invalid", password="private-fixture-password",
                                   business_id=7, token=lambda *args: "private-fixture-token")
        other_consumer = SimpleNamespace(tokens={}, email="other@example.invalid",
                                          password="other-private-fixture-password", business_id=8,
                                          token=lambda *args: "other-private-fixture-token")
        consumer_names = names + ["consumer-auto-merge", "merged-guest-proof-denied", "consumer-cart-reload",
                                  "exact-consumer-fixture-removed"]
        switch_names = ["consumer-new-tab-does-not-inherit-session",
                        "consumer-account-switch-logout-clears-session",
                        "consumer-account-switch-isolates-cart", "exact-switched-consumer-preserved"]
        consumer_switch_names = consumer_names + switch_names
        for checks, command_failed, expected, fixture, other_fixture in [
                ([{"name": name, "status": "PASS"} for name in names], False, "BLOCKED", None, None),
                ([{"name": name, "status": "PASS"} for name in names + [names[0]]], False, "FAIL", None, None),
                ([], False, "FAIL", None, None),
                ([{"name": "browser-prerequisites", "status": "BLOCKED"}], True, "BLOCKED", None, None),
                ([{"name": name, "status": "PASS"} for name in names], True, "FAIL", None, None),
                ([{"name": name, "status": "FAIL" if name == names[0] else "PASS"} for name in names],
                 False, "FAIL", None, None),
                ([{"name": name, "status": "PASS"} for name in names], False, "FAIL", consumer, None),
                ([{"name": name, "status": "PASS"} for name in consumer_names], False, "BLOCKED", consumer, None),
                ([{"name": name, "status": "PASS"} for name in consumer_switch_names], False, "PASS",
                 consumer, other_consumer)]:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as directory:
                report = auth.Report(Path(directory))
                deployment = SimpleNamespace(
                    required=lambda key: {"SERVICE_APP_NAME": "site", "AZURE_RESOURCE_GROUP": "group",
                                          "API_FUNCTIONS_URL": "https://functions.example.test",
                                          "API_URL": "https://dab.example.test/graphql",
                                          "API_MCP_URL": "https://mcp.example.test/mcp"}[key],
                    azure=lambda *args: {"defaultHostname": "site.example.test"})

                def fake_command(*args, **kwargs):
                    if fixture:
                        self.assertEqual(kwargs["environment"]["AUTH_BROWSER_CONSUMER_PASSWORD"], fixture.password)
                        self.assertNotIn(fixture.password, json.dumps(args))
                        self.assertNotIn("private-fixture-token", json.dumps(args))
                        if other_fixture:
                            self.assertEqual(kwargs["environment"]["AUTH_BROWSER_CONSUMER_B_PASSWORD"],
                                             other_fixture.password)
                            self.assertNotIn(other_fixture.password, json.dumps(args))
                            self.assertNotIn("other-private-fixture-token", json.dumps(args))
                            self.assertEqual(kwargs["environment"]["AUTH_BROWSER_CONSUMER_B_ID"],
                                             str(other_fixture.business_id))
                        else:
                            self.assertFalse(any(key.startswith("AUTH_BROWSER_CONSUMER_B_")
                                                 for key in kwargs["environment"]))
                    else:
                        self.assertFalse(any(key.startswith("AUTH_BROWSER_CONSUMER_")
                                             for key in kwargs["environment"]))
                    (Path(directory) / "guest-cart-browser.json").write_text(json.dumps({"checks": checks}))
                    if command_failed:
                        raise auth.EvidenceError("Browser command failed")
                    return ""

                with patch.object(auth, "command", side_effect=fake_command), \
                        patch.dict(auth.os.environ, {"AUTH_BROWSER_CONSUMER_ID": "unintended"}):
                    auth.guest_cart_browser(report, deployment, fixture, other_fixture)
                self.assertEqual(report.checks[-1]["status"], expected)

    def test_https_rejects_credentials_queries_fragments_and_insecure_urls(self):
        for value in ["http://example.test", "", "/relative", "https://user:pw@example.test",
                      "https://example.test/?token=secret", "https://example.test/#secret"]:
            with self.subTest(value=value), self.assertRaises(auth.EvidenceError):
                auth.https_url(value)
        self.assertEqual(auth.https_url("https://example.test/"), "https://example.test")

    def test_origin_drops_paths_not_hostname_suffixes(self):
        self.assertEqual(auth.origin("https://example.test/mcp"), "https://example.test")
        self.assertEqual(auth.origin("https://example.test.attacker.test/mcp"),
                         "https://example.test.attacker.test")

    def test_deployment_origin_inventory_has_stable_site_and_api_ids(self):
        values = {
            "APP_URL": "https://store.example.test/",
            "APP_ADMIN_URL": "https://admin.example.test/",
            "APP_MANUFACTURING_URL": "https://manufacturing.example.test/",
            "MCP_INSPECTOR_URL": "https://inspector.example.test/",
            "API_URL": "https://dab.example.test/graphql/",
            "API_FUNCTIONS_URL": "https://functions.example.test/api/",
            "API_MCP_URL": "https://mcp.example.test/mcp",
        }
        deployment = SimpleNamespace(required=lambda key: values[key])
        inventory = auth.deployment_origin_inventory(deployment)

        self.assertEqual([item["id"] for item in inventory], [
            "origin:storefront", "origin:admin", "origin:manufacturing",
            "origin:mcp-inspector", "origin:dab", "origin:functions", "origin:mcp",
        ])
        self.assertEqual(inventory[4]["origin"], "https://dab.example.test")
        self.assertNotIn("/graphql", json.dumps(inventory))
        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            auth.record_deployment_origin_inventory(report, deployment)
            self.assertEqual(report.checks[0]["status"], "PASS")
            self.assertEqual(report.inventory["deploymentOrigins"], inventory)
            self.assertEqual(len(report.provenance["deploymentOriginInventorySha256"]), 64)

    def test_deployment_origin_inventory_fails_closed_when_an_endpoint_is_missing(self):
        def required(_):
            raise auth.EvidenceError("azd value APP_URL is missing")

        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            auth.record_deployment_origin_inventory(report, SimpleNamespace(required=required))
        self.assertEqual(report.checks[0]["status"], "FAIL")
        self.assertEqual(report.checks[0]["id"], "inventory:deployment-origins")

    def test_routes_replace_every_parameter_and_preserve_constraints(self):
        self.assertEqual(auth.route_path("orders/{id:int}/lines/{line:long}"), "orders/1/lines/1")
        self.assertEqual(auth.route_path("jobs/{id:guid}"),
                         "jobs/11111111-1111-1111-1111-111111111111")
        self.assertEqual(auth.route_path("runs/{id}/steps/{*rest}"),
                         "runs/auth-validation/steps/auth-validation")

    def test_function_surface_inventory_assigns_stable_http_and_trigger_ids(self):
        functions = [{
            "Name": "GetOrder",
            "Triggers": ["HttpTriggerAttribute"],
            "Route": "Sales/Orders/{OrderId:int}",
            "Methods": ["get"],
            "Policy": {"Mode": "Authenticated"},
        }, {
            "Name": "OrderQueue",
            "Triggers": ["QueueTriggerAttribute"],
            "Route": None,
            "Methods": None,
            "Policy": None,
        }]

        surfaces = auth.function_surface_inventory(functions)

        self.assertEqual(
            {item["id"] for item in surfaces},
            {
                "function:trigger:GetOrder:HttpTriggerAttribute",
                "function:http:GET:sales/orders/{orderid:int}",
                "function:trigger:OrderQueue:QueueTriggerAttribute",
            },
        )
        self.assertEqual(surfaces[1]["policy"], {"Mode": "Authenticated"})

    def test_function_surface_inventory_rejects_missing_policy_and_route_collisions(self):
        function = {
            "Name": "GetOrder",
            "Triggers": ["HttpTriggerAttribute"],
            "Route": "sales/orders",
            "Methods": ["GET"],
            "Policy": {"Mode": "Authenticated"},
        }
        with self.assertRaisesRegex(auth.EvidenceError, "no authorization policy"):
            auth.function_surface_inventory([{**function, "Policy": None}])
        with self.assertRaisesRegex(auth.EvidenceError, "Duplicate Functions HTTP"):
            auth.function_surface_inventory([function, {**function, "Name": "ListOrders"}])

    def test_mcp_surface_inventory_rejects_unclassified_or_duplicate_tools(self):
        tool = {"Name": "get_product", "Policy": {"RequiredScope": "products.read"}}
        self.assertEqual(auth.mcp_surface_inventory([tool]), [{
            "id": "mcp:tool:get_product",
            "name": "get_product",
            "policy": {"RequiredScope": "products.read"},
        }])
        for tools in [[], [tool, tool], [{**tool, "Policy": None}]]:
            with self.subTest(tools=tools), self.assertRaises(auth.EvidenceError):
                auth.mcp_surface_inventory(tools)

    def test_dab_inventory_preserves_field_and_database_policy(self):
        permission = {"role": "consumer", "actions": [
            {"action": "read", "policy": {"database": "@item.ID eq @claims.customer_id"},
             "fields": {"include": ["ID"], "exclude": ["Password"]}}]}
        result = auth.dab_inventory({"entities": {"Order": {
            "source": {"object": "Sales.Order", "type": "table"}, "permissions": [permission]}}})
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["permission"], permission)
        self.assertEqual(result[0]["entity"], "Order")
        self.assertEqual(result[0]["id"], "dab:Order:consumer:read")

    def test_dab_rejects_role_level_fields_instead_of_silently_ignoring_exclusions(self):
        config = {"entities": {"Password": {
            "source": {"object": "Person.Password", "type": "table"},
            "permissions": [{"role": "executive-admin", "actions": ["read"],
                             "fields": {"exclude": ["PasswordHash", "PasswordSalt"]}}],
        }}}
        with self.assertRaisesRegex(auth.EvidenceError, "fields must be declared on each action"):
            auth.dab_inventory(config)
        permission = config["entities"]["Password"]["permissions"][0]
        permission["actions"] = [{"action": "read", "fields": permission.pop("fields")}]
        self.assertEqual(len(auth.dab_inventory(config)), 1)

    def test_dab_rejects_empty_discovery_and_unsupported_actions(self):
        for config in [{}, {"entities": {}}, {"entities": {"Order": {"permissions": []}}},
                       {"entities": {"Order": {"permissions": [{"role": "anonymous", "actions": ["magic"]}]}}}]:
            with self.subTest(config=config), self.assertRaises(auth.EvidenceError):
                auth.dab_inventory(config)
        duplicate = {"entities": {"Order": {
            "source": "Sales.Order",
            "permissions": [
                {"role": "consumer", "actions": ["read"]},
                {"role": "consumer", "actions": ["read"]},
            ],
        }}}
        with self.assertRaisesRegex(auth.EvidenceError, "Duplicate DAB"):
            auth.dab_inventory(duplicate)

    def test_dab_policy_columns_must_be_accessible_without_broadening_write_fields(self):
        for fields in [{"include": ["HelpfulVotes"]}, {"include": ["*"], "exclude": ["UserID"]}]:
            config = {"entities": {"ProductReview": {"source": "Production.ProductReview", "permissions": [{
                "role": "consumer", "actions": [{"action": "update", "fields": fields,
                    "policy": {"database": "@item.UserID ne @claims.business_entity_id"}}]}]}}}
            with self.subTest(fields=fields), self.assertRaisesRegex(auth.EvidenceError, "inaccessible fields: UserID"):
                auth.dab_inventory(config)

    def test_live_credential_fields_require_real_owned_metadata_and_role_denials_without_exporting_values(self):
        deployment = SimpleNamespace(required=lambda _: "https://dab.example.test/graphql/")
        consumers = [SimpleNamespace(label=label, business_id=owner, token=lambda *_: "consumer")
                     for label, owner in [("A", 71), ("B", 72)]]
        for scenario in ["complete", "hash-visible", "wrong-owner", "empty", "consumer-allowed",
                         "manufacturing-allowed", "role-spoof-allowed"]:
            calls = []

            def request(method, url, *, token=None, headers=None):
                self.assertEqual(method, "GET")
                self.assertTrue(url.startswith("https://dab.example.test/api/Password?"))
                calls.append((token, headers["X-MS-API-ROLE"]))
                owner = 71 if "71" in url else 72
                row = {"BusinessEntityID": owner, "rowguid": "fixture-guid", "ModifiedDate": "fixture-date"}
                allowed = (token == "admin" or scenario == "consumer-allowed" and token == "consumer" or
                           scenario == "manufacturing-allowed" and token == "manufacturing" or
                           scenario == "role-spoof-allowed" and headers["X-MS-API-ROLE"] == "executive-admin")
                if not allowed:
                    return 403, {}, b'{"error":{"code":"Forbidden"}}'
                if scenario == "hash-visible":
                    row["PasswordHash"] = "synthetic-sensitive-value"
                elif scenario == "wrong-owner":
                    row["BusinessEntityID"] = owner + 100
                rows = [] if scenario == "empty" else [row]
                return 200, {}, json.dumps({"value": rows}).encode()

            report = auth.Report(Path("."))
            with self.subTest(scenario=scenario), patch.object(auth, "http", side_effect=request):
                if scenario == "complete":
                    auth.dab_credential_field_restrictions(report, deployment, "admin", "manufacturing", consumers)
                    self.assertEqual(len(calls), 10)
                    self.assertEqual({check["status"] for check in report.checks}, {"PASS"})
                else:
                    with self.assertRaises(auth.EvidenceError):
                        auth.dab_credential_field_restrictions(
                            report, deployment, "admin", "manufacturing", consumers)
                    self.assertIn("FAIL", {check["status"] for check in report.checks})
                self.assertNotIn("synthetic-sensitive-value", json.dumps(report.checks))

    def run_employee_role_matrix(self, scenario):
        responses = {
            "admin": (200, {"data": {"employees": {"items": [{"BusinessEntityID": 42}]}}}),
            "manufacturing": (200, {"data": {"employees": {"items": []}},
                                    "errors": [{"message": "The current user is not authorized to access this resource.",
                                                "path": ["employees"],
                                                "extensions": {"code": "AUTH_NOT_AUTHORIZED"}}]}),
            "role-escalation": (403, {}),
        }
        calls = []

        def request(method, url, *, token=None, data=None, headers=None):
            calls.append((method, url, token, data, headers))
            label = "admin" if token == "admin-token" else (
                "role-escalation" if headers["X-MS-API-ROLE"] == "executive-admin" else "manufacturing")
            status, body = responses[label]
            if scenario == "employee-leak" and label == "manufacturing":
                body = {"data": {"employees": {"items": [{"BusinessEntityID": 42}]}}}
            if scenario == "admin-empty" and label == "admin":
                body = {"data": {"employees": {"items": []}}}
            if scenario == "denial-without-error" and label == "manufacturing":
                body = {"data": {"employees": {"items": []}}}
            if scenario == "wrong-denial" and label == "manufacturing":
                body = {"data": {}, "errors": [{"message": "Unknown field", "path": ["employees"],
                                                 "extensions": {"code": "GRAPHQL_VALIDATION_FAILED"}}]}
            if scenario == "invalid-json" and label == "manufacturing":
                return status, {}, b"{invalid"
            if status == 403:
                return status, {}, b""
            return status, {}, json.dumps(body).encode()

        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            deployment = SimpleNamespace(required=lambda key: "https://dab.example.invalid/graphql/")
            with patch.object(auth, "http", side_effect=request):
                report.guarded("dab:employee-role-matrix", "live-allows",
                    lambda: auth.dab_private_employee_role_matrix(
                        report, deployment, "admin-token", "manufacturing-token"))
            return report.checks, calls

    def test_dab_read_role_matrix_closes_schema_and_rejects_wrong_decisions_or_exported_columns(self):
        entities = {
            name: {"source": {"object": name, "type": "table"},
                   "fields": [{"name": "ID", "description": "Primary key."}],
                   "permissions": [{"role": role, "actions": ["read"]} for role in roles]}
            for name, roles in [("Product", ["anonymous", "executive-admin", "consumer"]),
                                ("Employee", ["executive-admin"]), ("Password", ["executive-admin"])]
        }
        selectors = {"products": "Product", "employees": "Employee", "passwords": "Password"}
        schema = {"queryType": {"fields": [
            {"name": selector, "type": {"kind": "NON_NULL", "name": None,
                                       "ofType": {"kind": "OBJECT", "name": name + "Connection"}}}
            for selector, name in selectors.items()]},
            "types": [{"name": name, "fields": [{"name": "ID"}]} for name in entities]}
        deployment = SimpleNamespace(required=lambda _: "https://dab.example.test/graphql/")
        consumers = [SimpleNamespace(label=label, token=lambda *_: "consumer-token") for label in ["A", "B"]]
        for scenario in ["complete", "wrong-denial", "wrong-allow", "extra-column", "missing-selector",
                         "invalid-selector-type",
                         "rest-wrong-denial", "rest-wrong-allow", "rest-extra-column", "rest-network-error"]:
            def request(method, url, *, token=None, headers=None, data=None):
                query = data["query"] if data else ""
                if "__schema" in query:
                    selected_schema = {**schema, "queryType": {"fields": schema["queryType"]["fields"][:-1]}} \
                        if scenario == "missing-selector" else schema
                    if scenario == "invalid-selector-type":
                        selected_schema = {**schema, "queryType": {"fields": [{
                            "name": "products", "type": {"kind": "NON_NULL", "ofType": None}}]}}
                    result = {"data": {"__schema": selected_schema}}
                else:
                    if method == "GET":
                        if scenario == "rest-network-error":
                            raise auth.EvidenceError("Synthetic network failure; not an authorization denial")
                        entity = url.split("/api/")[1].split("?")[0]
                        selector = next(key for key, value in selectors.items() if value == entity)
                    else:
                        selector = next(name for name in selectors if name + "(first:" in query)
                        entity = selectors[selector]
                    role = headers["X-MS-API-ROLE"]
                    allowed = any(permission["role"] in {role, "anonymous"}
                                  for permission in entities[entity]["permissions"])
                    if scenario == "wrong-denial" or scenario == "rest-wrong-denial" and method == "GET":
                        allowed = False
                    elif scenario == "wrong-allow" or scenario == "rest-wrong-allow" and method == "GET":
                        allowed = True
                    if allowed:
                        row = {"ID": 1}
                        if scenario == "extra-column" or scenario == "rest-extra-column" and method == "GET":
                            row["PrivateValue"] = "synthetic-withheld-value"
                        result = {"value": [row]} if method == "GET" else {"data": {selector: {"items": [row]}}}
                    else:
                        if method == "GET":
                            return 403, {}, b'{"error":{"code":"AuthorizationFailure"}}'
                        result = {"data": {selector: None}, "errors": [{
                            "message": "The current user is not authorized to access this resource.",
                            "path": [selector], "extensions": {
                                "code": "AUTH_NOT_AUTHENTICATED" if token is None else "AUTH_NOT_AUTHORIZED"},
                        }]}
                return 200, {}, json.dumps(result).encode()

            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "api").mkdir()
                (root / "api/dab-config.json").write_text(json.dumps({"entities": entities}))
                report = auth.Report(Path("."))
                with patch.object(auth, "ROOT", root), patch.object(auth, "http", side_effect=request):
                    if scenario in {"missing-selector", "invalid-selector-type"}:
                        with self.assertRaises(auth.EvidenceError):
                            auth.dab_read_role_matrix(report, deployment, "admin", "manufacturing", consumers)
                    else:
                        auth.dab_read_role_matrix(report, deployment, "admin", "manufacturing", consumers)
                        self.assertEqual(len(report.checks), 42)
                        self.assertEqual({item["status"] for item in report.checks},
                                         {"PASS"} if scenario == "complete" else
                                         {"PASS", "BLOCKED"} if scenario == "rest-network-error" else {"PASS", "FAIL"})
                self.assertNotIn("synthetic-withheld-value", json.dumps(report.checks))
                self.assertNotIn("synthetic-withheld-value", json.dumps(report.inventory))

    def test_dab_employee_role_matrix_checks_minimal_allowed_field_and_denials(self):
        checks, calls = self.run_employee_role_matrix("complete")
        self.assertEqual(len(checks), 3)
        self.assertTrue(all(item["status"] == "PASS" for item in checks), checks)
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(call[3] == {"query": "{ employees(first: 1) { items { BusinessEntityID } } }"}
                            for call in calls))
        self.assertTrue(all("42" not in check["detail"] for check in checks))
        self.assertFalse(any("token" in str(check).lower() for check in checks))

    def test_dab_employee_role_matrix_rejects_leaks_empty_positive_and_false_denials(self):
        for scenario in ["employee-leak", "admin-empty", "denial-without-error", "wrong-denial", "invalid-json"]:
            with self.subTest(scenario=scenario):
                checks, _ = self.run_employee_role_matrix(scenario)
                self.assertTrue(any(check["status"] in {"FAIL", "BLOCKED"} for check in checks), checks)

    def test_passwordless_sql_checks_auth_not_connection_string_variable_name(self):
        self.assertTrue(auth.passwordless_sql(
            "Server=tcp:server;Database=demo;Authentication=Active Directory Default;"))
        self.assertTrue(auth.passwordless_sql(
            "Server=server;Authentication=Active Directory Managed Identity;"))
        for value in [None, "", "Server=server;User ID=admin;Password=secret;",
                      "Authentication=Active Directory Default;Pwd=secret;",
                      "Authentication=Active Directory Default;Authentication=SqlPassword;",
                      "Server=server;BrokenField"]:
            with self.subTest(value=value):
                self.assertFalse(auth.passwordless_sql(value))

    def test_review_denial_uses_complete_shape_and_requires_absent_product(self):
        with patch.object(auth, "http", return_value=(200, {}, b'{"value":[]}')):
            body = auth.review_denial_body("https://dab.example.test")
            self.assertEqual(body["ProductID"], 0)
            self.assertEqual(body["UserID"], 0)
            self.assertEqual(set(body), {
                "ProductID", "ReviewerName", "ReviewDate", "EmailAddress", "Rating", "Comments", "UserID"})
        for response in [(200, {}, b'{"value":[{"ProductID":0}]}'),
                         (403, {}, b'{}'), (200, {}, b'invalid')]:
            with patch.object(auth, "http", return_value=response), self.assertRaises(auth.EvidenceError):
                auth.review_denial_body("https://dab.example.test")

    def test_contract_names_are_unique_and_chat_is_not_an_anonymous_business_exception(self):
        contract = json.loads(auth.CONTRACTS.read_text())
        self.assertEqual(len(contract["anonymousDabReads"]), len(set(contract["anonymousDabReads"])))
        self.assertEqual(contract["publicFunctions"]["AIAgentChat"], "alternate-mcp-enforcement")
        self.assertEqual(contract["groupScopedFunctions"], {"NegotiateWebPubSub": "realtime.connect"})
        self.assertNotIn("NegotiateWebPubSub", contract["publicFunctions"])
        self.assertNotIn("ShoppingCartItem", contract["anonymousDabReads"])
        self.assertNotIn("ShoppingCartItem", contract["unreviewedAnonymousDabOperations"])

    def test_group_scoped_function_contract_pins_the_route_and_required_scope(self):
        for mode, scope, expected in [
                ("GroupScoped", "realtime.connect", "PASS"),
                ("GroupScoped", "orders.read", "FAIL"),
                ("InternalOnly", "realtime.connect", "FAIL")]:
            with self.subTest(mode=mode, scope=scope), tempfile.TemporaryDirectory() as directory:
                report = auth.Report(Path(directory))
                report.inventory["functions"] = [{
                    "Name": "NegotiateWebPubSub",
                    "Policy": {"IsAnonymous": False, "Mode": mode, "RequiredScope": scope},
                }]
                auth.contracts(report)
                check = next(item for item in report.checks
                             if item["id"] == "inventory:group-scoped-functions")
                self.assertEqual(expected, check["status"])

    def test_webpubsub_capability_parser_returns_only_groups_and_remaining_lifetime(self):
        claims = {
            "webpubsub.group": ["orders", "finance"],
            "exp": int(auth.time.time()) + 600,
        }
        payload = auth.base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        url = "https://push.example.invalid/client/?access_token=header." + payload + ".signature"
        groups, lifetime = auth.webpubsub_group_claims(json.dumps({"url": url}).encode())
        self.assertEqual({"orders", "finance"}, groups)
        self.assertGreater(lifetime, 0)
        self.assertLessEqual(lifetime, 600)

        single_payload = auth.base64.urlsafe_b64encode(json.dumps({
            "webpubsub.group": "orders",
            "exp": int(auth.time.time()) + 600,
        }).encode()).decode().rstrip("=")
        single_url = ("https://push.example.invalid/client/?access_token=header." +
                      single_payload + ".signature")
        self.assertEqual({"orders"}, auth.webpubsub_group_claims(
            json.dumps({"url": single_url}).encode())[0])

        with self.assertRaises(auth.EvidenceError):
            auth.webpubsub_group_claims(b'{"url":"https://push.example.invalid/client"}')

        legacy_payload = auth.base64.urlsafe_b64encode(json.dumps({
            "groups": ["orders"],
            "exp": int(auth.time.time()) + 600,
        }).encode()).decode().rstrip("=")
        with self.assertRaises(auth.EvidenceError):
            auth.webpubsub_group_claims(
                json.dumps({"url": "https://push.example.invalid/client/?access_token=header." +
                           legacy_payload + ".signature"}).encode())

    def test_webpubsub_socket_capability_is_bound_to_selected_host_and_hub(self):
        host = "push.example.test"
        url = "wss://push.example.test/client/hubs/adventureworks?access_token=synthetic"
        self.assertEqual(auth.webpubsub_socket_target(json.dumps({"url": url}), host),
                         "/client/hubs/adventureworks?access_token=synthetic")
        for invalid in [
                url.replace(host, "other.example.test"),
                url.replace("wss://", "https://"),
                url.replace(host, host + ":443"),
                url.replace("adventureworks", "other"),
                url + "#fragment",
                url + "&access_token=another",
                url.replace("=synthetic", "=")]:
            with self.subTest(url=invalid), self.assertRaises(auth.EvidenceError):
                auth.webpubsub_socket_target(json.dumps({"url": invalid}), host)

    def test_webpubsub_socket_controls_fail_closed_and_never_forward_foreign_capabilities(self):
        host = "push.example.test"
        capability = json.dumps({
            "url": "wss://push.example.test/client/hubs/adventureworks?access_token=synthetic",
        })
        for responses, expected in [
                ([(101, True), (401, False)], ["PASS", "PASS"]),
                ([(101, False), (401, False)], ["FAIL", "PASS"]),
                ([(401, False), (101, True)], ["FAIL", "FAIL"]),
                ([(429, False), (401, False)], ["BLOCKED", "PASS"])]:
            with self.subTest(responses=responses):
                report = auth.Report(Path("."))
                with patch.object(auth, "webpubsub_socket_handshake", side_effect=responses):
                    auth.webpubsub_socket_controls(report, host, capability)
                self.assertEqual([check["status"] for check in report.checks], expected)
                self.assertNotIn("synthetic", json.dumps(report.checks))

        report = auth.Report(Path("."))
        with patch.object(auth, "webpubsub_socket_handshake", return_value=(401, False)) as handshake:
            auth.webpubsub_socket_controls(report, host, capability.replace(host, "foreign.example.test"))
        self.assertEqual([check["status"] for check in report.checks], ["FAIL", "PASS"])
        handshake.assert_called_once_with(host, "/client/hubs/adventureworks")

    def test_webpubsub_socket_handshake_verifies_upgrade_and_closes_connection(self):
        class Connection:
            closed = False

            def __init__(self, correct):
                self.correct = correct

            def request(self, method, target, headers):
                self.key = headers["Sec-WebSocket-Key"]

            def getresponse(self):
                connection = self

                class Response:
                    status = 101

                    def getheader(self, name, default=None):
                        accept = auth.base64.b64encode(auth.hashlib.sha1(
                            (connection.key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii"),
                            usedforsecurity=False).digest()).decode("ascii")
                        return {"Upgrade": "websocket", "Connection": "Upgrade",
                                "Sec-WebSocket-Accept": accept if connection.correct else "wrong"}.get(name, default)

                return Response()

            def close(self):
                self.closed = True

        for correct in [True, False]:
            with self.subTest(correct=correct):
                connection = Connection(correct)
                with patch.object(auth.http_client, "HTTPSConnection", return_value=connection):
                    self.assertEqual(auth.webpubsub_socket_handshake("push.example.test", "/client"), (101, correct))
                self.assertTrue(connection.closed)

    def test_promotion_agent_requires_scoped_admin_and_records_no_generated_content(self):
        report = auth.Report(Path("."))
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_MCP_URL": "https://mcp.example.test/mcp",
        }[key])
        calls = []

        def fake_http(method, url, *, token=None, data=None):
            calls.append((method, url, token, data))
            if token is None:
                return 401, {"WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", error="missing_token"'}, b'{"error":"missing_token"}'
            if token == "dab-token":
                return 401, {"WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", error="invalid_token"'}, b'{"error":"invalid_token"}'
            if token == "manufacturing-token":
                return 403, {"WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", error="insufficient_scope"'}, b'{"error":"insufficient_scope"}'
            return 200, {}, b'{"suggestion":{"suggestedProducts":[],"private":"not evidence"},"threadId":"response-id"}'

        with patch.object(auth, "http", side_effect=fake_http):
            auth.promotion_agent_authorization(
                report, deployment, "admin-token", "manufacturing-token", "dab-token")

        self.assertEqual(len(calls), 4)
        self.assertTrue(all(check["status"] == "PASS" for check in report.checks))
        self.assertEqual({check["id"] for check in report.checks}, {
            "agent:promotion-suggestion:deny-anonymous",
            "agent:promotion-suggestion:deny-wrong-audience",
            "agent:promotion-suggestion:deny-insufficient-scope",
            "agent:promotion-suggestion:allow-admin",
        })
        self.assertNotIn("not evidence", json.dumps(report.checks))
        self.assertEqual(calls[-1][3], {
            "promotionType": "AuthAssurance", "offerCategory": "Customer", "categoryName": "Bikes",
        })

    def test_promotion_agent_stops_after_first_unexpected_denial(self):
        report = auth.Report(Path("."))
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_MCP_URL": "https://mcp.example.test/mcp",
        }[key])
        with patch.object(auth, "http", return_value=(200, {}, b'{"suggestion":{}}')) as http:
            with self.assertRaises(auth.EvidenceError):
                auth.promotion_agent_authorization(
                    report, deployment, "admin-token", "manufacturing-token", "dab-token")
        http.assert_called_once()
        self.assertEqual(report.checks[0]["status"], "FAIL")

    def test_customer_chat_source_matches_the_guarded_read_only_tool_set(self):
        source = auth.agent_provisioner_tool_inventory(auth.ROOT / "scripts/utilities/agents")
        self.assertEqual(set(source["eshop-chat-agent"]), auth.CUSTOMER_CHAT_TOOLS)
        self.assertEqual(set(source["admin-chat-agent"]), auth.ADMIN_CHAT_TOOLS)

    def test_focused_chat_profile_never_creates_missing_consumer_fixtures(self):
        deployment = SimpleNamespace(values={})
        report = auth.Report(Path("."))
        with patch.object(auth, "consumer_fixtures") as fixtures, self.assertRaises(auth.EvidenceError):
            auth.retained_consumer_fixtures(report, deployment)
        fixtures.assert_not_called()

    def test_customer_chat_definition_requires_exact_reviewed_tools_and_target(self):
        values = {
            "AI_FOUNDRY_PROJECT_ENDPOINT": "https://foundry.example.test/api/projects/project",
            "AI_AGENT_CHAT_ID": "chat-agent",
            "MCP_SERVICE_URL": "https://mcp.example.test/mcp",
        }
        deployment = SimpleNamespace(required=lambda key: values[key])
        definition = {
            "id": "chat-agent",
            "versions": {"latest": {"id": "chat-agent:2", "definition": {
                "kind": "prompt", "instructions": "Configured",
                "tools": [{
                    "type": "mcp", "server_label": "adventureworks_mcp",
                    "server_url": "https://mcp.example.test/mcp",
                    "allowed_tools": {"tool_names": sorted(auth.CUSTOMER_CHAT_TOOLS)},
                }],
            }}},
        }
        for defect, expected in [
                (None, "PASS"), ("old-inventory-tool", "FAIL"), ("extra-tool", "FAIL"),
                ("wrong-target", "FAIL"), ("static-header", "FAIL"), ("additional-tool", "FAIL"),
                ("extra-allowlist-field", "FAIL"), ("invalid-tools", "FAIL"),
                ("invalid-url", "FAIL"), ("missing-version", "FAIL"), ("missing-instructions", "FAIL")]:
            with self.subTest(defect=defect):
                document = copy.deepcopy(definition)
                latest = document["versions"]["latest"]
                configured = latest["definition"]
                tool = configured["tools"][0]
                names = tool["allowed_tools"]["tool_names"]
                if defect == "old-inventory-tool":
                    names.remove("get_product_availability")
                    names.append("check_inventory_availability")
                elif defect == "extra-tool":
                    names.append("create_order")
                elif defect == "wrong-target":
                    tool["server_url"] = "https://other.example.test/mcp"
                elif defect == "static-header":
                    tool["headers"] = {"Authorization": "PRIVATE"}
                elif defect == "additional-tool":
                    configured["tools"].append({"type": "function", "name": "unreviewed"})
                elif defect == "extra-allowlist-field":
                    tool["allowed_tools"]["unreviewed"] = True
                elif defect == "invalid-tools":
                    configured["tools"] = None
                elif defect == "invalid-url":
                    tool["server_url"] = None
                elif defect == "missing-version":
                    latest.pop("id")
                elif defect == "missing-instructions":
                    configured["instructions"] = ""
                report = auth.Report(Path("."))
                with patch.object(auth, "command", return_value="foundry-token"), \
                        patch.object(auth, "http", return_value=(200, {}, json.dumps(document).encode())):
                    auth.customer_chat_agent_definition(report, deployment)
                self.assertEqual(report.checks[0]["status"], expected)
                self.assertNotIn("PRIVATE", json.dumps(report.checks))
                self.assertNotIn("foundry-token", json.dumps(report.checks))

    def test_admin_chat_definition_requires_exact_reviewed_tools_and_target(self):
        values = {
            "AI_FOUNDRY_PROJECT_ENDPOINT": "https://foundry.example.test/api/projects/project",
            "AI_AGENT_ADMIN_CHAT_ID": "admin-agent",
            "MCP_SERVICE_URL": "https://mcp.example.test/mcp",
        }
        deployment = SimpleNamespace(required=lambda key: values[key])
        definition = {"id": "admin-agent", "versions": {"latest": {
            "id": "admin-agent:1", "definition": {"kind": "prompt", "instructions": "Configured",
            "tools": [{"type": "mcp", "server_label": "adventureworks_mcp",
                       "server_url": "https://mcp.example.test/mcp",
                       "allowed_tools": {"tool_names": sorted(auth.ADMIN_CHAT_TOOLS)}}]},
        }}}
        for defect, expected in [(None, "PASS"), ("mutation", "FAIL"), ("missing", "FAIL"),
                                 ("wrong-target", "FAIL"), ("static-header", "FAIL")]:
            document = copy.deepcopy(definition)
            tool = document["versions"]["latest"]["definition"]["tools"][0]
            if defect == "mutation":
                tool["allowed_tools"]["tool_names"].append("create_order")
            elif defect == "missing":
                tool["allowed_tools"]["tool_names"].remove("get_business_stats")
            elif defect == "wrong-target":
                tool["server_url"] = "https://other.example.test/mcp"
            elif defect == "static-header":
                tool["headers"] = {"Authorization": "PRIVATE"}
            report = auth.Report(Path("."))
            with self.subTest(defect=defect), patch.object(auth, "command", return_value="foundry-token"), \
                    patch.object(auth, "http", return_value=(200, {}, json.dumps(document).encode())):
                auth.admin_chat_agent_definition(report, deployment)
            self.assertEqual(report.checks[0]["status"], expected)
            self.assertNotIn("PRIVATE", json.dumps(report.checks))
            self.assertNotIn("foundry-token", json.dumps(report.checks))

    def test_admin_chat_canary_requires_direct_controls_and_never_credits_narrative(self):
        deployment = SimpleNamespace(required=lambda _: "https://functions.example.test")

        def report_with_controls():
            report = auth.Report(Path("."))
            for check_id, group in [
                    ("agent:admin-chat:definition", "agent-policy"),
                    ("agent:admin-chat:direct-allow", "live-allows"),
                    ("agent:admin-chat:direct-denial", "live-denials")]:
                report.add(check_id, group, "PASS", "Reviewed control.")
            return report

        for defect in ["opt-in", "definition", "allow", "denial"]:
            report = report_with_controls()
            if defect != "opt-in":
                report.checks[{"definition": 0, "allow": 1, "denial": 2}[defect]]["status"] = "BLOCKED"
            with self.subTest(defect=defect), patch.object(auth, "http") as request, \
                    self.assertRaises(auth.EvidenceError):
                auth.admin_chat_flow(report, deployment, "admin-token", allow_agent_canary=defect != "opt-in")
            request.assert_not_called()

        for tools, expected in [
                (["get_business_stats"], ("PASS", "PASS")),
                ([], ("PASS", "BLOCKED")),
                (["create_order"], ("FAIL", "BLOCKED"))]:
            report = report_with_controls()
            with self.subTest(tools=tools), patch.object(
                    auth, "http", return_value=(200, {}, json.dumps({
                        "response": "private generated text", "toolsUsed": tools,
                        "threadId": "private-response-id",
                    }).encode())) as request:
                auth.admin_chat_flow(report, deployment, "admin-token", allow_agent_canary=True)
            self.assertEqual(tuple(item["status"] for item in report.checks[-2:]), expected)
            request.assert_called_once()
            self.assertEqual(request.call_args.kwargs["token"], "admin-token")
            self.assertTrue(request.call_args.kwargs["data"]["isAdmin"])
            self.assertRegex(request.call_args.kwargs["headers"]["traceparent"],
                             r"^00-[a-f0-9]{32}-[a-f0-9]{16}-01$")
            exported = json.dumps({"checks": report.checks, "inventory": report.inventory})
            for private in ["admin-token", "private generated text", "private-response-id"]:
                self.assertNotIn(private, exported)

    def test_admin_chat_direct_controls_require_real_allow_and_sales_denial(self):
        deployment = SimpleNamespace(required=lambda _: "https://mcp.example.test/mcp")
        for positive, negative, expected in [
                ((False, ["=== AdventureWorks Business Dashboard ===\nprivate"]), (True, ["sales.read"]), ("PASS", "PASS")),
                ((True, ["denied"]), (True, ["sales.read"]), ("FAIL", "PASS")),
                ((False, ["=== AdventureWorks Business Dashboard ==="]), (False, ["sales.read"]), ("PASS", "FAIL"))]:
            report = auth.Report(Path("."))
            with self.subTest(expected=expected), patch.object(
                    auth, "consumer_mcp_tool_call", side_effect=[positive, negative]) as call:
                auth.admin_chat_direct_controls(report, deployment, "admin-token", "manufacturing-token")
            self.assertEqual(tuple(item["status"] for item in report.checks), expected)
            self.assertEqual([item.args[1] for item in call.call_args_list], ["get_business_stats"] * 2)
            self.assertNotIn("private", json.dumps(report.checks))

    def test_admin_chat_correlation_binds_employee_scope_version_and_trace(self):
        subject = "00000000-0000-4000-8000-000000000001"
        payload = base64.urlsafe_b64encode(json.dumps({"sub": subject}).encode()).decode().rstrip("=")
        token = "header." + payload + ".signature"
        values = {"AI_AGENT_ADMIN_CHAT_ID": "admin-agent", "AZURE_RESOURCE_GROUP": "group"}

        def report_with_trace():
            report = auth.Report(Path("."))
            for check_id, group in [
                    ("agent:admin-chat:definition", "agent-policy"),
                    ("agent:admin-chat:response", "agents"),
                    ("agent:admin-chat:reported-tool", "agents")]:
                report.add(check_id, group, "PASS", "Current evidence.")
            report.inventory["adminChatTraceId"] = "a" * 32
            return report

        for rows, expected in [([["admin-agent:1", "get_business_stats", 1]], "PASS"),
                               ([], "BLOCKED"),
                               ([["other-agent:1", "get_business_stats", 1]], None),
                               ([["admin-agent:1", "search_products", 1]], None)]:
            queries = []

            def azure(*args):
                if args[:2] == ("resource", "list"):
                    return ["app"]
                queries.append(args[args.index("--analytics-query") + 1])
                return {"tables": [{"columns": [{"name": name} for name in
                                                 ["AgentVersionId", "Tool", "Hits"]], "rows": rows}]}

            deployment = SimpleNamespace(required=lambda key: values[key], azure=azure, runtime=None)
            report = report_with_trace()
            with self.subTest(rows=rows), patch.object(auth.time, "sleep"):
                if expected is None:
                    with self.assertRaises(auth.EvidenceError):
                        auth.delegated_chat_correlated_tool(report, deployment, lambda: token, "admin-chat")
                else:
                    auth.delegated_chat_correlated_tool(report, deployment, lambda: token, "admin-chat")
                    self.assertEqual(report.checks[-1]["status"], expected)
            for query in queries:
                for required in ["a" * 32, "admin-agent", "admin-chat", "get_business_stats", "sales.read",
                                 "employee", "adventureworks-admin", "CompletedMcpTools",
                                 auth.hashlib.sha256(subject.encode()).hexdigest()]:
                    self.assertIn(required, query)
                self.assertNotIn(subject, query)
                self.assertNotIn(token, query)
            self.assertNotIn(subject, json.dumps(report.inventory))
            self.assertNotIn(token, json.dumps(report.inventory))

    def test_admin_chat_correlation_credits_only_exact_current_inventory_edge(self):
        agent_id = "admin-agent"
        mcp = {
            "type": "mcp", "server_label": "adventureworks_mcp",
            "server_url": "https://mcp.example.test/mcp",
            "allowed_tools": sorted(auth.ADMIN_CHAT_TOOLS),
        }
        deployment = SimpleNamespace(required=lambda key: {
            "AI_AGENT_ADMIN_CHAT_ID": agent_id,
            "MCP_SERVICE_URL": "https://mcp.example.test/mcp",
        }[key])

        def make_report():
            summary = auth.summarize_agent_version(agent_id, "1", {"definition": {
                "kind": "prompt", "tools": [mcp],
            }}, "https://mcp.example.test", "https://dab.example.test")
            report = auth.Report(Path("."))
            edges = auth.agent_tool_runtime_evidence(report, [summary])
            report.inventory.update({
                "deployedAgentVersions": [summary], "agentDependencyEdges": edges,
                "adminChatCorrelatedTools": [{"version": "admin-agent:1", "tool": "get_business_stats", "matches": 1}],
            })
            for check_id, group in [
                    ("agent:admin-chat:definition", "agent-policy"),
                    ("agent:admin-chat:direct-allow", "live-allows"),
                    ("agent:admin-chat:direct-denial", "live-denials"),
                    ("agent:admin-chat:response", "agents"),
                    ("agent:admin-chat:reported-tool", "agents"),
                    ("agent:admin-chat:correlated-tool", "agents")]:
                report.add(check_id, group, "PASS", "Current evidence.")
            return report

        report = make_report()
        auth.reconcile_admin_chat_tool_paths(report, deployment)
        paths = {item["id"].rsplit(":", 1)[-1]: item["status"] for item in report.checks
                 if item["id"].startswith("agent-tool-path:")}
        self.assertEqual(paths["get_business_stats"], "PASS")
        self.assertTrue(all(status == "BLOCKED" for name, status in paths.items() if name != "get_business_stats"))
        self.assertEqual(report.checks[-1]["status"], "PASS")

        report = make_report()
        report.inventory["adminChatCorrelatedTools"][0]["version"] = "admin-agent:2"
        auth.reconcile_admin_chat_tool_paths(report, deployment)
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")
        self.assertTrue(all(item["status"] == "BLOCKED" for item in report.checks
                            if item["id"].startswith("agent-tool-path:")))

        report = make_report()
        next(item for item in report.checks if item["id"] == "agent:admin-chat:direct-denial")["status"] = "FAIL"
        with self.assertRaises(auth.EvidenceError):
            auth.reconcile_admin_chat_tool_paths(report, deployment)

    def test_customer_chat_canary_requires_controls_and_never_credits_narrative(self):
        consumer = SimpleNamespace(label="A", token=lambda resource, scopes=None: "consumer-token")
        deployment = SimpleNamespace(required=lambda _: "https://functions.example.test")

        def report_with_controls():
            report = auth.Report(Path("."))
            report.add("agent:customer-chat:definition", "agent-policy", "PASS", "Reviewed definition.")
            report.add("mcp-consumer:A:availability", "live-allows", "PASS", "Confirmed product.")
            return report

        for defect in ["opt-in", "definition", "availability", "product"]:
            report = report_with_controls()
            if defect in {"definition", "availability"}:
                report.checks[0 if defect == "definition" else 1]["status"] = "BLOCKED"
            with self.subTest(defect=defect), patch.object(auth, "http") as request, \
                    self.assertRaises(auth.EvidenceError):
                auth.customer_chat_flow(report, deployment, consumer, None if defect == "product" else 123,
                                        allow_agent_canary=defect != "opt-in")
            request.assert_not_called()

        for tools, expected in [
                (["get_product_availability"], ("PASS", "PASS")),
                ([], ("PASS", "BLOCKED")),
                (["create_order"], ("FAIL", "BLOCKED"))]:
            report = report_with_controls()
            with self.subTest(tools=tools), patch.object(
                    auth, "http", return_value=(200, {}, json.dumps({
                        "response": "private generated text", "toolsUsed": tools,
                        "threadId": "private-response-id",
                    }).encode())) as request:
                auth.customer_chat_flow(report, deployment, consumer, 123, allow_agent_canary=True)
            self.assertEqual(tuple(item["status"] for item in report.checks[-2:]), expected)
            request.assert_called_once()
            self.assertEqual(request.call_args.kwargs["token"], "consumer-token")
            self.assertEqual(request.call_args.kwargs["data"]["isAdmin"], False)
            self.assertRegex(request.call_args.kwargs["headers"]["traceparent"],
                             r"^00-[a-f0-9]{32}-[a-f0-9]{16}-01$")
            exported = json.dumps({"checks": report.checks, "inventory": report.inventory})
            for private in ["consumer-token", "private generated text", "private-response-id"]:
                self.assertNotIn(private, exported)

    def test_customer_chat_correlation_requires_trace_loaded_version_and_delegated_subject(self):
        subject = "00000000-0000-4000-8000-000000000001"
        payload = base64.urlsafe_b64encode(json.dumps({"sub": subject}).encode()).decode().rstrip("=")
        token = "header." + payload + ".signature"
        consumer = SimpleNamespace(label="A", token=lambda resource, scopes=None: token)
        values = {"AI_AGENT_CHAT_ID": "chat-agent", "AZURE_RESOURCE_GROUP": "group"}

        def report_with_trace():
            report = auth.Report(Path("."))
            for check_id, group in [
                    ("agent:customer-chat:definition", "agent-policy"),
                    ("agent:customer-chat:response", "agents"),
                    ("agent:customer-chat:reported-tool", "agents")]:
                report.add(check_id, group, "PASS", "Current evidence.")
            report.inventory["customerChatTraceId"] = "a" * 32
            return report

        for rows, expected in [
                ([["chat-agent:2", "get_product_availability", 1]], "PASS"),
                ([], "BLOCKED"),
                ([["other-agent:2", "get_product_availability", 1]], None),
                ([["chat-agent:2", "search_products", 1]], None),
                ([["chat-agent:2", "get_product_availability", True]], None),
                ([["chat-agent:2", "get_product_availability", 1]] * 2, None)]:
            with self.subTest(rows=rows):
                queries = []

                def azure(*args):
                    if args[:2] == ("resource", "list"):
                        return ["app"]
                    self.assertEqual(args[:3], ("monitor", "app-insights", "query"))
                    queries.append(args[args.index("--analytics-query") + 1])
                    return {"tables": [{"columns": [{"name": name} for name in
                                                     ["AgentVersionId", "Tool", "Hits"]], "rows": rows}]}

                deployment = SimpleNamespace(required=lambda key: values[key], azure=azure, runtime=None)
                report = report_with_trace()
                with patch.object(auth.time, "sleep"):
                    if expected is None:
                        with self.assertRaises(auth.EvidenceError):
                            auth.customer_chat_correlated_tool(report, deployment, consumer)
                    else:
                        auth.customer_chat_correlated_tool(report, deployment, consumer)
                        self.assertEqual(report.checks[-1]["status"], expected)
                self.assertEqual(len(queries), 4 if not rows else 1)
                for query in queries:
                    for required in ["a" * 32, "chat-agent", "customer-chat", "get_product_availability",
                                     "products.read", "adventureworks-eshop", "CompletedMcpTools",
                                     "hash_sha256", auth.hashlib.sha256(subject.encode()).hexdigest()]:
                        self.assertIn(required, query)
                    self.assertNotIn(subject, query)
                    self.assertNotIn(token, query)
                self.assertNotIn(subject, json.dumps(report.inventory))
                self.assertNotIn(token, json.dumps(report.inventory))

        report = report_with_trace()
        report.checks[-1]["status"] = "BLOCKED"
        deployment = SimpleNamespace(required=lambda key: values[key], azure=lambda *args: self.fail("No ARM calls"))
        with self.assertRaises(auth.EvidenceError):
            auth.customer_chat_correlated_tool(report, deployment, consumer)

    def test_customer_chat_correlation_credits_only_exact_current_inventory_edge(self):
        agent_id = "chat-agent"
        mcp = {
            "type": "mcp", "server_label": "adventureworks_mcp",
            "server_url": "https://mcp.example.test/mcp",
            "allowed_tools": sorted(auth.CUSTOMER_CHAT_TOOLS),
        }
        deployment = SimpleNamespace(required=lambda key: {
            "AI_AGENT_CHAT_ID": agent_id,
            "MCP_SERVICE_URL": "https://mcp.example.test/mcp",
        }[key])

        def make_report():
            summary = auth.summarize_agent_version(agent_id, "2", {"definition": {
                "kind": "prompt", "tools": [mcp],
            }}, "https://mcp.example.test", "https://dab.example.test")
            report = auth.Report(Path("."))
            edges = auth.agent_tool_runtime_evidence(report, [summary])
            report.inventory.update({
                "deployedAgentVersions": [summary], "agentDependencyEdges": edges,
                "customerChatCorrelatedTools": [
                    {"version": "chat-agent:2", "tool": "get_product_availability", "matches": 1}],
            })
            for check_id, group in [
                    ("agent:customer-chat:definition", "agent-policy"),
                    ("agent:customer-chat:response", "agents"),
                    ("agent:customer-chat:reported-tool", "agents"),
                    ("agent:customer-chat:correlated-tool", "agents")]:
                report.add(check_id, group, "PASS", "Current evidence.")
            return report

        report = make_report()
        auth.reconcile_customer_chat_tool_paths(report, deployment)
        paths = {item["id"].rsplit(":", 1)[-1]: item["status"] for item in report.checks
                 if item["id"].startswith("agent-tool-path:")}
        self.assertEqual(paths["get_product_availability"], "PASS")
        self.assertTrue(all(status == "BLOCKED" for name, status in paths.items()
                            if name != "get_product_availability"))
        self.assertEqual(report.checks[-1]["status"], "PASS")

        for defect in ["version", "origin", "missing-control"]:
            report = make_report()
            if defect == "version":
                report.inventory["customerChatCorrelatedTools"][0]["version"] = "chat-agent:1"
            elif defect == "origin":
                next(edge for edge in report.inventory["agentDependencyEdges"]
                     if edge["tool"] == "get_product_availability")["toOrigin"] = "https://other.example.test"
            else:
                next(item for item in report.checks
                     if item["id"] == "agent:customer-chat:correlated-tool")["status"] = "BLOCKED"
            if defect == "missing-control":
                with self.assertRaises(auth.EvidenceError):
                    auth.reconcile_customer_chat_tool_paths(report, deployment)
            else:
                auth.reconcile_customer_chat_tool_paths(report, deployment)
                self.assertEqual(report.checks[-1]["status"], "BLOCKED")
            self.assertTrue(all(item["status"] == "BLOCKED" for item in report.checks
                                if item["id"].startswith("agent-tool-path:")))

    def test_help_me_choose_agent_definition_pins_scoped_catalog_only_policy(self):
        report = auth.Report(Path("."))
        values = {
            "AI_FOUNDRY_PROJECT_ENDPOINT": "https://foundry.example.test/api/projects/project",
            "AI_AGENT_HELP_ME_CHOOSE_ID": "agent/id",
            "MCP_SERVICE_URL": "https://mcp.example.test/mcp",
        }
        deployment = SimpleNamespace(required=lambda key: values[key])
        definition = {
            "id": "agent/id",
            "versions": {"latest": {"definition": {
                "memory_stores": [],
                "structured_inputs": {"cultureId": {}, "profileContext": {}},
                "tools": [{
                    "type": "mcp",
                    "server_label": "adventureworks_mcp",
                    "server_url": "https://mcp.example.test/mcp",
                    "allowed_tools": {"tool_names": [
                        "search_products", "get_product_details",
                        "find_complementary_products", "get_categories_with_products",
                    ]},
                }],
            }}},
        }
        with patch.object(auth, "command", return_value="foundry-token") as command, \
                patch.object(auth, "http", return_value=(200, {}, json.dumps(definition).encode())) as request:
            auth.help_me_choose_agent_definition(report, deployment)
        command.assert_called_once_with([
            "az", "account", "get-access-token", "--resource", "https://ai.azure.com/",
            "--query", "accessToken", "-o", "tsv",
        ])
        self.assertIn("/agents/agent%2Fid?api-version=v1", request.call_args.args[1])
        self.assertEqual(request.call_args.kwargs["token"], "foundry-token")
        self.assertEqual(report.checks[0]["status"], "PASS")
        self.assertNotIn("foundry-token", json.dumps(report.checks))

        for defect in ["extra-mcp", "other-tool", "wrong-target", "static-header", "static-authorization",
                       "connection", "duplicate", "extra-allowlist-field"]:
            with self.subTest(defect=defect):
                changed = copy.deepcopy(definition)
                tools = changed["versions"]["latest"]["definition"]["tools"]
                if defect == "extra-mcp":
                    tools.append({"type": "mcp", "server_label": "dabmcp", "allowed_tools": []})
                elif defect == "other-tool":
                    tools.append({"type": "function", "name": "unreviewed"})
                elif defect == "wrong-target":
                    tools[0]["server_url"] = "https://other.example.test/mcp"
                elif defect == "static-header":
                    tools[0]["headers"] = {"Authorization": "PRIVATE"}
                elif defect == "static-authorization":
                    tools[0]["authorization"] = "PRIVATE"
                elif defect == "connection":
                    tools[0]["project_connection_id"] = "unreviewed"
                elif defect == "extra-allowlist-field":
                    tools[0]["allowed_tools"]["unreviewed"] = True
                else:
                    tools[0]["allowed_tools"]["tool_names"].append("search_products")
                report = auth.Report(Path("."))
                with patch.object(auth, "command", return_value="foundry-token"), \
                        patch.object(auth, "http", return_value=(200, {}, json.dumps(changed).encode())):
                    auth.help_me_choose_agent_definition(report, deployment)
                self.assertEqual(report.checks[0]["status"], "FAIL")
                self.assertNotIn("PRIVATE", json.dumps(report.checks))

    def test_help_me_choose_public_flow_is_anonymous_and_rejects_fallback_or_thread_ids(self):
        deployment = SimpleNamespace(required=lambda _: "https://functions.example.test")
        calls = []
        questions = {
            "sessionId": "a" * 32,
            "questions": [{"id": index, "options": ["a", "b", "c", "d"]} for index in range(1, 6)],
        }
        recommendations = {
            "recommendations": [{"productId": index} for index in range(1, 4)],
            "searchTermsUsed": ["mountain bike"],
        }

        def fake_http(method, url, *, token=None, data=None, timeout=None, headers=None):
            calls.append((method, url, token, data, timeout, headers))
            payload = questions if url.endswith("/questions") else recommendations
            return 200, {}, json.dumps(payload).encode()

        def report_with_control():
            report = auth.Report(Path("."))
            report.add("agent:helpme-choose:definition", "agent-policy", "PASS", "Reviewed definition.")
            return report

        report = report_with_control()
        with patch.object(auth, "http", side_effect=fake_http):
            auth.help_me_choose_public_flow(report, deployment, allow_agent_canary=True)
        self.assertEqual([check["status"] for check in report.checks], ["PASS", "PASS", "PASS"])
        self.assertTrue(all(call[2] is None for call in calls))
        self.assertEqual(calls[1][3]["customerId"], 0)
        self.assertEqual(calls[1][3]["previousThreadId"], "resp_auth_validation_untrusted")
        for call in calls:
            self.assertRegex(call[5]["traceparent"], r"^00-[a-f0-9]{32}-[a-f0-9]{16}-01$")
        self.assertNotEqual(calls[0][5]["traceparent"], calls[1][5]["traceparent"])
        self.assertNotIn("resp_auth_validation_untrusted", json.dumps(report.checks))

        fallback_report = report_with_control()
        fallback = {"recommendations": [], "searchTermsUsed": []}

        def fallback_http(method, url, **kwargs):
            payload = questions if url.endswith("/questions") else fallback
            return 200, {}, json.dumps(payload).encode()

        with patch.object(auth, "http", side_effect=fallback_http):
            auth.help_me_choose_public_flow(fallback_report, deployment, allow_agent_canary=True)
        self.assertEqual([check["status"] for check in fallback_report.checks], ["PASS", "PASS", "FAIL"])

        thread_report = report_with_control()
        threaded_questions = {
            **questions, "threadId": "foundry-response-id", "responseId": "foundry-response-id",
        }

        def threaded_http(method, url, **kwargs):
            payload = threaded_questions if url.endswith("/questions") else recommendations
            return 200, {}, json.dumps(payload).encode()

        with patch.object(auth, "http", side_effect=threaded_http) as http:
            auth.help_me_choose_public_flow(thread_report, deployment, allow_agent_canary=True)
        http.assert_called_once()
        self.assertEqual([check["status"] for check in thread_report.checks], ["PASS", "FAIL", "BLOCKED"])
        self.assertNotIn("foundry-response-id", json.dumps(thread_report.checks))

    def test_help_me_choose_public_flow_requires_a_passing_agent_definition_before_network(self):
        deployment = SimpleNamespace(required=lambda _: "https://functions.example.test")
        for status in [None, "FAIL", "BLOCKED"]:
            with self.subTest(status=status):
                report = auth.Report(Path("."))
                if status:
                    report.add("agent:helpme-choose:definition", "agent-policy", status, "Not approved.")
                with patch.object(auth, "http") as http, self.assertRaises(auth.EvidenceError):
                    auth.help_me_choose_public_flow(report, deployment, allow_agent_canary=True)
                http.assert_not_called()

    def test_help_me_choose_canary_is_opt_in_even_with_a_passing_definition(self):
        report = auth.Report(Path("."))
        report.add("agent:helpme-choose:definition", "agent-policy", "PASS", "Reviewed definition.")
        deployment = SimpleNamespace(required=lambda _: self.fail("No network configuration needed"))
        with patch.object(auth, "http") as http, self.assertRaises(auth.EvidenceError):
            auth.help_me_choose_public_flow(report, deployment)
        http.assert_not_called()

    def test_agent_correlation_requires_run_trace_version_scope_and_expected_runtime_principal(self):
        values = {
            "AI_AGENT_HELP_ME_CHOOSE_ID": "help-agent",
            "AZURE_RESOURCE_GROUP": "group",
            "USER_MANAGED_IDENTITY_NAME": "runtime",
        }
        principal = "00000000-0000-4000-8000-000000000001"

        def report_with_trace():
            report = auth.Report(Path("."))
            report.add("agent:helpme-choose:anonymous-recommendations", "agents", "PASS", "Valid response.")
            report.inventory["helpMeChooseTraceIds"] = {"questions": "a" * 32, "recommendations": "b" * 32}
            return report

        for rows, expected in [
                ([["help-agent:1", "search_products", 2]], "PASS"),
                ([], "BLOCKED"),
                ([["other-agent:1", "search_products", 1]], None),
                ([["help-agent:1", "create_order", 1]], None),
                ([["help-agent:1", "search_products", True]], None),
                ([["help-agent:1", "search_products", 1], ["help-agent:1", "search_products", 1]], None)]:
            with self.subTest(rows=rows):
                queries = []

                def azure(*args):
                   if args[:2] == ("identity", "show"):
                       return {"principalId": principal}
                   if args[:2] == ("resource", "list"):
                       return ["/subscriptions/test/resourceGroups/group/providers/Microsoft.Insights/components/app"]
                   self.assertEqual(args[:3], ("monitor", "app-insights", "query"))
                   queries.append(args[args.index("--analytics-query") + 1])
                   return {"tables": [{"columns": [{"name": name} for name in
                                                    ["AgentVersionId", "Tool", "Hits"]], "rows": rows}]}

                deployment = SimpleNamespace(required=lambda key: values[key], azure=azure, runtime=None)
                report = report_with_trace()
                with patch.object(auth.time, "sleep"):
                    if expected is None:
                        with self.assertRaises(auth.EvidenceError):
                            auth.help_me_choose_correlated_tools(report, deployment)
                    else:
                        auth.help_me_choose_correlated_tools(report, deployment)
                        self.assertEqual(report.checks[-1]["status"], expected)
                self.assertEqual(len(queries), 4 if not rows else 1)
                for query in queries:
                    for required in ["a" * 32, "b" * 32, "service:" + principal, "help-agent",
                                     "products.read", "adventureworks-agents", "public-catalog",
                                     "CompletedMcpTools", "operation_Id"]:
                        self.assertIn(required, query)
                self.assertNotIn(principal, json.dumps(report.checks))

        report = report_with_trace()
        report.inventory["helpMeChooseTraceIds"]["recommendations"] = "a" * 32
        deployment = SimpleNamespace(required=lambda key: values[key], azure=lambda *args: self.fail("No ARM calls"))
        with self.assertRaises(auth.EvidenceError):
            auth.help_me_choose_correlated_tools(report, deployment)

    def test_agent_correlation_retries_only_empty_telemetry_until_a_bounded_match(self):
        report = auth.Report(Path("."))
        report.add("agent:helpme-choose:anonymous-recommendations", "agents", "PASS", "Valid response.")
        report.inventory["helpMeChooseTraceIds"] = {"questions": "a" * 32, "recommendations": "b" * 32}
        values = {"AI_AGENT_HELP_ME_CHOOSE_ID": "help-agent", "AZURE_RESOURCE_GROUP": "group",
                  "USER_MANAGED_IDENTITY_NAME": "runtime"}
        responses = iter([[], [], [["help-agent:1", "search_products", 1]]])
        queries = []

        def azure(*args):
            if args[:2] == ("identity", "show"):
                return {"principalId": "00000000-0000-4000-8000-000000000001"}
            if args[:2] == ("resource", "list"):
                return ["app"]
            queries.append(args)
            return {"tables": [{"columns": [{"name": name} for name in
                                             ["AgentVersionId", "Tool", "Hits"]],
                                "rows": next(responses)}]}

        deployment = SimpleNamespace(required=lambda key: values[key], azure=azure, runtime=None)
        with patch.object(auth.time, "sleep") as sleep:
            auth.help_me_choose_correlated_tools(report, deployment)
        self.assertEqual(report.checks[-1]["status"], "PASS")
        self.assertEqual(len(queries), 3)
        self.assertEqual([call.args for call in sleep.call_args_list], [(20,), (20,)])

    def test_agent_correlation_credits_only_exact_current_inventory_edges(self):
        agent_id = "help-agent"
        mcp = {
            "type": "mcp", "server_label": "adventureworks_mcp",
            "server_url": "https://mcp.example.test/mcp",
            "allowed_tools": sorted(auth.PUBLIC_CATALOG_TOOLS),
        }
        deployment = SimpleNamespace(required=lambda key: {
            "AI_AGENT_HELP_ME_CHOOSE_ID": agent_id,
            "MCP_SERVICE_URL": "https://mcp.example.test/mcp",
        }[key])

        def make_report():
            summary = auth.summarize_agent_version(agent_id, "1", {"definition": {
                "kind": "prompt", "tools": [mcp],
            }}, "https://mcp.example.test", "https://dab.example.test")
            report = auth.Report(Path("."))
            edges = auth.agent_tool_runtime_evidence(report, [summary])
            report.inventory.update({
                "deployedAgentVersions": [summary],
                "agentDependencyEdges": edges,
                "helpMeChooseCorrelatedTools": [
                    {"version": "help-agent:1", "tool": "search_products", "matches": 2},
                    {"version": "help-agent:1", "tool": "get_product_details", "matches": 1},
                ],
            })
            for check_id, group in [
                    ("agent:helpme-choose:definition", "agent-policy"),
                    ("agent:helpme-choose:anonymous-recommendations", "agents"),
                    ("agent:helpme-choose:correlated-tools", "agents")]:
                report.add(check_id, group, "PASS", "Current-run evidence.")
            return report

        report = make_report()
        auth.reconcile_help_me_choose_tool_paths(report, deployment)
        paths = {item["id"].rsplit(":", 1)[-1]: item["status"] for item in report.checks
                 if item["id"].startswith("agent-tool-path:")}
        self.assertEqual(paths["search_products"], "PASS")
        self.assertEqual(paths["get_product_details"], "PASS")
        self.assertEqual(paths["get_categories_with_products"], "BLOCKED")
        self.assertEqual(paths["find_complementary_products"], "BLOCKED")
        self.assertEqual(report.checks[-1]["status"], "PASS")

        for defect in ["version", "origin", "definition", "duplicate-edge", "wrong-blocker"]:
            with self.subTest(defect=defect):
                report = make_report()
                report.inventory["helpMeChooseCorrelatedTools"] = [
                    {"version": "help-agent:1", "tool": "search_products", "matches": 1}]
                if defect == "version":
                    report.inventory["helpMeChooseCorrelatedTools"][0]["version"] = "help-agent:2"
                elif defect == "origin":
                    next(edge for edge in report.inventory["agentDependencyEdges"]
                         if edge["tool"] == "search_products")["toOrigin"] = "https://other.example.test"
                elif defect == "definition":
                    report.inventory["deployedAgentVersions"][0]["tools"][0]["allowedTools"].remove("search_products")
                elif defect == "duplicate-edge":
                    edge = next(edge for edge in report.inventory["agentDependencyEdges"]
                                if edge["tool"] == "search_products")
                    report.inventory["agentDependencyEdges"].append(copy.deepcopy(edge))
                else:
                    next(item for item in report.checks if item["id"].endswith(":tool:search_products"))[
                        "detail"] = "Different prerequisite remains blocked."
                auth.reconcile_help_me_choose_tool_paths(report, deployment)
                self.assertEqual(report.checks[-1]["status"], "BLOCKED")
                self.assertTrue(all(item["status"] == "BLOCKED" for item in report.checks
                                    if item["id"].startswith("agent-tool-path:")))

        for defect in ["duplicate-observation", "missing-control"]:
            with self.subTest(defect=defect):
                report = make_report()
                if defect == "duplicate-observation":
                    report.inventory["helpMeChooseCorrelatedTools"].append(
                        copy.deepcopy(report.inventory["helpMeChooseCorrelatedTools"][0]))
                else:
                    next(item for item in report.checks
                         if item["id"] == "agent:helpme-choose:definition")["status"] = "BLOCKED"
                with self.assertRaises(auth.EvidenceError):
                    auth.reconcile_help_me_choose_tool_paths(report, deployment)
                self.assertTrue(all(item["status"] == "BLOCKED" for item in report.checks
                                    if item["id"].startswith("agent-tool-path:")))

    def test_cart_contract_requires_owned_read_only_dab_and_rejects_anonymous_regressions(self):
        config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
        report = auth.Report(Path("."))
        auth.cart_contract(report, config)
        self.assertTrue(all(check["status"] == "PASS" for check in report.checks))
        config["entities"]["ShoppingCartItem"]["permissions"].append({"role": "anonymous", "actions": ["read"]})
        report = auth.Report(Path("."))
        auth.cart_contract(report, config)
        self.assertTrue(all(check["status"] == "FAIL" for check in report.checks))

    def test_address_link_contract_rejects_unscoped_reads_and_all_direct_writes(self):
        config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
        report = auth.Report(Path("."))
        auth.address_link_contract(report, config)
        self.assertEqual([check["status"] for check in report.checks], ["PASS"] * 3)

        for role in ["anonymous", "authenticated", "consumer"]:
            for action in ["read", "create", "update", "delete", "*"]:
                with self.subTest(role=role, action=action):
                    changed = copy.deepcopy(config)
                    changed["entities"]["BusinessEntityAddress"]["permissions"].append(
                        {"role": role, "actions": [action]})
                    report = auth.Report(Path("."))
                    auth.address_link_contract(report, changed)
                    self.assertEqual(next(check["status"] for check in report.checks
                                          if check["id"].endswith(":" + role)), "FAIL")

    def test_review_contract_preserves_public_reads_and_authenticates_all_mutations(self):
        config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
        report = auth.Report(Path("."))
        auth.review_contract(report, config)
        self.assertEqual(len(report.checks), 7)
        self.assertTrue(all(check["status"] == "PASS" for check in report.checks))
        config["entities"]["ProductReview"]["permissions"][0]["actions"].append("create")
        report = auth.Report(Path("."))
        auth.review_contract(report, config)
        self.assertEqual(report.checks[0]["status"], "FAIL")

    def test_review_contract_requires_public_email_redaction(self):
        config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
        for role in ["anonymous", "authenticated", "consumer"]:
            for defect in ["unrestricted-read", "missing-email-exclusion", "missing-reviewer-id"]:
                with self.subTest(role=role, defect=defect):
                    changed = copy.deepcopy(config)
                    permission = next(item for item in changed["entities"]["ProductReview"]["permissions"]
                                      if item["role"] == role)
                    index = next(index for index, action in enumerate(permission["actions"])
                                 if isinstance(action, dict) and action.get("action") == "read")
                    if defect == "unrestricted-read":
                        permission["actions"][index] = "read"
                    elif defect == "missing-email-exclusion":
                        permission["actions"][index]["fields"]["exclude"].remove("EmailAddress")
                    else:
                        permission["actions"][index]["fields"]["exclude"].append("UserID")
                    report = auth.Report(Path("."))
                    auth.review_contract(report, changed)
                    self.assertIn("FAIL", {check["status"] for check in report.checks})

    def test_review_contract_rejects_unscoped_or_privileged_authenticated_writes(self):
        for role in ["authenticated", "consumer"]:
            for defect in ["author", "moderation", "vote", "duplicate-create", "wildcard", "delete"]:
                config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
                permission = next(item for item in config["entities"]["ProductReview"]["permissions"]
                                  if item["role"] == role)
                create, _, update = permission["actions"]
                if defect == "author":
                    create.pop("policy")
                elif defect == "moderation":
                    create["fields"]["include"].append("IsModerated")
                elif defect == "vote":
                    update["fields"]["include"].append("Comments")
                elif defect == "duplicate-create":
                    permission["actions"].append("create")
                else:
                    permission["actions"].append("*" if defect == "wildcard" else "delete")
                report = auth.Report(Path("."))
                auth.review_contract(report, config)
                self.assertTrue(any(check["status"] == "FAIL" for check in report.checks))

    def test_payment_live_verifier_rejects_foreign_or_unmasked_results_and_wrong_denials(self):
        consumers = [
            SimpleNamespace(label=label, business_id=owner, token=lambda *_, label=label: label)
            for label, owner in [("A", 71), ("B", 72)]
        ]
        deployment = SimpleNamespace(required=lambda key:
            "https://dab.example.test/graphql/" if key == "API_URL" else "https://functions.example.test")
        for scenario in ["valid", "foreign", "unmasked", "wrong-denial", "empty", "pagination"]:
            def request(method, url, *, token=None, **_):
                if token in {"admin", "admin-dab"}:
                    return (200 if scenario == "wrong-denial" else 403 if token == "admin" else 401), {}, b"[]"
                owner = 71 if token == "A" else 72
                if "PersonCreditCard" in url:
                    body = {"value": [] if scenario == "empty" else [
                        {"BusinessEntityID": owner, "CreditCardID": owner + (100 if "$after" in url else 0)}]}
                    if scenario == "pagination" and "$after" not in url:
                        body["nextLink"] = "https://dab.example.test/api/PersonCreditCard?$after=next"
                else:
                    body = [] if scenario == "empty" else [{
                        "id": 999 if scenario == "foreign" else owner,
                        "cardType": "Vista",
                        "last4": "synthetic-withheld-number" if scenario == "unmasked" else "1234",
                        "expMonth": 12, "expYear": 2030,
                    }]
                    if scenario == "pagination":
                        body.append({**body[0], "id": owner + 100})
                return 200, {}, json.dumps(body).encode()

            with self.subTest(scenario=scenario), patch.object(auth, "http", side_effect=request):
                report = auth.Report(Path("."))
                report.guarded("payment:scenario", "live-allows",
                    lambda: auth.payment_method_reads(report, deployment, "admin", "admin-dab", consumers))
                statuses = {check["status"] for check in report.checks}
                if scenario in {"valid", "pagination"}:
                    self.assertEqual(statuses, {"PASS"})
                    self.assertEqual(len(report.checks), 7)
                elif scenario == "empty":
                    self.assertEqual(statuses, {"PASS", "BLOCKED"})
                else:
                    self.assertIn("FAIL", statuses)
                self.assertNotIn("synthetic-withheld-number", json.dumps(report.checks))

    def test_payment_contract_rejects_broad_card_reads_and_foreign_link_creation(self):
        config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
        report = auth.Report(Path("."))
        auth.payment_method_contract(report, config)
        self.assertTrue(all(check["status"] == "PASS" for check in report.checks))
        for entity, permission in [
            ("CreditCard", {"role": "authenticated", "actions": ["read"]}),
            ("PersonCreditCard", {"role": "consumer", "actions": ["create"]}),
        ]:
            changed = json.loads(json.dumps(config))
            changed["entities"][entity]["permissions"] = [
                item for item in changed["entities"][entity]["permissions"] if item["role"] != permission["role"]
            ] + [permission]
            report = auth.Report(Path("."))
            auth.payment_method_contract(report, changed)
            self.assertTrue(any(check["status"] == "FAIL" for check in report.checks))

    def test_order_detail_contract_rejects_unscoped_dab_reads_and_writes(self):
        config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
        report = auth.Report(Path("."))
        auth.order_detail_contract(report, config)
        self.assertEqual([check["status"] for check in report.checks], ["PASS"] * 6)

        for action, expected in [("read", ["FAIL", "PASS"] * 3),
                                 ("create", ["PASS", "FAIL"] * 3),
                                 ("*", ["FAIL"] * 6)]:
            changed = json.loads(json.dumps(config))
            changed["entities"]["SalesOrderDetail"]["permissions"].extend([
                {"role": role, "actions": [action]}
                for role in ["anonymous", "authenticated", "consumer"]])
            report = auth.Report(Path("."))
            auth.order_detail_contract(report, changed)
            self.assertEqual([check["status"] for check in report.checks], expected)

        for role in ["anonymous", "authenticated", "consumer"]:
            changed = copy.deepcopy(config)
            changed["entities"]["SalesOrderDetail"]["permissions"].extend([
                {"role": role, "actions": ["read", "create"]},
                {"role": role, "actions": []},
            ])
            report = auth.Report(Path("."))
            auth.order_detail_contract(report, changed)
            self.assertEqual([check["status"] for check in report.checks
                              if check["id"].endswith(":" + role)], ["FAIL", "FAIL"])

    def test_catalog_contract_rejects_exposed_fields_writes_and_broken_storefront_reads(self):
        config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
        report = auth.Report(Path("."))
        auth.catalog_contract(report, config)
        self.assertEqual([check["status"] for check in report.checks], ["PASS"] * 15)

        for role in ["anonymous", "authenticated", "consumer"]:
            for entity, field, required in [
                ("Product", "StandardCost", "Name"),
                ("ProductInventory", "Shelf", "Quantity"),
            ]:
                for defect in ["unrestricted-read", "missing-exclusion", "missing-storefront-field",
                               "write", "wildcard", "duplicate-broad-read"]:
                    with self.subTest(role=role, entity=entity, defect=defect):
                        changed = copy.deepcopy(config)
                        permissions = changed["entities"][entity]["permissions"]
                        permission = next(item for item in permissions if item["role"] == role)
                        if defect == "unrestricted-read":
                            permission["actions"] = ["read"]
                        elif defect == "missing-exclusion":
                            permission["actions"][0]["fields"]["exclude"].remove(field)
                        elif defect == "missing-storefront-field":
                            permission["actions"][0]["fields"]["exclude"].append(required)
                        elif defect == "write":
                            permission["actions"].append("update")
                        elif defect == "wildcard":
                            permission["actions"].append("*")
                        else:
                            permissions.append({"role": role, "actions": ["read"]})
                        report = auth.Report(Path("."))
                        auth.catalog_contract(report, changed)
                        self.assertIn("FAIL", {check["status"] for check in report.checks})
            changed = copy.deepcopy(config)
            changed["entities"]["Location"]["permissions"].append({"role": role, "actions": ["read"]})
            report = auth.Report(Path("."))
            auth.catalog_contract(report, changed)
            self.assertEqual(next(check["status"] for check in report.checks
                                  if check["id"] == "dab:catalog:Location:no-access:" + role), "FAIL")

    def test_catalog_live_verifier_requires_nonempty_controls_and_rejects_field_leaks(self):
        deployment = SimpleNamespace(required=lambda key: "https://dab.example.test/graphql/")
        consumers = [
            SimpleNamespace(label=label, business_id=owner, token=lambda *_, label=label: label)
            for label, owner in [("A", 71), ("B", 72)]
        ]
        fixtures = {
            "Product": ("products", {
                "ProductID": 42, "Name": "withheld-name", "ListPrice": 25,
                "StandardCost": 12, "SafetyStockLevel": 5, "ReorderPoint": 7, "DaysToManufacture": 2,
            }, {"StandardCost", "SafetyStockLevel", "ReorderPoint", "DaysToManufacture"}),
            "ProductInventory": ("productInventories", {
                "ProductID": 42, "LocationID": 10, "Quantity": 3, "Shelf": "withheld-shelf", "Bin": 7,
            }, {"Shelf", "Bin"}),
            "ProductReview": ("productReviews", {
                "ProductReviewID": 19, "ProductID": 42, "ReviewerName": "withheld-reviewer",
                "Rating": 4, "EmailAddress": "withheld-email@example.invalid",
            }, {"EmailAddress"}),
        }
        for scenario in ["valid", "empty-control", "admin-excluded", "manufacturing-excluded",
                         "public-exposed", "empty-public", "graphql-exposed", "unrelated-error",
                         "missing-error", "review-email-exposed", "review-graphql-exposed",
                         "review-rest-select-exposed", "review-rest-filter-exposed",
                         "review-graphql-filter-exposed", "review-graphql-order-exposed"]:
            calls = []

            def request(method, url, *, token=None, headers=None, data=None, **_):
                calls.append((method, url, token))
                role = (headers or {}).get("X-MS-API-ROLE")
                if method == "GET":
                    entity = urllib.parse.urlsplit(url).path.rsplit("/", 1)[-1]
                    _, row, restricted = fixtures[entity]
                    row = dict(row)
                    if token == "admin":
                        if scenario == "empty-control":
                            return 200, {}, b'{"value":[]}'
                        if scenario == "admin-excluded":
                            row.pop(next(iter(restricted)))
                    else:
                        arguments = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
                        referenced = {
                            operation for operation in ["select", "filter", "orderby"]
                            if any(field in arguments.get("$" + operation, [""])[0] for field in restricted)
                        }
                        if referenced:
                            bypass = entity == "ProductReview" and (
                                scenario == "review-rest-select-exposed" and "select" in referenced or
                                scenario == "review-rest-filter-exposed" and "filter" in referenced)
                            if not bypass:
                                return 403, {}, b'{"error":{"code":"Forbidden"}}'
                            return 200, {}, json.dumps({"value": [row]}).encode()
                        if scenario == "empty-public":
                            return 200, {}, b'{"value":[]}'
                        if scenario != "public-exposed" and not (
                                scenario == "review-email-exposed" and entity == "ProductReview"):
                            row = {key: value for key, value in row.items() if key not in restricted}
                    return 200, {}, json.dumps({"value": [row]}).encode()

                query = data["query"]
                entity = ("ProductInventory" if "productInventories" in query else
                          "ProductReview" if "productReviews" in query else "Product")
                selector, row, restricted = fixtures[entity]
                selected = query.split("items { ", 1)[1].split(" }", 1)[0].split()
                selected_row = {key: row[key] for key in selected}
                if role in {"executive-admin", "manufacturing-engineer"}:
                    if scenario == "manufacturing-excluded" and role == "manufacturing-engineer":
                        selected_row.pop(next(iter(restricted)))
                    body = {"data": {selector: {"items": [selected_row]}}}
                elif any(f"{field}: {{ eq:" in query for field in restricted):
                    if scenario == "review-graphql-filter-exposed" and entity == "ProductReview":
                        body = {"data": {selector: {"items": [selected_row]}}}
                    else:
                        body = {"data": {selector: None}, "errors": [{
                            "message": "Access forbidden to a field referenced in the filter."}]}
                elif any(f"{field}: ASC" in query for field in restricted):
                    if scenario == "review-graphql-order-exposed" and entity == "ProductReview":
                        body = {"data": {selector: {"items": [selected_row]}}}
                    else:
                        body = {"data": {selector: None}, "errors": [{
                            "message": "Access forbidden to a field referenced in the orderBy argument."}]}
                elif set(selected).intersection(restricted):
                    field = next(field for field in selected if field in restricted)
                    exposed = scenario == "graphql-exposed" or (
                        scenario == "review-graphql-exposed" and entity == "ProductReview")
                    selected_row[field] = row[field] if exposed else None
                    code = "INTERNAL_SERVER_ERROR" if scenario == "unrelated-error" else (
                        "AUTH_NOT_AUTHENTICATED" if role is None else "AUTH_NOT_AUTHORIZED")
                    body = {"data": {selector: {"items": [selected_row]}},
                            "errors": [] if scenario == "missing-error" else [{"extensions": {"code": code}}]}
                else:
                    body = {"data": {selector: {"items": [selected_row]}}}
                return 200, {}, json.dumps(body).encode()

            with self.subTest(scenario=scenario), patch.object(auth, "http", side_effect=request):
                report = auth.Report(Path("."))
                report.guarded("dab:catalog:scenario", "live-denials",
                               lambda: auth.dab_catalog_field_restrictions(
                                   report, deployment, "admin", "manufacturing", consumers))
                statuses = {check["status"] for check in report.checks}
                if scenario == "valid":
                    self.assertEqual(statuses, {"PASS"})
                    self.assertEqual(len(report.checks), 248)
                    self.assertTrue(all(method in {"GET", "POST"} for method, _, _ in calls))
                elif scenario == "empty-control":
                    self.assertEqual(statuses, {"BLOCKED"})
                else:
                    self.assertIn("FAIL", statuses)
                self.assertNotIn("withheld-shelf", json.dumps(report.checks))
                self.assertNotIn("withheld-name", json.dumps(report.checks))
                self.assertNotIn("withheld-email", json.dumps(report.checks))

    def test_order_detail_live_verifier_requires_nonempty_controls_and_rejects_leaks(self):
        deployment = SimpleNamespace(required=lambda key: {
            "API_URL": "https://dab.example.test/graphql/",
            "API_FUNCTIONS_URL": "https://functions.example.test",
        }[key])
        consumers = [
            SimpleNamespace(label=label, business_id=business_id,
                            token=lambda resource, scope, label=label: label + "-" + resource)
            for label, business_id in [("A", 101), ("B", 102)]
        ]
        lines = [
            {"salesOrderId": order_id, "productId": 5, "orderQty": 2, "unitPrice": 10.25,
             "unitPriceDiscount": 0.1, "lineTotal": 18.45, "productName": "withheld-product"}
            for order_id in [900, 901]
        ]

        for scenario in ["valid", "additional-control", "unbound", "no-owned", "empty-detail-control",
                         "empty-functions-control", "rest-leak", "graphql-leak", "foreign-leak"]:
            with self.subTest(scenario=scenario):
                calls = []
                control_id = 903 if scenario == "additional-control" else 900
                owners = ({"A-functions": 0, "B-functions": 8} if scenario == "unbound" else
                          {"A-functions": 70, "B-functions": 80} if scenario == "no-owned" else
                          {"A-functions": 7, "B-functions": 8})
                current_lines = lines + ([{**lines[0], "salesOrderId": 903}]
                                         if scenario == "additional-control" else [])

                def request(method, url, *, token=None, headers=None, data=None, **kwargs):
                    calls.append((method, url, token, headers, data))
                    parsed = urllib.parse.urlsplit(url)
                    query = urllib.parse.parse_qs(parsed.query)
                    if parsed.path == "/api/SalesOrderDetail" and token == "admin-dab":
                        return 200, {}, json.dumps({"value": [] if scenario == "empty-detail-control" else [
                            {"SalesOrderID": control_id, "SalesOrderDetailID": 1}]}).encode()
                    if parsed.path == "/api/SalesOrderDetail":
                        self.assertIn(headers["X-MS-API-ROLE"], ["consumer", "authenticated"])
                        body = ({"error": {"code": "Forbidden"}, "private": "withheld-product"}
                                if scenario == "rest-leak" else {"error": {"code": "Forbidden"}})
                        return 403, {}, json.dumps(body).encode()
                    if parsed.path == "/graphql":
                        self.assertEqual(method, "POST")
                        self.assertIn(headers["X-MS-API-ROLE"], ["consumer", "authenticated"])
                        body = {
                            "data": {"salesOrderDetails": (
                                {"items": [{"ProductName": "withheld-product"}]}
                                if scenario == "graphql-leak" else None)},
                            "errors": [{
                                "message": "The current user is not authorized to access this resource.",
                                "path": ["salesOrderDetails"],
                                "extensions": {"code": "AUTH_NOT_AUTHORIZED"},
                            }],
                        }
                        return 200, {}, json.dumps(body).encode()
                    if parsed.path == "/api/SalesOrderHeader":
                        rows = ([{"SalesOrderID": 903, "CustomerID": 9}] if "$filter" in query else [
                            {"SalesOrderID": 900, "CustomerID": 7},
                            {"SalesOrderID": 901, "CustomerID": 8},
                            {"SalesOrderID": 902, "CustomerID": 9},
                        ])
                        return 200, {}, json.dumps({"value": rows}).encode()
                    self.assertEqual(parsed.path, "/api/orders/details")
                    if token == "admin-functions":
                        result = [] if scenario == "empty-functions-control" else current_lines
                        return 200, {}, json.dumps(result).encode()
                    self.assertIn(token, owners)
                    order_id = int(query["orderIds"][0])
                    if "customerId" in query:
                        self.assertEqual(headers["X-MS-API-ROLE"], "executive-admin")
                        if scenario == "foreign-leak":
                            return 200, {}, json.dumps(current_lines).encode()
                        error = ("This token has no customer id; cannot resolve owned orders."
                                 if owners[token] == 0 else "Order access is not allowed.")
                        return 403, {}, json.dumps({"error": error}).encode()
                    return 200, {}, json.dumps([
                        line for line in current_lines if line["salesOrderId"] == order_id]).encode()

                helper = SimpleNamespace(claims=lambda token: {"customer_id": owners[token]})
                report = auth.Report(Path("."))
                with patch.object(auth, "http", side_effect=request), \
                        patch.object(auth, "load_auth_helper", return_value=helper):
                    report.guarded("orders:scenario", "ownership", lambda:
                        auth.order_detail_read_boundaries(
                            report, deployment, "admin-functions", "admin-dab", consumers))
                statuses = {check["status"] for check in report.checks}
                if scenario in {"valid", "additional-control"}:
                    self.assertEqual(statuses, {"PASS"})
                    self.assertEqual(len(report.checks), 14)
                elif scenario in {"unbound", "no-owned", "empty-detail-control"}:
                    self.assertIn("BLOCKED", statuses)
                    self.assertNotIn("FAIL", statuses)
                else:
                    self.assertIn("FAIL", statuses)
                self.assertNotIn("withheld-product", json.dumps(report.checks))
                if scenario == "additional-control":
                    self.assertTrue(any("SalesOrderID+eq+903" in call[1] for call in calls))
                if scenario == "empty-detail-control":
                    self.assertEqual(len(calls), 1)

    def test_oauth_preflight_stops_all_live_scenarios_when_discovery_is_unavailable_or_invalid(self):
        deployment = SimpleNamespace(required=lambda key: {
            "API_URL": "https://dab.example.test/graphql/",
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_MCP_URL": "https://mcp.example.test/mcp",
        }[key])

        class ContinueLive(Exception):
            pass

        scenarios = [
            ("valid", (200, {}, b'{"issuer":"https://mcp.example.test/"}'), "PASS"),
            ("server", (503, {}, b"SENTINEL-PRIVATE"), "BLOCKED"),
            ("network", auth.EvidenceError("Network unavailable"), "BLOCKED"),
            ("unauthorized", (401, {}, b'{"error":"SENTINEL-PRIVATE"}'), "FAIL"),
            ("malformed", (200, {}, b"SENTINEL-PRIVATE"), "FAIL"),
            ("wrong-issuer", (200, {}, b'{"issuer":"https://wrong.example.test/"}'), "FAIL"),
        ]
        for name, response, expected in scenarios:
            with self.subTest(name=name):
                report = auth.Report(Path("."))
                with patch.object(auth, "http", side_effect=response if isinstance(response, Exception) else None,
                                  return_value=None if isinstance(response, Exception) else response) as http, \
                        patch.object(auth, "internal_session_browser"), \
                        patch.object(auth, "internal_browser", side_effect=ContinueLive) as browser, \
                        patch.object(auth, "consumer_fixtures") as fixtures:
                    if name == "valid":
                        with self.assertRaises(ContinueLive):
                            auth.live(report, deployment)
                        browser.assert_called_once()
                    else:
                        auth.live(report, deployment)
                        browser.assert_not_called()
                    fixtures.assert_not_called()
                    http.assert_called_once()
                self.assertEqual([(check["id"], check["status"]) for check in report.checks],
                                 [("live:oauth-preflight", expected)])
                self.assertNotIn("SENTINEL-PRIVATE", json.dumps(report.checks))

    def test_order_header_contract_scopes_reads_and_disallows_direct_writes(self):
        config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
        report = auth.Report(Path("."))
        auth.order_header_contract(report, config)
        self.assertEqual([check["status"] for check in report.checks], ["PASS"] * 6)

        for role in ["anonymous", "authenticated", "consumer"]:
            for action in ["read", "create", "update", "delete", "*"]:
                with self.subTest(role=role, action=action):
                    changed = json.loads((auth.ROOT / "api/dab-config.json").read_text())
                    changed["entities"]["SalesOrderHeader"]["permissions"].insert(
                        0, {"role": role, "actions": [action]})
                    report = auth.Report(Path("."))
                    auth.order_header_contract(report, changed)
                    self.assertIn("FAIL", {check["status"] for check in report.checks
                                           if check["id"].endswith(":" + role)})

    def test_customer_contract_rejects_foreign_store_binding_and_direct_updates(self):
        config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
        report = auth.Report(Path("."))
        auth.customer_contract(report, config)
        self.assertEqual([check["status"] for check in report.checks], ["PASS"] * 9)
        for role in ["authenticated", "consumer"]:
            for defect in ["store", "policy", "read-policy", "duplicate-create", "update", "wildcard"]:
                changed = json.loads((auth.ROOT / "api/dab-config.json").read_text())
                permission = next(item for item in changed["entities"]["Customer"]["permissions"]
                                  if item["role"] == role)
                create = next(action for action in permission["actions"] if action["action"] == "create")
                if defect == "store":
                    create["fields"]["include"].append("StoreID")
                elif defect == "policy":
                    create["policy"]["database"] = "true"
                elif defect == "read-policy":
                    next(action for action in permission["actions"] if action["action"] == "read")["policy"]["database"] = "true"
                elif defect == "duplicate-create":
                    permission["actions"].append("create")
                else:
                    permission["actions"].append("update" if defect == "update" else "*")
                report = auth.Report(Path("."))
                auth.customer_contract(report, changed)
                self.assertIn("FAIL", {check["status"] for check in report.checks
                                       if check["id"].endswith(":" + role)})

    def test_mcp_unwraps_json_and_sse_and_does_not_confuse_transport_with_success(self):
        result = {"jsonrpc": "2.0", "id": 1, "result": {"isError": True}}
        for body in [json.dumps(result).encode(), ("event: message\ndata: " + json.dumps(result) + "\n\n").encode()]:
            self.assertTrue(auth.mcp_document(body)["result"]["isError"])
        for body in [b"{}", b"event: ping\n\n", b"data: invalid\n\n"]:
            if body == b"{}":
                self.assertEqual(auth.mcp_document(body), {})
            else:
                with self.assertRaises(auth.EvidenceError):
                    auth.mcp_document(body)

    def test_http_shared_mcp_opener_retains_container_app_affinity_cookie(self):
        cookies = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                cookies.append(self.headers.get("Cookie"))
                self.send_response(200)
                if len(cookies) == 1:
                    self.send_header("Set-Cookie", "aca-affinity=replica; Path=/; HttpOnly")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        server.timeout = 3

        def serve():
            server.handle_request()
            server.handle_request()

        worker = threading.Thread(target=serve, daemon=True)
        worker.start()
        opener = auth.urllib.request.build_opener(
            auth.NoRedirect(), auth.urllib.request.HTTPCookieProcessor(auth.cookiejar.CookieJar()))
        url = f"http://127.0.0.1:{server.server_port}/mcp"
        try:
            with patch.object(auth, "https_url", side_effect=lambda value: value):
                first = auth.http("POST", url, data={"method": "initialize"}, opener=opener)
                second = auth.http("POST", url, data={"method": "tools/list"}, opener=opener)
            self.assertEqual(first[0], 200)
            self.assertEqual(second[0], 200)
            self.assertIsNone(cookies[0])
            self.assertEqual(cookies[1], "aca-affinity=replica")
        finally:
            worker.join(timeout=5)
            server.server_close()
        self.assertFalse(worker.is_alive())

    def test_agent_discovery_follows_all_pages(self):
        deployment = SimpleNamespace(required=lambda key: "https://foundry.example.test/api/projects/project")
        with patch.object(auth, "https_url", wraps=auth.https_url):
            deployment.azure = unittest.mock.Mock(side_effect=[
                {"data": [{"name": "one"}], "has_more": True, "last_id": "cursor"},
                {"data": [{"name": "two"}], "has_more": False}])
            self.assertEqual(set(auth.fetch_agents(deployment)), {"one", "two"})
        self.assertIn("after=cursor", deployment.azure.call_args.args[-1])

    def test_agent_discovery_rejects_repeated_cursor_empty_and_duplicate_names(self):
        for pages in [
                [{"data": [], "has_more": False}],
                [{"data": [{"name": "one"}], "has_more": True, "last_id": "same"},
                 {"data": [{"name": "two"}], "has_more": True, "last_id": "same"}],
                [{"data": [{"name": "one"}], "has_more": True, "last_id": "cursor"},
                 {"data": [{"name": "one"}], "has_more": False}]]:
            deployment = SimpleNamespace(required=lambda key: "https://foundry.example.test")
            deployment.azure = unittest.mock.Mock(side_effect=pages)
            with self.assertRaises(auth.EvidenceError):
                auth.fetch_agents(deployment)

    def test_agent_version_discovery_follows_all_pages_and_encodes_agent_name(self):
        deployment = SimpleNamespace(required=lambda key: "https://foundry.example.test/api/projects/project")
        deployment.azure = unittest.mock.Mock(side_effect=[
            {"data": [{"name": "agent/one", "version": "1", "definition": {}}],
             "has_more": True, "last_id": "cursor"},
            {"data": [{"name": "agent/one", "version": "2", "definition": {}}],
             "has_more": False},
        ])

        versions = auth.fetch_agent_versions(deployment, "agent/one")

        self.assertEqual(set(versions), {"1", "2"})
        first_url = deployment.azure.call_args_list[0].args[-1]
        second_url = deployment.azure.call_args_list[1].args[-1]
        self.assertIn("/agents/agent%2Fone/versions?", first_url)
        self.assertIn("after=cursor", second_url)

    def test_agent_version_discovery_rejects_empty_duplicates_and_bad_pagination(self):
        for pages in [
                [{"data": [], "has_more": False}],
                [{"data": [{"name": "agent", "version": "1", "definition": {}}],
                  "has_more": True, "last_id": "cursor"},
                 {"data": [{"name": "agent", "version": "1", "definition": {}}],
                  "has_more": False}],
                [{"data": [{"name": "other", "version": "1", "definition": {}}],
                  "has_more": False}],
                [{"data": [{"name": "agent", "version": "1", "definition": {}}],
                  "has_more": True, "last_id": "cursor"},
                 {"data": [{"name": "agent", "version": "2", "definition": {}}],
                  "has_more": True, "last_id": "cursor"}]]:
            deployment = SimpleNamespace(required=lambda key: "https://foundry.example.test")
            deployment.azure = unittest.mock.Mock(side_effect=pages)
            with self.assertRaises(auth.EvidenceError):
                auth.fetch_agent_versions(deployment, "agent")

    def test_agent_version_inventory_is_stable_and_does_not_export_prompt_content(self):
        secret_prompt = "private prompt content must not enter the assurance report"
        summary = auth.summarize_agent_version(
            "catalog-agent",
            "4",
            {"instance_identity": {"principal_id": "b2b35cbf-5e15-4f4a-a2c2-7f450bb88b39"},
             "definition": {"kind": "prompt", "instructions": secret_prompt, "tools": [{
                 "type": "mcp",
                 "server_label": "adventureworks_mcp",
                 "server_url": "https://mcp.example.test/mcp",
                 "allowed_tools": {"tool_names": ["search"]},
             }]}},
            "https://mcp.example.test",
            "https://dab.example.test",
        )

        self.assertEqual(summary["versionId"], "foundry:agent:catalog-agent:version:4")
        self.assertEqual(summary["definitionSha256"], auth.hashlib.sha256(
            json.dumps({"kind": "prompt", "instructions": secret_prompt, "tools": [{
                "type": "mcp",
                "server_label": "adventureworks_mcp",
                "server_url": "https://mcp.example.test/mcp",
                "allowed_tools": {"tool_names": ["search"]},
            }]}, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
        self.assertEqual(summary["tools"][0]["surfaceIds"], [
            "foundry:agent:catalog-agent:version:4:mcp-server:adventureworks_mcp:tool:search"])
        self.assertNotIn(secret_prompt, json.dumps(summary))

    def test_agent_tool_paths_are_distinct_blocked_runtime_obligations(self):
        def summarize(name, version, tools):
            return auth.summarize_agent_version(name, version, {"definition": {
                "kind": "prompt", "instructions": "private instructions", "tools": tools,
            }}, "https://mcp.example.test", "https://dab.example.test")

        mcp = {"type": "mcp", "server_label": "demo", "server_url": "https://mcp.example.test/mcp",
               "allowed_tools": ["search", "details"]}
        unspecified = {"type": "mcp", "server_label": "unspecified", "server_url": "https://dab.example.test/mcp"}
        versions = [
            summarize("catalog", "1", [mcp, {"type": "code_interpreter"}]),
            summarize("catalog", "2", [mcp, unspecified]),
            summarize("no-tools", "1", []),
        ]
        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            edges = auth.agent_tool_runtime_evidence(report, versions)
        ids = {edge["id"] for edge in edges}
        self.assertEqual(len(edges), 6)
        self.assertEqual(len(ids), 6)
        self.assertEqual({check["id"] for check in report.checks},
                         {"agent-tool-path:" + edge_id for edge_id in ids})
        self.assertTrue(all(check["status"] == "BLOCKED" for check in report.checks))
        self.assertTrue(any(edge["kind"] == "agent-tool" and edge["toolType"] == "code_interpreter"
                            for edge in edges))
        self.assertTrue(any(edge["kind"] == "mcp-tool" and edge["tool"] is None for edge in edges))
        self.assertNotIn("private instructions", json.dumps({"checks": report.checks, "edges": edges}))

        duplicate = summarize("duplicate", "1", [mcp, {**mcp, "allowed_tools": ["other"]}])
        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            with self.assertRaises(auth.EvidenceError):
                auth.agent_tool_runtime_evidence(report, [duplicate])
            self.assertEqual(report.checks, [])

    def test_agent_static_credential_headers_fail_without_exporting_values(self):
        tool = {"type": "mcp", "server_label": "demo", "server_url": "https://mcp.example.test/mcp",
                "allowed_tools": ["search"]}
        for headers, status in [
                ({}, "PASS"), ({"Authorization": "secret-value"}, "FAIL"),
                ({"X-API-Key": "secret-value"}, "FAIL"),
                ({"Ocp-Apim-Subscription-Key": "secret-value"}, "FAIL"),
                ({"X-Unreviewed": "secret-value"}, "BLOCKED")]:
            with self.subTest(headers=list(headers)):
                summary = auth.summarize_agent_version(
                    "agent", "1", {"definition": {"kind": "prompt", "tools": [{**tool, "headers": headers}]}},
                    "https://mcp.example.test", "https://dab.example.test")
                self.assertEqual(auth.agent_header_status(summary["tools"][0]), status)
                self.assertNotIn("secret-value", json.dumps(summary))
        for bad in [{"type": ""}, {"type": "bad tool"}, {**tool, "server_label": "  "}]:
            with self.subTest(tool=bad), self.assertRaises(auth.EvidenceError):
                auth.summarize_agent_version(
                    "agent", "1", {"definition": {"kind": "prompt", "tools": [bad]}},
                    "https://mcp.example.test", "https://dab.example.test")

    def test_agent_version_fingerprint_changes_when_any_deployed_version_changes(self):
        first = {
            "name": "agent",
            "version": "1",
            "versionId": "foundry:agent:agent:version:1",
            "definitionSha256": "a" * 64,
        }
        second = {
            "name": "agent",
            "version": "2",
            "versionId": "foundry:agent:agent:version:2",
            "definitionSha256": "b" * 64,
        }
        fingerprint = auth.agent_version_inventory_sha256([first, second])

        self.assertEqual(fingerprint, auth.agent_version_inventory_sha256([second, first]))
        self.assertNotEqual(fingerprint, auth.agent_version_inventory_sha256([first]))
        changed = dict(second, definitionSha256="c" * 64)
        self.assertNotEqual(fingerprint, auth.agent_version_inventory_sha256([first, changed]))
        with self.assertRaises(auth.EvidenceError):
            auth.agent_version_inventory_sha256([])

    def test_workflow_invocations_keep_distinct_branches_to_the_same_agent(self):
        workflow = """
kind: Workflow
trigger:
  actions:
    - kind: ConditionGroup
      conditions:
        - actions:
            - kind: InvokeAzureAgent
              id: existing_customer
              agent: {name: order-agent, version: "2"}
              input:
                messages: =UserMessage("Customer ID: " & Local.CustomerId)
      elseActions:
        - kind: InvokeAzureAgent
          id: new_customer
          agent: {name: order-agent}
"""
        invocations = auth.workflow_invocations(workflow)
        self.assertEqual([item["actionId"] for item in invocations],
                         ["existing_customer", "new_customer"])
        self.assertEqual([item["version"] for item in invocations], ["2", None])
        self.assertNotEqual(invocations[0]["path"], invocations[1]["path"])
        summary = auth.summarize_agent_version("order-workflow", "3", {
            "definition": {"kind": "workflow", "workflow": workflow},
        }, "https://mcp.example.test", "https://dab.example.test")
        self.assertEqual(summary["agentReferences"], ["order-agent"])
        self.assertEqual([item["surfaceId"] for item in summary["workflowInvocations"]], [
            "foundry:agent:order-workflow:version:3:invoke:existing_customer",
            "foundry:agent:order-workflow:version:3:invoke:new_customer",
        ])

    def test_workflow_invocations_reject_ambiguous_dynamic_and_cyclic_definitions(self):
        valid = """
kind: Workflow
trigger:
  actions:
    - kind: InvokeAzureAgent
      id: invoke_agent
      agent: {name: catalog-agent}
"""
        for workflow in [
                valid.replace("name: catalog-agent", "name: '=Local.Agent'"),
                valid.replace("name: catalog-agent", "name: catalog-agent, version: '=Local.Version'"),
                valid.replace("id: invoke_agent", "id: invoke_agent\n      id: duplicate"),
                valid + """
    - kind: InvokeAzureAgent
      id: invoke_agent
      agent: {name: other-agent}
""",
                "kind: Workflow\ntrigger: &loop {actions: [*loop]}",
                "kind: Workflow\ntrigger: {actions: []}",
                "kind: Workflow\ntrigger: {actions: [{kind: InvokeAzureAgent}]}"]:
            with self.subTest(workflow=workflow), self.assertRaises(auth.EvidenceError):
                auth.workflow_invocations(workflow)

    def test_workflow_edges_resolve_pinned_versions_without_latest_fallback(self):
        workflow = """
kind: Workflow
trigger:
  actions:
    - kind: InvokeAzureAgent
      id: old_version
      agent: {name: catalog-agent, version: 1}
    - kind: InvokeAzureAgent
      id: current_version
      agent: {name: catalog-agent}
    - kind: InvokeAzureAgent
      id: missing_version
      agent: {name: catalog-agent, version: 3}
"""
        versions = []
        for name, version, latest, definition in [
                ("catalog-agent", "1", False, {"kind": "prompt"}),
                ("catalog-agent", "2", True, {"kind": "prompt"}),
                ("workflow-agent", "1", True, {"kind": "workflow", "workflow": workflow})]:
            summary = auth.summarize_agent_version(
                name, version, {"definition": definition}, "https://mcp.example.test",
                "https://dab.example.test")
            summary["isLatest"] = latest
            versions.append(summary)
        edges = auth.agent_dependency_edges(versions)
        self.assertEqual([edge["to"] for edge in edges], [
            "foundry:agent:catalog-agent:version:1",
            "foundry:agent:catalog-agent:version:2", None])
        self.assertEqual([edge["resolved"] for edge in edges], [True, True, False])
        self.assertEqual([edge["binding"] for edge in edges], ["version", "latest", "version"])

    def test_workflow_source_discovery_requires_exact_provisioner_file_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "scripts/utilities/agents"
            scripts.mkdir(parents=True)
            workflows = root / "workflows"
            workflows.mkdir()
            source = workflows / "advisor.yaml"
            source.write_text("""
kind: Workflow
trigger:
  actions:
    - kind: InvokeAzureAgent
      id: classify
      agent: {name: intent-agent}
""")
            script = scripts / "advisor-agent.sh"
            script.write_text('AGENT_NAME="advisor-agent"\n'
                              'YAML_PATH="$(cd "$(dirname "$0")" && pwd)/../../../workflows/advisor.yaml"\n')
            inventory = auth.agent_workflow_inventory(scripts, workflows)
            self.assertEqual(inventory["advisor-agent"]["invocations"][0]["agent"], "intent-agent")
            (workflows / "unprovisioned.yaml").write_text(source.read_text())
            with self.assertRaises(auth.EvidenceError):
                auth.agent_workflow_inventory(scripts, workflows)
            (workflows / "unprovisioned.yaml").unlink()
            script.write_text(script.read_text().replace("advisor.yaml", "../outside.yaml"))
            with self.assertRaises(auth.EvidenceError):
                auth.agent_workflow_inventory(scripts, workflows)

    def test_agent_version_and_mcp_tool_surfaces_are_stable_and_fail_closed(self):
        self.assertEqual(
            auth.foundry_agent_version_id("catalog-agent", "3"),
            "foundry:agent:catalog-agent:version:3",
        )
        self.assertEqual(
            auth.mcp_allowed_tool_names({"allowed_tools": {"tool_names": ["search", "details"]}}),
            ["details", "search"],
        )
        for definition in [
                {},
                {"allowed_tools": {"tool_names": []}},
                {"allowed_tools": {"tool_names": ["search", "search"]}},
                {"allowed_tools": {"tool_names": ["search", " other"]}},
                {"allowed_tools": {"tool_names": ["search", None]}}]:
            with self.subTest(definition=definition):
                self.assertIsNone(auth.mcp_allowed_tool_names(definition))
        with self.assertRaises(auth.EvidenceError):
            auth.foundry_agent_version_id("catalog-agent", None)

    def test_foundry_agent_identity_requires_a_nonempty_principal_id(self):
        self.assertTrue(auth.foundry_agent_identity_present({
            "instance_identity": {"principal_id": "b2b35cbf-5e15-4f4a-a2c2-7f450bb88b39"},
        }))
        for version in [
                {},
                {"instance_identity": None},
                {"instance_identity": {"principal_id": ""}},
                {"instance_identity": {"principal_id": 123}}]:
            with self.subTest(version=version):
                self.assertFalse(auth.foundry_agent_identity_present(version))
        self.assertFalse(auth.foundry_agent_identity_present({
            "instance_identity": {"principal_id": "not-a-guid"},
        }))

    def test_mcp_service_principal_allowlist_is_validated_and_normalized(self):
        first = "b2b35cbf-5e15-4f4a-a2c2-7f450bb88b39"
        second = "46d650b8-8ee8-44aa-a7ba-5b917737fa5b"
        self.assertEqual(auth.parse_principal_id_allowlist(first.upper() + ";" + second), {
            first, second,
        })
        for value in ["", first + ",", first + "," + first,
                      first + ",not-a-principal-id"]:
            with self.subTest(value=value), self.assertRaises(auth.EvidenceError):
                auth.parse_principal_id_allowlist(value)

    def test_seed_identity_edges_require_exact_acr_pull_and_sql_admin_binding(self):
        principal = "b2b35cbf-5e15-4f4a-a2c2-7f450bb88b39"
        registry = "/subscriptions/test/resourceGroups/demo/providers/Microsoft.ContainerRegistry/registries/registry"
        acr_pull = {"principalId": principal,
                    "roleDefinitionId": "/providers/Microsoft.Authorization/roleDefinitions/"
                                        "7f951dda-4ed3-4680-a7ca-43fe172d538d",
                    "scope": registry}
        self.assertTrue(auth.seed_acr_pull_is_exact([acr_pull], principal, registry))
        self.assertFalse(auth.seed_acr_pull_is_exact([acr_pull, {**acr_pull, "scope": "/"}],
                                                    principal, registry))
        self.assertFalse(auth.seed_acr_pull_is_exact([{**acr_pull, "condition": "unknown"}],
                                                    principal, registry))
        identity = {"principalId": principal, "name": "seed-identity"}
        sql_admin = {"administratorType": "ActiveDirectory", "sid": principal,
                     "login": "SEED-IDENTITY", "tenantId": "tenant-id"}
        self.assertTrue(auth.seed_sql_admin_matches(sql_admin, identity, "tenant-id"))
        for key, value in [("sid", "different"), ("login", "runtime-identity"),
                           ("tenantId", "different"), ("administratorType", "SQL")]:
            with self.subTest(key=key):
                self.assertFalse(auth.seed_sql_admin_matches(
                    {**sql_admin, key: value}, identity, "tenant-id"))

    def test_foundry_custom_role_must_be_unique_source_named_and_project_scoped(self):
        project = ("/subscriptions/test/resourceGroups/demo/providers/Microsoft.CognitiveServices/"
                   "accounts/ai/projects/project")
        role = {"roleDefinitionName": "AdventureWorks Foundry Agents abc123def4567",
                "scope": project}
        self.assertTrue(auth.foundry_custom_role_assignment_matches_source([role], project))
        for assignments in [
                [role, {**role, "roleDefinitionName": "AdventureWorks Foundry Agents Reader"}],
                [{**role, "roleDefinitionName": "AdventureWorks Foundry Agents Reader"}],
                [{**role, "scope": project.rsplit("/", 1)[0]}],
                [{"roleDefinitionName": None, "scope": project}]]:
            with self.subTest(assignments=assignments):
                self.assertFalse(auth.foundry_custom_role_assignment_matches_source(
                    assignments, project))

    def test_foundry_builtin_role_assignments_match_exact_account_and_project_scopes(self):
        account = "/subscriptions/test/resourceGroups/demo/providers/Microsoft.CognitiveServices/accounts/ai"
        project = account + "/projects/project"
        assignments = [
            {"roleDefinitionName": "Cognitive Services OpenAI User", "scope": account},
            {"roleDefinitionName": "Azure AI Developer", "scope": account},
            {"roleDefinitionName": "Azure AI Developer", "scope": project},
        ]
        self.assertTrue(auth.foundry_builtin_role_assignments_match_source(
            assignments, account, project))
        for invalid in [
                assignments + [{"roleDefinitionName": "Azure AI Developer", "scope": "/"}],
                assignments + [assignments[0]],
                assignments + [{"roleDefinitionName": "Cognitive Services OpenAI Contributor", "scope": account}],
                [{"roleDefinitionName": "Cognitive Services OpenAI Contributor", "scope": account}, *assignments[1:]],
                assignments[:-1],
                [{**assignments[0], "scope": project}, *assignments[1:]],
                [{**assignments[0], "scope": None}, *assignments[1:]]]:
            with self.subTest(assignments=invalid):
                self.assertFalse(auth.foundry_builtin_role_assignments_match_source(
                    invalid, account, project))

    def test_foundry_project_scope_comes_from_selected_https_endpoint(self):
        self.assertEqual(
            auth.foundry_project_scope("subscription", "demo", "account",
                                       "https://account.services.ai.azure.com/api/projects/project"),
            "/subscriptions/subscription/resourceGroups/demo/providers/"
            "Microsoft.CognitiveServices/accounts/account/projects/project",
        )
        for endpoint in ["https://account.services.ai.azure.com/api/projects/",
                         "https://account.services.ai.azure.com/projects/project"]:
            with self.subTest(endpoint=endpoint), self.assertRaises(auth.EvidenceError):
                auth.foundry_project_scope("subscription", "demo", "account", endpoint)

    def test_container_app_acr_pull_requires_attached_identity_and_exact_registry(self):
        identity = "/subscriptions/test/resourceGroups/demo/providers/Microsoft.ManagedIdentity/userAssignedIdentities/runtime"
        registry = "demo.azurecr.io"
        app = {
            "identity": {"userAssignedIdentities": {identity: {}}},
            "properties": {"configuration": {"registries": [
                {"server": registry, "identity": identity},
            ]}},
        }
        self.assertTrue(auth.container_registry_identity_is_valid(app, identity, registry))
        wrong_registry = {
            **app,
            "properties": {"configuration": {"registries": [
                {"server": "other.azurecr.io", "identity": identity},
            ]}},
        }
        self.assertFalse(auth.container_registry_identity_is_valid(wrong_registry, identity, registry))
        self.assertFalse(auth.container_registry_identity_is_valid(
            {**app, "identity": {"userAssignedIdentities": {}}}, identity, registry))
        self.assertFalse(auth.container_registry_identity_is_valid(
            {**app, "properties": {"configuration": {"registries": [
                {"server": registry, "identity": "system"},
            ]}}}, identity, registry))
        for field in ["username", "passwordSecretRef"]:
            with self.subTest(field=field):
                self.assertFalse(auth.container_registry_identity_is_valid(
                    {**app, "properties": {"configuration": {"registries": [
                        {"server": registry, "identity": identity, field: "unexpected"},
                    ]}}}, identity, registry))

    def test_registry_authentication_detects_non_rbac_access_and_invalid_evidence(self):
        registry = {
            "id": "/subscriptions/test/resourceGroups/demo/providers/Microsoft.ContainerRegistry/registries/demo",
            "loginServer": "demo.azurecr.io", "adminUserEnabled": False, "anonymousPullEnabled": False,
        }

        class Deployment:
            subscription = "test"
            group = "demo"

            def __init__(self, value, statuses):
                self.value = value
                self.statuses = statuses

            def required(self, key):
                if key != "AZURE_CONTAINER_REGISTRY_ENDPOINT":
                    raise AssertionError("Unexpected environment key")
                return "demo.azurecr.io"

            def azure(self, *args):
                if args[:2] == ("acr", "show"):
                    return self.value
                if args[:3] == ("acr", "token", "list"):
                    self.query = args
                    if isinstance(self.statuses, Exception):
                        raise self.statuses
                    return self.statuses
                raise AssertionError("Unexpected Azure operation")

        for value, tokens, expected in [
                (registry, [], ["PASS", "PASS", "PASS"]),
                ({**registry, "adminUserEnabled": True}, [], ["FAIL", "PASS", "PASS"]),
                ({**registry, "anonymousPullEnabled": True}, [], ["PASS", "FAIL", "PASS"]),
                (registry, [{"status": "disabled"}, {"status": "enabled"}], ["PASS", "PASS", "FAIL"])]:
            with self.subTest(value=value, tokens=tokens):
                report = auth.Report(Path("."))
                deployment = Deployment(value, tokens)
                auth.container_registry_authentication(report, deployment)
                self.assertEqual([check["status"] for check in report.checks], expected)
                self.assertIn("[].{status:status}", deployment.query)

        for value, tokens in [
                ({**registry, "id": registry["id"].replace("/demo/", "/other/")}, []),
                ({**registry, "loginServer": "other.azurecr.io"}, []),
                ({**registry, "adminUserEnabled": None}, []),
                ({**registry, "anonymousPullEnabled": "false"}, [])]:
            with self.subTest(value=value, tokens=tokens):
                report = auth.Report(Path("."))
                with self.assertRaises(auth.EvidenceError):
                    auth.container_registry_authentication(report, Deployment(value, tokens))
                self.assertEqual(report.checks, [])

        for tokens in [[{"status": None}], [{"status": "unknown"}], auth.EvidenceError("Access denied")]:
            with self.subTest(tokens=tokens):
                report = auth.Report(Path("."))
                auth.container_registry_authentication(
                    report, Deployment({**registry, "adminUserEnabled": True}, tokens))
                self.assertEqual([check["status"] for check in report.checks], ["FAIL", "PASS", "BLOCKED"])

    def test_webpubsub_authentication_requires_identity_and_rejects_access_keys(self):
        resource = {
            "id": "/subscriptions/test/resourceGroups/demo/providers/Microsoft.SignalRService/webPubSub/service",
            "properties": {"hostName": "service.webpubsub.azure.com",
                           "disableLocalAuth": True, "disableAadAuth": False},
        }

        class Deployment:
            subscription = "test"
            group = "demo"

            def __init__(self, value):
                self.value = value

            def required(self, key):
                if key != "WEB_PUBSUB_HOST_NAME":
                    raise AssertionError("Unexpected environment key")
                return "service.webpubsub.azure.com"

            def arm(self, path, version):
                if (path, version) != ("Microsoft.SignalRService/webPubSub/service", "2024-03-01"):
                    raise AssertionError("Unexpected resource")
                return self.value

        for properties, expected in [
                (resource["properties"], ["PASS", "PASS"]),
                ({**resource["properties"], "disableLocalAuth": False}, ["FAIL", "PASS"]),
                ({**resource["properties"], "disableAadAuth": True}, ["PASS", "FAIL"])]:
            with self.subTest(properties=properties):
                report = auth.Report(Path("."))
                auth.webpubsub_authentication(report, Deployment({**resource, "properties": properties}))
                self.assertEqual([check["status"] for check in report.checks], expected)

        for value in [
                {**resource, "id": resource["id"].replace("/demo/", "/other/")},
                {**resource, "properties": {**resource["properties"], "hostName": "other.example"}},
                {**resource, "properties": {**resource["properties"], "disableLocalAuth": None}},
                {**resource, "properties": {**resource["properties"], "disableAadAuth": "false"}}]:
            with self.subTest(value=value):
                report = auth.Report(Path("."))
                with self.assertRaises(auth.EvidenceError):
                    auth.webpubsub_authentication(report, Deployment(value))
                self.assertEqual(report.checks, [])

    def test_communication_authentication_requires_bound_resource_and_explicit_disabled_keys(self):
        resource = {
            "id": "/subscriptions/test/resourceGroups/demo/providers/Microsoft.Communication/communicationServices/service",
            "properties": {"hostName": "service.unitedstates.communication.azure.com",
                           "disableLocalAuth": True},
        }

        class Deployment:
            subscription = "test"
            group = "demo"

            def __init__(self, value, endpoint="https://service.communication.azure.com"):
                self.value = value
                self.endpoint = endpoint

            def required(self, key):
                return {"COMMUNICATION_SERVICE_NAME": "service",
                        "COMMUNICATION_SERVICE_ENDPOINT": self.endpoint}[key]

            def arm(self, path, version):
                if (path, version) != ("Microsoft.Communication/communicationServices/service", "2025-05-01"):
                    raise AssertionError("Unexpected resource")
                return self.value

        for value, expected in [(True, "PASS"), (False, "FAIL"), (None, "BLOCKED")]:
            with self.subTest(value=value):
                report = auth.Report(Path("."))
                auth.communication_authentication(
                    report, Deployment({**resource, "properties": {**resource["properties"],
                                                                   "disableLocalAuth": value}}))
                self.assertEqual([check["status"] for check in report.checks], [expected])

        for value, endpoint in [
                ({**resource, "id": resource["id"].replace("/demo/", "/other/")},
                 "https://service.communication.azure.com"),
                ({**resource, "properties": {**resource["properties"], "hostName": "other.communication.azure.com"}},
                 "https://service.communication.azure.com"),
                ({**resource, "properties": {**resource["properties"], "disableLocalAuth": "true"}},
                 "https://service.communication.azure.com"),
                (resource, "https://service.communication.azure.com.attacker.example"),
                (resource, "https://service.communication.azure.com:443"),
                (resource, "https://service.communication.azure.com/path")]:
            with self.subTest(value=value, endpoint=endpoint):
                report = auth.Report(Path("."))
                with self.assertRaises(auth.EvidenceError):
                    auth.communication_authentication(report, Deployment(value, endpoint))
                self.assertEqual(report.checks, [])

    def test_functions_host_identity_matches_attached_and_storage_client_ids(self):
        resource_id = "/subscriptions/test/resourceGroups/demo/providers/Microsoft.ManagedIdentity/userAssignedIdentities/runtime"
        client_id = "client-id"
        identity = {"id": resource_id, "clientId": client_id}
        function_app = {"identity": {"userAssignedIdentities": {resource_id: {}}}}
        settings = {"AZURE_CLIENT_ID": client_id, "AzureWebJobsStorage__clientId": client_id}
        self.assertTrue(auth.function_identity_binding_is_valid(function_app, settings, identity))
        for invalid_settings in [
                {**settings, "AZURE_CLIENT_ID": "other"},
                {**settings, "AzureWebJobsStorage__clientId": "other"}]:
            with self.subTest(settings=invalid_settings):
                self.assertFalse(auth.function_identity_binding_is_valid(
                    function_app, invalid_settings, identity))
        self.assertFalse(auth.function_identity_binding_is_valid(
            {"identity": {"userAssignedIdentities": {}}}, settings, identity))

    def test_agent_source_and_deployed_tool_lists_must_match_exactly(self):
        source = {
            "eshop-chat-agent": ["get_order_details", "search_products"],
            "email-agent": [],
        }
        custom = {"type": "mcp", "server": "adventureworks_mcp",
                  "allowedTools": ["get_order_details", "search_products"]}
        dab = {"type": "mcp", "server": "dabmcp", "allowedTools": ["read_record"]}
        self.assertTrue(auth.agent_tool_allowlist_matches(source["eshop-chat-agent"], [custom]))
        self.assertFalse(auth.agent_tool_allowlist_matches(source["eshop-chat-agent"], [custom, dab]))
        self.assertFalse(auth.agent_tool_allowlist_matches(source["eshop-chat-agent"], []))
        self.assertTrue(auth.agent_tool_allowlist_matches(source["email-agent"], []))
        self.assertFalse(auth.agent_tool_allowlist_matches(source["email-agent"], [custom]))

    def test_agent_provisioner_inventory_rejects_bad_lists_and_preserves_no_tool_agents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "no-tools.sh").write_text('upsert_agent "no-tools" ... "[]" "false"\n')
            (root / "limited.sh").write_text("ALLOWED_TOOLS='[\"search_products\"]'\n")
            self.assertEqual(auth.agent_provisioner_tool_inventory(root), {
                "limited": ["search_products"],
                "no-tools": [],
            })
            (root / "limited.sh").write_text("ALLOWED_TOOLS='{}'\n")
            with self.assertRaisesRegex(auth.EvidenceError, "invalid MCP allow-list"):
                auth.agent_provisioner_tool_inventory(root)

    def test_agent_source_inventory_includes_micro_agents_and_workflows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "direct.sh").write_text(
                'ALLOWED_TOOLS=\'["search_products"]\'\n'
                'upsert_agent "catalog-agent" "Catalog" "$INSTRUCTIONS"\n')
            (root / "workflow.sh").write_text(
                'INTENT_AGENT_NAME="intent-agent"\n'
                'AGENT_NAME="workflow-agent"\n')
            self.assertEqual(auth.agent_source_inventory(root), {
                "catalog-agent": ["search_products"],
                "intent-agent": [],
                "workflow-agent": [],
            })

    def test_agent_source_inventory_fails_closed_for_unclassified_or_duplicate_names(self):
        for contents, expected_error in [
                ('echo "no agent declaration"\n', "missing or duplicate agent names"),
                ('upsert_agent "same-agent"\nAGENT_NAME="same-agent"\n',
                 "missing or duplicate agent names")]:
            with self.subTest(contents=contents), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "agent.sh").write_text(contents)
                with self.assertRaisesRegex(auth.EvidenceError, expected_error):
                    auth.agent_source_inventory(root)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "first.sh").write_text('upsert_agent "same-agent"\n')
            (root / "second.sh").write_text('AGENT_NAME="same-agent"\n')
            with self.assertRaisesRegex(auth.EvidenceError, "multiple provisioners"):
                auth.agent_source_inventory(root)


class ReportTests(unittest.TestCase):
    def report(self, root):
        return auth.Report(Path(root))

    def test_blocked_assertions_prevent_success_and_do_not_inflate_coverage(self):
        with tempfile.TemporaryDirectory() as root:
            report = self.report(root)
            report.add("allow", "live", "PASS", "data returned")
            report.add("missing", "live", "BLOCKED", "identity unavailable")
            report.add("exception", "live", "ACCEPTED_EXCEPTION", "bounded public discovery")
            with patch("sys.stdout", new=io.StringIO()):
                self.assertEqual(report.save(), 2)
            document = json.loads((Path(root) / "report.json").read_text())
            self.assertEqual(document["outcome"], "BLOCKED")
            self.assertEqual(document["groups"]["live"]["applicable"], 2)
            self.assertEqual(document["groups"]["live"]["completed"], 1)
            tree = ET.parse(Path(root) / "junit.xml")
            self.assertEqual(len(tree.findall(".//error")), 1)
            self.assertEqual(len(tree.findall(".//skipped")), 1)

    def test_failure_dominates_blocked_and_uses_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as root:
            report = self.report(root)
            report.add("denial", "live", "FAIL", "expected 401 received 200")
            report.add("missing", "live", "BLOCKED", "unavailable")
            with patch("sys.stdout", new=io.StringIO()):
                self.assertEqual(report.save(), 1)

    def test_duplicate_ids_and_invalid_status_fail_loudly(self):
        report = self.report(".")
        report.add("one", "offline", "PASS", "done")
        with self.assertRaises(ValueError):
            report.add("one", "offline", "PASS", "duplicate")
        with self.assertRaises(ValueError):
            report.add("two", "offline", "UNKNOWN", "invalid")

    def test_guard_does_not_swallow_programming_errors(self):
        report = self.report(".")
        with self.assertRaises(ZeroDivisionError):
            report.guarded("bug", "offline", lambda: 1 / 0)

    def test_guard_records_unavailable_evidence_not_pass(self):
        report = self.report(".")
        def unavailable():
            raise auth.EvidenceError("private endpoint unavailable")
        report.guarded("network", "infra", unavailable)
        self.assertEqual(report.checks[0]["status"], "BLOCKED")


class TransportTests(unittest.TestCase):
    def test_cli_failure_does_not_expose_stdout_stderr_or_credentials(self):
        result = SimpleNamespace(returncode=1, stdout="access_token=secret", stderr="password=secret")
        with patch.object(auth.subprocess, "run", return_value=result) as run:
            with self.assertRaises(auth.EvidenceError) as error:
                auth.command(["az", "rest", "--url", "https://example.test"])
        self.assertNotIn("secret", str(error.exception))
        self.assertFalse(run.call_args.kwargs.get("shell", False))

    def test_redirects_are_not_followed(self):
        redirect = auth.NoRedirect()
        self.assertIsNone(redirect.redirect_request(None, None, 302, "", {}, "https://foreign.test/"))

    def test_network_failure_is_not_auth_denial(self):
        opener = SimpleNamespace(open=lambda *args, **kwargs: self.raise_url_error())
        with patch.object(auth.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(auth.EvidenceError, "not an authorization denial"):
                auth.http("GET", "https://example.test")

    @staticmethod
    def raise_url_error():
        raise urllib.error.URLError("could not connect")

    def test_azd_environment_selection_is_explicit_and_never_uses_shell(self):
        values = {"AZURE_SUBSCRIPTION_ID": "subscription", "AZURE_RESOURCE_GROUP": "group",
                  "AZURE_ENV_NAME": "selected-env"}
        with patch.object(auth, "json_command", return_value=values) as run:
            deployment = auth.Deployment("selected-env")
        self.assertEqual(deployment.group, "group")
        self.assertEqual(deployment.environment, "selected-env")
        self.assertIn("--environment", run.call_args.args[0])
        self.assertIn("selected-env", run.call_args.args[0])
        with patch.object(auth, "json_command", return_value=values):
            self.assertEqual(auth.Deployment(None).environment, "selected-env")
            with self.assertRaisesRegex(auth.EvidenceError, "does not match"):
                auth.Deployment("other-env")

    def test_internal_token_target_uses_the_captured_deployment(self):
        values = {"API_MCP_URL": "https://selected.example/mcp",
                  "MCP_RESOURCE_IDENTIFIER": "urn:custom:mcp/"}
        deployment = SimpleNamespace(values=values, required=lambda key: values[key])
        self.assertEqual(auth.internal_token_target(deployment, "mcp"),
                         ("https://selected.example", "urn:custom:mcp"))
        self.assertEqual(auth.internal_token_target(deployment, "functions"),
                         ("https://selected.example", "https://selected.example/functions"))
        values["FUNCTIONS_RESOURCE_IDENTIFIER"] = "////"
        with self.assertRaises(auth.EvidenceError):
            auth.internal_token_target(deployment, "functions")
        with self.assertRaises(auth.EvidenceError):
            auth.internal_token_target(deployment, "unknown")

    def test_internal_mcp_session_never_rereads_a_different_selected_environment(self):
        values = {"API_MCP_URL": "https://selected.example/mcp"}
        deployment = SimpleNamespace(values=values, required=lambda key: values[key], environment="selected-env")
        observed = []

        class Helper:
            AuthError = ValueError

            def NoRedirect(self):
                return object()

            def deployment(self, *args):
                raise AssertionError("The live run must not reread the selected environment")

            def session(self, opener, args, base, audience):
                observed.append((base, audience))
                return {"access_token": "fixture-token"}

        with patch.object(auth, "load_auth_helper", return_value=Helper()), \
                patch.object(auth.urllib.request, "build_opener", return_value=object()):
            self.assertEqual(auth.internal_mcp_token(deployment, "admin"), "fixture-token")
        self.assertEqual(observed, [("https://selected.example", "https://selected.example/mcp")])

    def test_missing_azd_values_are_errors_not_fallback_hostnames(self):
        with patch.object(auth, "json_command", return_value={}):
            with self.assertRaisesRegex(auth.EvidenceError, "AZURE_SUBSCRIPTION_ID"):
                auth.Deployment(None)


if __name__ == "__main__":
    unittest.main()
