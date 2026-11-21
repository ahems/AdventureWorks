import importlib.util
import base64
import copy
from collections import Counter
from datetime import datetime, timezone
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import urllib.error
import urllib.parse
import xml.etree.ElementTree as ET
import yaml

SPEC = importlib.util.spec_from_file_location("validate_auth", Path(__file__).with_name("validate.py"))
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)


class ContractTests(unittest.TestCase):
    def test_isolated_storage_wait_accepts_slow_start_but_not_timeout_or_exit(self):
        import functions_host

        process = SimpleNamespace(poll=lambda: None)
        with patch.object(functions_host.time, "monotonic", side_effect=[0, 0, 6]), \
                patch.object(functions_host.time, "sleep"), \
                patch.object(functions_host.socket, "create_connection",
                             side_effect=[OSError("not ready"), MagicMock()]) as connect:
            functions_host.wait_for_storage(process)
        self.assertEqual(connect.call_count, 2)

        with patch.object(functions_host.time, "monotonic", side_effect=[0, 0, 31]), \
                patch.object(functions_host.time, "sleep"), \
                patch.object(functions_host.socket, "create_connection", side_effect=OSError("not ready")), \
                self.assertRaisesRegex(functions_host.HostFailure, "within 30 seconds"):
            functions_host.wait_for_storage(process)

        with patch.object(functions_host.time, "monotonic", side_effect=[0, 0]), \
                self.assertRaisesRegex(functions_host.HostFailure, "exited during startup"):
            functions_host.wait_for_storage(SimpleNamespace(poll=lambda: 1))

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

    def mcp_sql_deployment_fixture(self):
        values = {
            "SERVICE_API_MCP_NAME": "selected-mcp",
            "USER_MANAGED_IDENTITY_NAME": "selected-identity",
            "SQL_SERVER_NAME": "selected-server",
            "SQL_DATABASE_NAME": "selected-db",
            "AZURE_CLIENT_ID": "00000000-0000-0000-0000-000000000123",
            "API_MCP_URL": "https://selected-mcp.example.test/mcp",
        }
        root = "/subscriptions/sub/resourceGroups/group/providers/"
        identity_id = root + "Microsoft.ManagedIdentity/userAssignedIdentities/selected-identity"
        server_id = root + "Microsoft.Sql/servers/selected-server"
        resources = {
            "identity": {"id": identity_id, "clientId": values["AZURE_CLIENT_ID"]},
            "server": {"id": server_id, "fullyQualifiedDomainName": "selected-server.example.test"},
            "database": {"id": server_id + "/databases/selected-db"},
            "app": {
                "id": root + "Microsoft.App/containerApps/selected-mcp",
                "identity": {"userAssignedIdentities": {identity_id: {}}},
                "properties": {
                    "provisioningState": "Succeeded",
                    "latestRevisionName": "ready-revision",
                    "latestReadyRevisionName": "ready-revision",
                    "configuration": {"ingress": {
                        "external": True, "fqdn": "selected-mcp.example.test",
                        "traffic": [{"latestRevision": True, "weight": 100}],
                    }},
                    "template": {"containers": [{
                        "name": "selected-mcp",
                        "env": [
                            {"name": "AZURE_CLIENT_ID", "value": values["AZURE_CLIENT_ID"]},
                            {"name": "ConnectionStrings__AdventureWorks",
                             "value": "Server=tcp:selected-server.example.test;Database=selected-db;"
                                      "Authentication=Active Directory Default;"},
                        ],
                    }]},
                },
            },
        }

        def azure(*args):
            key = {("identity", "show"): "identity", ("sql", "server"): "server",
                   ("sql", "db"): "database", ("containerapp", "show"): "app"}[args[:2]]
            return resources[key]

        return SimpleNamespace(required=values.__getitem__, group="group", subscription="sub", azure=azure), resources

    def test_mcp_sql_target_requires_exact_selected_passwordless_connection(self):
        target = "Server=tcp:selected-server.example.test;Database=selected-db;Authentication=Active Directory Default;"
        self.assertTrue(auth.mcp_sql_target_matches(target, "selected-server.example.test", "selected-db"))
        for value in [
                target.replace("selected-server.example.test", "other.example.test"),
                target.replace("selected-db", "other-db"),
                target + "User ID=other;",
                target + "Data Source=other.example.test;",
                target + "Initial Catalog=other-db;",
                target + "Server=other.example.test;",
                target + "Failover Partner=other.example.test;",
                target.replace("Active Directory Default", "SqlPassword"),
                None]:
            with self.subTest(value=value):
                self.assertFalse(auth.mcp_sql_target_matches(value, "selected-server.example.test", "selected-db"))

    def test_mcp_sql_binding_checks_selected_resources_identity_ingress_and_single_ready_revision(self):
        deployment, _ = self.mcp_sql_deployment_fixture()
        self.assertTrue(auth.mcp_sql_binding_snapshot(deployment)["valid"])
        for defect in ["identity", "attached", "server", "database", "connection", "ingress",
                       "selected-client", "duplicate-env"]:
            deployment, resources = self.mcp_sql_deployment_fixture()
            app = resources["app"]
            env = app["properties"]["template"]["containers"][0]["env"]
            if defect == "identity":
                env[0]["value"] = "00000000-0000-0000-0000-000000000456"
            elif defect == "attached":
                app["identity"]["userAssignedIdentities"] = {}
            elif defect == "server":
                resources["server"]["id"] += "-other"
            elif defect == "database":
                resources["database"]["id"] += "-other"
            elif defect == "connection":
                env[1]["value"] = env[1]["value"].replace("selected-db", "other-db")
            elif defect == "ingress":
                app["properties"]["configuration"]["ingress"]["fqdn"] = "other.example.test"
            elif defect == "selected-client":
                resources["identity"]["clientId"] = "00000000-0000-0000-0000-000000000456"
            else:
                env.append(copy.deepcopy(env[0]))
            with self.subTest(defect=defect):
                self.assertFalse(auth.mcp_sql_binding_snapshot(deployment)["valid"])

        for defect in ["unready", "split", "old-revision"]:
            deployment, resources = self.mcp_sql_deployment_fixture()
            properties = resources["app"]["properties"]
            if defect == "unready":
                properties["latestReadyRevisionName"] = "old-revision"
            elif defect == "split":
                properties["configuration"]["ingress"]["traffic"] = [
                    {"latestRevision": True, "weight": 50},
                    {"revisionName": "old-revision", "weight": 50},
                ]
            else:
                properties["configuration"]["ingress"]["traffic"] = [
                    {"revisionName": "old-revision", "weight": 100},
                ]
            with self.subTest(defect=defect), self.assertRaises(auth.EvidenceError):
                auth.mcp_sql_binding_snapshot(deployment)

    def test_mcp_sql_principal_requires_stable_binding_and_exact_current_probe(self):
        deployment = SimpleNamespace(required=lambda _: "https://selected-mcp.example.test/mcp")
        base = {
            "status": "healthy", "checkedAt": datetime.now(timezone.utc).isoformat(),
            "checks": [
                {"id": "sql", "required": True, "status": "healthy", "message": "catalog"},
                {"id": "tasks", "required": True, "status": "healthy", "message": "tasks"},
                {"id": "sql-identity", "required": False, "status": "healthy",
                 "message": "SQL principal matches the configured managed identity."},
            ],
        }
        for state, message, sql_state, expected in [
                ("healthy", "SQL principal matches the configured managed identity.", "healthy", "PASS"),
                ("unhealthy", "SQL principal does not match the configured managed identity.", "healthy", "FAIL"),
                ("unhealthy", "Dependency unavailable or access denied. See Application Insights.", "healthy", "BLOCKED"),
                ("unknown", "SQL principal identity could not be verified.", "healthy", "BLOCKED"),
                ("healthy", "unrecognized message", "healthy", "BLOCKED"),
                ("healthy", "SQL principal matches the configured managed identity.", "unhealthy", "BLOCKED")]:
            document = copy.deepcopy(base)
            document["checks"][0]["status"] = sql_state
            document["checks"][2].update(status=state, message=message)
            document["status"] = "healthy" if sql_state == "healthy" else "unhealthy"
            http_status = 200 if document["status"] == "healthy" else 503
            report = auth.Report(Path("."))
            binding = {"valid": True, "revision": "ready-revision"}
            with self.subTest(state=state, message=message, sql=sql_state), \
                    patch.object(auth, "mcp_sql_binding_snapshot", side_effect=[binding, binding]), \
                    patch.object(auth, "http", return_value=(http_status, {}, json.dumps(document).encode())) as request:
                auth.mcp_sql_principal_readiness(report, deployment)
                request.assert_called_once_with("GET", "https://selected-mcp.example.test/ready")
                results = {item["id"]: item["status"] for item in report.checks}
                self.assertEqual(results["infra:mcp-sql-binding"], "PASS")
                self.assertEqual(results["infra:mcp-sql-principal"], expected)
                self.assertNotIn(message, json.dumps(report.inventory))

        report = auth.Report(Path("."))
        with patch.object(auth, "mcp_sql_binding_snapshot", return_value={"valid": False}), \
                patch.object(auth, "http") as request:
            auth.mcp_sql_principal_readiness(report, deployment)
        request.assert_not_called()
        self.assertEqual({item["id"]: item["status"] for item in report.checks},
                         {"infra:mcp-sql-binding": "FAIL", "infra:mcp-sql-principal": "BLOCKED"})

        report = auth.Report(Path("."))
        with patch.object(auth, "mcp_sql_binding_snapshot",
                          side_effect=[{"valid": True, "revision": "one"}, {"valid": True, "revision": "two"}]), \
                patch.object(auth, "http", return_value=(200, {}, json.dumps(base).encode())), \
                self.assertRaises(auth.EvidenceError):
            auth.mcp_sql_principal_readiness(report, deployment)
        self.assertEqual(report.checks, [])

        for defect in ["legacy", "duplicate", "required", "overall", "stale", "bad-status"]:
            document = copy.deepcopy(base)
            if defect == "legacy":
                document["checks"].pop()
            elif defect == "duplicate":
                document["checks"].append(copy.deepcopy(document["checks"][0]))
            elif defect == "required":
                document["checks"][2]["required"] = True
            elif defect == "overall":
                document["status"] = "unhealthy"
            elif defect == "stale":
                document["checkedAt"] = "2000-01-01T00:00:00Z"
            else:
                document["checks"][0]["status"] = []
            report = auth.Report(Path("."))
            binding = {"valid": True, "revision": "one"}
            with self.subTest(defect=defect), \
                    patch.object(auth, "mcp_sql_binding_snapshot", side_effect=[binding, binding]), \
                    patch.object(auth, "http", return_value=(200, {}, json.dumps(document).encode())), \
                    self.assertRaises(auth.EvidenceError):
                auth.mcp_sql_principal_readiness(report, deployment)
            self.assertEqual(report.checks, [])

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
        expected.add(prefix + "Every_tool_with_issued_staff_scope_reaches_dispatch_once" +
                     '(name: "get_customer_orders")')
        expected.update(prefix + "Each_service_profile_enforces_its_tool_boundary" +
                        f'(name: "get_customer_orders", profile: "{profile}")'
                        for profile in ["functions", "hosted"])
        expected.add(prefix + "Denied_task_opt_in_returns_authorization_error_not_a_background_task" +
                     '(name: "get_customer_orders")')
        expected.add(prefix + "Authorized_task_opt_in_preserves_background_dispatch")
        expected.update(prefix + name for name in [
            "Future_autonomy_shutoff_permits_a_service_action",
            "Human_manufacturing_actions_are_not_bound_to_agent_autonomy",
            "Existing_service_token_stops_dispatching_when_principal_trust_is_removed",
            "Existing_hosted_token_stops_dispatching_when_the_instance_profile_rotates",
            "Service_task_handlers_deny_an_existing_token_after_principal_trust_is_removed",
        ])
        expected.update(
            prefix + "Service_actions_require_the_persisted_autonomy_mode" +
            f'(tool: "{tool}", mode: {mode}, allowed: {allowed})'
            for tool in ["begin_manufacturing_run", "place_supply_order"]
            for mode, allowed in [(0, "False"), (1, "False"), (2, "False"), (3, "True")]
        )
        expected.update(
            prefix + f'Service_actions_fail_closed_when_autonomy_cannot_be_confirmed(condition: "{condition}")'
            for condition in ["expired", "inconsistent", "malformed", "unavailable"]
        )
        expected.update(
            prefix + "Service_action_rechecks_autonomy_before_tool_dispatch" +
            f'(tool: "{tool}", task: {task})'
            for tool in ["begin_manufacturing_run", "place_supply_order"]
            for task in ["False", "True"]
        )
        expected.update(
            prefix + "Autonomous_service_action_task_reaches_dispatch_when_mode_remains_enabled" +
            f'(tool: "{tool}")'
            for tool in ["begin_manufacturing_run", "place_supply_order"]
        )
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

    def test_hosted_agent_auth_evidence_requires_the_current_mode_and_tool_cases(self):
        prefix = "ApiFunctions.Tests.ManufacturingMcpAuthenticationTests."
        expected = {prefix + name for name in [
            "Autonomous_mode_offers_write_tools_and_unknown_modes_fail_closed",
            "Manufacturing_invocation_mode_is_parsed_fail_closed",
            "Omitted_response_scope_means_the_requested_scope_set",
            "Insecure_endpoint_is_rejected_before_credentials_are_acquired",
            "Exchanges_managed_identity_assertion_for_the_correct_mcp_resource_each_invocation",
        ]}
        expected.update(prefix + f'Ambiguous_endpoint_is_rejected_before_credentials_are_acquired(defect: "{defect}")'
                        for defect in ["query", "fragment", "userinfo", "empty-userinfo", "dot-segment",
                                       "escaped-dot-segment", "backslash"])
        expected.update(prefix + f"Hosted_agent_accepts_the_actual_queue_trigger_mode_format(mode: {mode})"
                        for mode in ["ReadOnly", "ProposePending", "FullyAutonomous"])
        expected.update(prefix + f'Read_and_proposal_modes_do_not_offer_autonomous_write_tools(mode: "{mode}")'
                        for mode in ["ReadOnly", "ProposePending"])
        for scenario, status in [("complete", "PASS"), ("missing", "BLOCKED"),
                                 ("duplicate", "BLOCKED"), ("skipped", "BLOCKED"), ("failed", "FAIL")]:
            with self.subTest(scenario=scenario):
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
                report = auth.Report(Path("."))
                with patch.object(auth, "current_test_evidence", return_value=(results, {"current.trx": "hash"})):
                    auth.hosted_agent_auth_evidence(report)
                self.assertEqual(report.checks[0]["status"], status)

    def test_agent_token_target_gate_requires_exact_passing_current_results(self):
        names = auth.agent_token_target_cases()
        for scenario, status in [("complete", "PASS"), ("missing", "BLOCKED"),
                                 ("duplicate", "BLOCKED"), ("skipped", "BLOCKED"),
                                 ("failed", "FAIL"), ("absent", "BLOCKED")]:
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
                    auth.agent_token_target_evidence(report)
                self.assertEqual(report.checks[0]["status"], status)

    def test_agent_token_target_gate_requires_each_review_policy_regression(self):
        prefix = "ApiFunctions.Tests.FoundryAgentClientTests."
        required = {
            prefix + f'Review_batch_agents_{behavior}(operation: "{operation}")'
            for behavior in ["propagate_unsolicited_tool_calls", "preserve_non_policy_error_fallbacks"]
            for operation in ["reviews", "replies"]
        }
        required.update(prefix + f'Verified_review_job_stops_after_tool_policy_rejection(stage: "{stage}")'
                        for stage in ["review", "reply"])
        required.add(prefix + "Review_agent_does_not_log_unparseable_generated_content")
        names = auth.agent_token_target_cases()
        self.assertTrue(required <= names)
        for missing in required:
            with self.subTest(missing=missing):
                results = {name: ["Passed"] for name in names if name != missing}
                report = auth.Report(Path("."))
                with patch.object(auth, "current_test_evidence", return_value=(results, {"current.trx": "hash"})):
                    auth.agent_token_target_evidence(report)
                self.assertEqual(report.checks[0]["status"], "BLOCKED")

    def test_agent_token_target_gate_requires_each_analysis_policy_regression(self):
        prefix = "ApiFunctions.Tests.FoundryAgentClientTests."
        required = {
            prefix + f'{name}(operation: "{operation}")'
            for operation in ["review", "recovery"] for name in [
                "Analysis_memory_is_isolated_per_request_and_shared_within_batches",
                "Analysis_handlers_return_failure_after_a_policy_rejection",
                "Analysis_services_preserve_non_policy_batch_fallbacks",
            ]
        }
        required.update(prefix + "Analysis_policy_rejection_stops_later_batches" +
                        f'(operation: "{operation}", rejectedRound: {round_number})'
                        for operation in ["review", "recovery"] for round_number in [1, 2])
        required.add(prefix + "Moderation_policy_rejection_persists_terminal_state_and_skips_queued_items")
        required.add(prefix + "Moderation_skips_an_inflight_write_when_another_worker_stopped_the_job")
        required.add(prefix + "Email_content_memory_is_isolated_between_customer_requests")
        required.update(prefix + f"Email_content_handler_surfaces_policy_errors_and_preserves_ordinary_fallbacks(policy: {policy})"
                        for policy in ["True", "False"])
        required.update(prefix + "Secondary_translation_policy_errors_stop_before_description_persistence" +
                        f'(caller: "{caller}", policy: {policy})'
                        for caller in ["queue", "activity"] for policy in ["True", "False"])
        required.update(prefix + f"Foundry_error_and_retry_logs_omit_untrusted_response_bodies(retry: {retry})"
                        for retry in ["True", "False"])
        names = auth.agent_token_target_cases()
        self.assertTrue(required <= names)
        for missing in required:
            with self.subTest(missing=missing):
                results = {name: ["Passed"] for name in names if name != missing}
                report = auth.Report(Path("."))
                with patch.object(auth, "current_test_evidence", return_value=(results, {"current.trx": "hash"})):
                    auth.agent_token_target_evidence(report)
                self.assertEqual(report.checks[0]["status"], "BLOCKED")

    def test_mcp_functions_target_gate_rejects_incomplete_duplicate_or_failed_results(self):
        prefix = "AdventureWorks.Tests.FunctionsServiceTokenHandlerTests."
        names = {prefix + name for name in [
            "Functions_endpoint_accepts_only_canonical_https_or_loopback_origins",
            "Functions_service_token_is_sent_only_to_the_configured_origin",
            "Functions_proxy_rejects_supplied_authorization_and_host_headers",
            "Functions_proxy_fails_closed_without_a_remote_issuer_but_preserves_loopback_development",
            "Functions_proxy_fails_closed_without_signing_credentials",
            "Registered_functions_proxy_clients_do_not_follow_redirects",
        ]}
        for scenario, status in [("complete", "PASS"), ("missing", "BLOCKED"), ("duplicate", "BLOCKED"),
                                 ("skipped", "BLOCKED"), ("failed", "FAIL"), ("extra", "BLOCKED"),
                                 ("absent", "BLOCKED")]:
            with self.subTest(scenario=scenario):
                results = {name: ["Passed"] for name in names}
                first = sorted(names)[0]
                if scenario == "missing":
                    del results[first]
                elif scenario == "duplicate":
                    results[first].append("Passed")
                elif scenario == "skipped":
                    results[first] = ["NotExecuted"]
                elif scenario == "failed":
                    results[first] = ["Failed"]
                elif scenario == "extra":
                    results[prefix + "Unexpected_case"] = ["Passed"]
                elif scenario == "absent":
                    results = {}
                report = auth.Report(Path("."))
                with patch.object(auth, "current_test_evidence", return_value=(results, {"current.trx": "hash"})):
                    auth.mcp_functions_target_evidence(report)
                self.assertEqual(report.checks[0]["status"], status)

    def test_mcp_functions_proxy_requires_real_audience_scope_and_read_controls(self):
        denial = {"jsonrpc": "2.0", "id": 1, "result": {"isError": True, "content": [{
            "type": "text", "text": "This operation requires the 'manufacturing.read' scope, which your account does not have."}]}}
        allowed = {"jsonrpc": "2.0", "id": 1, "result": {"content": [{
            "type": "text", "text": "## Scrap Events\nTotal events: 0\n"}]}}
        deployment = SimpleNamespace(required=lambda _: "https://mcp.example.test/mcp")
        for scenario in ["complete", "anonymous-allowed", "wrong-audience-allowed", "scope-allowed",
                         "malformed-scope-result", "upstream-error", "malformed-read", "overbroad-token"]:
            with self.subTest(scenario=scenario):
                report = auth.Report(Path("."))
                claims = {"category": "manufacturing", "scope": "mcp.access products.read" +
                          (" manufacturing.read" if scenario == "overbroad-token" else "")}
                responses = [
                    (200 if scenario == "anonymous-allowed" else 401, {}, b"{}"),
                    (200 if scenario == "wrong-audience-allowed" else 401, {}, b"{}"),
                ]
                if scenario != "overbroad-token":
                    denied = copy.deepcopy(denial)
                    if scenario == "scope-allowed":
                        denied["result"]["isError"] = False
                    responses.append((200, {}, b"not-json" if scenario == "malformed-scope-result" else
                                      json.dumps(denied).encode()))
                read = copy.deepcopy(allowed)
                if scenario == "upstream-error":
                    read["result"]["content"][0]["text"] = "Error retrieving scrap events: Unauthorized"
                if scenario == "malformed-read":
                    read["result"]["isError"] = 0
                responses.append((200, {}, json.dumps(read).encode()))
                helper = SimpleNamespace(claims=lambda _: claims, AuthError=ValueError)
                with patch.object(auth, "internal_token", side_effect=["functions", "reduced", "full"]) as token, \
                        patch.object(auth, "load_auth_helper", return_value=helper), \
                        patch.object(auth.time, "sleep"), \
                        patch.object(auth, "http", side_effect=responses) as http:
                    auth.mcp_functions_proxy_tests(report, deployment)
                self.assertEqual(token.call_count, 3)
                self.assertEqual(http.call_count, 3 if scenario == "overbroad-token" else 4)
                self.assertEqual(token.call_args_list[1].kwargs["scopes"], "mcp.access products.read")
                statuses = {check["id"]: check["status"] for check in report.checks}
                if scenario == "complete":
                    self.assertEqual(set(statuses.values()), {"PASS"})
                elif scenario == "overbroad-token":
                    self.assertEqual(statuses["mcp-functions:reduced-scope-token"], "FAIL")
                    self.assertEqual(statuses["mcp-functions:scope-denied"], "BLOCKED")
                else:
                    self.assertIn("FAIL", statuses.values())

    def test_mcp_functions_cli_uses_only_its_focused_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "report")
            deployment = SimpleNamespace(values={"AZURE_ENV_NAME": "demo"})
            with patch.object(auth, "command", return_value=""), \
                    patch.object(auth, "Deployment", return_value=deployment), \
                    patch.object(auth, "record_deployment_origin_inventory"), \
                    patch.object(auth, "mcp_functions_proxy_tests") as scenario:
                self.assertEqual(auth.main(["--mcp-functions", "--environment", "demo", "--output", output]), 0)
            scenario.assert_called_once()
            self.assertEqual(json.loads((Path(output) / "report.json").read_text())["provenance"]["profile"],
                             "mcp-functions")

    def test_task_store_ownership_evidence_rejects_incomplete_and_failed_current_runs(self):
        prefix = "AdventureWorks.Tests.McpTaskOwnershipTests."
        names = {prefix + name for name in [
            "Creation_without_tool_authority_never_writes_a_table_entity",
            "In_memory_tasks_enforce_the_same_owner_and_scope_boundary",
            "Service_tasks_recheck_current_principal_trust_and_tool_profile",
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
            "exp": int(time.time()) + 600,
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
            "exp": int(time.time()) + 600,
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

    def test_consumer_session_renews_using_earliest_actual_expiry(self):
        deployment = SimpleNamespace(values={}, required=lambda _: "https://mcp.example.test/mcp")
        session = auth.ConsumerSession(deployment, "A", "fixture@example.invalid", "fixture-password", 7)
        clock = {"wall": 10000.0, "monotonic": 1000.0}

        for token_ttl, advertised_ttl in [(130, 600), (600, 130)]:
            with self.subTest(token_ttl=token_ttl, advertised_ttl=advertised_ttl):
                clock.update(wall=10000.0, monotonic=1000.0)
                session.tokens.clear()

                def exchange(resource, scopes):
                    payload = auth.base64.urlsafe_b64encode(json.dumps({
                        "category": "consumer", "aud": "https://mcp.example.test/functions",
                        "business_entity_id": "7", "scope": scopes, "exp": int(clock["wall"]) + token_ttl,
                    }).encode()).decode().rstrip("=")
                    return 200, {}, json.dumps({
                        "access_token": "fixture." + payload + ".signature", "expires_in": advertised_ttl,
                    }).encode()

                with patch.object(auth.time, "time", side_effect=lambda: clock["wall"]), \
                        patch.object(auth.time, "monotonic", side_effect=lambda: clock["monotonic"]), \
                        patch.object(session, "exchange", side_effect=exchange) as exchanges:
                    first = session.token("functions", "mcp.access")
                    self.assertEqual(first, session.token("functions", "mcp.access"))
                    clock["wall"] += 15
                    clock["monotonic"] += 15
                    self.assertNotEqual(first, session.token("functions", "mcp.access"))
                    self.assertEqual(exchanges.call_count, 2)

    def test_consumer_session_rejects_missing_or_near_token_expiry(self):
        deployment = SimpleNamespace(values={}, required=lambda _: "https://mcp.example.test/mcp")
        for expiry in [None, True, 10120, "10600"]:
            with self.subTest(expiry=expiry):
                claims = {"category": "consumer", "aud": "https://mcp.example.test/functions",
                          "business_entity_id": "7", "exp": expiry}
                payload = auth.base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
                response = (200, {}, json.dumps({
                    "access_token": "fixture." + payload + ".signature", "expires_in": 600,
                }).encode())
                session = auth.ConsumerSession(deployment, "A", "fixture@example.invalid", "fixture-password", 7)
                with patch.object(auth.time, "time", return_value=10000), \
                        patch.object(session, "exchange", return_value=response), \
                        self.assertRaises(auth.EvidenceError):
                    session.token("functions")

    def test_reduced_scope_metadata_reports_only_invalid_categories(self):
        deployment = SimpleNamespace(values={}, required=lambda _: "https://mcp.example.test/mcp")
        consumer = SimpleNamespace(business_id=7, token=lambda *_: "private-token")
        claims = {"category": "consumer", "aud": "https://mcp.example.test/functions",
                  "business_entity_id": "7", "scope": "mcp.access", "exp": 10600}
        for defect in [None, "scope", "category", "owner", "audience", "lifetime"]:
            with self.subTest(defect=defect):
                actual = claims.copy()
                if defect == "scope":
                    actual["scope"] = "mcp.access mcp.access"
                elif defect == "category":
                    actual["category"] = "private-category"
                elif defect == "owner":
                    actual["business_entity_id"] = "private-owner"
                elif defect == "audience":
                    actual["aud"] = "private-audience"
                elif defect == "lifetime":
                    actual["exp"] = 10060
                helper = SimpleNamespace(claims=lambda _: actual, AuthError=ValueError)
                with patch.object(auth.time, "time", return_value=10000), \
                        patch.object(auth, "load_auth_helper", return_value=helper):
                    if defect is None:
                        self.assertEqual(auth.reduced_consumer_functions_token(deployment, consumer),
                                         ("private-token", {"mcp.access"}))
                    else:
                        with self.assertRaises(auth.EvidenceError) as error:
                            auth.reduced_consumer_functions_token(deployment, consumer)
                        self.assertEqual(str(error.exception), "Reduced-scope token metadata invalid: " + defect)

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
        _, _, titles = auth.session_transition_local_titles(auth.session_transition_matrix())
        titles = sorted(titles | {"removing a temporary page route preserves the in-flight context guard"})
        lines = "".join(f"ok {index} - {title}\n" for index, title in enumerate(titles, 1))
        complete = lines + "# tests 13\n# suites 0\n# pass 13\n# fail 0\n"
        cases = [
            (complete, "PASS"),
            (lines + "# tests 12\n# pass 12\n# fail 0\n", "FAIL"),
            (complete + "# fail 1\n", "FAIL"),
            (lines + "# tests 13\n# pass 13\n", "FAIL"),
            ("# tests 13\n# suites 0\n# pass 13\n# fail 0\n", "FAIL"),
            (complete.replace("ok 1 - ", "not ok 1 - ", 1), "FAIL"),
        ]
        for output, status in cases:
            with self.subTest(output=output), patch.object(auth, "command", return_value=output):
                report = auth.Report(Path("."))
                auth.internal_session_browser(report)
                self.assertEqual(report.checks[-1]["status"], status)

    def test_internal_browser_requires_complete_nonduplicated_real_scenarios(self):
        scenarios = [
            "anonymous-gate-no-data", "wrong-category-denied", "pkce-resource-role-owner",
            "resource-server-read", "real-refresh-exchange",
            "renewal-preserves-route", "logout-clears-resource-sessions", "logout-gates-deep-link", "no-business-mutations",
            "renewal-resource-role-owner", "renewed-resource-server-read",
            "same-origin-second-tab-owner", "same-origin-second-tab-resource-read", "no-token-to-untrusted-origin",
            "same-origin-second-tab-signout", "same-user-new-generation-owner",
            "same-user-new-generation-resource-read", "stale-second-tab-no-adoption",
            "concurrent-refresh-success-server-response", "concurrent-refresh-success-stale-response-ignored",
            "concurrent-refresh-success-new-session-read",
            "concurrent-refresh-rejected-server-response", "concurrent-refresh-rejected-stale-response-ignored",
            "concurrent-refresh-rejected-new-session-read",
            "concurrent-functions-success-server-response", "concurrent-functions-success-stale-response-ignored",
            "concurrent-functions-success-new-session-read",
            "concurrent-functions-rejected-server-response", "concurrent-functions-rejected-stale-response-ignored",
            "concurrent-functions-rejected-new-session-read",
            "concurrent-callback-success-server-response", "concurrent-callback-success-stale-response-ignored",
            "concurrent-callback-success-new-session-read",
            "concurrent-callback-rejected-server-response", "concurrent-callback-rejected-stale-response-ignored",
            "concurrent-callback-rejected-new-session-read",
        ]
        checks = [{"name": app + ":" + scenario, "status": "PASS"}
                  for app in ["admin", "manufacturing"] for scenario in scenarios]
        checks.extend({"name": "manufacturing:" + scenario, "status": "PASS"} for scenario in [
            "reorder-progress-current-generation", "reorder-progress-isolated-after-login"])
        checks.extend({"name": "admin:concurrent-mcp-" + mode + "-" + suffix, "status": "PASS"}
                      for mode in ["success", "rejected"]
                      for suffix in ["server-response", "stale-response-ignored", "new-session-read"])
        for scenario, expected in [("complete", "PASS"), ("missing", "FAIL"), ("missing-category", "FAIL"),
                                   ("wrong-category-identity", "FAIL"), ("missing-transition", "FAIL"),
                                   ("missing-race", "FAIL"),
                                   ("missing-race-diagnostic", "FAIL"), ("race-wrong-status", "FAIL"),
                                   ("race-incomplete-handler", "FAIL"), ("race-duplicate-delivery", "FAIL"),
                                   ("race-state-contradiction", "FAIL"),
                                   ("missing-functions-race", "FAIL"), ("missing-functions-read", "FAIL"),
                                   ("functions-read-denied", "FAIL"),
                                   ("missing-callback", "FAIL"), ("callback-wrong-status", "FAIL"),
                                   ("callback-unfinished", "FAIL"), ("callback-duplicate", "FAIL"),
                                   ("missing-mcp-race", "FAIL"), ("mcp-chat-sent", "FAIL"),
                                   ("missing-mcp-read", "FAIL"), ("mcp-read-denied", "FAIL"),
                                   ("missing-login", "FAIL"), ("login-rate-limit", "FAIL"),
                                   ("login-too-fast", "FAIL"),
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
                if scenario == "missing-category":
                    selected = [item for item in selected if item["name"] != "admin:wrong-category-denied"]
                if scenario == "missing-transition":
                    selected = [item for item in selected if item["name"] != "admin:stale-second-tab-no-adoption"]
                if scenario == "missing-race":
                    selected = [item for item in selected
                                if item["name"] != "admin:concurrent-refresh-rejected-stale-response-ignored"]
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
                                       "same-user-new-generation", "concurrent-refresh-success",
                                       "concurrent-refresh-rejected", "concurrent-functions-success",
                                       "concurrent-functions-rejected", "concurrent-callback-success",
                                       "concurrent-callback-rejected"]]
                reads.extend({"site": "admin", "phase": "admin:concurrent-mcp-" + mode,
                              "status": 200, "valid": True, "durationMs": 60, "timeoutMs": 90000,
                              "startupEligible": False, "slow": False} for mode in ["success", "rejected"])
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

                race_diagnostics = []
                for app in ["admin", "manufacturing"]:
                    for mode, status in [("success", 200), ("rejected", 400)]:
                        for event in ["target-refresh-started", "fixture-ready", "response-captured",
                                      "response-delivered", "handler-returned-null"]:
                            item = {"site": app, "mode": mode, "event": event}
                            if event == "response-captured":
                                item["status"] = status
                            race_diagnostics.append(item)
                functions_race_diagnostics = [dict(item) for item in race_diagnostics]
                mcp_race_diagnostics = []
                for mode, status in [("success", 200), ("rejected", 400)]:
                    for event in ["target-refresh-started", "fixture-ready", "response-captured",
                                  "response-delivered", "handler-returned-null", "stale-chat-not-sent"]:
                        item = {"site": "admin", "mode": mode, "event": event}
                        if event == "response-captured":
                            item["status"] = status
                        mcp_race_diagnostics.append(item)
                callback_race_diagnostics = []
                for app in ["admin", "manufacturing"]:
                    for mode, status in [("success", 200), ("rejected", 400)]:
                        for event in ["authorization-code-started", "response-captured",
                                      "response-delivered", "callback-superseded"]:
                            item = {"site": app, "mode": mode, "event": event}
                            if event == "response-captured":
                                item["status"] = status
                            callback_race_diagnostics.append(item)
                functions_reads = [{"site": app, "phase": app + ":concurrent-functions-" + mode,
                                    "status": 200, "valid": True, "durationMs": 60, "timeoutMs": 90000}
                                   for app in ["admin", "manufacturing"] for mode in ["success", "rejected"]]
                functions_reads.extend({"site": "admin", "phase": "admin:concurrent-mcp-" + mode,
                                        "status": 200, "valid": True, "durationMs": 60, "timeoutMs": 90000}
                                       for mode in ["success", "rejected"])
                mcp_reads = [{"site": "admin", "phase": "admin:concurrent-mcp-" + mode,
                              "status": 200, "valid": True, "durationMs": 60, "timeoutMs": 90000}
                             for mode in ["success", "rejected"]]
                login_attempts = [{"site": "admin" if index < 19 else "manufacturing",
                                   "identity": ("manufacturing" if index == 0 else "admin" if index == 19 else
                                                "admin" if index < 19 else "manufacturing"),
                                   "responseAtMs": index * policy["internalLoginMinimumIntervalMs"], "status": 302}
                                  for index in range(34)]
                if scenario == "missing-race-diagnostic":
                    race_diagnostics.pop()
                if scenario == "race-wrong-status":
                    next(item for item in race_diagnostics
                         if item["event"] == "response-captured")["status"] = 400
                if scenario == "race-incomplete-handler":
                    race_diagnostics[-1]["event"] = "handler-returned-other"
                if scenario == "race-duplicate-delivery":
                    next(item for item in race_diagnostics
                         if item["event"] == "response-delivered")["count"] = 2
                if scenario == "race-state-contradiction":
                    race_diagnostics.append({"site": "manufacturing", "mode": "success",
                                             "event": "new-session-changed"})
                if scenario == "missing-functions-race":
                    functions_race_diagnostics.pop()
                if scenario == "missing-functions-read":
                    functions_reads.pop()
                if scenario == "functions-read-denied":
                    functions_reads[-1]["status"] = 403
                if scenario == "missing-callback":
                    selected = [item for item in selected
                                if item["name"] != "admin:concurrent-callback-success-stale-response-ignored"]
                if scenario == "callback-wrong-status":
                    next(item for item in callback_race_diagnostics
                         if item["event"] == "response-captured")["status"] = 400
                if scenario == "callback-unfinished":
                    callback_race_diagnostics.pop()
                if scenario == "callback-duplicate":
                    callback_race_diagnostics[-1] = dict(callback_race_diagnostics[0])
                if scenario == "missing-mcp-race":
                    mcp_race_diagnostics.pop()
                if scenario == "mcp-chat-sent":
                    mcp_race_diagnostics[-1]["event"] = "stale-chat-sent"
                if scenario == "missing-mcp-read":
                    mcp_reads.pop()
                if scenario == "mcp-read-denied":
                    mcp_reads[-1]["status"] = 403
                if scenario == "missing-login":
                    login_attempts.pop()
                if scenario == "wrong-category-identity":
                    login_attempts[0]["identity"] = "admin"
                if scenario == "login-rate-limit":
                    login_attempts[-1]["status"] = 429
                if scenario == "login-too-fast":
                    login_attempts[-1]["responseAtMs"] = login_attempts[-2]["responseAtMs"] + 100

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
                        "raceDiagnostics": race_diagnostics,
                        "functionsRaceDiagnostics": functions_race_diagnostics,
                        "mcpRaceDiagnostics": mcp_race_diagnostics,
                        "callbackRaceDiagnostics": callback_race_diagnostics,
                        "functionsReads": functions_reads,
                        "mcpReads": mcp_reads,
                        "loginAttempts": login_attempts,
                        "navigationResponses": [
                            {"site": "admin", "kind": "document", "status": 503,
                             "private": "private-value-must-not-be-exported"},
                            {"site": "admin", "kind": "private-value-must-not-be-exported", "status": 200},
                        ] if scenario == "process-failure" else [],
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
                    self.assertIn("admin anonymous document HTTP 503", report.checks[-1]["detail"])
                    self.assertNotIn("private-value-must-not-be-exported", report.checks[-1]["detail"])
                if scenario == "anonymous-request":
                    self.assertIn("anonymous API request attempts: manufacturing/functions/GET",
                                  report.checks[-1]["detail"])
                if scenario == "race-state-contradiction":
                    self.assertIn("raceDiagnostics/manufacturing/success/new-session-changed",
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
                                   ("missing-startup", "FAIL"), ("wrong-policy", "FAIL"), ("slow-flag", "FAIL"),
                                   ("missing-login", "FAIL"), ("wrong-login-identity", "FAIL"),
                                   ("login-rate-limit", "FAIL"), ("login-too-fast", "FAIL"),
                                   ("missing-switch", "FAIL"), ("stale-cookie", "FAIL"),
                                   ("stale-accepted", "FAIL"), ("replacement-changed", "FAIL"),
                                   ("replay-cleanup-count", "FAIL"), ("replay-cleanup-status", "FAIL"),
                                   ("old-session-accepted", "FAIL"), ("old-backend-accepted", "FAIL"),
                                   ("switch-invalid-types", "FAIL"), ("callback-not-intercepted", "FAIL"),
                                   ("authorize-not-redirected", "FAIL"), ("login-not-redirected", "FAIL"),
                                   ("diagnostic-run", "FAIL")]:
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
                interval = policy["internalLoginMinimumIntervalMs"]
                attempts = [{"identity": identity, "submittedAtMs": index * (interval + 100),
                             "responseAtMs": index * (interval + 100) + 100, "status": 302}
                            for index, identity in enumerate(
                                ["manufacturing", "admin", "manufacturing", "manufacturing", "admin"])]
                if scenario == "missing-login":
                    attempts.pop()
                if scenario == "wrong-login-identity":
                    attempts[2]["identity"] = "admin"
                if scenario == "login-rate-limit":
                    attempts[-1]["status"] = 429
                if scenario == "login-too-fast":
                    attempts[-1]["submittedAtMs"] -= 1
                switch = {
                    "loginStatus": 302, "browserLoginStatus": 200, "authorizeStatus": 302,
                    "callbackIntercepted": True,
                    "oldFlowCaptured": True, "staleStatus": 403, "staleError": "invalid_oauth_state",
                    "staleSetCookie": False, "replayCleanupCount": 1, "replayCleanupStatus": 303,
                    "replacementPreserved": True, "oldSessionStatus": 401,
                    "oldBackendStatus": 403, "oldBackendError": "session_not_owned",
                }
                if scenario == "missing-switch":
                    switch = None
                if scenario == "stale-cookie":
                    switch["staleSetCookie"] = True
                if scenario == "stale-accepted":
                    switch["staleStatus"] = 303
                if scenario == "replacement-changed":
                    switch["replacementPreserved"] = False
                if scenario == "replay-cleanup-count":
                    switch["replayCleanupCount"] = 0
                if scenario == "replay-cleanup-status":
                    switch["replayCleanupStatus"] = 500
                if scenario == "old-session-accepted":
                    switch["oldSessionStatus"] = 200
                if scenario == "old-backend-accepted":
                    switch["oldBackendStatus"] = 200
                if scenario == "switch-invalid-types":
                    switch["oldFlowCaptured"] = 1
                if scenario == "callback-not-intercepted":
                    switch["callbackIntercepted"] = False
                if scenario == "authorize-not-redirected":
                    switch["authorizeStatus"] = 200
                if scenario == "login-not-redirected":
                    switch["loginStatus"] = 200

                def command(arguments, *, environment, timeout):
                    self.assertEqual(arguments[:2], ["node", "tests/scripts/test-inspector-browser-auth.mjs"])
                    self.assertEqual(environment["AUTH_BROWSER_MANUFACTURING_EMAIL"], "engineer@example.invalid")
                    self.assertEqual(environment["AUTH_BROWSER_ADMIN_EMAIL"], "admin@example.invalid")
                    self.assertEqual(timeout, 1200)
                    (root / "inspector-browser.json").write_text(json.dumps({
                        "phase": "complete", "checks": checks, "blockedMutations": 1 if scenario == "mutation" else 0,
                        "diagnosticOnly": scenario == "diagnostic-run",
                        "startupRead": startup, "policy": {} if scenario == "wrong-policy" else policy,
                        "loginAttempts": attempts, "switchEvidence": switch,
                        "dabUiDiagnostics": {"targetInputMatches": True, "targetConnectError": True,
                                             "private": "do-not-export"},
                        "proxyResponses": [
                            {"endpoint": "mcp", "target": "dab", "status": 504, "private": "do-not-export"},
                            {"endpoint": "mcp", "target": "do-not-export", "status": 200},
                        ],
                    }))
                    if scenario == "failed":
                        raise auth.EvidenceError("Browser failed after writing partial evidence")
                    return ""

                with patch.object(auth, "load_auth_helper", return_value=helper), \
                        patch.object(auth, "command", side_effect=command):
                    auth.inspector_browser(report, deployment)
                self.assertEqual(report.checks[-1]["status"], expected)
                if scenario == "failed":
                    self.assertIn("targetConnectError=True", report.checks[-1]["detail"])
                    self.assertIn("dab proxy HTTP 504", report.checks[-1]["detail"])
                    self.assertNotIn("do-not-export", report.checks[-1]["detail"])

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
            ("SupplyChainGetVendors", "supply/vendors", ["GET"]),
            ("SupplyChainGetVendor", "supply/vendors/{vendorId}", ["GET"]),
            ("SupplyChainGetCatalog", "supply/catalog", ["GET"]),
            ("SupplyChainGetCatalogByProduct", "supply/catalog/{productId:int}", ["GET"]),
            ("SupplyChainGetQuote", "supply/quote", ["GET"]),
            ("PlanFeasibility", "plan/feasibility/{productId:int}", ["GET"]),
            ("PlanFeasibilityAll", "plan/feasibility", ["GET"]),
            ("PlanReorderRecommendations", "plan/reorder-recommendations", ["GET"]),
            ("ManufacturingWorkforce", "manufacturing/workforce", ["GET"]),
            ("ManufacturingWorkforceDetail", "manufacturing/workforce/detail", ["GET"]),
            ("GetManufacturingAgentConfig", "manufacturing/agent-config", ["GET"]),
            ("GetManufacturingProposals", "manufacturing/proposals", ["GET"]),
            ("GetVerifiedReviewsStatus", "generate-verified-reviews/status", ["GET"]),
            ("ReviewModeration_Status", "reviews/moderation/status", ["GET"]),
            ("WarehouseStatus", "warehouse/status", ["GET"]),
            ("WarehouseWorkforce", "warehouse/workforce", ["GET"]),
            ("WarehouseGetDamageConfig", "warehouse/damage-config", ["GET"]),
            ("WarehouseGetSubcategoryConfig", "warehouse/subcategory-config", ["GET"]),
            ("WarehouseGetSupplierReceiveConfig", "warehouse/supplier-receive-config", ["GET"]),
            ("BankGetStatus", "bank/status", ["GET"]),
            ("BankGetAccounts", "bank/accounts", ["GET"]),
            ("FinancialSummary", "financials/summary", ["GET"]),
            ("FinancialProcurement", "financials/procurement", ["GET"]),
            ("FinancialManufacturing", "financials/manufacturing", ["GET"]),
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

    def test_illustration_export_denials_require_the_exact_reviewed_mixed_method_binding(self):
        function = {
            "Name": "ExportManufacturingIllustrations", "Route": "manufacturing/illustrations/export",
            "Methods": ["GET", "POST"], "Policy": {"IsAnonymous": False},
        }
        for defect in [None, "route", "methods", "anonymous"]:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                report = auth.Report(Path(directory))
                entry = copy.deepcopy(function)
                if defect == "route":
                    entry["Route"] += "/changed"
                elif defect == "methods":
                    entry["Methods"].append("DELETE")
                elif defect == "anonymous":
                    entry["Policy"]["IsAnonymous"] = True
                report.inventory["functions"] = [entry]
                obligations = auth.function_denial_obligations(report, "https://functions.example.invalid")
                if defect is None:
                    self.assertEqual(len(obligations), 4)
                    posts = [item for item in obligations if item[1] == "POST"]
                    self.assertEqual(len(posts), 2)
                    self.assertTrue(all(item[4] == auth.illustration_export_fixture() for item in posts))
                else:
                    self.assertEqual(obligations, [])

    def test_reviewed_read_contract_rejects_malformed_method_bindings(self):
        for binding in [
                {"route": "manufacturing/illustrations/export", "methods": ["POST"]},
                {"route": "manufacturing/illustrations/export", "methods": ["GET", "GET"]},
                {"route": "manufacturing/illustrations/export", "methods": ["GET", 1]},
                {"route": "../unsafe", "methods": ["GET", "POST"]},
                {"route": "manufacturing/illustrations/export", "methods": ["GET"], "extra": True},
        ]:
            with self.subTest(binding=binding), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "contracts.json"
                path.write_text(json.dumps({"safeFunctionReadRoutes": {"Export": binding}}))
                with patch.object(auth, "CONTRACTS", path), self.assertRaises(auth.EvidenceError):
                    auth.reviewed_function_read_routes()

    def test_function_get_review_closure_detects_unclassified_and_stale_routes(self):
        safe = {"Name": "ReadOnly", "Route": "read", "Methods": ["GET"], "Policy": {"IsAnonymous": False}}
        effect = {"Name": "Effect", "Route": "effect", "Methods": ["GET"], "Policy": {"IsAnonymous": False}}
        new = {"Name": "NewRead", "Route": "new", "Methods": ["GET"], "Policy": {"IsAnonymous": False}}
        document = {"safeFunctionReadRoutes": {"ReadOnly": "read"},
                    "sideEffectingFunctionReads": {"Effect": {"route": "effect", "reason": "seeds table rows"}}}
        for functions, expected in [([safe, effect], "PASS"), ([safe, effect, new], "FAIL"), ([safe], "FAIL")]:
            with self.subTest(names=[item["Name"] for item in functions]), \
                    tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "contracts.json"
                path.write_text(json.dumps(document))
                report = auth.Report(Path(directory) / "out")
                report.inventory["functions"] = functions
                with patch.object(auth, "CONTRACTS", path):
                    auth.function_get_review_closure(report)
                    obligations = auth.function_denial_obligations(report, "https://functions.example.invalid")
                self.assertEqual(report.checks[0]["status"], expected)
                if expected == "PASS":
                    self.assertEqual({item[0].split(":")[1] for item in obligations}, {"ReadOnly"})
                    blocked = next(item for item in report.checks if item["id"] == "functions:Effect:GET:deny")
                    self.assertIn("seeds table rows", blocked["detail"])

    def test_side_effecting_read_contract_rejects_overlap_and_malformed_entries(self):
        for entry in [{"route": "read", "reason": "seeds table rows"}, {"route": "effect"},
                      {"route": "/effect", "reason": "seeds table rows"},
                      {"route": "effect", "reason": "short"}]:
            name = "ReadOnly" if entry.get("route") == "read" else "Effect"
            with self.subTest(entry=entry), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "contracts.json"
                path.write_text(json.dumps({"safeFunctionReadRoutes": {"ReadOnly": "read"},
                                            "sideEffectingFunctionReads": {name: entry}}))
                with patch.object(auth, "CONTRACTS", path), self.assertRaises(auth.EvidenceError):
                    auth.side_effecting_function_reads()

    def test_illustration_export_fixture_rejects_malformed_input(self):
        for fixture in [
                [], [{"illustrationId": True, "diagram": "<x/>"}],
                [{"illustrationId": 2, "diagram": "<x/>"}],
                [{"illustrationId": 1, "diagram": ""}],
                [{"illustrationId": 1, "diagram": "x" * 2049}],
                [{"illustrationId": 1, "diagram": "<x/>", "extra": 1}],
        ]:
            with self.subTest(fixture=fixture), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "contracts.json"
                path.write_text(json.dumps({"illustrationExportProbe": fixture}))
                with patch.object(auth, "CONTRACTS", path), self.assertRaises(auth.EvidenceError):
                    auth.illustration_export_fixture()

    def test_illustration_export_post_requires_positive_and_exact_scope_controls(self):
        function = {
            "Name": "ExportManufacturingIllustrations", "Route": "manufacturing/illustrations/export",
            "Methods": ["GET", "POST"],
            "Policy": {"IsAnonymous": False, "RequiredScope": "manufacturing.read"},
        }
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.invalid",
            "API_MCP_URL": "https://oauth.example.invalid/mcp",
        }[key])
        metadata = "https://oauth.example.invalid/.well-known/oauth-protected-resource"
        response = json.dumps({"illustrations": [{
            "illustrationId": 1, "fileName": "illustration-1.svg",
            "svg": ('<svg xmlns="http://www.w3.org/2000/svg">'
                    '<path d="M 0,0 L 10,10" stroke="#000000"/></svg>'),
        }]}).encode()
        empty_svg = json.dumps({"illustrations": [{
            "illustrationId": 1, "fileName": "illustration-1.svg",
            "svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
        }]}).encode()
        denied = json.dumps({
            "error": "insufficient_scope",
            "error_description": "The token is missing the required scope 'manufacturing.read'.",
        }).encode()
        challenge = (f'Bearer resource_metadata="{metadata}", error="insufficient_scope", '
                     'scope="manufacturing.read"')
        invalid_token = json.dumps({
            "error": "invalid_token", "error_description": "The access token is invalid.",
        }).encode()
        invalid_challenge = f'Bearer resource_metadata="{metadata}", error="invalid_token"'
        for scenario in ["complete", "invalid-positive", "missing-positive-path", "invalid-get",
                         "wrong-audience-challenge", "wrong-scope-challenge"]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                report = auth.Report(Path(directory))
                report.inventory["functions"] = [function]
                positive = b'{}' if scenario == "invalid-positive" else (
                    empty_svg if scenario == "missing-positive-path" else response)
                responses = [
                    (200, {}, positive),
                    (200, {}, b'{}' if scenario == "invalid-get" else response),
                    (401, {"WWW-Authenticate": "" if scenario == "wrong-audience-challenge" else invalid_challenge},
                     invalid_token),
                    (403, {"WWW-Authenticate": "" if scenario == "wrong-scope-challenge" else challenge}, denied),
                ]
                with patch.object(auth, "http", side_effect=responses) as http, \
                        patch.object(auth, "reduced_consumer_functions_token",
                                     return_value=("reduced", {"mcp.access"})):
                    if scenario in {"invalid-positive", "missing-positive-path"}:
                        with self.assertRaises(auth.EvidenceError):
                            auth.illustration_export_authorization(
                                report, deployment, {"functions": "manufacturing", "dab": "dab"}, object())
                        self.assertEqual(http.call_count, 1)
                    elif scenario == "invalid-get":
                        with self.assertRaises(auth.EvidenceError):
                            auth.illustration_export_authorization(
                                report, deployment, {"functions": "manufacturing", "dab": "dab"}, object())
                        self.assertEqual(http.call_count, 2)
                    else:
                        auth.illustration_export_authorization(
                            report, deployment, {"functions": "manufacturing", "dab": "dab"}, object())
                        self.assertEqual([call.args[0] for call in http.call_args_list],
                                         ["POST", "GET", "POST", "POST"])
                        self.assertTrue(all(call.kwargs["data"] == auth.illustration_export_fixture()
                                            for call in http.call_args_list if call.args[0] == "POST"))
                statuses = {check["id"]: check["status"] for check in report.checks}
                if scenario == "complete":
                    self.assertEqual(set(statuses.values()), {"PASS"})
                elif scenario in {"invalid-positive", "missing-positive-path"}:
                    self.assertEqual(statuses["illustration-export:post:authorized"], "FAIL")
                elif scenario == "invalid-get":
                    self.assertEqual(statuses["illustration-export:get:authorized"], "FAIL")
                elif scenario == "wrong-audience-challenge":
                    self.assertEqual(statuses["illustration-export:post:wrong-audience"], "FAIL")
                else:
                    self.assertEqual(statuses["illustration-export:post:reduced-scope"], "FAIL")

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
        for defect in ["missing-control", "failed-control", "scope", "category", "owner", "audience",
                       "audience-extra", "expiry",
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
                elif defect == "audience-extra":
                    claims["aud"] = ["https://mcp.example.invalid/functions", "https://other.example.invalid"]
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
                                  "audience", "audience-extra", "expiry"}:
                        with self.assertRaises(auth.EvidenceError):
                            auth.functions_scope_read_denials(report, deployment, consumer)
                        http.assert_not_called()
                    else:
                        auth.functions_scope_read_denials(report, deployment, consumer)
                        http.assert_called_once()
                        self.assertEqual(report.checks[-1]["status"],
                                         "BLOCKED" if defect in {"server", "transport"} else "FAIL")
                self.assertNotIn("SENTINEL-PRIVATE", json.dumps(report.checks))

    def test_reduced_functions_token_accepts_a_singleton_audience_array(self):
        audience = "https://mcp.example.invalid/functions"
        deployment = SimpleNamespace(values={}, required=lambda _: "https://mcp.example.invalid/mcp")
        claims = {
            "aud": [audience], "category": "consumer", "business_entity_id": "7",
            "scope": "mcp.access", "exp": int(auth.time.time()) + 600,
        }
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        token = "header." + payload + ".signature"
        consumer = SimpleNamespace(business_id=7, token=lambda resource, scopes: token)
        self.assertEqual(auth.reduced_consumer_functions_token(deployment, consumer), (token, {"mcp.access"}))

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

    def test_email_role_requires_the_exact_builtin_at_the_communication_resource(self):
        scope = "/subscriptions/test/resourceGroups/demo/providers/Microsoft.Communication/communicationServices/comms"
        rule = json.loads(auth.CONTRACTS.read_text())["runtimeEmailRole"]
        block = {"actions": ["Microsoft.Communication/CommunicationServices/write",
                             "Microsoft.Communication/CommunicationServices/ListKeys/action"],
                 "notActions": [], "dataActions": [], "notDataActions": []}
        definition = {"name": rule["roleDefinitionId"], "roleName": rule["roleName"], "permissions": [block]}
        assignment = {"roleDefinitionId": "/roles/" + rule["roleDefinitionId"],
                      "roleDefinitionName": rule["roleName"], "scope": scope, "principalId": "runtime"}
        self.assertTrue(auth.reviewed_email_sender(definition, assignment, scope, "runtime"))
        for drift in [{**block, "actions": block["actions"] + ["Microsoft.Authorization/roleAssignments/write"]},
                      {**block, "actions": ["*"]}, {**block, "dataActions": ["Microsoft.Communication/*"]},
                      {**block, "actions": []}]:
            with self.subTest(drift=drift):
                self.assertFalse(auth.reviewed_email_sender(
                    {**definition, "permissions": [drift]}, assignment, scope, "runtime"))
        for key, value in [("scope", scope.rsplit("/providers/", 1)[0]), ("principalId", "other"),
                           ("condition", "unknown"), ("conditionVersion", "2.0"),
                           ("roleDefinitionId", "/roles/owner"),
                           ("roleDefinitionName", "Owner")]:
            with self.subTest(key=key):
                self.assertFalse(auth.reviewed_email_sender(definition, {**assignment, key: value}, scope, "runtime"))
        for key, value in [("name", "owner"), ("roleName", "Owner")]:
            with self.subTest(key=key):
                self.assertFalse(auth.reviewed_email_sender({**definition, key: value}, assignment, scope, "runtime"))

    def test_deployer_role_allowlist_matches_infrastructure_role_assignments(self):
        contracts = json.loads(auth.CONTRACTS.read_text())
        allowlist_path = auth.ROOT / "infra/azd-role-assignment-allowlist.json"
        allowlist = json.loads(allowlist_path.read_text())["roleDefinitionIds"]
        self.assertCountEqual(contracts["azdRoleAssignmentAllowlist"], allowlist.values())

        allowed_ids = {value.lower() for value in allowlist.values()}
        privileged = {value.lower() for value in contracts["azdPrivilegedRoleDefinitionIds"].values()}
        self.assertFalse(allowed_ids & privileged)

        deployer = json.loads((auth.ROOT / "infra/azd-deployer-role.json").read_text())
        self.assertCountEqual(deployer["Actions"], [
            "Microsoft.Authorization/roleAssignments/write", "Microsoft.Authorization/roleAssignments/delete"])
        self.assertEqual([deployer[key] for key in ["NotActions", "DataActions", "NotDataActions"]], [[], [], []])

        guid = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
        referenced = set()
        bicep_files = list((auth.ROOT / "infra").rglob("*.bicep"))
        self.assertTrue(bicep_files)
        for path in bicep_files:
            text = path.read_text()
            with self.subTest(bicep=path.name):
                self.assertNotRegex(text, r"'Microsoft\.Authorization/roleDefinitions@")
                variables = dict(re.findall(r"var\s+(\w+)\s*=\s*'(" + guid + ")'", text, re.IGNORECASE))
                references = re.findall(r"roleDefinitionId(?:OrName)?:\s*(.+)", text)
                for reference in references:
                    literal = re.search(r"'(" + guid + ")'", reference, re.IGNORECASE)
                    variable = re.search(r"roleDefinitions',\s*(\w+)\)", reference)
                    name = re.fullmatch(r"'([^']+)'\s*", reference)
                    if literal:
                        referenced.add(literal.group(1).lower())
                    elif variable and variable.group(1) in variables:
                        referenced.add(variables[variable.group(1)].lower())
                    elif name and name.group(1) in allowlist:
                        referenced.add(allowlist[name.group(1)].lower())
                    else:
                        self.fail(f"Unresolved or unallowlisted role reference in {path.name}: {reference}")

        hooks = list((auth.ROOT / "scripts/hooks").glob("*.sh"))
        for path in hooks:
            text = path.read_text()
            with self.subTest(hook=path.name):
                self.assertNotRegex(text, r"az\s+role\s+definition\s+(create|update)")
                for role in re.findall(r"--role\s+\"([^\"$]+)\"", text):
                    referenced.add(allowlist[role].lower() if role in allowlist else role.lower())
                for role in re.findall(r"ensure_project_role\s+\"\$\w+\"\s+\w+\s+\"(" + guid + ")\"", text,
                                       re.IGNORECASE):
                    referenced.add(role.lower())
                for loop in re.findall(r"for\s+_\w*role\w*\s+in\s+([^;]+);", text):
                    referenced.update(item.lower() for item in re.findall(guid, loop, re.IGNORECASE))
        self.assertTrue(referenced)
        self.assertLessEqual(referenced, allowed_ids)
        self.assertEqual(allowed_ids - referenced, set(), "Remove allowlisted roles that nothing assigns")

    def test_reviewed_builtin_data_roles_fail_on_permission_drift(self):
        contracts = json.loads(auth.CONTRACTS.read_text())
        for key in ["runtimeWebPubSubRole", "runtimeFoundryDataRole"]:
            rule = contracts[key]
            block = {"actions": [], "notActions": [], "dataActions": list(rule["dataActions"]), "notDataActions": []}
            with self.subTest(role=key):
                self.assertTrue(auth.builtin_role_shape_matches({"permissions": [block]}, rule))
                for drift in [{**block, "actions": ["Microsoft.CognitiveServices/accounts/listKeys/action"]},
                              {**block, "dataActions": block["dataActions"] + ["*"]},
                              {**block, "condition": "x"}]:
                    self.assertFalse(auth.builtin_role_shape_matches({"permissions": [drift]}, rule))
                self.assertFalse(auth.builtin_role_shape_matches({"permissions": [block, block]}, rule))
                self.assertFalse(auth.builtin_role_shape_matches({}, rule))

    def test_azd_principal_assignments_must_use_the_deployer_allowlist(self):
        group = "/subscriptions/s/resourceGroups/rg"
        allow = ["acdd72a7-3385-48ef-bd42-f606fba81ae7"]

        def item(principal, role, scope, name="Role"):
            return {"principalId": principal, "roleDefinitionId": "/roles/" + role,
                    "roleDefinitionName": name, "scope": scope}

        clean = [item("runtime", allow[0], group + "/providers/x/y/z"),
                 item("deployer", allow[0].upper(), group),
                 item("other", "8e3af657-a8ff-443c-a75c-2fe8c4bcb635", group),
                 item("runtime", "8e3af657-a8ff-443c-a75c-2fe8c4bcb635", "/subscriptions/s"),
                 item("runtime", "8e3af657-a8ff-443c-a75c-2fe8c4bcb635", group + "-other")]
        self.assertEqual(auth.azd_role_assignment_violations(clean, group, ["RUNTIME", "deployer"], allow), [])
        bad = clean + [item("deployer", "8e3af657-a8ff-443c-a75c-2fe8c4bcb635", group + "/providers/a/b/c", "Owner")]
        self.assertEqual(auth.azd_role_assignment_violations(bad, group, ["runtime", "deployer"], allow),
                         ["Owner at /providers/a/b/c"])
        with self.assertRaises(auth.EvidenceError):
            auth.azd_role_assignment_violations(["bad"], group, ["runtime"], allow)

    def test_template_custom_roles_are_detected_only_when_scoped_to_the_selected_group(self):
        group = "/subscriptions/s/resourceGroups/rg"
        definitions = [
            {"roleType": "CustomRole", "roleName": "tenant", "assignableScopes": ["/subscriptions/s"]},
            {"roleType": "CustomRole", "roleName": "mixed", "assignableScopes": [group, "/subscriptions/s"]},
            {"roleType": "BuiltInRole", "roleName": "Reader", "assignableScopes": [group]},
            {"roleType": "CustomRole", "roleName": "sibling", "assignableScopes": [group + "2"]},
            {"roleType": "CustomRole", "roleName": "demo", "assignableScopes": [group + "/providers/a/b/c"]},
        ]
        self.assertEqual(auth.demo_custom_role_definitions(definitions, group), ["demo"])

    @staticmethod
    def _deployer_condition(roles, service_principal_only=False):
        def clause(source):
            text = (f"@{source}[Microsoft.Authorization/roleAssignments:RoleDefinitionId] "
                    f"ForAnyOfAnyValues:GuidEquals {{{', '.join(roles)}}}")
            if service_principal_only:
                text += (f" AND @{source}[Microsoft.Authorization/roleAssignments:PrincipalType] "
                         "ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'}")
            return text
        return ("((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (" + clause("Request") +
                ")) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (" +
                clause("Resource") + "))")

    def test_deployer_condition_parser_accepts_only_the_reviewed_shape(self):
        roles = ["acdd72a7-3385-48ef-bd42-f606fba81ae7", "BA92F5B4-2D11-453D-A403-E96B0029C9FE"]
        expected = {item.lower() for item in roles}
        for service_principal_only in [False, True]:
            parsed = auth.parse_role_assignment_condition(self._deployer_condition(roles, service_principal_only))
            self.assertEqual(parsed, {action: {"roles": expected, "servicePrincipalOnly": service_principal_only}
                                      for action in ["write", "delete"]})
        good = self._deployer_condition(roles)
        for bad in [None, "", good.replace("@Resource", "@Request"),
                    good + " OR (true)",
                    good.replace("ForAnyOfAnyValues:GuidEquals", "ForAnyOfAnyValues:GuidNotEquals"),
                    good.replace("{" + ", ".join(roles) + "}", "{}"),
                    good.replace("roleAssignments/delete", "roleAssignments/write"),
                    good.replace(")) AND ((", ")) OR ((")]:
            with self.subTest(bad=bad and bad[-40:]):
                self.assertIsNone(auth.parse_role_assignment_condition(bad))

    def test_deployer_access_management_requires_conditioned_authority(self):
        rules = json.loads(auth.CONTRACTS.read_text())["azdDeployerAccessManagement"]
        allow = ["acdd72a7-3385-48ef-bd42-f606fba81ae7", "ba92f5b4-2d11-453d-a403-e96b0029c9fe"]
        rbac_admin = rules["conditionedRoleDefinitionIds"][0]
        custom_role = "custom-guid"

        def grant(role, name, condition=None, principal="sp", scope="/subscriptions/s"):
            return {"principalId": principal, "principalType": "Group" if principal.startswith("group") else "ServicePrincipal",
                    "roleDefinitionId": "/x/roleDefinitions/" + role,
                    "roleDefinitionName": name, "scope": scope, "condition": condition}

        def definition(role, name, actions=()):
            return {"name": role, "roleName": name, "roleType": "CustomRole",
                    "permissions": [{"actions": list(actions), "notActions": [],
                                     "dataActions": [], "notDataActions": []}]}

        definitions = [
            definition(rbac_admin, "Role Based Access Control Administrator"),
            definition(custom_role, rules["customRoleName"], [
                "Microsoft.Authorization/roleAssignments/write",
                "Microsoft.Authorization/roleAssignments/delete"]),
            definition("b24988ac-6180-42a0-ab88-20f7382dd24c", "Contributor", ["Microsoft.Compute/*"]),
            definition("unreviewed", "Unreviewed Role", ["Microsoft.Authorization/roleAssignments/*"]),
        ]

        def classify(items, principal_type="ServicePrincipal"):
            return auth.deployer_access_management(items, "s", allow, rules, principal_type, definitions)

        conditioned = self._deployer_condition(allow, service_principal_only=True)
        contributor = grant("b24988ac-6180-42a0-ab88-20f7382dd24c", "Contributor")
        result = classify([contributor, grant(rbac_admin, "Role Based Access Control Administrator", conditioned)])
        self.assertEqual((result["violations"], result["conditionedBuiltIn"]), ([], True))
        group_owner = grant("8e3af657-a8ff-443c-a75c-2fe8c4bcb635", "Owner", principal="group-admin")
        self.assertIn("Owner", classify([group_owner])["violations"][0])
        group_grant = grant(custom_role, rules["customRoleName"], self._deployer_condition(allow),
                            principal="group-assigned")
        custom = grant(custom_role, rules["customRoleName"], self._deployer_condition(allow))
        user = classify([custom], "User")
        self.assertEqual((user["violations"], user["conditioned"], user["conditionedBuiltIn"]),
                         ([], [rules["customRoleName"]], False))
        self.assertEqual(classify([group_grant], "User")["conditioned"], [rules["customRoleName"]])
        inherited = grant(rbac_admin, "Role Based Access Control Administrator", conditioned,
                          scope="/providers/Microsoft.Management/managementGroups/parent")
        self.assertIn("not scoped to the selected subscription",
                      classify([inherited])["violations"][0])
        self.assertEqual(classify([contributor]), {
            "conditioned": [], "violations": [], "blocked": [], "conditionedBuiltIn": False})
        for label, item, principal_type in [
                ("unconditioned", grant(rbac_admin, "RBAC Admin"), "ServicePrincipal"),
                ("not SP-only", grant(rbac_admin, "RBAC Admin", self._deployer_condition(allow)), "ServicePrincipal"),
                ("extra role", grant(rbac_admin, "RBAC Admin", self._deployer_condition(
                    allow + ["8e3af657-a8ff-443c-a75c-2fe8c4bcb635"], True)), "ServicePrincipal"),
                ("missing role", grant(rbac_admin, "RBAC Admin", self._deployer_condition(allow[:1])), "User"),
                ("owner", grant("8e3af657-a8ff-443c-a75c-2fe8c4bcb635", "Owner"), "User"),
                ("uaa", grant("18d7d88d-d35e-4fb5-a5c3-7773c20a72d9", "UAA", conditioned), "ServicePrincipal")]:
            with self.subTest(label):
                self.assertTrue(classify([item], principal_type)["violations"])
        unsafe_custom = grant("unreviewed", "Unreviewed Role")
        unsafe = classify([unsafe_custom])
        self.assertIn("unreviewed role-assignment authority", unsafe["violations"][0])
        wrong_documented_shape = definition(custom_role, rules["customRoleName"], [
            "Microsoft.Authorization/roleAssignments/write", "Microsoft.Authorization/*"])
        unsafe = auth.deployer_access_management(
            [custom], "s", allow, rules, "User", definitions + [wrong_documented_shape])
        self.assertIn("definition differs", unsafe["violations"][0])
        unverifiable = classify([grant("missing-definition", "Missing role")])
        self.assertTrue(unverifiable["blocked"])
        self.assertTrue(auth.role_definition_assignment_authority(
            definition("wildcard", "Wildcard", ["Microsoft.Authorization/*"])))
        self.assertFalse(auth.role_definition_assignment_authority(
            {**definition("excluded", "Excluded", ["Microsoft.Authorization/*"]),
             "permissions": [{"actions": ["Microsoft.Authorization/*"],
                              "notActions": ["Microsoft.Authorization/roleAssignments/*"]}]}))
        with self.assertRaises(auth.EvidenceError):
            classify(["bad"])

    def test_assignee_principal_types_match_the_declared_deployer_type(self):
        group = "/subscriptions/s/resourceGroups/rg"

        def item(principal, kind, scope=group):
            return {"principalId": principal, "principalType": kind, "roleDefinitionName": "Role", "scope": scope}

        expected = {"runtime": "ServicePrincipal", "deployer": "ServicePrincipal"}
        clean = [item("RUNTIME", "ServicePrincipal"), item("deployer", "ServicePrincipal", group + "/x"),
                 item("deployer", "User", "/subscriptions/s"), item("other", "User")]
        self.assertEqual(auth.assignee_principal_type_mismatches(clean, group, expected), [])
        self.assertEqual(auth.assignee_principal_type_mismatches(clean + [item("deployer", "User")], group, expected),
                         ["Role assigned as User"])

    def test_documented_deployer_conditions_match_the_allowlist(self):
        allow = {item.lower() for item in json.loads(
            (auth.ROOT / "infra/azd-role-assignment-allowlist.json").read_text())["roleDefinitionIds"].values()}
        joined = ", ".join(sorted(allow))
        sources = {
            "docs/AZD_DEPLOYER_PERMISSIONS.md": False,
            ".github/workflows/README.md": True,
        }
        for relative, service_principal_only in sources.items():
            text = (auth.ROOT / relative).read_text()
            found = re.findall(r'(?:CONDITION="|--condition ")(\(\(!\(ActionMatches[^"]+)"', text)
            self.assertTrue(found, relative)
            for condition in found:
                with self.subTest(source=relative, condition=condition[-30:]):
                    parsed = auth.parse_role_assignment_condition(condition.replace("$ROLE_IDS", joined))
                    self.assertIsNotNone(parsed)
                    for clause in parsed.values():
                        self.assertEqual(clause["roles"], allow)
                        self.assertEqual(clause["servicePrincipalOnly"], service_principal_only)
        readme = (auth.ROOT / "infra/README.md").read_text()
        block = re.search(r"```text\n(\(\(!\(ActionMatches.*?)```", readme, re.S).group(1)
        parsed = auth.parse_role_assignment_condition(" ".join(block.replace("<allowlisted GUIDs>", joined).split()))
        self.assertEqual({action: clause["roles"] for action, clause in parsed.items()},
                         {"write": allow, "delete": allow})

    def test_service_principal_deployment_path_keeps_its_conditioned_grant_contract(self):
        readme = (auth.ROOT / ".github/workflows/README.md").read_text()
        grant = re.search(r"az role assignment create[^\n]*\\\n(?:[^\n]*\\\n)*[^\n]*--condition \"\$CONDITION\""
                          r"[^\n]*", readme)
        self.assertIsNotNone(grant)
        self.assertIn("--role f58310d9-a9f6-439a-9e8d-f62e7b41a168", grant.group(0))
        self.assertIn("--condition-version 2.0", grant.group(0))
        self.assertIn("--assignee-principal-type ServicePrincipal", grant.group(0))
        self.assertNotIn("roleDefinitionIds[]", readme)
        inlined = re.search(r"ALLOWED_ROLE_IDS=\(\n(.*?)\n\)", readme, re.S)
        self.assertIsNotNone(inlined)
        inlined_ids = [line.split("#")[0].strip().lower() for line in inlined.group(1).splitlines()]
        allow = {item.lower() for item in json.loads(
            (auth.ROOT / "infra/azd-role-assignment-allowlist.json").read_text())["roleDefinitionIds"].values()}
        self.assertEqual(len(inlined_ids), len(set(inlined_ids)))
        self.assertEqual(set(inlined_ids), allow)
        self.assertIn("ROLE_IDS=$(printf '%s, ' \"${ALLOWED_ROLE_IDS[@]}\")", readme)
        workflow = (auth.ROOT / ".github/workflows/azd-up-service-principal.yml").read_text()
        self.assertIn('azd env set OBJECT_ID "$DEPLOYER_OBJECT_ID"', workflow)
        self.assertIn("azd env set DEPLOYER_PRINCIPAL_TYPE ServicePrincipal", workflow)
        steps = {step.get("name"): step for step in yaml.safe_load(workflow)["jobs"]["deploy"]["steps"]}
        validate_step = steps["Validate authentication infrastructure (read-only)"]
        upload_step = steps["Upload authentication infrastructure report"]
        self.assertEqual(validate_step["if"], "${{ inputs.validate_auth_infra }}")
        self.assertIn("always() && inputs.validate_auth_infra", upload_step["if"])
        self.assertEqual(upload_step["with"]["path"], ".auth-results/ci-infra/summary.md")
        invocations = re.findall(r"validate-auth\.sh([^\n]*\\\n[^\n]*)", validate_step["run"])
        self.assertEqual(len(invocations), 1)
        self.assertIn("--infra --environment", invocations[0])
        self.assertNotIn("canary", invocations[0])
        self.assertIn("report.json", validate_step["run"])
        self.assertNotIn("report.json", upload_step["with"]["path"])
        self.assertNotIn("['detail']", validate_step["run"])
        self.assertNotIn("['inventory']", validate_step["run"])
        self.assertIs(yaml.safe_load(workflow)[True]["workflow_dispatch"]["inputs"]["validate_auth_infra"]["default"],
                      False)
        self.assertEqual(json.loads((auth.ROOT / "infra/main.parameters.json").read_text())
                         ["parameters"]["deployerPrincipalType"]["value"], "${DEPLOYER_PRINCIPAL_TYPE:-User}")
        rules = json.loads(auth.CONTRACTS.read_text())["azdDeployerAccessManagement"]
        self.assertEqual(rules["conditionedRoleDefinitionIds"],
                         [json.loads(auth.CONTRACTS.read_text())["azdPrivilegedRoleDefinitionIds"]
                          ["Role Based Access Control Administrator"]])
        self.assertEqual(rules["customRoleName"],
                         json.loads((auth.ROOT / "infra/azd-deployer-role.json").read_text())["Name"])
        assignment_query = (auth.ROOT / "tests/auth/validate.py").read_text().split(
            "effective_deployer_assignments = d.azure(", 1)[1].split(
            "if not isinstance(effective_deployer_assignments, list)", 1)[0]
        for flag in ['"--include-inherited"', '"--include-groups"', '"--assignee"']:
            self.assertIn(flag, assignment_query)

    def test_every_role_assignment_declares_a_principal_type(self):
        # The service-principal deployer condition matches the request's PrincipalType, so it must always be sent.
        for path in sorted((auth.ROOT / "infra").rglob("*.bicep")):
            source = path.read_text()
            relative = str(path.relative_to(auth.ROOT))
            blocks = re.findall(r"^resource \w+ 'Microsoft\.Authorization/roleAssignments@[^']+' = "
                                r"(?:if \([^\n]*\) )?\{\n(.*?)^\}", source, re.S | re.M)
            self.assertEqual(len(blocks), source.count("'Microsoft.Authorization/roleAssignments@"), relative)
            for index, block in enumerate(blocks):
                with self.subTest(relative, block=index):
                    self.assertRegex(block, r"principalType: ('ServicePrincipal'|deployerPrincipalType)\n")
            self.assertEqual(source.count("roleDefinitionIdOrName:"),
                             len(re.findall(r"roleDefinitionIdOrName:[^\n]*\n(?:[^\n]*\n){0,3}?\s*principalType: "
                                            r"(?:'ServicePrincipal'|deployerPrincipalType)\n", source)), relative)
            self.assertNotIn("principalType: 'User'", source, relative)
            self.assertNotIn("principalType: 'Group'", source, relative)
        for path in sorted((auth.ROOT / "scripts").rglob("*.sh")):
            source = path.read_text()
            for match in re.finditer(r"az role assignment create((?:[^\n]*\\\n)*[^\n]*)", source):
                with self.subTest(str(path.relative_to(auth.ROOT)), at=match.start()):
                    self.assertIn("--assignee-principal-type", match.group(1))

    def test_webpubsub_role_requires_exact_builtin_at_the_webpubsub_resource(self):
        scope = "/subscriptions/test/resourceGroups/demo/providers/Microsoft.SignalRService/webPubSub/pubsub"
        rule = json.loads(auth.CONTRACTS.read_text())["runtimeWebPubSubRole"]
        actions = rule["dataActions"]
        block = {"actions": [], "notActions": [], "dataActions": actions, "notDataActions": []}
        definition = {"name": rule["roleDefinitionId"], "roleName": rule["roleName"],
                      "permissions": [block]}
        assignment = {"roleDefinitionId": "/roles/" + rule["roleDefinitionId"],
                      "roleDefinitionName": rule["roleName"], "scope": scope, "principalId": "runtime"}
        self.assertTrue(auth.reviewed_webpubsub_runtime(definition, assignment, scope, "runtime"))
        self.assertTrue(auth.reviewed_webpubsub_runtime(
            {**definition, "permissions": [{**block, "dataActions": [action.lower() for action in actions]}]},
            {**assignment, "scope": scope.upper(), "principalId": "RUNTIME"}, scope, "runtime"))
        for variant in [
                {**definition, "name": "owner"},
                {**definition, "roleName": "Owner"},
                {**definition, "permissions": [block, block]},
                {**definition, "permissions": [{**block, "actions": ["*"]}]},
                {**definition, "permissions": [{**block, "actions": None}]},
                {**definition, "permissions": [{**block, "dataActions": []}]},
                {**definition, "permissions": [{**block, "notDataActions": ["*/delete"]}]},
                {**definition, "permissions": [{**block, "condition": "unknown"}]},
        ]:
            with self.subTest(definition=variant):
                self.assertFalse(auth.reviewed_webpubsub_runtime(variant, assignment, scope, "runtime"))
        for variant in [{**assignment, "scope": "/subscriptions/test"},
                        {**assignment, "principalId": "other"},
                        {**assignment, "principalId": None},
                        {**assignment, "roleDefinitionId": "/roles/owner"},
                        {**assignment, "roleDefinitionName": "Owner"},
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
                expected_reviewed = [] if action in allowed else [action]
                self.assertEqual(
                    auth.unreviewed_webpubsub_data_grants(definition, reviewed_role=True), expected_reviewed)
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
    def test_webpubsub_bicep_assigns_builtin_service_owner_without_custom_role_definition(self):
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
        assignment = resources["Microsoft.Authorization/roleAssignments"]
        self.assertNotIn("Microsoft.Authorization/roleDefinitions", resources)
        self.assertIn("Microsoft.SignalRService/webPubSub", assignment["scope"])
        role_id = json.loads(auth.CONTRACTS.read_text())["runtimeWebPubSubRole"]["roleDefinitionId"]
        self.assertIn(role_id, assignment["properties"]["roleDefinitionId"])

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
                "business_entity_id": str(accounts[form["username"]]),
                "exp": int(time.time()) + 600}).encode()).decode().rstrip("=")
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
        for fraction, normalized in [
                ("1", "100000"), ("12", "120000"), ("123", "123000"),
                ("1234", "123400"), ("12345", "123450"), ("123456", "123456"),
                ("1234567", "123456")]:
            with self.subTest(fraction=fraction):
                self.assertEqual(auth.guest_expiry(f"2026-11-10T18:02:07.{fraction}+00:00"),
                                 auth.guest_expiry(f"2026-11-10T18:02:07.{normalized}Z"))
        for value in [None, "invalid", "2026-11-10T18:02:07", "2026-99-10T18:02:07Z"]:
            with self.subTest(value=value), self.assertRaises(auth.EvidenceError):
                auth.guest_expiry(value)

    def test_guest_scenario_retires_proven_empty_fixture_after_invalid_expiry(self):
        proof = "A" * 64
        cart = "guest-" + "a" * 32
        calls = []

        def fake_http(method, url, **kwargs):
            calls.append((method, url, kwargs))
            if "/api/Product?" in url:
                return 200, {}, b'{"value":[{"ProductID":1}]}'
            if method == "POST":
                return 200, {}, json.dumps({"token": proof, "cartId": cart, "expiresAt": "invalid"}).encode()
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
            with patch.object(auth, "http", side_effect=fake_http), \
                    self.assertRaisesRegex(auth.EvidenceError, "Server returned invalid guest expiry"):
                auth.guest_cart_live(report, deployment)
            ledger = (Path(directory) / "guest-cart-ledger.json").read_text()
            self.assertNotIn(proof, ledger)
            self.assertTrue(json.loads(ledger)["sessions"][0]["retired"])
            self.assertEqual(sum(call[0] == "DELETE" for call in calls), 1)
            self.assertTrue(any(check["id"] == "guest-cart:retired-proof:0" and check["status"] == "PASS"
                                for check in report.checks))

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
                         "rest-wrong-denial", "rest-wrong-allow", "rest-extra-column", "rest-network-error",
                         "rest-transient-error"]:
            transient_failures = set()

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
                        if scenario == "rest-transient-error" and (url, token) not in transient_failures:
                            transient_failures.add((url, token))
                            raise auth.EvidenceError("Synthetic transient failure")
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
                with patch.object(auth, "ROOT", root), patch.object(auth, "http", side_effect=request), \
                        patch.object(auth, "dab_owner_row_isolation"):
                    if scenario in {"missing-selector", "invalid-selector-type"}:
                        with self.assertRaises(auth.EvidenceError):
                            auth.dab_read_role_matrix(report, deployment, "admin", "manufacturing", consumers)
                    else:
                        auth.dab_read_role_matrix(report, deployment, "admin", "manufacturing", consumers)
                        self.assertEqual(len(report.checks), 42)
                        self.assertEqual({item["status"] for item in report.checks},
                                         {"PASS"} if scenario in {"complete", "rest-transient-error"} else
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

        def fake_http(method, url, *, token=None, data=None, headers=None, timeout=None):
            calls.append((method, url, token, data, headers, timeout))
            if token is None:
                return 401, {"WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", error="missing_token"'}, b'{"error":"missing_token"}'
            if token == "dab-token":
                return 401, {"WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", error="invalid_token"'}, b'{"error":"invalid_token"}'
            if token == "manufacturing-token":
                return 403, {"WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", error="insufficient_scope"'}, b'{"error":"insufficient_scope"}'
            return 200, {}, b'{"suggestion":{"suggestedProducts":[],"private":"not evidence"},"threadId":"response-id"}'

        with patch.object(auth, "http", side_effect=fake_http):
            auth.promotion_agent_authorization(
                report, deployment, "admin-token", "manufacturing-token", "dab-token", allow_agent_canary=True)

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
        self.assertRegex(calls[-1][4]["traceparent"],
                         r"^00-" + report.inventory["promotionSuggestionTraceId"] + r"-[a-f0-9]{16}-01$")
        self.assertEqual(calls[-1][5], 300)
        self.assertEqual(report._promotion_response_hash, hashlib.sha256(b"response-id").hexdigest())
        self.assertNotIn("response-id", json.dumps([report.checks, report.inventory]))

    def test_promotion_agent_stops_after_first_unexpected_denial(self):
        report = auth.Report(Path("."))
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_MCP_URL": "https://mcp.example.test/mcp",
        }[key])
        with patch.object(auth, "http", return_value=(200, {}, b'{"suggestion":{}}')) as http:
            with self.assertRaises(auth.EvidenceError):
                auth.promotion_agent_authorization(
                    report, deployment, "admin-token", "manufacturing-token", "dab-token", allow_agent_canary=True)
        http.assert_called_once()
        self.assertEqual(report.checks[0]["status"], "FAIL")

    def test_promotion_agent_scenario_requires_explicit_opt_in_before_requests(self):
        report = auth.Report(Path("."))
        with patch.object(auth, "http") as http, patch.object(auth, "promotion_foundry_evidence") as evidence:
            auth.promotion_agent_scenario(report, SimpleNamespace(), "admin", "manufacturing", "dab")
            with self.assertRaisesRegex(auth.EvidenceError, "opt-in"):
                auth.promotion_agent_authorization(report, SimpleNamespace(), "admin", "manufacturing", "dab")
        http.assert_not_called()
        evidence.assert_not_called()
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

    def test_live_profile_runs_promotion_only_with_its_canary_flag(self):
        deployment = SimpleNamespace(required=lambda key: {
            "API_URL": "https://dab.example.test/graphql/",
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_MCP_URL": "https://mcp.example.test/mcp",
        }[key])
        helper = SimpleNamespace(
            NoRedirect=auth.NoRedirect,
            session=lambda opener, args, base, audience: {"access_token": args.identity + ":" + audience},
            IDENTITIES={"admin": ("", "", "", "", "executive-admin"),
                        "manufacturing": ("", "", "", "", "manufacturing-engineer")},
            AuthError=ValueError)

        def fake_http(method, url, *, token=None, data=None, headers=None, timeout=None):
            if url.endswith("/.well-known/openid-configuration"):
                return 200, {}, b'{"issuer":"https://mcp.example.test/"}'
            if url.endswith("/graphql"):
                return 200, {}, b'{"data":{"products":{"items":[{"ProductID":1}]}}}'
            if url.endswith("/api/protected"):
                return (401, {}, b'{}') if token.endswith(":mcp") else (200, {}, b'{"state":"ok"}')
            if token.endswith(":functions"):
                return 401, {}, b'{}'
            name = data["params"]["name"]
            result = ({"content": [{"text": "## Scrap Events\nTotal events: 0\n"}]}
                      if name == "get_manufacturing_scrap_events" else
                      {"isError": True, "content": [{"text": "sales.read"}]})
            return 200, {}, json.dumps({"result": result}).encode()

        for enabled in [False, True]:
            with self.subTest(enabled=enabled):
                report = auth.Report(Path("."))
                guarded = report.guarded

                def selected_guard(check_id, group, callback):
                    if check_id in {"live:authenticated-paths", "agent:promotion-suggestion:scenario"}:
                        guarded(check_id, group, callback)

                with patch.object(report, "guarded", side_effect=selected_guard), \
                        patch.object(auth, "http", side_effect=fake_http), \
                        patch.object(auth, "load_auth_helper", return_value=helper), \
                        patch.object(auth, "internal_token_target", side_effect=lambda d, resource: ("base", resource)), \
                        patch.object(auth, "reviewed_function_read_url",
                                     return_value="https://functions.example.test/api/protected"), \
                        patch.object(auth, "function_denial_obligations", return_value=[]), \
                        patch.object(auth, "live_denial_probes"), \
                        patch.object(auth, "customer_chat_live"), \
                        patch.object(auth, "admin_chat_live"), \
                        patch.object(auth, "reconcile_browser_auth_requirement"), \
                        patch.object(auth, "reconcile_mcp_task_requirement"), \
                        patch.object(auth, "reconcile_dab_operation_requirement"), \
                        patch.object(auth, "reconcile_ownership_handlers_requirement"), \
                        patch.object(auth, "reconcile_session_transition_requirement"), \
                        patch.object(auth, "promotion_agent_authorization") as promotion, \
                        patch.object(auth, "promotion_foundry_evidence") as evidence:
                    auth.live(report, deployment, allow_promotion_agent_canary=enabled)
                self.assertEqual(promotion.call_count, int(enabled))
                self.assertEqual(evidence.call_count, int(enabled))
                if enabled:
                    self.assertTrue(promotion.call_args.kwargs["allow_agent_canary"])
                else:
                    self.assertTrue(any(item["id"] == "agent:promotion-suggestion:canary" and
                                        item["status"] == "BLOCKED" for item in report.checks))

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

    def test_guarded_mutation_definition_requires_the_reviewed_tool_shape_and_endpoint(self):
        expected = {"generate_random_customer", "generate_random_customer_for_locale"}
        definition = {
            "kind": "prompt", "instructions": "Configured",
            "tools": [{
                "type": "mcp", "server_label": "adventureworks_mcp",
                "server_url": "https://mcp.example.test/mcp",
                "allowed_tools": sorted(expected), "require_approval": "never",
            }],
        }
        cases = [
            (None, True), ("normalized-url", True), ("object-allowlist", True),
            ("missing-instructions", False), ("missing-tools", False), ("wrong-target", False),
            ("query", False), ("extra-tool", False), ("duplicate-tool", False),
            ("extra-allowlist-field", False), ("static-header", False),
            ("static-authorization", False), ("unknown-property", False),
            ("additional-server", False),
        ]
        for defect, allowed in cases:
            with self.subTest(defect=defect):
                candidate = copy.deepcopy(definition)
                tool = candidate["tools"][0]
                if defect == "normalized-url":
                    tool["server_url"] = "https://MCP.EXAMPLE.TEST:443/mcp/"
                elif defect == "object-allowlist":
                    tool["allowed_tools"] = {"tool_names": sorted(expected)}
                elif defect == "missing-instructions":
                    candidate["instructions"] = ""
                elif defect == "missing-tools":
                    candidate["tools"] = []
                elif defect == "wrong-target":
                    tool["server_url"] = "https://mcp.example.test/other"
                elif defect == "query":
                    tool["server_url"] += "?key=private"
                elif defect == "extra-tool":
                    tool["allowed_tools"].append("create_order")
                elif defect == "duplicate-tool":
                    tool["allowed_tools"].append(tool["allowed_tools"][0])
                elif defect == "extra-allowlist-field":
                    tool["allowed_tools"] = {"tool_names": sorted(expected), "extra": True}
                elif defect == "static-header":
                    tool["headers"] = {"Authorization": "PRIVATE"}
                elif defect == "static-authorization":
                    tool["authorization"] = "PRIVATE"
                elif defect == "unknown-property":
                    tool["unreviewed"] = True
                elif defect == "additional-server":
                    candidate["tools"].append(copy.deepcopy(tool))
                self.assertEqual(auth.guarded_agent_tool_definition_matches(
                    candidate, expected, "https://mcp.example.test/mcp"), allowed)
        self.assertFalse(auth.guarded_agent_tool_definition_matches(definition, set(), "https://mcp.example.test/mcp"))

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
            for name in auth.ADMIN_CHAT_SALES_TOOLS:
                self.assertIn(name, request.call_args.kwargs["data"]["message"])
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

    def test_admin_chat_correlation_accumulates_only_current_sales_tool_results(self):
        subject = "00000000-0000-4000-8000-000000000001"
        payload = base64.urlsafe_b64encode(json.dumps({"sub": subject}).encode()).decode().rstrip("=")
        token = "header." + payload + ".signature"
        report = auth.Report(Path("."))
        for check_id, group in [
                ("agent:admin-chat:definition", "agent-policy"),
                ("agent:admin-chat:response", "agents"),
                ("agent:admin-chat:reported-tool", "agents")]:
            report.add(check_id, group, "PASS", "Current evidence.")
        report.inventory["adminChatTraceId"] = "a" * 32
        responses = iter([
            [["admin-agent:1", "get_business_stats", 1]],
            [["admin-agent:1", "get_business_stats", 2], ["admin-agent:1", "get_sales_report_by_status", 1]],
            [["admin-agent:1", "get_top_selling_products", 1]],
        ])
        queries = []

        def azure(*args):
            if args[:2] == ("resource", "list"):
                return ["app"]
            queries.append(args[args.index("--analytics-query") + 1])
            return {"tables": [{"columns": [{"name": name} for name in
                                             ["AgentVersionId", "Tool", "Hits"]], "rows": next(responses)}]}

        values = {"AI_AGENT_ADMIN_CHAT_ID": "admin-agent", "AZURE_RESOURCE_GROUP": "group"}
        deployment = SimpleNamespace(required=lambda key: values[key], azure=azure, runtime=None)
        with patch.object(auth.time, "sleep") as sleep:
            auth.delegated_chat_correlated_tool(report, deployment, lambda: token, "admin-chat")
        observed = report.inventory["adminChatCorrelatedTools"]
        self.assertEqual({item["tool"] for item in observed}, auth.ADMIN_CHAT_SALES_TOOLS)
        self.assertEqual(next(item["matches"] for item in observed if item["tool"] == "get_business_stats"), 2)
        self.assertEqual(len(queries), 3)
        self.assertEqual([call.args for call in sleep.call_args_list], [(20,), (20,)])
        self.assertEqual(report.checks[-1]["status"], "PASS")
        for query in queries:
            self.assertTrue(all(name in query for name in auth.ADMIN_CHAT_SALES_TOOLS))
            self.assertIn("sales.read", query)
            self.assertNotIn(subject, query)
            self.assertNotIn(token, query)

    def test_admin_chat_tool_obligations_require_individual_correlated_results(self):
        report = auth.Report(Path("."))
        report.inventory["adminChatCorrelatedTools"] = [
            {"version": "admin-agent:1", "tool": "get_business_stats", "matches": 1},
            {"version": "admin-agent:1", "tool": "get_sales_report_by_status", "matches": 1},
        ]
        report.add("agent:admin-chat:correlated-tool", "agents", "PASS", "Current trace.")
        auth.report_admin_chat_tool_observations(report)
        statuses = {item["id"].rsplit(":", 1)[-1]: item["status"] for item in report.checks
                    if item["id"].startswith("agent:admin-chat:tool:")}
        self.assertEqual(statuses, {
            "get_business_stats": "PASS",
            "get_sales_report_by_status": "PASS",
            "get_top_selling_products": "BLOCKED",
        })
        report = auth.Report(Path("."))
        report.inventory["adminChatCorrelatedTools"] = [
            {"version": "admin-agent:1", "tool": "get_business_stats", "matches": 1},
        ]
        report.add("agent:admin-chat:correlated-tool", "agents", "BLOCKED", "No current trace.")
        auth.report_admin_chat_tool_observations(report)
        self.assertTrue(all(item["status"] == "BLOCKED" for item in report.checks))

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
            }}, "https://mcp.example.test/mcp", "https://dab.example.test/mcp")
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
        report.inventory["adminChatCorrelatedTools"].append({
            "version": "admin-agent:1", "tool": "get_sales_report_by_status", "matches": 1,
        })
        auth.reconcile_admin_chat_tool_paths(report, deployment)
        paths = {item["id"].rsplit(":", 1)[-1]: item["status"] for item in report.checks
                 if item["id"].startswith("agent-tool-path:")}
        self.assertEqual(paths["get_business_stats"], "PASS")
        self.assertEqual(paths["get_sales_report_by_status"], "PASS")
        self.assertTrue(all(status == "BLOCKED" for name, status in paths.items()
                            if name not in {"get_business_stats", "get_sales_report_by_status"}))
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
            }}, "https://mcp.example.test/mcp", "https://dab.example.test/mcp")
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

        for status in [401, 403]:
            with self.subTest(denied=status):
                report = auth.Report(Path("."))
                with patch.object(auth, "command", return_value="foundry-token"), \
                        patch.object(auth, "http", return_value=(status, {}, b'{"error":{}}')):
                    report.guarded("agent:helpme-choose:definition", "agent-policy",
                                   lambda: auth.help_me_choose_agent_definition(report, deployment))
                self.assertEqual([check["status"] for check in report.checks], ["BLOCKED"])
                self.assertIn("agents/read", report.checks[0]["detail"])

    def test_az_rest_failure_reports_only_a_sanitized_permission_cause(self):
        stderr = "ERROR: (Forbidden) Identity does not have permissions; token=PRIVATE"
        result = subprocess.CompletedProcess([], 1, stdout="", stderr=stderr)
        with patch.object(auth.subprocess, "run", return_value=result):
            with self.assertRaises(auth.EvidenceError) as raised:
                auth.command(["az", "rest", "--method", "get"])
        self.assertIn("permission denied", str(raised.exception))
        self.assertNotIn("PRIVATE", str(raised.exception))
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

    def test_catalog_agent_profile_does_not_send_ai_requests_without_opt_in(self):
        report = auth.Report(Path("."))
        deployment = SimpleNamespace()
        def definition(report, _):
            report.add("agent:helpme-choose:definition", "agent-policy", "PASS", "Reviewed definition.")
        with patch.object(auth, "help_me_choose_agent_definition", side_effect=definition), \
                patch.object(auth, "http") as http:
            auth.catalog_agent_tests(report, deployment)
        http.assert_not_called()
        tool_checks = {"agent:helpme-choose:tool:" + tool: "BLOCKED" for tool in auth.PUBLIC_CATALOG_TOOLS}
        self.assertEqual(
            {item["id"]: item["status"] for item in report.checks},
            {"scope:catalog-agent": "PASS", "agent:helpme-choose:definition": "PASS",
             "agent:helpme-choose:public-flow": "BLOCKED",
             "agent:helpme-choose:correlated-tools": "BLOCKED",
             "agent:helpme-choose:foundry-identity": "BLOCKED", **tool_checks},
        )

    def test_catalog_profile_reports_each_unobserved_tool_as_blocked(self):
        report = auth.Report(Path("."))
        def correlate(report, _):
            report.inventory["helpMeChooseCorrelatedTools"] = [
                {"version": "help-agent:1", "tool": "search_products", "matches": 1},
                {"version": "help-agent:1", "tool": "get_product_details", "matches": 2},
            ]
            report.add("agent:helpme-choose:correlated-tools", "agents", "PASS", "Partial telemetry.")
        with patch.object(auth, "help_me_choose_agent_definition"), \
                patch.object(auth, "help_me_choose_public_flow"), \
                patch.object(auth, "help_me_choose_correlated_tools", side_effect=correlate):
            auth.catalog_agent_tests(report, SimpleNamespace(), allow_agent_canary=True)
        statuses = {item["id"].rsplit(":", 1)[-1]: item["status"] for item in report.checks
                    if item["id"].startswith("agent:helpme-choose:tool:")}
        self.assertEqual(statuses, {
            "search_products": "PASS", "get_product_details": "PASS",
            "get_categories_with_products": "BLOCKED", "find_complementary_products": "BLOCKED",
        })

    def test_foundry_identity_requires_the_selected_binding_and_all_current_trace_observations(self):
        client_id = "00000000-0000-4000-8000-000000000001"
        client_hash = hashlib.sha256(client_id.encode()).hexdigest()
        identity_id = "/subscriptions/test/resourceGroups/group/providers/Microsoft.ManagedIdentity/userAssignedIdentities/runtime"
        values = {
            "AI_AGENT_HELP_ME_CHOOSE_ID": "help-agent",
            "AI_FOUNDRY_PROJECT_ENDPOINT": "https://foundry.example.test/api/projects/demo",
            "AZURE_RESOURCE_GROUP": "group",
            "SERVICE_API_FUNCTIONS_NAME": "functions",
            "USER_MANAGED_IDENTITY_NAME": "runtime",
            "API_FUNCTIONS_URL": "https://functions.example.test",
        }
        settings = [
            {"name": "AZURE_CLIENT_ID", "value": client_id},
            {"name": "AzureWebJobsStorage__clientId", "value": client_id},
            {"name": "AI_FOUNDRY_PROJECT_ENDPOINT", "value": values["AI_FOUNDRY_PROJECT_ENDPOINT"]},
            {"name": "AI_AGENT_HELP_ME_CHOOSE_ID", "value": "help-agent"},
        ]
        app = {"defaultHostName": "functions.example.test",
               "identity": {"userAssignedIdentities": {identity_id: {}}}}
        identity = {"id": identity_id, "clientId": client_id}
        good = [["a" * 32, "help-agent:1", "match", client_hash, 1],
                ["b" * 32, "help-agent:1", "match", client_hash, 1]]
        cases = [
            (good, "PASS"),
            ([], "BLOCKED"),
            (good[:1], "BLOCKED"),
            ([good[0], ["b" * 32, "help-agent:1", "mismatch", client_hash, 1]], "FAIL"),
            ([good[0], ["b" * 32, "help-agent:1", "match", "f" * 64, 1]], "FAIL"),
            ([good[0], ["b" * 32, "help-agent:1", "unverifiable", client_hash, 1]], "BLOCKED"),
            ([good[0], ["b" * 32, "help-agent:1", "", "", 1]], "BLOCKED"),
            ([good[0], ["b" * 32, "unknown", "match", client_hash, 1]], "BLOCKED"),
            ([good[0], ["b" * 32, "unknown", "mismatch", client_hash, 1]], "FAIL"),
        ]
        for rows, expected in cases:
            with self.subTest(rows=rows):
                queries = []
                report = auth.Report(Path("."))
                for phase in ("questions", "recommendations"):
                    report.add("agent:helpme-choose:anonymous-" + phase, "agents", "PASS", "Valid response.")
                report.inventory["helpMeChooseTraceIds"] = {"questions": "a" * 32, "recommendations": "b" * 32}

                def azure(*args):
                    if args[:2] == ("functionapp", "show"):
                        return app
                    if args[:2] == ("identity", "show"):
                        return identity
                    if args[:4] == ("functionapp", "config", "appsettings", "list"):
                        return settings
                    if args[:2] == ("resource", "list"):
                        return ["app"]
                    self.assertEqual(args[:3], ("monitor", "app-insights", "query"))
                    queries.append(args[args.index("--analytics-query") + 1])
                    return {"tables": [{"columns": [{"name": name} for name in
                        ["TraceId", "AgentVersionId", "ClientMatch", "ClientHash", "Hits"]], "rows": rows}]}

                deployment = SimpleNamespace(required=lambda key: values[key], azure=azure, runtime=None)
                with patch.object(auth.time, "sleep"):
                    auth.foundry_response_identity(report, deployment, "helpme-choose")
                self.assertEqual(report.checks[-1]["status"], expected)
                self.assertEqual(len(queries), 1 if expected in {"PASS", "FAIL"} else 4)
                self.assertIn("CredentialClientMatch", queries[0])
                self.assertIn("CredentialExpectedClientHash", queries[0])
                self.assertIn("public-catalog", queries[0])
                self.assertNotIn(client_id, json.dumps([report.checks, report.inventory]))
                self.assertNotIn(client_hash, json.dumps([report.checks, report.inventory]))

    def test_foundry_identity_rejects_bad_traces_shapes_and_bindings(self):
        report = auth.Report(Path("."))
        for phase in ("questions", "recommendations"):
            report.add("agent:helpme-choose:anonymous-" + phase, "agents", "PASS", "Valid response.")
        report.inventory["helpMeChooseTraceIds"] = {"questions": "a" * 32, "recommendations": "a" * 32}
        deployment = SimpleNamespace(required=lambda _: self.fail("No ARM calls for invalid traces"),
                                     azure=lambda *args: self.fail("No ARM calls for invalid traces"), runtime=None)
        with self.assertRaises(auth.EvidenceError):
            auth.foundry_response_identity(report, deployment, "helpme-choose")

        report.inventory["helpMeChooseTraceIds"]["recommendations"] = "b" * 32
        client_id = "00000000-0000-4000-8000-000000000001"
        identity_id = "/subscriptions/test/identities/runtime"
        values = {"AI_AGENT_HELP_ME_CHOOSE_ID": "help-agent", "AZURE_RESOURCE_GROUP": "group",
                  "SERVICE_API_FUNCTIONS_NAME": "functions", "USER_MANAGED_IDENTITY_NAME": "runtime",
                  "API_FUNCTIONS_URL": "https://functions.example.test",
                  "AI_FOUNDRY_PROJECT_ENDPOINT": "https://foundry.example.test/api/projects/demo"}
        settings = [{"name": name, "value": value} for name, value in {
            "AZURE_CLIENT_ID": client_id, "AzureWebJobsStorage__clientId": client_id,
            "AI_FOUNDRY_PROJECT_ENDPOINT": values["AI_FOUNDRY_PROJECT_ENDPOINT"],
            "AI_AGENT_HELP_ME_CHOOSE_ID": "help-agent"}.items()]
        app = {"defaultHostName": "other.example.test",
               "identity": {"userAssignedIdentities": {identity_id: {}}}}

        def azure(*args):
            if args[:2] == ("functionapp", "show"):
                return app
            if args[:2] == ("identity", "show"):
                return {"id": identity_id, "clientId": client_id}
            if args[:4] == ("functionapp", "config", "appsettings", "list"):
                return settings
            self.fail("Invalid host must fail before telemetry")

        deployment = SimpleNamespace(required=lambda key: values[key], azure=azure, runtime=None)
        auth.foundry_response_identity(report, deployment, "helpme-choose")
        self.assertEqual(report.checks[-1]["status"], "FAIL")

        app["defaultHostName"] = "functions.example.test"
        client_hash = hashlib.sha256(client_id.encode()).hexdigest()
        for rows in [
                [["c" * 32, "help-agent:1", "match", client_hash, 1]],
                [["a" * 32, "other:1", "match", client_hash, 1]],
                [["a" * 32, "help-agent:1", "match", "invalid", 1]],
                [["a" * 32, "help-agent:1", "match", client_hash, True]],
                [["a" * 32, "help-agent:1", "match", client_hash, 1]] * 2]:
            with self.subTest(rows=rows):
                current = auth.Report(Path("."))
                for phase in ("questions", "recommendations"):
                    current.add("agent:helpme-choose:anonymous-" + phase, "agents", "PASS", "Valid response.")
                current.inventory["helpMeChooseTraceIds"] = {"questions": "a" * 32, "recommendations": "b" * 32}

                def invalid_telemetry(*args):
                    if args[:2] == ("resource", "list"):
                        return ["app"]
                    if args[:3] == ("monitor", "app-insights", "query"):
                        return {"tables": [{"columns": [{"name": name} for name in
                            ["TraceId", "AgentVersionId", "ClientMatch", "ClientHash", "Hits"]],
                                            "rows": rows}]}
                    return azure(*args)

                selected = SimpleNamespace(required=lambda key: values[key], azure=invalid_telemetry, runtime=None)
                with self.assertRaises(auth.EvidenceError):
                    auth.foundry_response_identity(current, selected, "helpme-choose")

    def test_foundry_identity_supports_delegated_chat_and_promotion_traces(self):
        client_id = "00000000-0000-4000-8000-000000000001"
        client_hash = hashlib.sha256(client_id.encode()).hexdigest()
        identity_id = "/subscriptions/test/identities/runtime"
        for profile, agent_key, trace_key, check_id, policy in [
                ("customer-chat", "AI_AGENT_CHAT_ID", "customerChatTraceId",
                 "agent:customer-chat:response", "customer-chat"),
                ("admin-chat", "AI_AGENT_ADMIN_CHAT_ID", "adminChatTraceId",
                 "agent:admin-chat:response", "admin-chat"),
                ("promotion-suggestion", "AI_AGENT_PROMOTION_ID", "promotionSuggestionTraceId",
                 "agent:promotion-suggestion:allow-admin", "none"),
                ("email-content", "AI_AGENT_EMAIL_CONTENT_ID", "emailContentTraceId",
                 "agent:email-content:allow-admin", "none"),
                ("product-content", "AI_AGENT_PRODUCT_CONTENT_ID", "productContentTraceId",
                 "agent:product-content:allow-admin", "none"),
                ("manufacturing-content", "AI_AGENT_MANUFACTURING_CONTENT_ID", "manufacturingContentTraceId",
                 "agent:manufacturing-content:allow-manufacturing", "none"),
                ("review-analysis", "AI_AGENT_REVIEW_ANALYSIS_ID", "reviewAnalysisTraceId",
                 "agent:review-analysis:allow-admin", "none"),
                ("cart-recovery", "AI_AGENT_CART_RECOVERY_ID", "cartRecoveryTraceId",
                 "agent:cart-recovery:allow-admin", "none")]:
            with self.subTest(profile=profile):
                report = auth.Report(Path("."))
                report.add(check_id, "agents", "PASS", "Valid response.")
                report.inventory[trace_key] = "a" * 32
                if profile == "promotion-suggestion":
                    report._promotion_response_hash = hashlib.sha256(b"private-response-id").hexdigest()
                if profile == "product-content":
                    report._product_content_response_hash = hashlib.sha256(b"private-response-id").hexdigest()
                if profile == "manufacturing-content":
                    report._manufacturing_content_response_hash = hashlib.sha256(b"private-response-id").hexdigest()
                if profile == "email-content":
                    report._email_content_template = "authassurance_" + "a" * 32
                values = {agent_key: "chat-agent", "AZURE_RESOURCE_GROUP": "group",
                          "SERVICE_API_FUNCTIONS_NAME": "functions", "USER_MANAGED_IDENTITY_NAME": "runtime",
                          "API_FUNCTIONS_URL": "https://functions.example.test",
                          "AI_FOUNDRY_PROJECT_ENDPOINT": "https://foundry.example.test/api/projects/demo"}
                settings = [{"name": name, "value": value} for name, value in {
                    "AZURE_CLIENT_ID": client_id, "AzureWebJobsStorage__clientId": client_id,
                    "AI_FOUNDRY_PROJECT_ENDPOINT": values["AI_FOUNDRY_PROJECT_ENDPOINT"],
                    agent_key: "chat-agent"}.items()]
                queries = []

                def azure(*args):
                    if args[:2] == ("functionapp", "show"):
                        return {"defaultHostName": "functions.example.test",
                                "identity": {"userAssignedIdentities": {identity_id: {}}}}
                    if args[:2] == ("identity", "show"):
                        return {"id": identity_id, "clientId": client_id}
                    if args[:4] == ("functionapp", "config", "appsettings", "list"):
                        return settings
                    if args[:2] == ("resource", "list"):
                        return ["app"]
                    queries.append(args[args.index("--analytics-query") + 1])
                    return {"tables": [{"columns": [{"name": name} for name in
                        ["TraceId", "AgentVersionId", "ClientMatch", "ClientHash", "Hits"]],
                                        "rows": [[("response-hash-match" if profile in {"promotion-suggestion", "product-content", "manufacturing-content"}
                                                   else "email-content-operation-match" if profile == "email-content"
                                                   else "a" * 32), "chat-agent:1", "match", client_hash, 1]]}]}

                deployment = SimpleNamespace(required=lambda key: values[key], azure=azure, runtime=None)
                auth.foundry_response_identity(report, deployment, profile)
                self.assertEqual(report.checks[-1]["status"], "PASS")
                self.assertIn(f"customDimensions.ToolPolicy) == '{policy}'", queries[0])
                self.assertNotIn("delegate", report.checks[-1]["detail"].lower())
                if profile in {"promotion-suggestion", "product-content", "manufacturing-content"}:
                    self.assertIn("hash_sha256(tostring(customDimensions.ResponseId))", queries[0])
                    self.assertNotIn("private-response-id", json.dumps([report.checks, report.inventory]))
                if profile == "email-content":
                    self.assertIn("EmailContentAgent.Generate", queries[0])
                    self.assertIn(report._email_content_template, queries[0])
                    self.assertNotIn(report._email_content_template, json.dumps([report.checks, report.inventory]))

    def test_promotion_foundry_identity_requires_the_current_response_hash(self):
        report = auth.Report(Path("."))
        report.add("agent:promotion-suggestion:allow-admin", "agents", "PASS", "Valid response.")
        report.inventory["promotionSuggestionTraceId"] = "a" * 32
        deployment = SimpleNamespace(required=lambda _: self.fail("No ARM calls without response hash"),
                                     azure=lambda *args: self.fail("No ARM calls without response hash"), runtime=None)
        with self.assertRaises(auth.EvidenceError):
            auth.foundry_response_identity(report, deployment, "promotion-suggestion")

    def test_analysis_tool_suppression_requires_the_current_trace_and_identity(self):
        for profile, key, trace_key in [
                ("review-analysis", "AI_AGENT_REVIEW_ANALYSIS_ID", "reviewAnalysisTraceId"),
                ("cart-recovery", "AI_AGENT_CART_RECOVERY_ID", "cartRecoveryTraceId")]:
            with self.subTest(profile=profile):
                report = auth.Report(Path("."))
                report.add(f"agent:{profile}:foundry-identity", "agents", "PASS", "Current response.")
                report.inventory[profile + "FoundryIdentity"] = [{"version": "analysis-agent:1"}]
                report.inventory[trace_key] = "a" * 32
                queries = []

                def azure(*args):
                    if args[:2] == ("resource", "list"):
                        return ["app"]
                    queries.append(args[args.index("--analytics-query") + 1])
                    return {"tables": [{"columns": [{"name": name} for name in
                        ["AgentVersionId", "DefinitionFallback", "ToolChoice", "ToolsOffered",
                         "ToolCallCount", "Hits"]],
                        "rows": [["analysis-agent:1", "false", "none", "false", "0", 1]]}]}

                deployment = SimpleNamespace(required=lambda name: {
                    key: "analysis-agent", "AZURE_RESOURCE_GROUP": "group"}[name], azure=azure)
                auth.data_supplied_tool_suppression(report, deployment, profile)
                self.assertEqual(report.checks[-1]["status"], "PASS")
                self.assertIn("operation_Id == '" + "a" * 32 + "'", queries[0])

                report.inventory[trace_key] = "not-a-trace"
                with self.assertRaises(auth.EvidenceError):
                    auth.data_supplied_tool_suppression(report, deployment, profile)
                self.assertEqual(len(queries), 1)

    def test_promotion_tool_suppression_requires_current_complete_correlated_evidence(self):
        response_hash = hashlib.sha256(b"private-response-id").hexdigest()
        good = ["promotion-agent:1", "true", "none", "false", "0", 1]
        cases = [
            ([good], "PASS"),
            ([["promotion-agent:1", "false", "none", "false", "0", 1]], "PASS"),
            ([], "BLOCKED"),
            ([["promotion-agent:1", "", "none", "false", "0", 1]], "BLOCKED"),
            ([["promotion-agent:1", "true", "", "false", "0", 1]], "BLOCKED"),
            ([["unknown", "true", "none", "false", "0", 1]], "BLOCKED"),
            ([["promotion-agent:2", "true", "none", "false", "0", 1]], "BLOCKED"),
            ([["promotion-agent:1", "true", "auto", "false", "0", 1]], "FAIL"),
            ([["promotion-agent:1", "true", "none", "true", "0", 1]], "FAIL"),
            ([["promotion-agent:1", "true", "none", "false", "1", 1]], "FAIL"),
            ([good, ["promotion-agent:1", "true", "required", "true", "1", 1]], "FAIL"),
        ]
        for rows, expected in cases:
            with self.subTest(rows=rows):
                report = auth.Report(Path("."))
                report.add("agent:promotion-suggestion:foundry-identity", "agents", "PASS", "Current response.")
                report._promotion_response_hash = response_hash
                report.inventory["promotion-suggestionFoundryIdentity"] = [{"version": "promotion-agent:1"}]
                queries = []

                def azure(*args):
                    if args[:2] == ("resource", "list"):
                        return ["app"]
                    self.assertEqual(args[:3], ("monitor", "app-insights", "query"))
                    queries.append(args[args.index("--analytics-query") + 1])
                    return {"tables": [{"columns": [{"name": name} for name in
                        ["AgentVersionId", "DefinitionFallback", "ToolChoice", "ToolsOffered",
                         "ToolCallCount", "Hits"]], "rows": rows}]}

                deployment = SimpleNamespace(required=lambda key: {
                    "AI_AGENT_PROMOTION_ID": "promotion-agent", "AZURE_RESOURCE_GROUP": "group"}[key],
                    azure=azure)
                with patch.object(auth.time, "sleep"):
                    auth.promotion_tool_suppression(report, deployment)
                self.assertEqual(report.checks[-1]["status"], expected)
                self.assertEqual(len(queries), 1 if expected in {"PASS", "FAIL"} else 4)
                self.assertIn("hash_sha256(tostring(customDimensions.ResponseId))", queries[0])
                self.assertIn(response_hash, queries[0])
                self.assertNotIn(response_hash, json.dumps([report.checks, report.inventory]))
                self.assertNotIn("private-response-id", json.dumps([report.checks, report.inventory]))

    def test_promotion_tool_suppression_blocks_missing_identity_and_malformed_telemetry(self):
        report = auth.Report(Path("."))
        deployment = SimpleNamespace(required=lambda _: self.fail("No ARM calls without identity"),
                                     azure=lambda *args: self.fail("No ARM calls without identity"))
        with self.assertRaises(auth.EvidenceError):
            auth.promotion_tool_suppression(report, deployment)

        report.add("agent:promotion-suggestion:foundry-identity", "agents", "PASS", "Current response.")
        report._promotion_response_hash = "a" * 64
        report.inventory["promotion-suggestionFoundryIdentity"] = [{"version": "promotion-agent:1"}]
        columns = ["AgentVersionId", "DefinitionFallback", "ToolChoice", "ToolsOffered", "ToolCallCount", "Hits"]
        rows = [
            [["promotion-agent:1", "maybe", "none", "false", "0", 1]],
            [["promotion-agent:1", "true", "none", "false", "bad", 1]],
            [["promotion-agent:1", "true", "none", "false", "0", True]],
            [["promotion-agent:1", "true", "none", "false", "0", 1]] * 2,
        ]
        for invalid in rows:
            with self.subTest(rows=invalid):
                def azure(*args):
                    if args[:2] == ("resource", "list"):
                        return ["app"]
                    return {"tables": [{"columns": [{"name": name} for name in columns], "rows": invalid}]}
                deployment = SimpleNamespace(required=lambda key: {
                    "AI_AGENT_PROMOTION_ID": "promotion-agent", "AZURE_RESOURCE_GROUP": "group"}[key],
                    azure=azure)
                with self.assertRaises(auth.EvidenceError):
                    auth.promotion_tool_suppression(report, deployment)

    def test_email_content_tool_suppression_uses_only_the_current_worker_operation(self):
        report = auth.Report(Path("."))
        report.add("agent:email-content:foundry-identity", "agents", "PASS", "Current response.")
        report._email_content_template = "authassurance_" + "a" * 32
        report.inventory["email-contentFoundryIdentity"] = [{"version": "email-agent:1"}]
        queries = []

        def azure(*args):
            if args[:2] == ("resource", "list"):
                return ["app"]
            queries.append(args[args.index("--analytics-query") + 1])
            columns = ["AgentVersionId", "DefinitionFallback", "ToolChoice", "ToolsOffered", "ToolCallCount", "Hits"]
            return {"tables": [{"columns": [{"name": name} for name in columns],
                                "rows": [["email-agent:1", "true", "none", "false", "0", 1]]}]}

        deployment = SimpleNamespace(required=lambda key: {
            "AI_AGENT_EMAIL_CONTENT_ID": "email-agent", "AZURE_RESOURCE_GROUP": "group"}[key], azure=azure)
        auth.data_supplied_tool_suppression(report, deployment, "email-content")
        self.assertEqual(report.checks[-1]["status"], "PASS")
        self.assertIn("EmailContentAgent.Generate", queries[0])
        self.assertIn(report._email_content_template, queries[0])
        self.assertNotIn(report._email_content_template, json.dumps([report.checks, report.inventory]))

        report._email_content_template = "not-a-reviewed-marker"
        with self.assertRaises(auth.EvidenceError):
            auth.data_supplied_tool_suppression(report, deployment, "email-content")

    def test_content_tool_suppression_uses_the_current_response_hash(self):
        for profile, agent_key, hash_field in [
                ("product-content", "AI_AGENT_PRODUCT_CONTENT_ID", "_product_content_response_hash"),
                ("manufacturing-content", "AI_AGENT_MANUFACTURING_CONTENT_ID",
                 "_manufacturing_content_response_hash")]:
            with self.subTest(profile=profile):
                report = auth.Report(Path("."))
                report.add(f"agent:{profile}:foundry-identity", "agents", "PASS", "Current response.")
                response_hash = hashlib.sha256(b"private-response-id").hexdigest()
                setattr(report, hash_field, response_hash)
                report.inventory[profile + "FoundryIdentity"] = [{"version": "content-agent:1"}]
                queries = []

                def azure(*args):
                    if args[:2] == ("resource", "list"):
                        return ["app"]
                    queries.append(args[args.index("--analytics-query") + 1])
                    columns = ["AgentVersionId", "DefinitionFallback", "ToolChoice", "ToolsOffered",
                               "ToolCallCount", "Hits"]
                    return {"tables": [{"columns": [{"name": name} for name in columns],
                                        "rows": [["content-agent:1", "true", "none", "false", "0", 1]]}]}

                deployment = SimpleNamespace(required=lambda key: {
                    agent_key: "content-agent", "AZURE_RESOURCE_GROUP": "group"}[key], azure=azure)
                auth.data_supplied_tool_suppression(report, deployment, profile)
                self.assertEqual(report.checks[-1]["status"], "PASS")
                self.assertIn(response_hash, queries[0])
                self.assertNotIn(response_hash, json.dumps([report.checks, report.inventory]))

    def test_manufacturing_content_candidate_uses_bounded_read_only_discovery(self):
        deployment = SimpleNamespace(required=lambda key: {
            "API_URL": "https://dab.example.test/graphql/",
            "API_FUNCTIONS_URL": "https://functions.example.test"}[key])
        helper = SimpleNamespace(IDENTITIES={"manufacturing": ("", "", "", "", "manufacturing-engineer")})
        products = [{"ProductID": 1, "MakeFlag": True, "ProductModelID": None},
                    {"ProductID": 2, "MakeFlag": True, "ProductModelID": None}]
        calls = []

        def request(method, url, *, token=None, headers=None):
            calls.append((method, url, token, headers))
            parsed = urllib.parse.urlsplit(url)
            if parsed.path == "/api/Product":
                body = {"value": products}
            elif parsed.path == "/api/BillOfMaterials":
                product_id = int(urllib.parse.parse_qs(parsed.query)["$filter"][0].split()[-1])
                body = {"value": [{"ProductAssemblyID": product_id,
                                   "StartDate": "2000-01-01T00:00:00", "EndDate": None}]}
            else:
                product_id = int(parsed.path.split("/")[-2])
                body = [{"generated": True}] if product_id == 1 else []
            return 200, {}, json.dumps(body).encode()

        with patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "http", side_effect=request):
            self.assertEqual(auth.manufacturing_content_candidate(deployment, "functions-token", "dab-token"), 2)
        self.assertEqual(len(calls), 5)
        self.assertTrue(all(call[0] == "GET" for call in calls))
        self.assertTrue(all(call[2:] == ("dab-token", {"X-MS-API-ROLE": "manufacturing-engineer"})
                            for call in calls if "/api/BillOfMaterials" in call[1]))
        self.assertTrue(all(call[2] == "functions-token"
                            for call in calls if "/api/manufacturing/parts/" in call[1]))

        with patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "http", return_value=(200, {}, b'{"value":[{"ProductID":1,"MakeFlag":true}]}')):
            with self.assertRaises(auth.EvidenceError):
                auth.manufacturing_content_candidate(deployment, "functions-token", "dab-token")

        def malformed_bom(method, url, *, token=None, headers=None):
            body = ({"value": [products[0]]} if "/api/Product?" in url else
                    {"value": [{"ProductAssemblyID": True, "StartDate": "2000-01-01", "EndDate": None}]})
            return 200, {}, json.dumps(body).encode()

        with patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "http", side_effect=malformed_bom):
            with self.assertRaisesRegex(auth.EvidenceError, "BOM discovery returned invalid rows"):
                auth.manufacturing_content_candidate(deployment, "functions-token", "dab-token")

    def test_manufacturing_content_canary_denials_and_output_are_fail_closed(self):
        metadata = "https://mcp.example.test/.well-known/oauth-protected-resource"
        denials = [
            (status, {"WWW-Authenticate": f'Bearer resource_metadata="{metadata}", error="{error}"'},
             json.dumps({"error": error}).encode())
            for status, error in [(401, "missing_token"), (401, "invalid_token"), (403, "insufficient_scope")]
        ]
        body = {"status": "draft-awaiting-instruction-review", "agentId": "manufacturing-agent",
                "sourceFingerprint": "a" * 64, "responseId": "private-response",
                "grounding": {"product": {"productId": 2}}, "draft": {"summary": "private draft"},
                "instructionsXml": "<private />", "diagramReservations": []}
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_MCP_URL": "https://mcp.example.test/mcp",
            "AI_AGENT_MANUFACTURING_CONTENT_ID": "manufacturing-agent"}[key])
        report = auth.Report(Path("."))
        with patch.object(auth, "manufacturing_content_candidate", return_value=2), \
                patch.object(auth, "http", side_effect=[*denials, (200, {}, json.dumps(body).encode())]) as request:
            auth.manufacturing_content_agent_authorization(report, deployment, "functions", "reduced", "dab")
        self.assertEqual(request.call_count, 4)
        self.assertEqual([call.kwargs["data"] for call in request.call_args_list],
                         [{"productId": 0}] * 3 + [{"productId": 2}])
        self.assertEqual([item["status"] for item in report.checks], ["PASS"] * 5)
        self.assertEqual(report._manufacturing_content_response_hash,
                         hashlib.sha256(b"private-response").hexdigest())
        self.assertNotIn("private", json.dumps([report.checks, report.inventory]))

        report = auth.Report(Path("."))
        with patch.object(auth, "manufacturing_content_candidate", return_value=2), \
                patch.object(auth, "http", side_effect=[denials[0], (200, {}, b'{}')]) as request:
            with self.assertRaises(auth.EvidenceError):
                auth.manufacturing_content_agent_authorization(report, deployment, "functions", "reduced", "dab")
        self.assertEqual(request.call_count, 2)
        self.assertEqual(report.checks[-1]["status"], "FAIL")

        report = auth.Report(Path("."))
        with patch.object(auth, "manufacturing_content_candidate",
                          side_effect=auth.EvidenceError("No eligible fixture")), \
                patch.object(auth, "http", side_effect=denials) as request:
            with self.assertRaisesRegex(auth.EvidenceError, "No eligible fixture"):
                auth.manufacturing_content_agent_authorization(report, deployment, "functions", "reduced", "dab")
        self.assertEqual(request.call_count, 3)
        self.assertEqual([item["status"] for item in report.checks], ["PASS"] * 3)

        report = auth.Report(Path("."))
        with patch.object(auth, "manufacturing_content_candidate", return_value=2), \
                patch.object(auth, "http", side_effect=[*denials, (409, {}, b'{}')]) as request:
            auth.manufacturing_content_agent_authorization(report, deployment, "functions", "reduced", "dab")
        self.assertEqual(request.call_count, 4)
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

        body["grounding"]["product"]["productId"] = 3
        report = auth.Report(Path("."))
        with patch.object(auth, "manufacturing_content_candidate", return_value=2), \
                patch.object(auth, "http", side_effect=[*denials, (200, {}, json.dumps(body).encode())]):
            auth.manufacturing_content_agent_authorization(report, deployment, "functions", "reduced", "dab")
        self.assertEqual(report.checks[-1]["status"], "FAIL")
        self.assertIsNone(report._manufacturing_content_response_hash)

        model_body = dict(body, grounding={"model": {"productModelId": 9}})
        no_part = auth.EvidenceError("No usable manufacturing content candidate was found")
        for model_id, supplement, expected in [(9, False, "PASS"), (8, False, "FAIL"), (9, True, "PASS")]:
            report = auth.Report(Path("."))
            with patch.object(auth, "manufacturing_content_candidate", side_effect=no_part), \
                    patch.object(auth, "manufacturing_model_candidate", return_value=(model_id, supplement)), \
                    patch.object(auth, "http", side_effect=[*denials, (200, {}, json.dumps(model_body).encode())]) \
                    as request:
                auth.manufacturing_content_agent_authorization(report, deployment, "functions", "reduced", "dab")
            self.assertTrue(request.call_args_list[-1].args[1].endswith("/api/manufacturing/content/instructions/generate"))
            expected_data = {"productModelId": model_id}
            if supplement:
                expected_data["supplementExistingInstructions"] = True
            self.assertEqual(request.call_args_list[-1].kwargs["data"], expected_data)
            self.assertEqual(report.checks[-1]["status"], expected)

    def test_manufacturing_model_candidate_requires_variant_english_description_and_effective_bom(self):
        deployment = SimpleNamespace(required=lambda key: {"API_URL": "https://dab.example.test/graphql/"}[key])
        helper = SimpleNamespace(IDENTITIES={"manufacturing": ("", "", "", "", "manufacturing-engineer")})
        calls = []

        def request(method, url, *, token=None, headers=None):
            calls.append((method, url, token, headers))
            parsed = urllib.parse.urlsplit(url)
            query = urllib.parse.parse_qs(parsed.query).get("$filter", [""])[0]
            entity = parsed.path.rsplit("/", 1)[-1]
            if entity == "ProductModel":
                body = {"value": [{"ProductModelID": 1}, {"ProductModelID": 2}, {"ProductModelID": 3}]}
            elif entity == "Product":
                model = int(query.split()[2])
                body = {"value": [] if model == 1 else [{"ProductID": 10 * model, "MakeFlag": True,
                                                         "ProductModelID": model}]}
            elif entity == "ProductModelProductDescriptionCulture":
                model = int(query.split()[-1])
                body = {"value": [{"ProductModelID": model, "CultureID": "en    " if model == 3 else "fr    "}]}
            else:
                body = {"value": [{"ProductAssemblyID": 30, "StartDate": "2000-01-01T00:00:00", "EndDate": None}]}
            return 200, {}, json.dumps(body).encode()

        with patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "http", side_effect=request):
            self.assertEqual(auth.manufacturing_model_candidate(deployment, "dab-token"), (3, False))
        self.assertTrue(all(call[0] == "GET" and call[2] == "dab-token" and
                            call[3] == {"X-MS-API-ROLE": "manufacturing-engineer"} for call in calls))

        with patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "http", return_value=(200, {}, b'{"value":[]}')):
            with self.assertRaisesRegex(auth.EvidenceError, "No usable manufacturing model candidate"):
                auth.manufacturing_model_candidate(deployment, "dab-token")

    def test_manufacturing_model_candidate_falls_back_to_diagram_free_supplement(self):
        deployment = SimpleNamespace(required=lambda key: {"API_URL": "https://dab.example.test/graphql/"}[key])
        helper = SimpleNamespace(IDENTITIES={"manufacturing": ("", "", "", "", "manufacturing-engineer")})
        ns = auth.MANUFACTURING_INSTRUCTIONS_NAMESPACE
        documents = [{"ProductModelID": 5, "Instructions": f'<root xmlns="{ns}"><Location><step><diag/></step></Location></root>'},
                     {"ProductModelID": 6, "Instructions": "<root><!DOCTYPE x></root>"},
                     {"ProductModelID": 7, "Instructions": f'<root xmlns="{ns}"><Location><step>Cut</step></Location></root>'}]

        def request(method, url, *, token=None, headers=None):
            parsed = urllib.parse.urlsplit(url)
            query = urllib.parse.parse_qs(parsed.query).get("$filter", [""])[0]
            entity = parsed.path.rsplit("/", 1)[-1]
            if entity == "ProductModel":
                body = {"value": [{"ProductModelID": 1}] if "eq null" in query else documents}
            elif entity == "Product":
                model = int(query.split()[2])
                body = {"value": [] if model == 1 else [{"ProductID": 10 * model, "MakeFlag": True,
                                                         "ProductModelID": model}]}
            elif entity == "ProductModelProductDescriptionCulture":
                body = {"value": [{"ProductModelID": int(query.split()[-1]), "CultureID": "en    "}]}
            else:
                body = {"value": [{"ProductAssemblyID": 70, "StartDate": "2000-01-01T00:00:00", "EndDate": None}]}
            return 200, {}, json.dumps(body).encode()

        with patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "http", side_effect=request):
            self.assertEqual(auth.manufacturing_model_candidate(deployment, "dab-token"), (7, True))

    def test_manufacturing_content_profile_requires_opt_in_and_verified_reduced_scope(self):
        report = auth.Report(Path("."))
        with patch.object(auth, "internal_token") as token:
            auth.manufacturing_content_agent_tests(report, SimpleNamespace())
        token.assert_not_called()
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

        helper = SimpleNamespace(
            claims=lambda _: {"category": "manufacturing", "aud": "functions-audience",
                              "scope": "manufacturing.read"},
            AuthError=ValueError)
        deployment = SimpleNamespace(runtime=None)
        report = auth.Report(Path("."))
        with patch.object(auth, "internal_token", side_effect=["functions", "dab", "reduced"]) as token, \
                patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "internal_token_target", return_value=("base", "functions-audience")), \
                patch.object(auth.time, "sleep") as sleep, \
                patch.object(auth, "manufacturing_content_agent_authorization") as scenario, \
                patch.object(auth, "foundry_response_identity"), \
                patch.object(auth, "data_supplied_tool_suppression"):
            auth.manufacturing_content_agent_tests(report, deployment, allow_agent_canary=True)
        self.assertEqual([call.args[1:] for call in token.call_args_list],
                         [("manufacturing", "functions"), ("manufacturing", "dab"),
                          ("manufacturing", "functions")])
        self.assertEqual(token.call_args_list[-1].kwargs["scopes"], "manufacturing.read")
        self.assertEqual(sleep.call_count, 2)
        scenario.assert_called_once_with(report, deployment, "functions", "reduced", "dab")

        helper.claims = lambda _: {"category": "manufacturing", "aud": ["functions-audience"],
                                   "scope": "manufacturing.read"}
        report = auth.Report(Path("."))
        with patch.object(auth, "internal_token", side_effect=["functions", "dab", "reduced"]), \
                patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "internal_token_target", return_value=("base", "functions-audience")), \
                patch.object(auth.time, "sleep"), \
                patch.object(auth, "manufacturing_content_agent_authorization") as scenario, \
                patch.object(auth, "foundry_response_identity"), \
                patch.object(auth, "data_supplied_tool_suppression"):
            auth.manufacturing_content_agent_tests(report, deployment, allow_agent_canary=True)
        scenario.assert_called_once()

        helper.claims = lambda _: {"category": "manufacturing", "aud": ["functions-audience", "other-audience"],
                                   "scope": "manufacturing.read"}
        report = auth.Report(Path("."))
        with patch.object(auth, "internal_token", side_effect=["functions", "dab", "reduced"]), \
                patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "internal_token_target", return_value=("base", "functions-audience")), \
                patch.object(auth.time, "sleep"), \
                patch.object(auth, "manufacturing_content_agent_authorization") as scenario:
            auth.manufacturing_content_agent_tests(report, deployment, allow_agent_canary=True)
        scenario.assert_not_called()
        self.assertIn("FAIL", [item["status"] for item in report.checks])

        helper.claims = lambda _: {"category": "manufacturing", "aud": "functions-audience",
                                   "scope": "manufacturing.read manufacturing.write"}
        report = auth.Report(Path("."))
        with patch.object(auth, "internal_token", side_effect=["functions", "dab", "reduced"]), \
                patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "internal_token_target", return_value=("base", "functions-audience")), \
                patch.object(auth.time, "sleep"), \
                patch.object(auth, "manufacturing_content_agent_authorization") as scenario:
            auth.manufacturing_content_agent_tests(report, deployment, allow_agent_canary=True)
        scenario.assert_not_called()
        self.assertIn("FAIL", [item["status"] for item in report.checks])
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

    def test_manufacturing_content_profile_cli_requires_matching_opt_in(self):
        with self.assertRaises(SystemExit):
            auth.main(["--chat", "--manufacturing-content-agent-canary"])
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "report")
            deployment = SimpleNamespace(values={"AZURE_ENV_NAME": "demo"})
            with patch.object(auth, "command", return_value=""), \
                    patch.object(auth, "Deployment", return_value=deployment), \
                    patch.object(auth, "record_deployment_origin_inventory"), \
                    patch.object(auth, "manufacturing_content_agent_tests") as scenario:
                self.assertEqual(auth.main(["--manufacturing-content-agent", "--manufacturing-content-agent-canary",
                                            "--environment", "demo", "--output", output]), 0)
            self.assertTrue(scenario.call_args.kwargs["allow_agent_canary"])
            self.assertEqual(json.loads((Path(output) / "report.json").read_text())["provenance"]["profile"],
                             "manufacturing-content-agent")

    def test_product_content_canary_checks_continuation_boundaries_and_withholds_content(self):
        metadata = "https://mcp.example.test/.well-known/oauth-protected-resource"
        denials = [
            (status, {"WWW-Authenticate": f'Bearer resource_metadata="{metadata}", error="{error}"'},
             json.dumps({"error": error}).encode())
            for status, error in [(401, "missing_token"), (401, "invalid_token"), (403, "insufficient_scope")]
        ]
        initial = (200, {}, b'{"productName":"private generated name","productDescription":"private content","threadId":"resp-owner"}')
        denied = (403, {}, b'{"error":"conversation_not_available"}')
        continued = (200, {}, b'{"productName":"private refined name","threadId":"resp-next"}')
        report = auth.Report(Path("."))
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_MCP_URL": "https://mcp.example.test/mcp"}[key])
        with patch.object(auth, "http", side_effect=[*denials, initial, denied, denied, denied, continued]) as http:
            auth.product_content_agent_authorization(report, deployment, "admin", "manufacturing", "dab")
        self.assertEqual([check["status"] for check in report.checks], ["PASS"] * 8)
        self.assertEqual(http.call_count, 8)
        requests = [call.kwargs["data"] for call in http.call_args_list]
        self.assertRegex(requests[0]["subcategory"], r"^authassurance_[a-f0-9]{32}$")
        self.assertEqual(requests[4]["previousThreadId"], "resp-owner")
        self.assertRegex(requests[5]["previousResponseId"], r"^resp_authassurance_[a-f0-9]{32}$")
        self.assertEqual(len(requests[6]["previousResponseId"]), len("resp-owner"))
        self.assertTrue(requests[6]["previousResponseId"].startswith("resp-"))
        self.assertNotEqual(requests[6]["previousResponseId"], "resp-owner")
        self.assertEqual(requests[7]["previousResponseId"], "resp-owner")
        self.assertEqual(report._product_content_response_hash, hashlib.sha256(b"resp-owner").hexdigest())
        stored = json.dumps([report.checks, report.inventory])
        self.assertNotIn("private", stored)
        self.assertNotIn("resp-owner", stored)
        self.assertNotIn(requests[0]["subcategory"], stored)

        report = auth.Report(Path("."))
        with patch.object(auth, "http", side_effect=[*denials, initial, (200, {}, b'{"suggestion":{}}')]) as http:
            with self.assertRaises(auth.EvidenceError):
                auth.product_content_agent_authorization(report, deployment, "admin", "manufacturing", "dab")
        self.assertEqual(http.call_count, 5)
        self.assertEqual(report.checks[-1]["status"], "FAIL")

        for preceding in ([denied], [denied, denied]):
            report = auth.Report(Path("."))
            with self.subTest(preceding=len(preceding)), \
                    patch.object(auth, "http", side_effect=[*denials, initial, *preceding, (500, {}, b'{}')]) as http:
                with self.assertRaises(auth.EvidenceError):
                    auth.product_content_agent_authorization(report, deployment, "admin", "manufacturing", "dab")
            self.assertEqual(http.call_count, 5 + len(preceding))
            self.assertEqual(report.checks[-1]["status"], "FAIL")

    def test_product_content_profile_requires_opt_in_and_control_tokens(self):
        report = auth.Report(Path("."))
        with patch.object(auth, "internal_token") as token, patch.object(auth, "http") as http:
            auth.product_content_agent_tests(report, SimpleNamespace())
        token.assert_not_called()
        http.assert_not_called()
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

        report = auth.Report(Path("."))
        deployment = SimpleNamespace(runtime=None)
        with patch.object(auth, "internal_token", side_effect=["admin", "manufacturing", "dab"]), \
                patch.object(auth, "product_content_agent_authorization") as scenario, \
                patch.object(auth, "foundry_response_identity") as identity:
            auth.product_content_agent_tests(report, deployment, allow_agent_canary=True)
        scenario.assert_called_once_with(report, deployment, "admin", "manufacturing", "dab")
        identity.assert_called_once_with(report, deployment, "product-content")
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

    def test_product_content_cli_requires_matching_explicit_opt_in(self):
        with self.assertRaises(SystemExit):
            auth.main(["--chat", "--product-content-agent-canary"])
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "report")
            deployment = SimpleNamespace(values={"AZURE_ENV_NAME": "demo"})
            with patch.object(auth, "command", return_value=""), \
                    patch.object(auth, "Deployment", return_value=deployment), \
                    patch.object(auth, "record_deployment_origin_inventory"), \
                    patch.object(auth, "product_content_agent_tests") as product:
                self.assertEqual(auth.main(["--product-content-agent", "--product-content-agent-canary",
                                            "--environment", "demo", "--output", output]), 0)
            self.assertTrue(product.call_args.kwargs["allow_agent_canary"])
            self.assertEqual(json.loads((Path(output) / "report.json").read_text())["provenance"]["profile"],
                             "product-content-agent")

    def test_email_content_agent_canary_requires_denials_and_never_exports_generated_content(self):
        metadata = "https://mcp.example.test/.well-known/oauth-protected-resource"
        responses = [
            (status, {"WWW-Authenticate": f'Bearer resource_metadata="{metadata}", error="{error}"'},
             json.dumps({"error": error}).encode())
            for status, error in [(401, "missing_token"), (401, "invalid_token"), (403, "insufficient_scope")]
        ]
        responses.append((200, {}, b'{"subject":"private generated subject","body":"private generated body"}'))
        report = auth.Report(Path("."))
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_MCP_URL": "https://mcp.example.test/mcp"}[key])
        with patch.object(auth, "http", side_effect=responses) as http:
            auth.email_content_agent_authorization(report, deployment, "admin", "manufacturing", "dab")
        self.assertEqual([check["status"] for check in report.checks], ["PASS"] * 4)
        self.assertEqual(http.call_count, 4)
        payloads = [call.kwargs["data"] for call in http.call_args_list]
        self.assertTrue(all(payload == payloads[0] for payload in payloads))
        self.assertEqual(payloads[0]["firstName"], "Demo")
        self.assertRegex(payloads[0]["templateType"], r"^authassurance_[a-f0-9]{32}$")
        stored = json.dumps([report.checks, report.inventory])
        self.assertNotIn(payloads[0]["templateType"], stored)
        self.assertNotIn("private generated", stored)

        report = auth.Report(Path("."))
        with patch.object(auth, "http", return_value=(200, {}, b'{"Subject":"unexpected"}')) as http:
            with self.assertRaises(auth.EvidenceError):
                auth.email_content_agent_authorization(report, deployment, "admin", "manufacturing", "dab")
        self.assertEqual(http.call_count, 1)
        self.assertEqual(report.checks[-1]["status"], "FAIL")

        report = auth.Report(Path("."))
        failure = responses[:3] + [(200, {}, b'{"subject":null,"body":null,"error":"unavailable"}')]
        with patch.object(auth, "http", side_effect=failure):
            auth.email_content_agent_authorization(report, deployment, "admin", "manufacturing", "dab")
        self.assertEqual(report.checks[-1]["status"], "FAIL")

    def test_analysis_empty_input_controls_are_pinned_and_leave_valid_inference_blocked(self):
        metadata = "https://mcp.example.test/.well-known/oauth-protected-resource"
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_MCP_URL": "https://mcp.example.test/mcp"}[key])
        cases = [
            ("AnalyzeReviewsBatch", "review-analysis", "reviews/analyze-batch", "admin.write",
             "reviews", "reviews array is required and must not be empty"),
            ("AnalyzeCartRecovery", "cart-recovery", "carts/analyze-recovery", "admin.read",
             "carts", "carts array is required and must not be empty"),
        ]
        for name, profile, route, scope, field, message in cases:
            with self.subTest(name=name):
                function = {"Name": name, "Route": route, "Methods": ["POST"],
                            "Policy": {"FunctionName": name, "IsAnonymous": False, "Tier": "Internal",
                                       "Mode": "InternalOnly", "RequiredScope": scope, "OwnershipKey": None}}
                def report_with_controls(entries):
                    report = auth.Report(Path("."))
                    report.inventory["functions"] = entries
                    report.check("allow:admin:dab", "live-allows", True, "DAB token accepted")
                    report.check("allow:manufacturing:functions", "live-allows", True, "Functions token accepted")
                    return report

                report = report_with_controls([function])
                responses = [(400, {}, json.dumps({"error": message}).encode())]
                responses.extend([
                    (status, {"WWW-Authenticate": f'Bearer resource_metadata="{metadata}", error="{error}"'},
                     json.dumps({"error": error}).encode())
                    for status, error in [(401, "missing_token"), (401, "invalid_token"),
                                          (403, "insufficient_scope")]
                ])
                responses.append((
                    401, {"WWW-Authenticate": f'Bearer resource_metadata="{metadata}", error="invalid_token"'},
                    b'{"error":"invalid_token","error_description":"The access token is invalid."}'))
                with patch.object(auth, "http", side_effect=responses) as http:
                    auth.analysis_empty_input_authorization(report, deployment, name, "admin", "manufacturing", "dab")
                self.assertEqual(http.call_count, 5)
                self.assertEqual([call.kwargs["token"] for call in http.call_args_list],
                                 ["admin", None, "dab", "manufacturing", "invalid-auth-validation-token"])
                self.assertTrue(all(call.kwargs["data"] == {field: []} for call in http.call_args_list))
                self.assertTrue(all(call.args == ("POST", "https://functions.example.test/api/" + route)
                                    for call in http.call_args_list))
                statuses = {check["id"]: check["status"] for check in report.checks}
                self.assertEqual(statuses[f"agent:{profile}:empty-input-control"], "PASS")
                self.assertEqual(statuses[f"agent:{profile}:empty-input:deny-forged"], "PASS")
                self.assertEqual(statuses[f"agent:{profile}:valid-input"], "BLOCKED")
                self.assertEqual(sum(status == "PASS" for key, status in statuses.items()
                                     if key.startswith("agent:")), 5)

                for defect in ["duplicate", "route", "methods", "scope", "anonymous", "category"]:
                    with self.subTest(name=name, defect=defect):
                        entry = copy.deepcopy(function)
                        if defect == "route":
                            entry["Route"] += "/changed"
                        elif defect == "methods":
                            entry["Methods"].append("GET")
                        elif defect == "scope":
                            entry["Policy"]["RequiredScope"] = "products.read"
                        elif defect == "anonymous":
                            entry["Policy"]["IsAnonymous"] = True
                        elif defect == "category":
                            entry["Policy"]["Mode"] = "Any"
                        entries = [entry, copy.deepcopy(entry)] if defect == "duplicate" else [entry]
                        report = report_with_controls(entries)
                        with patch.object(auth, "http") as http, self.assertRaises(auth.EvidenceError) as error:
                            auth.analysis_empty_input_authorization(report, deployment, name, "admin", "manufacturing", "dab")
                        self.assertRegex(str(error.exception), "binding|policy")
                        http.assert_not_called()

                for defect in ["missing", "failed", "wrong-group", "duplicate"]:
                    with self.subTest(name=name, control=defect):
                        report = report_with_controls([function])
                        if defect == "missing":
                            report.checks.pop(0)
                        elif defect == "failed":
                            report.checks[0]["status"] = "FAIL"
                        elif defect == "wrong-group":
                            report.checks[0]["group"] = "preflight"
                        else:
                            report.checks.append(report.checks[0].copy())
                        with patch.object(auth, "http") as http, self.assertRaises(auth.EvidenceError) as error:
                            auth.analysis_empty_input_authorization(report, deployment, name, "admin", "manufacturing", "dab")
                        self.assertIn("controls are incomplete", str(error.exception))
                        http.assert_not_called()

                report = report_with_controls([function])
                with patch.object(auth, "http", return_value=(200, {}, b'{"analyses":[]}')) as http:
                    with self.assertRaises(auth.EvidenceError):
                        auth.analysis_empty_input_authorization(report, deployment, name, "admin", "manufacturing", "dab")
                http.assert_called_once()
                self.assertEqual(report.checks[-1]["status"], "FAIL")

                report = report_with_controls([function])
                with patch.object(auth, "http", side_effect=[responses[0], (200, {}, b'{}')]) as http:
                    with self.assertRaises(auth.EvidenceError):
                        auth.analysis_empty_input_authorization(report, deployment, name, "admin", "manufacturing", "dab")
                self.assertEqual(http.call_count, 2)
                self.assertEqual(report.checks[-1]["status"], "FAIL")

    def test_analysis_canary_requires_preflight_and_denials_before_synthetic_input(self):
        metadata = "https://mcp.example.test/.well-known/oauth-protected-resource"
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_MCP_URL": "https://mcp.example.test/mcp"}[key])
        for name, profile, route, scope, field, result_field in [
                ("AnalyzeReviewsBatch", "review-analysis", "reviews/analyze-batch",
                 "admin.write", "reviews", "analyses"),
                ("AnalyzeCartRecovery", "cart-recovery", "carts/analyze-recovery",
                 "admin.read", "carts", "strategies")]:
            with self.subTest(name=name):
                def make_report():
                    report = auth.Report(Path("."))
                    report.inventory["functions"] = [{
                        "Name": name, "Route": route, "Methods": ["POST"],
                        "Policy": {"FunctionName": name, "IsAnonymous": False, "Tier": "Internal",
                                   "Mode": "InternalOnly", "RequiredScope": scope, "OwnershipKey": None},
                    }]
                    for check_id in ["allow:admin:dab", "allow:manufacturing:functions"]:
                        report.add(check_id, "live-allows", "PASS", "Positive control.")
                    report.add(f"agent:{profile}:empty-input-control", "agents", "PASS", "Empty input.")
                    for label in ["anonymous", "wrong-audience", "insufficient-scope", "forged"]:
                        report.add(f"agent:{profile}:empty-input:deny-{label}", "agents", "PASS", "Denied.")
                    return report

                denials = [
                    (status, {"WWW-Authenticate": f'Bearer resource_metadata="{metadata}", error="{error}"'},
                     json.dumps({"error": error}).encode())
                    for status, error in [(401, "missing_token"), (401, "invalid_token"),
                                          (403, "insufficient_scope")]
                ]
                forged = (401, {"WWW-Authenticate": f'Bearer resource_metadata="{metadata}", error="invalid_token"'},
                          b'{"error":"invalid_token","error_description":"The access token is invalid."}')
                calls = []

                def request(method, url, **kwargs):
                    calls.append((method, url, kwargs))
                    if len(calls) <= 3:
                        return denials[len(calls) - 1]
                    if len(calls) == 4:
                        return forged
                    fixture = kwargs["data"][field][0]
                    result = ({"productReviewId": fixture["productReviewId"], "sentiment": "positive",
                               "flags": [], "suggestedResponse": "private-generated-content"}
                              if name == "AnalyzeReviewsBatch" else
                              {"cartId": fixture["cartId"], "recoveryScore": 50, "urgency": "medium",
                               "emailBody": "private-generated-content"})
                    return 200, {}, json.dumps({result_field: [result]}).encode()

                report = make_report()
                with patch.object(auth, "http", side_effect=request):
                    auth.analysis_agent_authorization(report, deployment, name, "admin", "manufacturing", "dab",
                                                      allow_agent_canary=True)
                self.assertEqual(len(calls), 5)
                self.assertEqual([call[2]["token"] for call in calls],
                                 [None, "dab", "manufacturing", "invalid-auth-validation-token", "admin"])
                self.assertTrue(all(call[0] == "POST" and call[1].endswith("/api/" + route) for call in calls))
                self.assertTrue(all(call[2]["data"] == calls[0][2]["data"] for call in calls))
                self.assertEqual(report.checks[-1]["status"], "PASS")
                self.assertNotIn("private-generated-content", json.dumps([report.checks, report.inventory]))
                self.assertNotIn("authassurance_", json.dumps([report.checks, report.inventory]))

                report = make_report()
                report.checks.pop()
                with patch.object(auth, "http") as http:
                    with self.assertRaises(auth.EvidenceError):
                        auth.analysis_agent_authorization(report, deployment, name, "admin", "manufacturing", "dab",
                                                          allow_agent_canary=True)
                    http.assert_not_called()
                with patch.object(auth, "http") as http:
                    with self.assertRaises(auth.EvidenceError):
                        auth.analysis_agent_authorization(make_report(), deployment, name, "admin",
                                                          "manufacturing", "dab")
                    http.assert_not_called()

                report = make_report()
                with patch.object(auth, "http", return_value=(200, {}, b'{}')) as http:
                    with self.assertRaises(auth.EvidenceError):
                        auth.analysis_agent_authorization(report, deployment, name, "admin", "manufacturing", "dab",
                                                          allow_agent_canary=True)
                self.assertEqual(http.call_count, 1)
                self.assertEqual(report.checks[-1]["status"], "FAIL")

    def test_analysis_profile_requires_opt_in_and_positive_controls(self):
        report = auth.Report(Path("."))
        with patch.object(auth, "internal_token") as token, patch.object(auth, "http") as http:
            auth.analysis_agent_tests(report, SimpleNamespace())
        token.assert_not_called()
        http.assert_not_called()
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

        report = auth.Report(Path("."))
        tokens = {("admin", "functions"): "admin", ("manufacturing", "functions"): "manufacturing",
                  ("admin", "dab"): "dab"}
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_URL": "https://dab.example.test/graphql/"}[key])
        helper = SimpleNamespace(IDENTITIES={"admin": (None, None, None, None, "executive-admin")})
        with patch.object(auth, "data_supplied_agent_control_tokens", return_value=tokens), \
                patch.object(auth, "reviewed_function_read_url", return_value="https://functions.example.test/read"), \
                patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "http", return_value=(401, {}, b'{}')) as http, \
                patch.object(auth, "analysis_empty_input_authorization") as empty, \
                patch.object(auth, "analysis_agent_authorization") as scenario:
            auth.analysis_agent_tests(report, deployment, allow_agent_canary=True)
        http.assert_called_once()
        empty.assert_not_called()
        scenario.assert_not_called()
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

    def test_analysis_profile_runs_both_guarded_canaries_after_positive_controls(self):
        report = auth.Report(Path("."))
        tokens = {("admin", "functions"): "admin", ("manufacturing", "functions"): "manufacturing",
                  ("admin", "dab"): "dab"}
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_URL": "https://dab.example.test/graphql/"}[key])
        helper = SimpleNamespace(IDENTITIES={"admin": (None, None, None, None, "executive-admin")})

        def empty(current, _, name, *args, **kwargs):
            profile = "review-analysis" if name == "AnalyzeReviewsBatch" else "cart-recovery"
            self.assertFalse(kwargs["add_valid_input_blocker"])
            current.add(f"agent:{profile}:empty-input-control", "agents", "PASS", "Empty input.")
            for label in ["anonymous", "wrong-audience", "insufficient-scope", "forged"]:
                current.add(f"agent:{profile}:empty-input:deny-{label}", "agents", "PASS", "Denied.")

        responses = [(200, {}, b'{"queueDepth":0}'),
                     (200, {}, b'{"data":{"products":{"items":[{"ProductID":1}]}}}')]
        with patch.object(auth, "data_supplied_agent_control_tokens", return_value=tokens) as token, \
                patch.object(auth, "reviewed_function_read_url", return_value="https://functions.example.test/read"), \
                patch.object(auth, "load_auth_helper", return_value=helper), \
                patch.object(auth, "http", side_effect=responses) as http, \
                patch.object(auth, "analysis_empty_input_authorization", side_effect=empty) as empty_check, \
                patch.object(auth, "analysis_agent_authorization") as scenario, \
                patch.object(auth, "foundry_response_identity") as identity, \
                patch.object(auth, "data_supplied_tool_suppression") as suppression:
            auth.analysis_agent_tests(report, deployment, allow_agent_canary=True)
        self.assertTrue(token.call_args.kwargs["pace"])
        self.assertEqual(http.call_count, 2)
        self.assertEqual(empty_check.call_count, 2)
        self.assertEqual(scenario.call_count, 2)
        self.assertTrue(all(call.kwargs["allow_agent_canary"] for call in scenario.call_args_list))
        self.assertEqual([call.args[2] for call in identity.call_args_list], ["review-analysis", "cart-recovery"])
        self.assertEqual([call.args[2] for call in suppression.call_args_list], ["review-analysis", "cart-recovery"])

    def test_analysis_canary_cli_requires_its_focused_opt_in(self):
        with self.assertRaises(SystemExit):
            auth.main(["--chat", "--analysis-agent-canary"])
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "report")
            deployment = SimpleNamespace(values={"AZURE_ENV_NAME": "demo"})
            with patch.object(auth, "ROOT", Path(directory)), \
                    patch.object(auth, "command", return_value=""), \
                    patch.object(auth, "Deployment", return_value=deployment), \
                    patch.object(auth, "record_deployment_origin_inventory"), \
                    patch.object(auth, "export_inventory"), \
                    patch.object(auth, "analysis_agent_tests") as analysis:
                self.assertEqual(auth.main(["--analysis-agent", "--analysis-agent-canary",
                                            "--environment", "demo", "--output", output]), 0)
            self.assertTrue(analysis.call_args.kwargs["allow_agent_canary"])
            self.assertEqual(json.loads((Path(output) / "report.json").read_text())["provenance"]["profile"],
                             "analysis-agent")

    def test_email_content_agent_profile_requires_opt_in_and_all_control_tokens(self):
        report = auth.Report(Path("."))
        with patch.object(auth, "internal_token") as token, patch.object(auth, "http") as http:
            auth.email_content_agent_tests(report, SimpleNamespace())
        token.assert_not_called()
        http.assert_not_called()
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

        report = auth.Report(Path("."))
        deployment = SimpleNamespace(runtime=None)
        with patch.object(auth, "internal_token", side_effect=["admin", "manufacturing", "dab"]), \
                patch.object(auth, "email_content_agent_authorization") as scenario, \
                patch.object(auth, "foundry_response_identity") as identity:
            auth.email_content_agent_tests(report, deployment, allow_agent_canary=True)
        scenario.assert_called_once_with(report, deployment, "admin", "manufacturing", "dab")
        identity.assert_called_once_with(report, deployment, "email-content")
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

        report = auth.Report(Path("."))
        with patch.object(auth, "internal_token", side_effect=auth.EvidenceError("Missing control")), \
                patch.object(auth, "email_content_agent_authorization") as scenario:
            auth.email_content_agent_tests(report, deployment, allow_agent_canary=True)
        scenario.assert_not_called()
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

    def test_email_content_agent_cli_requires_matching_explicit_opt_in(self):
        with self.assertRaises(SystemExit):
            auth.main(["--chat", "--email-content-agent-canary"])
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "report")
            deployment = SimpleNamespace(values={"AZURE_ENV_NAME": "demo"})
            with patch.object(auth, "command", return_value=""), \
                    patch.object(auth, "Deployment", return_value=deployment), \
                    patch.object(auth, "record_deployment_origin_inventory"), \
                    patch.object(auth, "email_content_agent_tests") as email:
                self.assertEqual(auth.main(["--email-content-agent", "--email-content-agent-canary",
                                            "--environment", "demo", "--output", output]), 0)
            self.assertTrue(email.call_args.kwargs["allow_agent_canary"])
            self.assertEqual(json.loads((Path(output) / "report.json").read_text())["provenance"]["profile"],
                             "email-content-agent")

        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "report")
            deployment = SimpleNamespace(values={"AZURE_ENV_NAME": "demo"})
            with patch.object(auth, "ROOT", Path(directory)), \
                    patch.object(auth, "command", return_value=""), \
                    patch.object(auth, "Deployment", return_value=deployment), \
                    patch.object(auth, "record_deployment_origin_inventory"), \
                    patch.object(auth, "export_inventory"), \
                    patch.object(auth, "contracts"), \
                    patch.object(auth, "live") as live:
                self.assertEqual(auth.main(["--live", "--email-content-agent-canary", "--product-content-agent-canary",
                                            "--environment", "demo", "--output", output]), 0)
            self.assertTrue(live.call_args.kwargs["allow_email_content_agent_canary"])
            self.assertTrue(live.call_args.kwargs["allow_product_content_agent_canary"])

    def test_promotion_agent_profile_requires_opt_in_and_all_control_tokens(self):
        report = auth.Report(Path("."))
        with patch.object(auth, "internal_token") as token, patch.object(auth, "http") as http:
            auth.promotion_agent_tests(report, SimpleNamespace())
        token.assert_not_called()
        http.assert_not_called()
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

        report = auth.Report(Path("."))
        deployment = SimpleNamespace(runtime=None)
        with patch.object(auth, "internal_token", side_effect=["admin", "manufacturing", "dab"]) as token, \
                patch.object(auth, "promotion_agent_authorization") as scenario, \
                patch.object(auth, "foundry_response_identity") as identity:
            auth.promotion_agent_tests(report, deployment, allow_agent_canary=True)
        self.assertEqual([call.args[1:] for call in token.call_args_list],
                         [("admin", "functions"), ("manufacturing", "functions"), ("admin", "dab")])
        scenario.assert_called_once_with(report, deployment, "admin", "manufacturing", "dab",
                                         allow_agent_canary=True)
        identity.assert_called_once_with(report, deployment, "promotion-suggestion")

        report = auth.Report(Path("."))
        with patch.object(auth, "internal_token", side_effect=auth.EvidenceError("Missing control")), \
                patch.object(auth, "promotion_agent_authorization") as scenario:
            auth.promotion_agent_tests(report, deployment, allow_agent_canary=True)
        scenario.assert_not_called()
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

    def test_promotion_agent_cli_requires_matching_explicit_opt_in(self):
        with self.assertRaises(SystemExit):
            auth.main(["--chat", "--promotion-agent-canary"])
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "report")
            deployment = SimpleNamespace(values={"AZURE_ENV_NAME": "demo"})
            with patch.object(auth, "command", return_value=""), \
                    patch.object(auth, "Deployment", return_value=deployment), \
                    patch.object(auth, "record_deployment_origin_inventory"), \
                    patch.object(auth, "promotion_agent_tests") as promotion:
                self.assertEqual(auth.main(["--promotion-agent", "--promotion-agent-canary",
                                            "--environment", "demo", "--output", output]), 0)
            self.assertTrue(promotion.call_args.kwargs["allow_agent_canary"])
            self.assertEqual(json.loads((Path(output) / "report.json").read_text())["provenance"]["profile"],
                             "promotion-agent")

        for profile in ["--live", "--all"]:
            for enabled in [False, True]:
                with self.subTest(profile=profile, enabled=enabled), tempfile.TemporaryDirectory() as directory:
                    output = str(Path(directory) / "report")
                    deployment = SimpleNamespace(values={"AZURE_ENV_NAME": "demo"})
                    args = [profile, "--environment", "demo", "--output", output]
                    if enabled:
                        args.append("--promotion-agent-canary")
                    with patch.object(auth, "ROOT", Path(directory)), \
                            patch.object(auth, "command", return_value=""), \
                            patch.object(auth, "Deployment", return_value=deployment), \
                            patch.object(auth, "record_deployment_origin_inventory"), \
                            patch.object(auth, "export_inventory"), \
                            patch.object(auth, "offline_tests"), \
                            patch.object(auth, "contracts"), \
                            patch.object(auth, "infra"), \
                            patch.object(auth, "live") as live:
                        self.assertEqual(auth.main(args), 0)
                    self.assertIs(live.call_args.kwargs["allow_promotion_agent_canary"], enabled)

    def test_foundry_identity_accumulates_partial_telemetry_without_double_counting(self):
        client_id = "00000000-0000-4000-8000-000000000001"
        client_hash = hashlib.sha256(client_id.encode()).hexdigest()
        identity_id = "/subscriptions/test/identities/runtime"
        values = {"AI_AGENT_HELP_ME_CHOOSE_ID": "help-agent", "AZURE_RESOURCE_GROUP": "group",
                  "SERVICE_API_FUNCTIONS_NAME": "functions", "USER_MANAGED_IDENTITY_NAME": "runtime",
                  "API_FUNCTIONS_URL": "https://functions.example.test",
                  "AI_FOUNDRY_PROJECT_ENDPOINT": "https://foundry.example.test/api/projects/demo"}
        settings = [{"name": name, "value": value} for name, value in {
            "AZURE_CLIENT_ID": client_id, "AzureWebJobsStorage__clientId": client_id,
            "AI_FOUNDRY_PROJECT_ENDPOINT": values["AI_FOUNDRY_PROJECT_ENDPOINT"],
            "AI_AGENT_HELP_ME_CHOOSE_ID": "help-agent"}.items()]
        responses = iter([
            [["a" * 32, "help-agent:1", "match", client_hash, 1]],
            [["a" * 32, "help-agent:1", "match", client_hash, 2]],
            [["b" * 32, "help-agent:1", "match", client_hash, 1]],
        ])
        report = auth.Report(Path("."))
        for phase in ("questions", "recommendations"):
            report.add("agent:helpme-choose:anonymous-" + phase, "agents", "PASS", "Valid response.")
        report.inventory["helpMeChooseTraceIds"] = {"questions": "a" * 32, "recommendations": "b" * 32}

        def azure(*args):
            if args[:2] == ("functionapp", "show"):
                return {"defaultHostName": "functions.example.test",
                        "identity": {"userAssignedIdentities": {identity_id: {}}}}
            if args[:2] == ("identity", "show"):
                return {"id": identity_id, "clientId": client_id}
            if args[:4] == ("functionapp", "config", "appsettings", "list"):
                return settings
            if args[:2] == ("resource", "list"):
                return ["app"]
            return {"tables": [{"columns": [{"name": name} for name in
                ["TraceId", "AgentVersionId", "ClientMatch", "ClientHash", "Hits"]],
                                "rows": next(responses)}]}

        deployment = SimpleNamespace(required=lambda key: values[key], azure=azure, runtime=None)
        with patch.object(auth.time, "sleep") as sleep:
            auth.foundry_response_identity(report, deployment, "helpme-choose")
        self.assertEqual(report.checks[-1]["status"], "PASS")
        self.assertEqual([call.args for call in sleep.call_args_list], [(20,), (20,)])
        observations = {item["phase"]: item["matches"] for item in report.inventory["helpme-chooseFoundryIdentity"]}
        self.assertEqual(observations, {"questions": 2, "recommendations": 1})

    def test_catalog_agent_cli_routes_the_explicit_canary_without_running_the_live_suite(self):
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "report")
            deployment = SimpleNamespace(values={"AZURE_ENV_NAME": "demo"})
            with patch.object(auth, "command", return_value=""), \
                    patch.object(auth, "Deployment", return_value=deployment), \
                    patch.object(auth, "record_deployment_origin_inventory"), \
                    patch.object(auth, "catalog_agent_tests") as catalog, \
                    patch.object(auth, "live") as live:
                self.assertEqual(auth.main(["--catalog-agent", "--public-agent-canary",
                                            "--environment", "demo", "--output", output]), 0)
            self.assertTrue(catalog.call_args.kwargs["allow_agent_canary"])
            live.assert_not_called()
            self.assertEqual(json.loads((Path(output) / "report.json").read_text())["provenance"]["profile"],
                             "catalog-agent")

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
                self.assertEqual(len(queries), 1 if expected is None else 4)
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

    def test_agent_correlation_retries_partial_telemetry_and_accumulates_exact_tools(self):
        report = auth.Report(Path("."))
        report.add("agent:helpme-choose:anonymous-recommendations", "agents", "PASS", "Valid response.")
        report.inventory["helpMeChooseTraceIds"] = {"questions": "a" * 32, "recommendations": "b" * 32}
        values = {"AI_AGENT_HELP_ME_CHOOSE_ID": "help-agent", "AZURE_RESOURCE_GROUP": "group",
                  "USER_MANAGED_IDENTITY_NAME": "runtime"}
        responses = iter([
            [],
            [["help-agent:1", "search_products", 1]],
            [["help-agent:1", "search_products", 2], ["help-agent:1", "get_product_details", 1]],
            [["help-agent:1", "find_complementary_products", 1],
             ["help-agent:1", "get_categories_with_products", 1]],
        ])
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
        self.assertEqual(len(queries), 4)
        self.assertEqual([call.args for call in sleep.call_args_list], [(20,), (20,), (20,)])
        observed = report.inventory["helpMeChooseCorrelatedTools"]
        self.assertEqual({item["tool"] for item in observed}, auth.PUBLIC_CATALOG_TOOLS)
        self.assertEqual(next(item["matches"] for item in observed if item["tool"] == "search_products"), 2)

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
            }}, "https://mcp.example.test/mcp", "https://dab.example.test/mcp")
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

        for defect in ["version", "origin", "endpoint", "summary-endpoint", "definition",
                       "duplicate-edge", "wrong-blocker"]:
            with self.subTest(defect=defect):
                report = make_report()
                report.inventory["helpMeChooseCorrelatedTools"] = [
                    {"version": "help-agent:1", "tool": "search_products", "matches": 1}]
                if defect == "version":
                    report.inventory["helpMeChooseCorrelatedTools"][0]["version"] = "help-agent:2"
                elif defect == "origin":
                    next(edge for edge in report.inventory["agentDependencyEdges"]
                         if edge["tool"] == "search_products")["toOrigin"] = "https://other.example.test"
                elif defect == "endpoint":
                    next(edge for edge in report.inventory["agentDependencyEdges"]
                         if edge["tool"] == "search_products")["toEndpointSha256"] = "wrong-path"
                elif defect == "summary-endpoint":
                    report.inventory["deployedAgentVersions"][0]["tools"][0]["targetEndpointSha256"] = "wrong-path"
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
            "https://mcp.example.test/mcp",
            "https://dab.example.test/mcp",
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
            }}, "https://mcp.example.test/mcp", "https://dab.example.test/mcp")

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

    def test_agent_inventory_classifies_only_the_exact_selected_mcp_endpoint(self):
        configured = "https://mcp.example.test/mcp"
        for target, expected in [
                (configured, "custom-mcp"), ("https://MCP.EXAMPLE.TEST:443/mcp/", "custom-mcp"),
                ("https://mcp.example.test/other", "unclassified"),
                ("https://mcp.example.test/private-path-value", "unclassified"),
                ("https://mcp.example.test/mcp/other", "unclassified"),
                ("https://mcp.example.test/mcp?token=private-value", "unclassified"),
                ("https://mcp.example.test/mcp#fragment", "unclassified"),
                ("https://@mcp.example.test/mcp", "unclassified"),
                ("https://mcp.example.test/a/../mcp", "unclassified"),
                ("https://mcp.example.test:0/mcp", "unclassified"),
                ("https://mcp.example.test/mcp//", "unclassified")]:
            with self.subTest(target=target):
                tool = {"type": "mcp", "server_label": "demo", "server_url": target,
                        "allowed_tools": ["search"]}
                summary = auth.summarize_agent_version(
                    "agent", "1", {"definition": {"kind": "prompt", "tools": [tool]}},
                    configured, "https://dab.example.test/mcp")
                self.assertEqual(summary["tools"][0]["resource"], expected)
                self.assertNotIn("private-value", json.dumps(summary))
                self.assertNotIn("private-path-value", json.dumps(summary))

    def test_agent_inventory_rejects_top_level_static_authorization_without_exporting_it(self):
        tool = {"type": "mcp", "server_label": "demo", "server_url": "https://mcp.example.test/mcp",
                "allowed_tools": ["search"], "authorization": "private-token"}
        summary = auth.summarize_agent_version(
            "agent", "1", {"definition": {"kind": "prompt", "tools": [tool]}},
            "https://mcp.example.test/mcp", "https://dab.example.test/mcp")
        self.assertEqual(auth.agent_header_status(summary["tools"][0]), "FAIL")
        self.assertNotIn("private-token", json.dumps(summary))

    def test_agent_static_credential_headers_fail_without_exporting_values(self):
        tool = {"type": "mcp", "server_label": "demo", "server_url": "https://mcp.example.test/mcp",
                "allowed_tools": ["search"]}
        for headers, status in [
                ({}, "PASS"), ({"Authorization": "secret-value"}, "FAIL"),
                ({"X-API-Key": "secret-value"}, "FAIL"),
                ({"Cookie": "secret-value"}, "FAIL"),
                ({"Ocp-Apim-Subscription-Key": "secret-value"}, "FAIL"),
                ({"X-Unreviewed": "secret-value"}, "BLOCKED")]:
            with self.subTest(headers=list(headers)):
                summary = auth.summarize_agent_version(
                    "agent", "1", {"definition": {"kind": "prompt", "tools": [{**tool, "headers": headers}]}},
                    "https://mcp.example.test/mcp", "https://dab.example.test/mcp")
                self.assertEqual(auth.agent_header_status(summary["tools"][0]), status)
                self.assertNotIn("secret-value", json.dumps(summary))
        for bad in [{"type": ""}, {"type": "bad tool"}, {**tool, "server_label": "  "}]:
            with self.subTest(tool=bad), self.assertRaises(auth.EvidenceError):
                auth.summarize_agent_version(
                    "agent", "1", {"definition": {"kind": "prompt", "tools": [bad]}},
                    "https://mcp.example.test/mcp", "https://dab.example.test/mcp")

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
        }, "https://mcp.example.test/mcp", "https://dab.example.test/mcp")
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
                name, version, {"definition": definition}, "https://mcp.example.test/mcp",
                "https://dab.example.test/mcp")
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

    def test_mcp_service_profiles_require_the_selected_distinct_instance_principals(self):
        functions = "b2b35cbf-5e15-4f4a-a2c2-7f450bb88b39"
        hosted = "46d650b8-8ee8-44aa-a7ba-5b917737fa5b"
        configuration = {
            "MCP_FUNCTIONS_PRINCIPAL_ID": functions.upper(),
            "MCP_HOSTED_MANUFACTURING_PRINCIPAL_ID": hosted,
        }
        self.assertTrue(auth.mcp_service_profiles_match(configuration, functions, hosted))
        for invalid, runtime, agent in [
                ({}, functions, hosted),
                ({**configuration, "MCP_FUNCTIONS_PRINCIPAL_ID": hosted}, functions, hosted),
                ({**configuration, "MCP_HOSTED_MANUFACTURING_PRINCIPAL_ID": functions}, functions, hosted),
                ({**configuration, "MCP_HOSTED_MANUFACTURING_PRINCIPAL_ID": "invalid"}, functions, hosted),
                (configuration, functions, functions),
                (configuration, functions, None),
        ]:
            with self.subTest(configuration=invalid, runtime=runtime, hosted=agent):
                self.assertFalse(auth.mcp_service_profiles_match(invalid, runtime, agent))

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

    def test_foundry_data_role_must_be_the_approved_builtin_at_project_scope(self):
        project = ("/subscriptions/test/resourceGroups/demo/providers/Microsoft.CognitiveServices/"
                   "accounts/ai/projects/project")
        rule = json.loads(auth.CONTRACTS.read_text())["runtimeFoundryDataRole"]
        role = {"roleDefinitionName": rule["roleName"],
                "roleDefinitionId": "/roles/" + rule["roleDefinitionId"], "scope": project}
        self.assertTrue(auth.foundry_data_role_assignment_matches_source([role], project))
        for assignments in [
                [role, {**role, "scope": project + "/child"}],
                [{**role, "roleDefinitionName": "Foundry Project Manager"}],
                [role, {"roleDefinitionName": "AdventureWorks Foundry Agents Reader", "scope": project}],
                [{**role, "scope": project.rsplit("/", 1)[0]}],
                [{"roleDefinitionName": None, "scope": project}]]:
            with self.subTest(assignments=assignments):
                self.assertFalse(auth.foundry_data_role_assignment_matches_source(
                    assignments, project))

    def test_foundry_builtin_role_assignments_match_exact_account_and_project_scopes(self):
        account = "/subscriptions/test/resourceGroups/demo/providers/Microsoft.CognitiveServices/accounts/ai"
        project = account + "/projects/project"
        assignments = [
            {"roleDefinitionName": "Cognitive Services OpenAI User", "scope": account},
            {"roleDefinitionName": "Azure AI Developer", "scope": account},
            {"roleDefinitionName": "Azure AI Developer", "scope": project},
            {"roleDefinitionName": "Cognitive Services Data Contributor (Preview)", "scope": project},
        ]
        self.assertTrue(auth.foundry_builtin_role_assignments_match_source(
            assignments, account, project))
        for invalid in [
                assignments + [{"roleDefinitionName": "Azure AI Developer", "scope": "/"}],
                assignments + [assignments[0]],
                assignments + [{"roleDefinitionName": "Cognitive Services Data Contributor (Preview)",
                                "scope": account}],
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
                  "resource": "custom-mcp", "allowedTools": ["get_order_details", "search_products"]}
        dab = {"type": "mcp", "server": "dabmcp", "allowedTools": ["read_record"]}
        self.assertTrue(auth.agent_tool_allowlist_matches(source["eshop-chat-agent"], [custom]))
        self.assertFalse(auth.agent_tool_allowlist_matches(
            source["eshop-chat-agent"], [{**custom, "resource": "unclassified"}]))
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


