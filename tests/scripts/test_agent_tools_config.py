import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "agent_tools", ROOT / "scripts/utilities/agents/lib/build-agent-tools.py")
agent_tools = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent_tools)
FINGERPRINT_SPEC = importlib.util.spec_from_file_location(
    "agent_fingerprint", ROOT / "scripts/utilities/agents/lib/agent-config-fingerprint.py")
agent_fingerprint = importlib.util.module_from_spec(FINGERPRINT_SPEC)
FINGERPRINT_SPEC.loader.exec_module(agent_fingerprint)


class AgentToolConfigurationTests(unittest.TestCase):
    def build(self, mcp_tools="[]", include_dab=False, dab_tools="[]", connection_id=""):
        return agent_tools.build_tools(
            "https://mcp.example.test/mcp",
            "https://dab.example.test/mcp",
            mcp_tools,
            include_dab,
            connection_id,
            dab_tools,
        )

    def test_empty_allow_lists_omit_both_mcp_servers(self):
        self.assertEqual(self.build(), [])

    def test_custom_mcp_has_only_explicitly_allowed_tools_and_dab_is_opt_in(self):
        self.assertEqual(self.build(mcp_tools='["search_products","get_product_details"]'), [{
            "type": "mcp",
            "server_label": "adventureworks_mcp",
            "server_url": "https://mcp.example.test/mcp",
            "require_approval": "never",
            "allowed_tools": ["search_products", "get_product_details"],
        }])

    def test_dab_requires_an_explicit_allow_list(self):
        with self.assertRaisesRegex(ValueError, "explicit non-empty"):
            self.build(include_dab=True)
        self.assertEqual(
            self.build(include_dab=True, dab_tools='["read_record"]', connection_id="dab-connection"),
            [{
                "type": "mcp",
                "server_label": "dabmcp",
                "require_approval": "never",
                "allowed_tools": ["read_record"],
                "project_connection_id": "dab-connection",
            }],
        )

    def test_invalid_or_duplicate_tool_names_fail_closed(self):
        for value in ["{", "{}", '[""]', '["search","search"]', "[null]", '["search products"]']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.build(mcp_tools=value)
        with self.assertRaises(ValueError):
            self.build(mcp_tools='["search"]', include_dab="true")

    def test_server_urls_must_be_https_when_server_is_enabled(self):
        with self.assertRaisesRegex(ValueError, "absolute HTTPS"):
            agent_tools.build_tools("http://mcp.example.test", "", '["search"]', False, "", "[]")
        with self.assertRaisesRegex(ValueError, "absolute HTTPS"):
            agent_tools.build_tools("", "https://user:secret@dab.example.test", "[]",
                                    True, "", '["read_record"]')

    def test_agent_config_fingerprint_is_stable_and_tracks_source_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "a.sh"
            second = root / "b.py"
            first.write_text("agent one\n")
            second.write_text("agent two\n")

            initial = agent_fingerprint.fingerprint(root, [second, first])
            self.assertEqual(initial, agent_fingerprint.fingerprint(root, [first, second]))
            second.write_text("agent two changed\n")
            self.assertNotEqual(initial, agent_fingerprint.fingerprint(root, [first, second]))

    def test_azd_deploy_hook_updates_definitions_only_when_sources_change(self):
        hook = (ROOT / "scripts/hooks/postdeploy.sh").read_text()
        provision = (ROOT / "scripts/hooks/postprovision.sh").read_text()
        self.assertIn('if [[ "$foundry_agent_config_hash" != "$deployed_foundry_agent_config_hash" ]]', hook)
        self.assertIn("bash scripts/utilities/create-foundry-agents.sh", hook)
        self.assertLess(provision.index("create-foundry-agents.sh"),
                        provision.index("azd env refresh --no-prompt"))
        self.assertGreater(provision.index("azd env set FOUNDRY_AGENT_CONFIG_HASH"),
                           provision.index("azd env refresh --no-prompt"))

    def test_predeploy_reads_the_explicit_azd_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "app").mkdir()
            (root / "app/staticwebapp.config.template.json").write_text('{"api":"{{API_FUNCTIONS_URL}}"}')
            azd = root / "azd"
            azd.write_text("""#!/bin/sh
if [ "$1" != env ] || [ "$2" != get-value ] || [ "$4" != --environment ] ||
   [ "$5" != selected ] || [ "$6" != --no-prompt ]; then exit 1; fi
if [ "${MISSING_KEY:-}" = "$3" ]; then exit 1; fi
case "$3" in
  API_URL) echo https://dab.example.test/graphql/ ;;
  API_FUNCTIONS_URL) echo https://functions.example.test ;;
  API_MCP_URL) echo https://mcp.example.test/mcp ;;
  APPINSIGHTS_CONNECTIONSTRING) echo local-test-connection ;;
  *) exit 1 ;;
esac
""")
            azd.chmod(0o755)
            environment = {**os.environ, "AZURE_ENV_NAME": "selected", "PATH": str(root) + os.pathsep + os.environ["PATH"]}
            result = subprocess.run(["bash", str(ROOT / "scripts/hooks/predeploy.sh")],
                                    cwd=root, env=environment, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            generated = (root / "app/.env.production").read_text()
            self.assertIn("VITE_API_URL=https://dab.example.test/graphql/", generated)
            self.assertIn("VITE_API_FUNCTIONS_URL=https://functions.example.test", generated)
            self.assertIn("VITE_API_MCP_URL=https://mcp.example.test/mcp", generated)
            self.assertIn("VITE_APPINSIGHTS_CONNECTIONSTRING=local-test-connection", generated)
            self.assertEqual((root / "app/staticwebapp.config.json").read_text(),
                             '{"api":"https://functions.example.test"}')
            environment["MISSING_KEY"] = "API_MCP_URL"
            failed = subprocess.run(["bash", str(ROOT / "scripts/hooks/predeploy.sh")],
                                    cwd=root, env=environment, capture_output=True, text=True, check=False)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("Unable to read API_MCP_URL", failed.stderr)
            self.assertEqual((root / "app/.env.production").read_text(), generated)

    def provisioner_environment(self, root):
        binaries = root / "bin"
        temporary = root / "temporary"
        evidence = root / "evidence"
        for directory in (binaries, temporary, evidence):
            directory.mkdir()

        azd = binaries / "azd"
        azd.write_text("""#!/usr/bin/env python3
import os
from pathlib import Path
import sys
args = sys.argv[1:]
if args[:2] == ["env", "get-value"]:
    if os.environ.get("TEST_REQUIRE_PIN") == "1" and args[3:] != [
            "--environment", os.environ["AZURE_ENV_NAME"], "--no-prompt"]:
        sys.exit(2)
    if args[2] == os.environ.get("TEST_MISSING_KEY"):
        sys.exit(1)
    values = {
        "AI_FOUNDRY_PROJECT_ENDPOINT": "https://foundry.example.test/api/projects/demo",
        "MCP_SERVICE_URL": "https://mcp.example.test/mcp",
        "API_URL": "https://dab.example.test/graphql/",
        "chatGptDeploymentName": "chat",
        "AZURE_SUBSCRIPTION_ID": "00000000-0000-0000-0000-000000000001",
        "AZURE_RESOURCE_GROUP": "demo",
        "APPLICATIONINSIGHTS_CONNECTION_STRING": "local-test",
        "AI_AGENT_CHAT_ID": "chat-agent",
        "AI_AGENT_ORDER_ID": "order-agent",
        "AI_AGENT_PROMOTION_ID": "promotion-agent",
        "AI_AGENT_HELP_ME_CHOOSE_ID": "catalog-agent",
        "AI_AGENT_CART_RECOVERY_ID": "cart-agent",
        "AI_AGENT_PRODUCT_CONTENT_ID": "content-agent",
        "SERVICE_API_FUNCTIONS_NAME": "functions-app",
        "API_FUNCTIONS_URL": "https://functions.example.test",
    }
    print(values.get(args[2], ""))
elif args[:2] == ["env", "set"]:
    (Path(os.environ["TEST_EVIDENCE"]) / (os.environ["TEST_MARKER"] + ".set")).write_text(args[3])
else:
    sys.exit(1)
""")
        az = binaries / "az"
        az.write_text("""#!/usr/bin/env python3
import os
from pathlib import Path
import sys
args = sys.argv[1:]
subscription = "00000000-0000-0000-0000-000000000001"
if os.environ.get("TEST_REQUIRE_PIN") == "1" and (
        "--subscription" not in args or args[args.index("--subscription") + 1] != subscription):
    sys.exit(2)
if args[:2] == ["account", "get-access-token"]:
    print("mock-token")
elif args[:4] == ["functionapp", "config", "appsettings", "set"]:
    (Path(os.environ["TEST_EVIDENCE"]) / "functionapp").write_text(" ".join(args))
else:
    sys.exit(1)
""")
        curl = binaries / "curl"
        curl.write_text("""#!/usr/bin/env python3
import json
import os
from pathlib import Path
import stat
import sys
import time
args = sys.argv[1:]
target = Path(args[args.index("-o") + 1]).resolve()
temporary = Path(os.environ["TMPDIR"]).resolve()
if target.parent.parent != temporary or stat.S_IMODE(target.parent.stat().st_mode) != 0o700:
    sys.exit(2)
marker = os.environ["TEST_MARKER"]
post = "-X" in args and args[args.index("-X") + 1] == "POST"
failed = post and os.environ.get("TEST_FAIL_POST") == "1"
target.write_text("{}" if failed else json.dumps({"id": marker, "name": marker}))
if post and os.environ.get("TEST_BARRIER") == "1":
    evidence = Path(os.environ["TEST_EVIDENCE"])
    (evidence / (marker + ".ready")).write_text(str(target))
    for _ in range(250):
        if (evidence / "alpha.ready").exists() and (evidence / "beta.ready").exists():
            break
        time.sleep(0.02)
    else:
        sys.exit(3)
print("500" if failed else "200" if post else os.environ.get("TEST_GET_STATUS", "200"), end="")
""")
        for executable in (azd, az, curl):
            executable.chmod(0o755)
        return {
            **os.environ,
            "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
            "TMPDIR": str(temporary),
            "TEST_EVIDENCE": str(evidence),
            "FOUNDRY_CONNECTIONS_READY": "1",
        }, temporary, evidence

    def test_concurrent_agent_provisioners_isolate_responses_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            environment, temporary, evidence = self.provisioner_environment(Path(directory))
            script = ROOT / "scripts/utilities/agents/eshop-help-me-choose-agent.sh"
            processes = [
                subprocess.Popen(["bash", str(script)], cwd=ROOT, text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env={**environment, "TEST_MARKER": marker, "TEST_BARRIER": "1"})
                for marker in ("alpha", "beta")
            ]
            try:
                for process in processes:
                    stdout, stderr = process.communicate(timeout=20)
                    self.assertEqual(process.returncode, 0, stdout + stderr)
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=5)

            self.assertEqual((evidence / "alpha.set").read_text(), "alpha")
            self.assertEqual((evidence / "beta.set").read_text(), "beta")
            self.assertNotEqual((evidence / "alpha.ready").read_text(),
                                (evidence / "beta.ready").read_text())
            self.assertEqual(list(temporary.iterdir()), [])

    def test_agent_provisioners_cleanup_after_failure_and_workflow_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            environment, temporary, _ = self.provisioner_environment(Path(directory))
            environment["TEST_MARKER"] = "mock-id"
            scripts = ROOT / "scripts/utilities/agents"
            failed = subprocess.run(
                ["bash", str(scripts / "eshop-help-me-choose-agent.sh")], cwd=ROOT,
                env={**environment, "TEST_FAIL_POST": "1"}, capture_output=True, text=True, check=False)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(list(temporary.iterdir()), [])

            interrupted = subprocess.run(
                ["bash", "-c", 'source "$1"; kill -TERM "$$"', "test", str(scripts / "lib/common.sh")],
                cwd=ROOT, env=environment, capture_output=True, text=True, check=False)
            self.assertEqual(interrupted.returncode, 143)
            self.assertEqual(list(temporary.iterdir()), [])

            for name, get_status in (("eshop-workflow-agent.sh", "200"),
                                     ("admin-promotion-workflow-agent.sh", "404"),
                                     ("admin-order-workflow-agent.sh", "200")):
                with self.subTest(script=name):
                    result = subprocess.run(["bash", str(scripts / name)], cwd=ROOT,
                                            env={**environment, "TEST_GET_STATUS": get_status},
                                            capture_output=True, text=True, check=False)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(list(temporary.iterdir()), [])

            result = subprocess.run(
                ["bash", "-c", 'source "$1"; setup_shared_connections; upsert_memory_store demo description schema',
                 "test", str(scripts / "lib/common.sh")], cwd=ROOT,
                env={**environment, "TEST_GET_STATUS": "404"}, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("mock-id", result.stdout)
            self.assertEqual(list(temporary.iterdir()), [])

    def test_functions_postdeploy_pins_environment_and_subscription(self):
        with tempfile.TemporaryDirectory() as directory:
            environment, temporary, evidence = self.provisioner_environment(Path(directory))
            environment.update({
                "TEST_MARKER": "mock-id",
                "AZURE_ENV_NAME": "selected",
                "TEST_REQUIRE_PIN": "1",
            })
            git = Path(directory) / "bin/git"
            git.write_text("#!/bin/sh\nexit 1\n")
            git.chmod(0o755)
            script = ROOT / "scripts/hooks/api-functions-postdeploy.sh"
            result = subprocess.run(["bash", str(script)], cwd=ROOT, env=environment,
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("--subscription 00000000-0000-0000-0000-000000000001",
                          (evidence / "functionapp").read_text())
            self.assertEqual(list(temporary.iterdir()), [])

            (evidence / "functionapp").unlink()
            failed = subprocess.run(["bash", str(script)], cwd=ROOT,
                                    env={**environment, "TEST_MISSING_KEY": "AI_AGENT_ORDER_ID"},
                                    capture_output=True, text=True, check=False)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("required agent IDs", failed.stdout)
            self.assertFalse((evidence / "functionapp").exists())
            self.assertEqual(list(temporary.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
