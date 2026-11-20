"""Offline tests for the rerunnable deployer setup script in .github/workflows/README.md."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SUB, TENANT = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"
APP, SP = "33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444"
SUBJECT = "repo:username/adventureworks:environment:adventureworks-demo"
CONTRIBUTOR = "b24988ac-6180-42a0-ab88-20f7382dd24c"
RBAC_ADMIN = "f58310d9-a9f6-439a-9e8d-f62e7b41a168"

FAKE_AZ = r'''#!/usr/bin/env python3
import json, os, sys
path = os.environ["AZ_STATE"]
state = json.load(open(path))
args = sys.argv[1:]
state["calls"].append(args)
def opt(name):
    return args[args.index(name) + 1]
out = ""
cmd = " ".join(args[:4])
if cmd.startswith("account set"):
    pass
elif cmd.startswith("account show"):
    out = state["tenant"]
elif cmd.startswith("ad app list"):
    out = "\n".join(state["apps"])
elif cmd.startswith("ad app create"):
    state["apps"].append(state["new_app"]); out = state["new_app"]
elif cmd.startswith("ad sp list"):
    out = state["sp"] or ""
elif cmd.startswith("ad sp create"):
    if state["sp"]:
        print("service principal name is already in use", file=sys.stderr); sys.exit(1)
    state["sp"] = state["new_sp"]; out = state["sp"]
elif cmd.startswith("ad app federated-credential list"):
    out = json.dumps(state["credentials"])
elif cmd.startswith("ad app federated-credential create"):
    state["credentials"].append(json.loads(opt("--parameters")))
elif cmd.startswith("role assignment list"):
    out = json.dumps(state["assignments"])
elif cmd.startswith("role assignment create"):
    role = {"Contributor": "%s"}.get(opt("--role"), opt("--role"))
    state["assignments"].append({
        "roleDefinitionId": "/subscriptions/%s/providers/Microsoft.Authorization/roleDefinitions/" + role,
        "scope": opt("--scope"), "condition": opt("--condition") if "--condition" in args else None})
else:
    print("unexpected az " + " ".join(args), file=sys.stderr); sys.exit(2)
json.dump(state, open(path, "w"))
if out:
    print(out)
''' % (CONTRIBUTOR, SUB)


def setup_script():
    readme = (ROOT / ".github/workflows/README.md").read_text()
    script = re.search(r"```bash\n(#!/usr/bin/env bash\n# Self-contained.*?)```", readme, re.S).group(1)
    return (script.replace("<target-subscription-id>", SUB).replace("<target-tenant-id>", TENANT)
            .replace("<exact-subject-for-the-fork-and-adventureworks-demo-environment>", SUBJECT))


def assignment(role, condition=None):
    return {"roleDefinitionId": f"/subscriptions/{SUB}/providers/Microsoft.Authorization/roleDefinitions/{role}",
            "scope": f"/subscriptions/{SUB}", "condition": condition}


@unittest.skipUnless(shutil.which("jq"), "jq is required")
class DeployerSetupScriptTests(unittest.TestCase):
    def run_script(self, **overrides):
        state = {"tenant": TENANT, "apps": [], "new_app": APP, "sp": None, "new_sp": SP,
                 "credentials": [], "assignments": [], "calls": []}
        state.update(overrides)
        with tempfile.TemporaryDirectory() as directory:
            bin_dir = Path(directory, "bin")
            bin_dir.mkdir()
            (bin_dir / "az").write_text(FAKE_AZ)
            (bin_dir / "az").chmod(0o755)
            Path(directory, "state.json").write_text(json.dumps(state))
            Path(directory, "setup.sh").write_text(setup_script())
            env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", AZ_STATE=f"{directory}/state.json")
            result = subprocess.run(["bash", "setup.sh"], cwd=directory, env=env, capture_output=True, text=True)
            return result, json.loads(Path(directory, "state.json").read_text())

    def created(self, state):
        return [" ".join(call[:3]) for call in state["calls"] if "create" in call]

    def test_fresh_run_creates_everything_without_repository_files(self):
        result, state = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"DEPLOYER_OBJECT_ID={SP}", result.stdout)
        self.assertEqual(len(self.created(state)), 5)
        self.assertEqual(state["credentials"][0]["subject"], SUBJECT)
        admin = [a for a in state["assignments"] if a["roleDefinitionId"].endswith(RBAC_ADMIN)]
        self.assertIn("GuidEquals {09976791", admin[0]["condition"])

    def test_rerun_after_partial_failure_reuses_existing_app_and_principal(self):
        first, completed = self.run_script()
        self.assertEqual(first.returncode, 0, first.stderr)
        partial = {"apps": [APP], "sp": SP, "credentials": completed["credentials"],
                   "assignments": [assignment(CONTRIBUTOR)]}
        result, state = self.run_script(**partial)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.created(state), ["role assignment create"])
        self.assertEqual(state["assignments"][1], completed["assignments"][1])

        result, state = self.run_script(**{**partial, "assignments": completed["assignments"]})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.created(state), [])

    def test_stops_on_ambiguous_or_conflicting_existing_state(self):
        cases = {
            "Several app registrations": {"apps": [APP, "55555555-5555-5555-5555-555555555555"]},
            "different subject": {"apps": [APP], "sp": SP, "credentials": [
                {"name": "github-adventureworks-demo", "issuer": "https://token.actions.githubusercontent.com",
                 "subject": "repo:other/repo:environment:adventureworks-demo"}]},
            "different or missing condition": {"apps": [APP], "sp": SP, "assignments": [
                assignment(CONTRIBUTOR), assignment(RBAC_ADMIN)]},
        }
        for message, overrides in cases.items():
            with self.subTest(message):
                if "credentials" not in overrides and "assignments" in overrides:
                    overrides["credentials"] = [{"name": "x", "issuer": "https://token.actions.githubusercontent.com",
                                                 "subject": SUBJECT}]
                result, state = self.run_script(**overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertNotIn("role assignment create", self.created(state))


if __name__ == "__main__":
    unittest.main()
