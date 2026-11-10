import importlib.util
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("seed_log_probe", ROOT / "tests/scripts/test-seed-log-mount.py")
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class SeedLogMountTests(unittest.TestCase):
    def template(self):
        return {
            "containers": [{
                "name": "seed-job", "image": "example.azurecr.io/seed:current",
                "resources": {"cpu": 2, "memory": "4Gi"},
                "env": [{"name": "SQL_SERVER_NAME", "value": "must-not-be-used"}],
                "volumeMounts": [{"volumeName": "logs", "mountPath": "/logs"}],
            }],
            "volumes": [{"name": "logs", "storageName": "seed-job", "storageType": "AzureFile"}],
        }

    def test_execution_override_preserves_mount_image_resources_and_never_seeds(self):
        template = self.template()
        for phase in ["write", "read-cleanup", "cleanup"]:
            with self.subTest(phase=phase):
                result = probe.probe_template(template, "auth-mount-unit.log", "testcontent", phase)
                container = result["containers"][0]
                self.assertEqual(container["command"], ["pwsh"])
                self.assertEqual(container["env"], [])
                for key in ["name", "image", "resources", "volumeMounts"]:
                    self.assertEqual(container[key], template["containers"][0][key])
                self.assertEqual(result["volumes"], template["volumes"])
                script = container["args"][-1]
                self.assertIn(" /logs cifs ", script)
                self.assertNotIn("seed-database", script)
                self.assertNotIn("Connect-AzAccount", script)
                self.assertNotIn("Sql", script)
                if phase == "write":
                    self.assertIn("[IO.FileMode]::CreateNew", script)
                    self.assertIn("Flush($true)", script)
                    self.assertNotIn("Delete", script)
                else:
                    self.assertLess(script.index("ReadAllText"), script.index("[IO.File]::Delete"))
                    self.assertIn("-cne $expected", script)
                if phase == "read-cleanup":
                    self.assertIn("Persisted probe file missing", script)
        self.assertNotIn("command", template["containers"][0])
        self.assertEqual(len(template["containers"][0]["env"]), 1)

    def test_unknown_phase_paths_and_missing_mounts_fail_before_execution(self):
        for filename, content, phase in [
                ("../../seed.log", "valid", "write"), ("auth-mount-test.log", "';exit", "write"),
                ("auth-mount-test.log", "valid", "seed"), ("auth-mount-test.log/other", "valid", "write")]:
            with self.subTest(filename=filename), self.assertRaises(probe.auth.EvidenceError):
                probe.probe_template(self.template(), filename, content, phase)
        for key in ["volumes", "containers"]:
            template = self.template()
            template[key] = []
            with self.subTest(key=key), self.assertRaises(probe.auth.EvidenceError):
                probe.probe_template(template, "auth-mount-test.log", "valid", "write")

    def test_iac_mount_uses_existing_environment_identity_without_storage_key(self):
        aca = (ROOT / "infra/modules/aca.bicep").read_text()
        storage = (ROOT / "infra/modules/storage.bicep").read_text()
        mount = aca[aca.index("resource seedJobStorage"):aca.index("output containerAppEnvId")]
        self.assertIn("@2026-03-02-preview", mount)
        self.assertIn("identity: azidentity.id", mount)
        self.assertIn("seedJobSmbRole", mount)
        self.assertNotIn("accountKey", mount)
        self.assertNotIn("listKeys", mount)
        self.assertIn("'${azidentity.id}': {}", aca)
        self.assertIn("a235d3ee-5935-4cfb-8cc5-a3303ad5995e", aca)
        self.assertIn("scope: storageAccount", aca)
        self.assertIn("allowSharedKeyAccess: false", storage)
        self.assertIn("isSmbOAuthEnabled: true", storage)
        self.assertIn("authenticationMethods: 'Kerberos'", storage)


if __name__ == "__main__":
    unittest.main()