class DabWriteDecisionTests(unittest.TestCase):
    CONFIG = json.loads((auth.ROOT / "api/dab-config.json").read_text())

    def test_inheritance_resolves_named_then_authenticated_then_anonymous(self):
        entity = {"permissions": [{"role": "anonymous", "actions": ["read"]},
                                  {"role": "authenticated", "actions": ["read", "create"]},
                                  {"role": "sales-admin", "actions": ["read"]}]}
        self.assertEqual(auth.dab_effective_permission(entity, "sales-admin")["role"], "sales-admin")
        self.assertEqual(auth.dab_effective_permission(entity, "consumer")["role"], "authenticated")
        self.assertEqual(auth.dab_effective_permission({"permissions": entity["permissions"][:1]},
                                                       "consumer")["role"], "anonymous")
        self.assertIsNone(auth.dab_effective_permission({"permissions": []}, "anonymous"))

    def test_source_config_classifies_every_cell_without_violations(self):
        cells, violations = auth.dab_write_decision_violations(self.CONFIG)
        self.assertEqual(violations, [])
        self.assertEqual(len(cells), len(self.CONFIG["entities"]) * len(auth.DAB_ROLES) * 3)
        allowed = {(c["entity"], c["role"], c["operation"]) for c in cells if c["decision"] == "allow"}
        self.assertIn(("ProductReview", "consumer", "update"), allowed)
        self.assertNotIn(("SalesOrderHeader", "manufacturing-engineer", "create"), allowed)

    def mutate(self, change):
        config = copy.deepcopy(self.CONFIG)
        change(config["entities"])
        return auth.dab_write_decision_violations(config)[1]

    def test_unsafe_grants_are_rejected(self):
        def anonymous_write(entities):
            entities["Product"]["permissions"].append({"role": "anonymous", "actions": ["read", "delete"]})
        def unscoped_consumer(entities):
            for permission in entities["PersonPhone"]["permissions"]:
                if permission["role"] in {"consumer", "authenticated"}:
                    for action in permission["actions"]:
                        if isinstance(action, dict):
                            action.pop("policy", None)
        def view_write(entities):
            entities["ProductSearch"]["permissions"].append({"role": "executive-admin", "actions": ["create"]})
        def manufacturing_sales(entities):
            entities["SalesOrderHeader"]["permissions"].append(
                {"role": "manufacturing-engineer", "actions": ["read", "update"]})
        def claim_free_inheritance(entities):
            entities["ProductReview"]["permissions"] = [
                item for item in entities["ProductReview"]["permissions"] if item["role"] != "manufacturing-engineer"]
        for change, text in [(claim_free_inheritance, "fail-closed owner policy"), (anonymous_write, "anonymous"), (unscoped_consumer, "owner policy"),
                             (view_write, "read-only"), (manufacturing_sales, "Production")]:
            with self.subTest(text=text):
                self.assertTrue(any(text in item for item in self.mutate(change)))
        config = copy.deepcopy(self.CONFIG)
        config["entities"]["Product"]["permissions"].append({"role": "auditor", "actions": ["read"]})
        with self.assertRaises(auth.EvidenceError):
            auth.dab_write_decisions(config)

    def run_matrix(self, responder):
        deployment = SimpleNamespace(required=lambda key: "https://dab.example.test/graphql/")
        consumer = SimpleNamespace(label="A", token=lambda *args: "consumer-token")
        config = {"entities": {"Product": copy.deepcopy(self.CONFIG["entities"]["Product"])}}
        with tempfile.TemporaryDirectory() as root, \
                patch.object(auth.Path, "read_text", return_value=json.dumps(config)), \
                patch.object(auth, "graphql_update_selectors",
                             return_value={"Product": "updateProduct(ProductID: -1, item: {})"}), \
                patch.object(auth, "http", side_effect=responder):
            report = auth.Report(Path(root))
            auth.dab_write_role_matrix(report, deployment, "admin-token", "mfg-token", [consumer])
            return report

    @staticmethod
    def response(status, code, message, graphql=False):
        document = ({"errors": [{"message": message, "extensions": {"code": code}}]} if graphql else
                    {"error": {"code": code, "message": message}})
        return status, {}, json.dumps(document).encode()

    def honest(self):
        entity = self.CONFIG["entities"]["Product"]
        decisions = {(c["role"], c["operation"]): c["decision"]
                     for c in auth.dab_write_decisions({"entities": {"Product": entity}})}
        operations = {"POST": {"create"}, "PATCH": {"create", "update"}, "DELETE": {"delete"}}
        def respond(method, url, *, token=None, data=None, headers=None):
            role = (headers or {}).get("X-MS-API-ROLE", "anonymous")
            if "/graphql" in url:
                self.assertIn("updateProduct(ProductID: -1, item: {})", data["query"])
                if auth.dab_graphql_update_allowed(entity, role):
                    return self.response(200, "BadRequest", "Update mutation does not update any values", True)
                return self.response(200, "AUTH_NOT_AUTHENTICATED" if token is None else "AUTH_NOT_AUTHORIZED",
                                     "The current user is not authorized to access this resource.", True)
            if all(decisions[(role, operation)] == "allow" for operation in operations[method]):
                return self.response(400, "InvalidIdentifierField",
                                     "Primary key column: NotAColumn not found in the entity definition.")
            return self.response(403, "AuthorizationCheckFailed", "Authorization Failure: Access Not Allowed.")
        return respond

    def test_live_matrix_passes_on_exact_authorization_outcomes(self):
        report = self.run_matrix(self.honest())
        self.assertEqual(len(report.checks), 5 * 4)
        self.assertEqual({item["status"] for item in report.checks}, {"PASS"})
        self.assertTrue(any(item["group"] == "live-allows" for item in report.checks))
        self.assertTrue(any(item["group"] == "live-denials" for item in report.checks))

    def test_live_matrix_fails_when_denied_cell_reaches_validation(self):
        def leak(method, url, **kwargs):
            if "/graphql" in url:
                return self.response(200, "BadRequest", "Update mutation does not update any values", True)
            return self.response(400, "InvalidIdentifierField",
                                 "Primary key column: NotAColumn not found in the entity definition.")
        report = self.run_matrix(leak)
        failed = {item["id"] for item in report.checks if item["status"] == "FAIL"}
        self.assertIn("dab:write-role:Product:anonymous:rest-delete", failed)
        self.assertIn("dab:write-role:Product:A:graphql-update", failed)
        self.assertNotIn("dab:write-role:Product:admin:rest-delete", failed)

    def test_transport_failure_retries_once_then_blocks(self):
        honest = self.honest()
        calls = []
        def flaky(method, url, **kwargs):
            calls.append(url)
            if len(calls) == 1:
                raise auth.EvidenceError("Network/TLS/timeout failure; not an authorization denial")
            return honest(method, url, **kwargs)
        self.assertEqual({item["status"] for item in self.run_matrix(flaky).checks}, {"PASS"})
        def down(*args, **kwargs):
            raise auth.EvidenceError("Network/TLS/timeout failure; not an authorization denial")
        self.assertEqual({item["status"] for item in self.run_matrix(down).checks}, {"BLOCKED"})

    def test_internal_tokens_renew_before_expiry_with_paced_logins(self):
        clock = [100.0]
        issued = []
        def login(deployment, identity, resource):
            issued.append((identity, clock[0]))
            return f"{identity}-{len(issued)}"
        def sleep(seconds):
            clock[0] += seconds
        with patch.object(auth, "internal_token", side_effect=login), \
                patch.object(auth.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(auth.time, "sleep", side_effect=sleep):
            admin, manufacturing = auth.renewing_internal_tokens(object(), ["admin", "manufacturing"], "dab",
                                                                 max_age=60)
            self.assertEqual((admin(), manufacturing()), ("admin-1", "manufacturing-2"))
            interval = json.loads((auth.ROOT / "tests/auth/browser-policy.json").read_text())[
                "internalLoginMinimumIntervalMs"] / 1000
            self.assertGreaterEqual(issued[1][1] - issued[0][1], interval)
            clock[0] += 61
            self.assertEqual(admin(), "admin-3")
            self.assertEqual(len(issued), 3)

    def test_reconcile_requires_complete_pass_evidence(self):
        with tempfile.TemporaryDirectory() as root:
            report = auth.Report(Path(root))
            report.add("required:dab-all-role-operation-decisions", "required", "BLOCKED", "pending")
            report.add("contract:dab:write-decisions", "contracts", "PASS", "ok")
            report.inventory.update({"dabWriteRoleMatrix": [{}], "dabReadRoleMatrix": [{}]})
            report.add("dab:read-role:X:anonymous", "live-denials", "PASS", "ok")
            report.add("dab:role-header:A:sales-admin:rest", "live-denials", "PASS", "ok")
            auth.reconcile_dab_operation_requirement(report)
            self.assertEqual(report.checks[0]["status"], "BLOCKED")
            report.add("dab:write-role:X:anonymous:rest-create", "live-denials", "PASS", "ok")
            auth.reconcile_dab_operation_requirement(report)
            self.assertEqual(report.checks[0]["status"], "PASS")
            report.add("dab:write-role:X:anonymous:rest-delete", "live-denials", "FAIL", "leak")
            auth.reconcile_dab_operation_requirement(report)
            self.assertEqual(report.checks[0]["status"], "FAIL")


class OwnershipHandlerTests(unittest.TestCase):
    def test_continuation_closure_matches_source_and_flags_unknown_callers(self):
        services, handlers, workers, unknown = auth.continuation_handler_closure()
        self.assertEqual(len(services), 4)
        self.assertEqual((handlers, workers, unknown),
                         (auth.CONTINUATION_HANDLERS, auth.CONTINUATION_WORKERS, set()))
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            (base / "api-functions/Services").mkdir(parents=True)
            (base / "api-functions/Functions").mkdir(parents=True)
            (base / "api-functions/Services/NewAgentService.cs").write_text(
                "Task Run(string? previousResponseId = null, string? conversationOwner = null)")
            (base / "api-functions/Functions/NewAgentFunction.cs").write_text(
                "_svc.Run(body.PreviousResponseId); // NewAgentService")
            (base / "api-functions/Functions/AutoPromotionQueueTrigger.cs").write_text(
                "NewAgentService.Run(previousResponseId: msg.Id)")
            _, handlers, workers, unknown = auth.continuation_handler_closure(base)
            self.assertEqual((handlers, workers), (set(), set()))
            self.assertEqual(unknown, {"NewAgentFunction", "AutoPromotionQueueTrigger"})

    def test_chat_continuation_gate_requires_every_named_case(self):
        prefix = "ApiFunctions.Tests.FoundryAgentClientTests."
        names = [prefix + name for name in [
            "Chat_resumes_only_responses_owned_by_the_same_subject_and_agent",
            "Chat_handler_binds_conversations_to_the_validated_token_subject_not_the_body",
            "Product_content_handler_binds_initial_and_resumed_conversations_to_the_validated_subject",
            "Promotion_handler_binds_resumed_conversations_to_the_validated_subject",
            "Order_agent_handler_denies_a_foreign_conversation_before_order_creation"]]
        for base, count in [("Externally_supplied_continuations_require_a_validated_owner_before_any_io", 3),
                            ("Invalid_conversation_metadata_is_denied_without_a_followup", 3),
                            ("Unavailable_conversation_identifiers_are_denied_without_a_followup", 2)]:
            names += [prefix + base + f"(case: {index})" for index in range(count)]
        def run(results):
            with tempfile.TemporaryDirectory() as root:
                report = auth.Report(Path(root))
                (Path(root) / "dotnet").mkdir()
                rows = "".join(f'<UnitTestResult testName={json.dumps(name)} outcome="{outcome}"/>'
                               for name, outcome in results)
                (Path(root) / "dotnet/f.trx").write_text(f"<TestRun><Results>{rows}</Results></TestRun>")
                auth.chat_continuation_ownership_evidence(report)
                return report.checks[0]["status"]
        self.assertEqual(run([(name, "Passed") for name in names]), "PASS")
        self.assertEqual(run([(name, "Passed") for name in names[:-1]]), "BLOCKED")
        self.assertEqual(run([(name, "Passed") for name in names[1:]] + [(names[0], "Failed")]), "FAIL")

    def test_umbrella_requires_offline_gates_and_live_owner_rows(self):
        with tempfile.TemporaryDirectory() as root:
            report = auth.Report(Path(root))
            report.add("required:all-ownership-handlers-two-owners", "required", "BLOCKED", "pending")
            for check_id in auth.OWNERSHIP_DEPENDENCIES:
                report.add(check_id, "required", "PASS", "ok")
            auth.reconcile_ownership_handlers_requirement(report)
            self.assertEqual(report.checks[0]["status"], "BLOCKED")
            report.inventory["dabOwnerRows"] = [{}, {}]
            report.add("dab:owner-rows:graphql:X:consumer:A:own", "live-denials", "PASS", "ok")
            auth.reconcile_ownership_handlers_requirement(report)
            self.assertEqual(report.checks[0]["status"], "BLOCKED")
            report.add("dab:owner-rows:graphql:X:consumer:A:foreign-filter", "live-denials", "PASS", "ok")
            auth.reconcile_ownership_handlers_requirement(report)
            self.assertEqual(report.checks[0]["status"], "PASS")
            report.checks[1]["status"] = "FAIL"
            auth.reconcile_ownership_handlers_requirement(report)
            self.assertEqual(report.checks[0]["status"], "FAIL")

    def test_umbrella_accepts_customer_canary_rows_only_for_claim_blocked_cells(self):
        with tempfile.TemporaryDirectory() as root:
            report = auth.Report(Path(root))
            report.add("required:all-ownership-handlers-two-owners", "required", "BLOCKED", "pending")
            for check_id in auth.OWNERSHIP_DEPENDENCIES:
                report.add(check_id, "required", "PASS", "ok")
            report.inventory["dabOwnerRows"] = [{}, {}]
            report.add("dab:owner-rows:graphql:Y:consumer:A:own", "live-denials", "PASS", "ok")
            report.add("dab:owner-rows:graphql:X:consumer:A:own", "live-denials", "BLOCKED",
                       auth.OWNER_ROW_CLAIM_BLOCKER + " customer_id claims")
            auth.reconcile_ownership_handlers_requirement(report)
            self.assertEqual(report.checks[0]["status"], "BLOCKED")
            report.inventory["dabCustomerOwnerRows"] = [{}]
            report.add("dab:owner-rows-customer:graphql:X:consumer:A:own", "live-denials", "PASS", "ok")
            auth.reconcile_ownership_handlers_requirement(report)
            self.assertEqual(report.checks[0]["status"], "PASS")
            report.checks[-2]["detail"] = "DAB returned an unexpected error"
            auth.reconcile_ownership_handlers_requirement(report)
            self.assertEqual(report.checks[0]["status"], "BLOCKED")
            report.checks[-2]["detail"] = auth.OWNER_ROW_CLAIM_BLOCKER + " customer_id claims"
            report.checks[-1]["status"] = "FAIL"
            auth.reconcile_ownership_handlers_requirement(report)
            self.assertEqual(report.checks[0]["status"], "FAIL")

    def test_customer_owner_rows_filter_entities_and_key_owners_by_position(self):
        policy = {"role": "consumer", "actions": [{"action": "read", "policy": {
            "database": "@item.CustomerID eq @claims.customer_id"}}]}
        entities = {"Order": {"source": {"object": "Sales.Order"}, "permissions": [policy]},
                    "Cart": {"source": {"object": "Sales.Cart"}, "permissions": [{"role": "consumer", "actions": [
                        {"action": "read", "policy": {"database": "@item.OwnerID eq @claims.business_entity_id"}}]}]}}
        self.assertEqual(auth.dab_owner_policy_entities(entities, "customer_id"), {"Order"})
        schema = ("CREATE TABLE [Sales].[Order](\n    [CustomerID] [int] NOT NULL\n) ON [PRIMARY];\n"
                  "CREATE TABLE [Sales].[Cart](\n    [OwnerID] [int] NOT NULL\n) ON [PRIMARY];\n")
        def token(customer):
            payload = base64.urlsafe_b64encode(json.dumps({"customer_id": customer}).encode()).decode().rstrip("=")
            return "h." + payload + ".s"
        consumers = [SimpleNamespace(label=label, token=lambda *args, value=token(value): value)
                     for label, value in [("O", 7), ("F", 8)]]
        def fake_http(method, url, *, token=None, data=None, **kwargs):
            owner = 7 if token == consumers[0].token() else 8
            foreign = ("filter" in json.dumps(data)) if data else "%24filter" in url
            rows = [] if foreign else [{"CustomerID": owner}]
            return 200, {}, json.dumps({"value": rows} if method == "GET" else {"data": {"orders": {"items": rows}}})
        with tempfile.TemporaryDirectory() as root:
            report = auth.Report(Path(root))
            with patch.object(auth, "http", side_effect=fake_http):
                auth.dab_owner_row_isolation(report, "https://dab.test/graphql", entities,
                                             {"Order": "orders", "Cart": "carts"}, consumers, schema,
                                             only={"Order"}, prefix="dab:owner-rows-customer",
                                             inventory="dabCustomerOwnerRows")
                with self.assertRaises(auth.EvidenceError):
                    auth.dab_owner_row_isolation(report, "https://dab.test/graphql", entities, {}, consumers,
                                                 schema, only={"Missing"})
        ids = {item["id"] for item in report.checks}
        self.assertEqual(len(ids), 8)
        self.assertTrue(all(item.startswith("dab:owner-rows-customer:") and ":Order:" in item for item in ids))
        self.assertIn("dab:owner-rows-customer:graphql:Order:consumer:B:own", ids)
        self.assertEqual({item["status"] for item in report.checks}, {"PASS"})
        self.assertEqual(len(report.inventory["dabCustomerOwnerRows"]), 8)
        self.assertNotIn("dabOwnerRows", report.inventory)

    def test_owner_rows_detect_foreign_rows_and_accept_isolated_results(self):
        entities = {"Order": {"rest": True, "source": {"object": "Sales.Order"}, "permissions": [
            {"role": "consumer", "actions": [{"action": "read", "policy": {
                "database": "@item.CustomerID eq @claims.customer_id"}}]}]}}
        schema = "CREATE TABLE [Sales].[Order](\n    [CustomerID] [int] NOT NULL\n) ON [PRIMARY];\n"
        def token(customer):
            payload = base64.urlsafe_b64encode(json.dumps({"customer_id": customer}).encode()).decode().rstrip("=")
            return "h." + payload + ".s"
        consumers = [SimpleNamespace(label=label, token=lambda *args, value=token(value): value)
                     for label, value in [("A", 7), ("B", 8)]]
        def run(leak):
            def fake_http(method, url, *, token=None, headers=None, data=None, **kwargs):
                owner = 7 if token == consumers[0].token() else 8
                foreign = ("filter" in json.dumps(data)) if data else "%24filter" in url
                rows = [{"CustomerID": 15 - owner}] if foreign and leak else [] if foreign else [
                    {"CustomerID": owner}]
                body = {"value": rows} if method == "GET" else {"data": {"orders": {"items": rows}}}
                return 200, {}, json.dumps(body)
            with tempfile.TemporaryDirectory() as root:
                report = auth.Report(Path(root))
                with patch.object(auth, "http", side_effect=fake_http):
                    auth.dab_owner_row_isolation(report, "https://dab.test/graphql", entities,
                                                 {"Order": "orders"}, consumers, schema)
                return report, Counter(item["status"] for item in report.checks)
        report, counts = run(False)
        self.assertEqual(counts, Counter({"PASS": 8}))
        self.assertEqual(len(report.inventory["dabOwnerRows"]), 8)
        self.assertEqual(run(True)[1], Counter({"PASS": 4, "FAIL": 4}))

    def test_owner_row_filters_use_declared_column_type(self):
        schema = ("CREATE TABLE [Sales].[ShoppingCartItem](\n    [ShoppingCartItemID] [int] NOT NULL,\n"
                  "    [ShoppingCartID] [nvarchar](50) NOT NULL\n) ON [PRIMARY];\n")
        self.assertTrue(auth.dab_owner_column_is_text("Sales.ShoppingCartItem", "ShoppingCartID", schema))
        self.assertFalse(auth.dab_owner_column_is_text("Sales.ShoppingCartItem", "ShoppingCartItemID", schema))
        with self.assertRaises(auth.EvidenceError):
            auth.dab_owner_column_is_text("Sales.ShoppingCartItem", "Missing", schema)
        entities = {"ShoppingCartItem": {"source": {"object": "Sales.ShoppingCartItem"}, "permissions": [
            {"role": "consumer", "actions": [{"action": "read", "policy": {
                "database": "@item.ShoppingCartID eq @claims.business_entity_id"}}]}]}}
        def token(owner):
            payload = base64.urlsafe_b64encode(json.dumps({"business_entity_id": owner}).encode()).decode()
            return "h." + payload.rstrip("=") + ".s"
        consumers = [SimpleNamespace(label=label, token=lambda *args, value=token(value): value)
                     for label, value in [("A", 7), ("B", 8)]]
        requests = []
        def fake_http(method, url, *, data=None, **kwargs):
            requests.append(urllib.parse.unquote_plus(url) + json.dumps(data))
            return 200, {}, json.dumps({"value": [], "data": {"shoppingCartItems": {"items": []}}})
        with tempfile.TemporaryDirectory() as root:
            report = auth.Report(Path(root))
            with patch.object(auth, "http", side_effect=fake_http):
                auth.dab_owner_row_isolation(report, "https://dab.test/graphql", entities,
                                             {"ShoppingCartItem": "shoppingCartItems"}, consumers, schema)
        filters = [item for item in requests if "eq" in item]
        self.assertTrue(any('eq: \\"8\\"' in item for item in filters), filters)
        self.assertTrue(any("ShoppingCartID eq '8'" in item for item in filters), filters)
        self.assertFalse(any("eq: 8" in item or "eq 8" in item for item in filters), filters)

    def test_browser_suites_wait_out_helper_login_window(self):
        with patch.dict(auth.LAST_HELPER_LOGIN, {"at": 100.0}), \
                patch.object(auth.time, "monotonic", return_value=130.0), \
                patch.object(auth.time, "sleep") as sleep:
            auth.await_login_limiter_window()
        sleep.assert_called_once_with(auth.LOGIN_LIMITER_WINDOW_SECONDS - 30.0)
        with patch.dict(auth.LAST_HELPER_LOGIN, {"at": None}), patch.object(auth.time, "sleep") as sleep:
            auth.await_login_limiter_window()
        sleep.assert_not_called()


class SessionTransitionTests(unittest.TestCase):
    def test_matrix_follows_each_portals_exported_exchanges(self):
        with tempfile.TemporaryDirectory() as root:
            for app, extra in [("app-admin", "export function getMcpAccessToken() {}\n"), ("app-manufacturing", "")]:
                path = Path(root) / app / "src/services/dabAuth.ts"
                path.parent.mkdir(parents=True)
                path.write_text("export async function handleCallback() {}\n"
                                "export async function refreshAccessToken(force) {}\n"
                                "export function getFunctionsAccessToken(force) {}\n" + extra)
            matrix = auth.session_transition_matrix(Path(root))
        self.assertEqual(matrix, {"app-admin": ["callback", "functions", "mcp", "refresh"],
                                  "app-manufacturing": ["callback", "functions", "refresh"]})
        races, requests, browser = auth.session_transition_local_titles(matrix)
        self.assertIn("app-admin: stale MCP exchange 401 leaves a new session intact", races)
        self.assertNotIn("app-manufacturing: stale MCP exchange 401 leaves a new session intact", races)
        self.assertIn("admin: agent calls cannot dispatch or return across account switches", requests)
        self.assertEqual(len(browser), 12)

    def test_local_gate_requires_every_titled_case(self):
        races, requests, _ = auth.session_transition_local_titles(auth.session_transition_matrix())
        titles = sorted(races | requests)
        def run(lines):
            report = auth.Report(Path("."))
            with patch.object(auth, "command", return_value="".join(lines)):
                auth.internal_session_transition_evidence(report)
            return report.checks[0]["status"]
        passing = [f"ok {index} - {title}\n" for index, title in enumerate(titles, 1)]
        self.assertEqual(run(passing), "PASS")
        self.assertEqual(run(passing[1:]), "BLOCKED")
        self.assertEqual(run(passing + ["not ok 99 - app-admin: other\n"]), "FAIL")

    def test_reconcile_requires_local_deployed_and_accepted_exception(self):
        matrix = {"app-admin": ["mcp"], "app-manufacturing": ["refresh"]}
        def report_with(statuses, deployed_status="PASS"):
            report = auth.Report(Path("."))
            report.inventory["sessionTransitions"] = matrix
            report.add("required:internal-session-transition-races", "required", "BLOCKED", "pending")
            for check_id, status in statuses.items():
                report.add(check_id, "required", status, "x")
            cells = [f"{label}:concurrent-{kind}-{mode}-{suffix}"
                     for label, kind in [("admin", "mcp"), ("manufacturing", "refresh")]
                     for mode in ["success", "rejected"]
                     for suffix in ["server-response", "stale-response-ignored", "new-session-read"]]
            cells += [f"{label}:{name}" for label in ["admin", "manufacturing"] for name in
                      ["wrong-category-denied", "same-user-new-generation-owner", "stale-second-tab-no-adoption",
                       "logout-clears-resource-sessions", "same-origin-second-tab-signout"]]
            for index, cell in enumerate(cells):
                report.add(f"browser:internal:{index}", "frontend", deployed_status if index == 0 else "PASS", cell)
            auth.reconcile_session_transition_requirement(report)
            return report.checks[0]["status"]
        gates = {"required:internal-session-transition-local": "PASS", "browser:internal:cross-tab-local": "PASS",
                 "browser:internal:complete": "PASS",
                 "exception:session:deployed-distinct-user-switch": "ACCEPTED_EXCEPTION"}
        self.assertEqual(report_with(gates), "PASS")
        self.assertEqual(report_with(gates, deployed_status="BLOCKED"), "BLOCKED")
        self.assertEqual(report_with({**gates, "browser:internal:complete": "BLOCKED"}), "BLOCKED")
        self.assertEqual(report_with({key: value for key, value in gates.items()
                                      if not key.startswith("exception:")}), "BLOCKED")
        self.assertEqual(report_with({**gates, "required:internal-session-transition-local": "FAIL"}), "FAIL")


class ServiceClientCredentialTests(unittest.TestCase):
    def scan(self, source):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "api-functions/Services").mkdir(parents=True)
            (root / "api-functions/Services/S.cs").write_text(source)
            (root / "api-functions/bin").mkdir()
            (root / "api-functions/bin/Old.cs").write_text('new BlobServiceClient("UseDevelopmentStorage=true");')
            return auth.service_client_credential_violations(root)

    def test_token_credentials_pass(self):
        violations, clients = self.scan(
            "var bound = new SelectedIdentityCredential(credential, id);\n"
            "new TableServiceClient(new Uri(u), bound);\n"
            "new Azure.Storage.Queues.QueueServiceClient(new Uri(u), new Azure.Identity.DefaultAzureCredential());\n"
            "new SecretClient(vaultUri, sp.GetRequiredService<DefaultAzureCredential>());\n")
        self.assertEqual((violations, clients), ([], 3))

    def test_key_sas_and_connection_string_clients_fail(self):
        cases = {
            'new QueueClient(connStr, "q");': "QueueClient without a token credential",
            'new BlobServiceClient(Environment.GetEnvironmentVariable("AzureWebJobsStorage"));':
                "key/SAS/connection-string",
            "new EmailClient(new Uri(e), new AzureKeyCredential(k));": "key/SAS/connection-string",
            'var s = "AccountName=a;AccountKey=b";': "key/SAS/connection-string",
            "var token = bound;\nnew TableClient(new Uri(u), token);": "TableClient without a token credential",
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                violations, _ = self.scan(source)
                self.assertTrue(any(expected in item for item in violations), violations)

    def test_repository_service_clients_use_token_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            auth.service_client_credential_contract(report)
        check = next(item for item in report.checks if item["id"] == "contract:service-clients:token-credential")
        self.assertEqual(check["status"], "PASS", check["detail"])


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

    def test_unittest_failure_reports_case_names_without_other_output(self):
        result = SimpleNamespace(
            returncode=1,
            stdout="access_token=secret",
            stderr="FAIL: test_example (test_validate.ContractTests)\npassword=secret\n",
        )
        with patch.object(auth.subprocess, "run", return_value=result):
            with self.assertRaises(auth.EvidenceError) as error:
                auth.command(["python3", "-B", "-m", "unittest"])
        self.assertIn("FAIL: test_example (test_validate.ContractTests)", str(error.exception))
        self.assertNotIn("secret", str(error.exception))

    def test_browser_child_failure_reports_only_sanitized_categories_and_locations(self):
        result = SimpleNamespace(
            returncode=1, stdout="access_token=secret",
            stderr="route.fulfill: Target page, context or browser has been closed password=secret\n"
                   "at file:///private/test-internal-browser-auth.mjs:123:4\nhttps://private.example/",
        )
        with patch.object(auth.subprocess, "run", return_value=result):
            with self.assertRaises(auth.EvidenceError) as error:
                auth.command(["node", "tests/scripts/test-internal-browser-auth.mjs"])
        message = str(error.exception)
        self.assertIn("closed-target, route-fulfill", message)
        self.assertIn("test-internal-browser-auth.mjs:123:4", message)
        self.assertNotIn("secret", message)
        self.assertNotIn("private.example", message)

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
