"""Verify compiled ARM dependencies serialize Foundry parent-lock operations."""

import json
import pathlib
import subprocess
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
BICEP = pathlib.Path.home() / ".azure/bin/bicep"


class FoundryDependencyTests(unittest.TestCase):
    def test_compiled_parent_operation_chain(self):
        result = subprocess.run(
            [str(BICEP), "build", str(ROOT / "infra/modules/aiservices.bicep"), "--no-restore", "--stdout"],
            check=True, capture_output=True, text=True,
        )
        template = json.loads(result.stdout)
        resources = template["resources"]

        def find(resource_type):
            return next(resource for resource in resources if resource["type"] == resource_type)

        project = find("Microsoft.CognitiveServices/accounts/projects")
        insights = find("Microsoft.CognitiveServices/accounts/connections")
        connections = [r for r in resources if r["type"] == "Microsoft.CognitiveServices/accounts/projects/connections"]
        aoai = next(r for r in connections if "aoaiConnectionName" in r["name"])
        storage = next(r for r in connections if "storageAccountConnectionName" in r["name"])
        models = find("Microsoft.CognitiveServices/accounts/deployments")
        self.assertTrue(any("appInsightConnectionName" in dep for dep in project["dependsOn"]))
        self.assertTrue(any("eshop-chat-guardrails" in dep for dep in insights["dependsOn"]))
        self.assertTrue(any("projectName" in dep for dep in aoai["dependsOn"]))
        self.assertTrue(any("aoaiConnectionName" in dep for dep in storage["dependsOn"]))
        self.assertTrue(any("storageAccountConnectionName" in dep for dep in models["dependsOn"]))
        self.assertEqual(models["copy"]["mode"], "serial")
        self.assertEqual(models["copy"]["batchSize"], 1)

        guardrails = next(
            r["properties"]["template"] for r in resources
            if r["type"] == "Microsoft.Resources/deployments" and r["name"] == "eshop-chat-guardrails"
        )
        policy = next(r for r in guardrails["resources"] if r["type"].endswith("/raiPolicies"))
        item = next(r for r in guardrails["resources"] if r["type"].endswith("/raiBlocklistItems"))
        self.assertTrue(any("code-syntax" in dep for dep in policy["dependsOn"]))
        self.assertTrue(any("AdventureWorks-Chat-CodeOutput" in dep for dep in item["dependsOn"]))


if __name__ == "__main__":
    unittest.main()
