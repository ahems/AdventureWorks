import copy
import importlib.util
import io
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("reconcile_rbac", ROOT / "scripts/utilities/reconcile-runtime-rbac.py")
rbac = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rbac)
PROBE_SPEC = importlib.util.spec_from_file_location("runtime_rbac_probe", ROOT / "tests/scripts/test-runtime-rbac.py")
probe = importlib.util.module_from_spec(PROBE_SPEC)
PROBE_SPEC.loader.exec_module(probe)


class RuntimeRoleTests(unittest.TestCase):
    def fixtures(self):
        group = "/subscriptions/test/resourceGroups/demo"
        acr, communication = (group + "/providers/Microsoft.ContainerRegistry/registries/registry",
                              group + "/providers/Microsoft.Communication/communicationServices/comms")

        def assignment(identifier, scope, principal="runtime", name=None):
            return {"id": scope + "/providers/Microsoft.Authorization/roleAssignments/" + (name or identifier),
                    "principalId": principal, "scope": scope, "roleDefinitionId": "/roles/" + identifier}

        def definition(identifier, name, scopes, actions):
            return {"name": identifier, "roleName": name, "assignableScopes": scopes,
                    "permissions": [{"actions": list(actions), "dataActions": [], "notActions": [], "notDataActions": []}]}

        definitions = [
            definition("email", "AdventureWorks Email Sender demo", [communication], rbac.EMAIL_ACTIONS),
            definition("legacy", "av-deployment-script-role-demo", [group], rbac.LEGACY_ACTIONS),
        ]
        assignments = [
            assignment(rbac.ACR_PULL, acr),
            assignment("email", communication),
            assignment(rbac.CONTRIBUTOR, acr),
            assignment(rbac.CONTRIBUTOR, communication),
            assignment(rbac.IDENTITY_OPERATOR, group),
            assignment("legacy", group),
            assignment(rbac.CONTRIBUTOR, communication, "administrator", "admin"),
            assignment(rbac.CONTRIBUTOR, group + "/providers/Microsoft.Storage/storageAccounts/other"),
            assignment("smb-role", group + "/providers/Microsoft.Storage/storageAccounts/storage"),
        ]
        return assignments, definitions, "runtime", group, acr, communication

    def test_only_four_exact_runtime_bindings_are_targeted_and_rerun_is_idempotent(self):
        values = self.fixtures()
        targets = rbac.retirement_plan(*values)
        self.assertEqual(len(targets), 4)
        self.assertEqual(targets, values[0][2:6])
        retained = [item for item in values[0] if item not in targets]
        self.assertEqual(rbac.retirement_plan(retained, *values[1:]), [])
        for field, replacement in [("principalId", "other"), ("scope", "/subscriptions/test/resourceGroups/other")]:
            changed = copy.deepcopy(values)
            for item in changed[0][2:6]:
                item[field] = replacement
            self.assertEqual(rbac.retirement_plan(*changed), [])

    def test_replacements_must_exist_with_exact_scope_permissions_and_principal(self):
        for mutation in ["no-pull", "no-email", "broad-email", "wrong-principal", "conditional-email", "extra-action"]:
            with self.subTest(mutation=mutation):
                assignments, definitions, *args = copy.deepcopy(self.fixtures())
                if mutation == "no-pull":
                    assignments.pop(0)
                elif mutation == "no-email":
                    assignments.pop(1)
                elif mutation == "broad-email":
                    definitions[0]["assignableScopes"] = [args[1]]
                elif mutation == "wrong-principal":
                    assignments[1]["principalId"] = "other"
                elif mutation == "conditional-email":
                    assignments[1]["condition"] = "unreviewed"
                else:
                    definitions[0]["permissions"][0]["actions"].append("Microsoft.Communication/*")
                with self.assertRaises(rbac.ReconciliationError):
                    rbac.retirement_plan(assignments, definitions, *args)

    def test_unexpected_legacy_definition_fails_instead_of_deleting_it(self):
        for key in ["actions", "dataActions", "notActions"]:
            with self.subTest(key=key):
                values = copy.deepcopy(self.fixtures())
                values[1][1]["permissions"][0][key].append("unexpected")
                with self.assertRaises(rbac.ReconciliationError):
                    rbac.retirement_plan(*values)

    def test_iac_does_not_recreate_runtime_management_grants(self):
        identity = (ROOT / "infra/modules/identity.bicep").read_text()
        acr = (ROOT / "infra/modules/acr.bicep").read_text()
        communication = (ROOT / "infra/modules/communication.bicep").read_text()
        self.assertNotIn("roleAssignments", identity)
        self.assertNotIn("roleDefinitions", identity)
        self.assertNotIn("roleAssignments", acr)
        self.assertNotIn("'Contributor'", acr)
        self.assertIn("resource communicationServiceAdminRoleAssignment", communication)
        self.assertIn("principalId: aadAdminObjectId", communication)
        self.assertIn("roleDefinitionId: emailSenderRole.id", communication)
        self.assertNotIn("principalId: identity.properties.principalId\n    principalType: 'ServicePrincipal'\n    roleDefinitionId:",
                         communication)
        self.assertIn("resource acrPullAssignment", (ROOT / "infra/modules/aca.bicep").read_text())
        hook = (ROOT / "scripts/hooks/postprovision.sh").read_text()
        self.assertIn('utilities/reconcile-runtime-rbac.py" --apply', hook)
        self.assertLess(hook.index('utilities/reconcile-runtime-rbac.py" --apply'), hook.index("Preparing the MCP"))
        self.assertIn('ensure_project_role "$_USER_OID" User "$_CUSTOM_ROLE_NAME"', hook)
        self.assertNotIn('ensure_project_role "$_MI_PRINCIPAL" ServicePrincipal "$_CUSTOM_ROLE_NAME"', hook)
        self.assertIn(r"^AdventureWorks\ Foundry\ Agents\ [a-z0-9]{13}$", hook)
        self.assertNotIn("contains(roleName", hook)
        self.assertIn("resource foundryAgentsProjectMiRoleAssignment",
                      (ROOT / "infra/modules/aiservices.bicep").read_text())

    def test_seed_readiness_checks_file_data_not_management_share_properties(self):
        source = (ROOT / "api-functions/Services/DependencyHealthService.cs").read_text()
        probe = source.split('yield return new("files",', 1)[1].split("foreach (var probe", 1)[0]
        self.assertIn("ShareTokenIntent.Backup", probe)
        self.assertIn("await client.GetRootDirectoryClient().GetPropertiesAsync(cancellationToken: ct)", probe)
        self.assertNotIn("await client.GetPropertiesAsync(", probe)


