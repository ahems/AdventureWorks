import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("reconcile_rbac", ROOT / "scripts/utilities/reconcile-runtime-rbac.py")
rbac = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rbac)


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

    def test_seed_readiness_checks_file_data_not_management_share_properties(self):
        source = (ROOT / "api-functions/Services/DependencyHealthService.cs").read_text()
        probe = source.split('yield return new("files",', 1)[1].split("foreach (var probe", 1)[0]
        self.assertIn("ShareTokenIntent.Backup", probe)
        self.assertIn("await client.GetRootDirectoryClient().GetPropertiesAsync(cancellationToken: ct)", probe)
        self.assertNotIn("await client.GetPropertiesAsync(", probe)


if __name__ == "__main__":
    unittest.main()