class RuntimePushProbeTests(unittest.TestCase):
    class CapturedInput(io.BytesIO):
        def close(self):
            self.value = self.getvalue()
            super().close()

    def test_receiver_preflight_binds_the_capability_and_keeps_it_out_of_process_arguments(self):
        deployment = SimpleNamespace(required=lambda key: {"API_FUNCTIONS_URL": "https://functions.example.test"}[key])
        helper = probe.auth.load_auth_helper()
        process = MagicMock()
        process.stdin = self.CapturedInput()
        host = "push.example.test"
        target = "/client/hubs/adventureworks?access_token=secret-capability"
        with patch.object(probe.auth, "selected_webpubsub_resource",
                          return_value=(host, {"disableAadAuth": False})), \
                patch.object(probe.auth, "load_auth_helper", return_value=helper), \
                patch.object(probe.auth, "internal_token_target",
                             return_value=("https://mcp.example.test", "https://mcp.example.test/functions")), \
                patch.object(helper, "session", return_value={"access_token": "secret-user-token"}), \
                patch.object(probe.auth, "http", return_value=(200, {}, b"capability")), \
                patch.object(probe.auth, "webpubsub_group_claims", return_value=({"utilities"}, 600)), \
                patch.object(probe.auth, "webpubsub_socket_target", return_value=target), \
                patch.object(probe.subprocess, "Popen", return_value=process) as popen, \
                patch.object(probe, "receiver_line", return_value="SOCKET_READY"):
            started, config = probe.start_webpubsub_receiver(deployment)
        self.assertIs(started, process)
        self.assertEqual(config["host"], host)
        payload = json.loads(process.stdin.value)
        self.assertEqual(payload["url"], "wss://" + host + target)
        self.assertEqual(payload["probeId"], config["probeId"])
        self.assertNotIn("secret", str(popen.call_args))

    def test_receiver_preflight_stops_before_launch_when_scope_lifetime_or_socket_is_invalid(self):
        deployment = SimpleNamespace(required=lambda key: {"API_FUNCTIONS_URL": "https://functions.example.test"}[key])
        helper = probe.auth.load_auth_helper()
        cases = [
            ({"orders"}, 600, "/client"),
            ({"utilities"}, 0, "/client"),
            ({"utilities"}, 3601, "/client"),
            ({"utilities"}, 600, probe.auth.EvidenceError("foreign target")),
        ]
        for groups, lifetime, target in cases:
            with self.subTest(groups=groups, lifetime=lifetime, target=target), \
                    patch.object(probe.auth, "selected_webpubsub_resource",
                                 return_value=("push.example.test", {"disableAadAuth": False})), \
                    patch.object(probe.auth, "load_auth_helper", return_value=helper), \
                    patch.object(probe.auth, "internal_token_target", return_value=("https://mcp.example.test", "audience")), \
                    patch.object(helper, "session", return_value={"access_token": "test-token"}), \
                    patch.object(probe.auth, "http", return_value=(200, {}, b"capability")), \
                    patch.object(probe.auth, "webpubsub_group_claims", return_value=(groups, lifetime)), \
                    patch.object(probe.auth, "webpubsub_socket_target",
                                 side_effect=target if isinstance(target, Exception) else None,
                                 return_value=target if isinstance(target, str) else None), \
                    patch.object(probe.subprocess, "Popen") as popen:
                with self.assertRaises(probe.auth.EvidenceError):
                    probe.start_webpubsub_receiver(deployment)
                popen.assert_not_called()

    def test_receiver_preflight_rejects_incomplete_sessions_before_negotiation(self):
        deployment = SimpleNamespace(required=lambda key: "https://functions.example.test")
        helper = probe.auth.load_auth_helper()
        for session in [None, [], {}, {"access_token": ""}, {"access_token": 123}]:
            with self.subTest(session=session), \
                    patch.object(probe.auth, "selected_webpubsub_resource",
                                 return_value=("push.example.test", {"disableAadAuth": False})), \
                    patch.object(probe.auth, "load_auth_helper", return_value=helper), \
                    patch.object(probe.auth, "internal_token_target",
                                 return_value=("https://mcp.example.test", "audience")), \
                    patch.object(helper, "session", return_value=session), \
                    patch.object(probe.auth, "http") as http, \
                    patch.object(probe.subprocess, "Popen") as popen:
                with self.assertRaisesRegex(probe.auth.EvidenceError, "session was incomplete"):
                    probe.start_webpubsub_receiver(deployment)
                http.assert_not_called()
                popen.assert_not_called()

    def test_receiver_pipe_keeps_ready_and_delivery_lines_separate(self):
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b"SOCKET_READY\nMESSAGE_RECEIVED\n")
            os.close(write_fd)
            write_fd = None
            with os.fdopen(read_fd, "rb") as stream:
                read_fd = None
                process = SimpleNamespace(stdout=stream)
                self.assertEqual(probe.receiver_line(process, 1), "SOCKET_READY")
                self.assertEqual(probe.receiver_line(process, 1), "MESSAGE_RECEIVED")
                with self.assertRaises(probe.auth.EvidenceError):
                    probe.receiver_line(process, 1)
        finally:
            if read_fd is not None:
                os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)

    def test_receiver_pipe_rejects_non_ascii_evidence(self):
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b"\xff\n")
            os.close(write_fd)
            write_fd = None
            with os.fdopen(read_fd, "rb") as stream:
                read_fd = None
                with self.assertRaisesRegex(probe.auth.EvidenceError, "invalid evidence"):
                    probe.receiver_line(SimpleNamespace(stdout=stream), 1)
        finally:
            if read_fd is not None:
                os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)

    def test_malformed_runtime_result_is_blocked_without_exposing_output(self):
        deployment = SimpleNamespace(group="group", subscription="subscription")
        for payload in [b"Welcome to Node\nAUTH_RUNTIME_RBAC_RESULT:{invalid}\n",
                        b'Welcome to Node\nAUTH_RUNTIME_RBAC_RESULT:{"checks":[{}]}\n']:
            with self.subTest(payload=payload):
                process = MagicMock()
                process.poll.return_value = 0
                with patch.object(probe.pty, "openpty", return_value=(10, 11)), \
                        patch.object(probe.subprocess, "Popen", return_value=process), \
                        patch.object(probe.select, "select", return_value=([10], [], [])), \
                        patch.object(probe.os, "read", return_value=payload), \
                        patch.object(probe.os, "write"), \
                        patch.object(probe.time, "sleep"), \
                        patch.object(probe.os, "close"):
                    with self.assertRaisesRegex(probe.auth.EvidenceError,
                                                "malformed evidence; do not retry an uncertain send"):
                        probe.execute(deployment, "admin", "")

    def test_runtime_result_is_rejected_if_probe_source_was_not_sent(self):
        deployment = SimpleNamespace(group="group", subscription="subscription")
        for payload in [b"Container startup failed\n",
                        b'AUTH_RUNTIME_RBAC_RESULT:{"checks":[]}\n']:
            with self.subTest(payload=payload):
                process = MagicMock()
                process.poll.return_value = 0
                with patch.object(probe.pty, "openpty", return_value=(10, 11)), \
                        patch.object(probe.subprocess, "Popen", return_value=process), \
                        patch.object(probe.select, "select", return_value=([10], [], [])), \
                        patch.object(probe.os, "read", return_value=payload), \
                        patch.object(probe.os, "write") as write, \
                        patch.object(probe.os, "close"):
                    with self.assertRaisesRegex(probe.auth.EvidenceError,
                                                "source was not sent; no runtime send was attempted"):
                        probe.execute(deployment, "admin", "")
                    write.assert_not_called()

    def test_missing_delivery_evidence_is_reported_as_failure(self):
        identity = {"id": "/identity", "clientId": "client", "principalId": "principal"}
        app = {
            "name": "admin",
            "tags": {"azd-service-name": "app-admin"},
            "identity": {"userAssignedIdentities": {"/identity": {}}},
            "properties": {"template": {"containers": [{"image": "registry.example/admin:tag"}]},
                           "configuration": {"ingress": {"fqdn": "admin.example"}}},
        }
        checks = [{"name": name, "status": "PASS", "detail": "verified"} for name in (
            "storage-management-denied", "acr-management-denied", "acr-manifest-pull",
            "webpubsub-identity", "webpubsub-group-send")]
        for result in ["SOCKET_FAILED", probe.auth.EvidenceError("receiver timed out")]:
            with self.subTest(result=result), TemporaryDirectory() as output:
                deployment = MagicMock(environment="demo", group="group", subscription="subscription")
                deployment.azure.side_effect = [[app], identity, [{"loginServer": "registry.example", "id": "/acr"}],
                                               {"id": "/storage"}, {"tenantId": "tenant"}]
                report = SimpleNamespace(provenance={}, inventory={}, output=Path(output),
                                         add=MagicMock(), check=MagicMock())
                with patch.object(probe.auth, "http", return_value=(200, {}, b"")), \
                        patch.object(probe, "start_webpubsub_receiver",
                                     return_value=(object(), {"host": "push.example", "probeId": "id"})), \
                        patch.object(probe, "execute", return_value={"checks": checks}), \
                        patch.object(probe, "receiver_line", side_effect=result if isinstance(result, Exception)
                                     else None, return_value=result if isinstance(result, str) else None), \
                        patch.object(probe, "stop_receiver"):
                    probe.run(report, deployment, None, webpubsub=True)
                self.assertEqual(report.provenance["azdEnvironment"], "demo")
                self.assertEqual(report.inventory["webPubSubProbe"]["host"], "push.example")
                if isinstance(result, Exception):
                    delivery = report.add.call_args_list[0].args
                    self.assertEqual(delivery[:3], ("runtime-rbac:webpubsub-delivery", "runtime", "FAIL"))
                    self.assertIn("receiver timed out", delivery[3])
                else:
                    delivery = report.check.call_args_list[0].args
                    self.assertEqual(delivery[:3], ("runtime-rbac:webpubsub-delivery", "runtime", False))
                    self.assertIn("did not confirm delivery", delivery[3])


if __name__ == "__main__":
    unittest.main()
