import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
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
FUNCTIONS_PUSH_SPEC = importlib.util.spec_from_file_location(
    "functions_push_probe", ROOT / "tests/scripts/test-functions-webpubsub.py")
functions_push = importlib.util.module_from_spec(FUNCTIONS_PUSH_SPEC)
FUNCTIONS_PUSH_SPEC.loader.exec_module(functions_push)
SEED_SQL_SPEC = importlib.util.spec_from_file_location(
    "seed_sql_probe", ROOT / "tests/scripts/test-seed-sql-identity.py")
seed_sql = importlib.util.module_from_spec(SEED_SQL_SPEC)
SEED_SQL_SPEC.loader.exec_module(seed_sql)
SEED_PRINCIPAL_SPEC = importlib.util.spec_from_file_location(
    "seed_principal_probe", ROOT / "tests/scripts/test-seed-sql-principal.py")
seed_principal = importlib.util.module_from_spec(SEED_PRINCIPAL_SPEC)
SEED_PRINCIPAL_SPEC.loader.exec_module(seed_principal)


class SeedSqlLogProbeTests(unittest.TestCase):
    def fixtures(self):
        values = {
            "SERVICE_SEED_JOB_NAME": "seed-job",
            "SERVICE_APP_ADMIN_NAME": "admin",
            "SEED_MANAGED_IDENTITY_NAME": "seed-identity",
            "SQL_SERVER_NAME": "sql-server",
            "SQL_DATABASE_NAME": "database",
            "STORAGE_ACCOUNT_NAME": "storage123",
            "CONTAINER_APP_ENVIRONMENT_NAME": "aca-env",
        }
        seed = {"id": "/seed-identity", "clientId": "seed-client"}
        identity = {"id": "/runtime-identity"}
        job = {
            "identity": {"userAssignedIdentities": {"/seed-identity": {}}},
            "containers": [{"image": "registry/seed:tag",
                            "volumeMounts": [{"mountPath": "/logs", "volumeName": "logs"}]}],
            "volumes": [{"name": "logs", "storageName": "seed-mount", "storageType": "AzureFile"}],
        }
        env = [
            {"name": "AZURE_CLIENT_ID", "value": "seed-client"},
            {"name": "USER_MANAGED_IDENTITY_NAME", "value": "seed-identity"},
            {"name": "SQL_SERVER_NAME", "value": "sql-server"},
            {"name": "SQL_DATABASE_NAME", "value": "database"},
        ]
        execution = {"id": "/execution", "name": "execution", "status": "Succeeded",
                     "start": "2020-01-01T00:00:00.1234567Z", "end": "2020-01-01T00:10:00+00:00",
                     "containers": [{"image": "registry/seed:tag", "env": env}]}
        app = {"id": "/admin", "name": "admin", "revision": "admin--rev1", "ready": "admin--rev1",
               "state": "Succeeded", "identity": {"userAssignedIdentities": {"/runtime-identity": {}}},
               "containers": [{"name": "admin", "image": "registry/admin:tag"}]}
        mount = {"properties": {"azureFile": {"shareName": "seed-job-logs", "accountName": "storage123",
                                               "identity": "/runtime-identity"}}}
        storage = {"file": "https://storage123.file.core.windows.net/", "sharedKey": False}
        resources = {"job": job, "executions": [execution], "app": app, "mount": mount, "storage": storage}

        def azure(*args):
            if args[:3] == ("containerapp", "job", "show"):
                return resources["job"]
            if args[:4] == ("containerapp", "job", "execution", "list"):
                return resources["executions"]
            if args[:2] == ("containerapp", "show"):
                return resources["app"]
            if args[:3] == ("storage", "account", "show"):
                return resources["storage"]
            self.fail("Unexpected Azure command")

        deployment = SimpleNamespace(group="group", required=lambda key: values[key], azure=azure,
                                     arm=lambda *_: resources["mount"])
        return deployment, seed, identity, resources

    def test_seed_snapshot_requires_one_matching_successful_execution_and_mount(self):
        d, seed, _, resources = self.fixtures()
        snapshot = seed_sql.seed_snapshot(d, seed)
        self.assertEqual(snapshot["name"], "execution")
        self.assertEqual(snapshot["mount"], "seed-mount")
        override = copy.deepcopy(resources["executions"][0])
        override["containers"][0]["env"] = []
        resources["executions"].append(override)
        self.assertEqual(seed_sql.seed_snapshot(d, seed), snapshot)

    def test_seed_snapshot_rejects_mismatches_ambiguity_and_missing_metadata(self):
        for defect in ["identity", "mount", "failed", "sql", "client", "duplicate-env", "missing-env",
                       "image", "duplicate-execution", "start", "end"]:
            with self.subTest(defect=defect):
                d, seed, _, resources = self.fixtures()
                job, execution = resources["job"], resources["executions"][0]
                env = execution["containers"][0]["env"]
                if defect == "identity":
                    job["identity"]["userAssignedIdentities"] = {"/other": {}}
                elif defect == "mount":
                    job["volumes"][0]["storageType"] = "Secret"
                elif defect == "failed":
                    execution["status"] = "Failed"
                elif defect == "sql":
                    env[2]["value"] = "other"
                elif defect == "client":
                    env[0]["value"] = "other"
                elif defect == "duplicate-env":
                    env.append(copy.deepcopy(env[0]))
                elif defect == "missing-env":
                    env.pop()
                elif defect == "image":
                    execution["containers"][0]["image"] = "registry/other:tag"
                elif defect == "duplicate-execution":
                    resources["executions"].append(copy.deepcopy(execution))
                elif defect == "start":
                    execution["start"] = "2020-01-01T00:00:00"
                else:
                    execution["end"] = "2019-12-31T23:59:00Z"
                with self.assertRaises(seed_sql.auth.EvidenceError):
                    seed_sql.seed_snapshot(d, seed)

    def test_admin_snapshot_rejects_unready_or_foreign_identity(self):
        for defect in ["revision", "identity"]:
            with self.subTest(defect=defect):
                d, _, identity, resources = self.fixtures()
                if defect == "revision":
                    resources["app"]["ready"] = "older"
                else:
                    resources["app"]["identity"]["userAssignedIdentities"] = {"/other": {}}
                with self.assertRaises(seed_sql.auth.EvidenceError):
                    seed_sql.admin_snapshot(d, identity)

    def test_file_target_requires_selected_keyless_mount_and_trusted_cloud_origin(self):
        cloud = {"name": "AzureCloud", "suffix": "core.windows.net"}
        d, _, identity, _ = self.fixtures()
        with patch.object(seed_sql.auth, "json_command", return_value=cloud):
            target = seed_sql.file_target(d, identity, "seed-mount")
        self.assertEqual(target["share"], "seed-job-logs")
        for defect in ["foreign-host", "prefix-host", "wrong-identity", "key", "shared-key",
                       "foreign-cloud", "foreign-suffix", "invalid-share"]:
            with self.subTest(defect=defect):
                d, _, identity, resources = self.fixtures()
                altered_cloud = dict(cloud)
                if defect == "foreign-host":
                    resources["storage"]["file"] = "https://foreign.example/"
                elif defect == "prefix-host":
                    resources["storage"]["file"] = "https://storage123.file.attacker.example/"
                elif defect == "wrong-identity":
                    resources["mount"]["properties"]["azureFile"]["identity"] = "/other"
                elif defect == "key":
                    resources["mount"]["properties"]["azureFile"]["accountKey"] = "not-for-output"
                elif defect == "shared-key":
                    resources["storage"]["sharedKey"] = True
                elif defect == "foreign-cloud":
                    altered_cloud = {"name": "custom", "suffix": "attacker.example"}
                elif defect == "foreign-suffix":
                    altered_cloud["suffix"] = "attacker.example"
                else:
                    resources["mount"]["properties"]["azureFile"]["shareName"] = "../other"
                with patch.object(seed_sql.auth, "json_command", return_value=altered_cloud), \
                        self.assertRaises(seed_sql.auth.EvidenceError):
                    seed_sql.file_target(d, identity, "seed-mount")

    def test_run_pins_revision_withholds_raw_details_and_rechecks_snapshot(self):
        subscription = "11111111-1111-4111-8111-111111111111"
        tenant = "22222222-2222-4222-8222-222222222222"
        runtime = {"id": "/runtime", "clientId": "33333333-3333-4333-8333-333333333333",
                   "principalId": "44444444-4444-4444-8444-444444444444"}
        seed = {"id": "/seed", "clientId": "55555555-5555-4555-8555-555555555555"}
        values = {"USER_MANAGED_IDENTITY_NAME": "runtime", "SEED_MANAGED_IDENTITY_NAME": "seed",
                  "SQL_SERVER_NAME": "server", "SQL_DATABASE_NAME": "database"}
        d = SimpleNamespace(runtime=None, subscription=subscription, environment="demo", group="group",
                            required=lambda key: values[key],
                            azure=lambda *args: runtime if args[-1] == "runtime" else seed)
        snapshot = {"name": "seed-run", "start": "2020-01-01T00:00:00Z",
                    "end": "2020-01-01T00:01:00Z", "mount": "seed-mount"}
        admin = {"name": "admin", "revision": "admin--rev1"}
        target = {"endpoint": "https://storage123.file.core.windows.net/", "account": "storage123",
                  "suffix": "core.windows.net", "share": "seed-job-logs"}
        response = {"checks": [{"name": "seed-sql-log", "status": "PASS", "phase": "read",
                                "detail": "private log content"}]}
        for changed in [False, True]:
            with self.subTest(changed=changed):
                report = seed_sql.auth.Report(Path("."))
                after = {**snapshot, "name": "other"} if changed else snapshot
                with patch.object(seed_sql.auth, "json_command", return_value={"id": subscription, "tenantId": tenant}), \
                        patch.object(seed_sql, "seed_snapshot", side_effect=[snapshot, after]), \
                        patch.object(seed_sql, "admin_snapshot", return_value=admin), \
                        patch.object(seed_sql, "file_target", return_value=target), \
                        patch.object(seed_sql.runtime, "execute", return_value=response) as execute:
                    if changed:
                        with self.assertRaises(seed_sql.auth.EvidenceError):
                            seed_sql.run(report, d)
                    else:
                        seed_sql.run(report, d)
                self.assertEqual(execute.call_args.kwargs["revision"], "admin--rev1")
                if changed:
                    self.assertFalse(report.checks)
                else:
                    self.assertEqual(report.checks[0]["status"], "PASS")
                    self.assertNotIn("private log content", json.dumps(report.checks))


class SeedSqlPrincipalProbeTests(unittest.TestCase):
    def fixtures(self):
        tenant = "11111111-1111-4111-8111-111111111111"
        client = "22222222-2222-4222-8222-222222222222"
        principal = "33333333-3333-4333-8333-333333333333"
        seed = {"name": "seed-identity", "id": "/identity", "clientId": client, "principalId": principal}
        runtime = {"name": "runtime-identity", "id": "/runtime",
                   "clientId": "44444444-4444-4444-8444-444444444444",
                   "principalId": "55555555-5555-4555-8555-555555555555"}
        server = {"name": "sql-server", "fullyQualifiedDomainName": "sql-server.database.windows.net",
                  "administrators": {"administratorType": "ActiveDirectory", "sid": principal,
                                     "login": seed["name"], "tenantId": tenant,
                                     "azureAdOnlyAuthentication": True}}
        database = {"name": "AdventureWorks", "status": "Online"}
        template = {"containers": [{"name": "seed-job", "image": "registry.azurecr.io/seed-job:latest",
                                    "env": [{"name": "SQL_SERVER_NAME", "value": "sql-server"}],
                                    "volumeMounts": [{"volumeName": "logs", "mountPath": "/logs"}]}],
                    "volumes": [{"name": "logs", "storageType": "AzureFile"}]}
        job = {"id": "/jobs/seed-job", "identity": {"type": "UserAssigned",
                                                     "userAssignedIdentities": {"/identity": {}}},
               "properties": {"template": template, "configuration": {
                   "triggerType": "Manual", "replicaRetryLimit": 0,
                   "registries": [{"server": "registry.azurecr.io", "identity": "/identity"}],
                   "manualTriggerConfig": {"parallelism": 1, "replicaCompletionCount": 1}}}}
        values = {"SEED_MANAGED_IDENTITY_NAME": seed["name"], "USER_MANAGED_IDENTITY_NAME": runtime["name"],
                  "SQL_SERVER_NAME": server["name"],
                  "SQL_DATABASE_NAME": database["name"], "SERVICE_SEED_JOB_NAME": "seed-job",
                  "AZURE_CONTAINER_REGISTRY_ENDPOINT": "registry.azurecr.io"}
        resources = {"seed": seed, "runtime": runtime, "server": server, "database": database,
                     "job": job, "executions": [],
                     "registries": [{"loginServer": "registry.azurecr.io", "name": "registry"}],
                     "image": {"digest": "sha256:" + "d" * 64}}

        def azure(*args):
            if args[:2] == ("identity", "show"):
                return resources["seed"] if args[-1] == seed["name"] else resources["runtime"]
            if args[:3] == ("sql", "server", "show"):
                return resources["server"]
            if args[:3] == ("sql", "db", "show"):
                return resources["database"]
            if args[:3] == ("containerapp", "job", "show"):
                return resources["job"]
            if args[:4] == ("containerapp", "job", "execution", "list"):
                return resources["executions"]
            if args[:2] == ("acr", "list"):
                return resources["registries"]
            if args[:3] == ("acr", "repository", "show"):
                return resources["image"]
            self.fail("Unexpected Azure command")

        deployment = SimpleNamespace(group="group", environment="demo", subscription="subscription", runtime=None,
                                     required=lambda key: values[key], azure=azure)
        config = {"seedName": seed["name"], "clientId": client, "principalId": principal,
                  "runtimeName": runtime["name"], "runtimeClientId": runtime["clientId"],
                  "tenantId": tenant, "sqlHost": server["fullyQualifiedDomainName"],
                  "database": database["name"], "nonce": "a" * 32}
        return deployment, resources, config

    def evidence(self):
        return {"status": "PASS", "phase": "complete", "token": "PASS", "database": "PASS",
                "session": "PASS", "control": "PASS", "catalog": "PASS", "runtimePrincipal": "PASS",
                "runtimeDataRoles": "PASS", "runtimeExecute": "PASS", "externalAdminRoles": "PASS",
                "externalInventory": "PASS", "externalRoleClosure": "PASS",
                "externalDatabaseAdminGrants": "PASS", "externalScopedAdminGrants": "PASS",
                "dbo": True, "owner": True, "principalCount": 1,
                "privilegedExternalRoleCount": 0, "runtimeExplicitDenies": 0, "permissionEntries": 128,
                "transitivePrivilegedRoleCount": 0, "truncatedRolePathCount": 0,
                "publicRoleCount": 1, "privilegedDatabaseGrantCount": 0, "privilegedScopedGrantCount": 0}

    def test_snapshot_rejects_untrusted_identity_sql_job_and_image(self):
        defects = ["identity", "admin", "local-auth", "sql-host", "cloud", "database",
                   "retries", "parallel", "init", "sidecar", "image", "registry-identity",
                   "registry-ambiguous", "invalid-digest", "shared-identity"]
        for defect in ["valid", *defects]:
            with self.subTest(defect=defect):
                deployment, data, config = self.fixtures()
                job = data["job"]
                cloud = {"name": "AzureCloud", "suffix": ".database.windows.net"}
                if defect == "identity":
                    job["identity"]["userAssignedIdentities"]["/other"] = {}
                elif defect == "admin":
                    data["server"]["administrators"]["sid"] = config["clientId"]
                elif defect == "local-auth":
                    data["server"]["administrators"]["azureAdOnlyAuthentication"] = False
                elif defect == "sql-host":
                    data["server"]["fullyQualifiedDomainName"] = "sql-server.attacker.example"
                elif defect == "cloud":
                    cloud["suffix"] = ".attacker.example"
                elif defect == "database":
                    data["database"]["status"] = "Restoring"
                elif defect == "retries":
                    job["properties"]["configuration"]["replicaRetryLimit"] = 1
                elif defect == "parallel":
                    job["properties"]["configuration"]["manualTriggerConfig"]["parallelism"] = 2
                elif defect == "init":
                    job["properties"]["template"]["initContainers"] = [{}]
                elif defect == "sidecar":
                    job["properties"]["template"]["containers"].append({})
                elif defect == "image":
                    job["properties"]["template"]["containers"][0]["image"] = "registry.azurecr.io/other:latest"
                elif defect == "registry-identity":
                    job["properties"]["configuration"]["registries"][0]["identity"] = "/other"
                elif defect == "registry-ambiguous":
                    data["registries"].append(data["registries"][0])
                elif defect == "invalid-digest":
                    data["image"]["digest"] = "sha256:invalid"
                elif defect == "shared-identity":
                    data["runtime"]["id"] = data["seed"]["id"]
                with patch.object(seed_principal, "selected_account", return_value=config["tenantId"]), \
                        patch.object(seed_principal.auth, "json_command", return_value=cloud):
                    if defect == "valid":
                        snapshot = seed_principal.snapshot(deployment)
                        self.assertEqual(snapshot["probe"]["principalId"], config["principalId"])
                    else:
                        with self.assertRaises(seed_principal.auth.EvidenceError):
                            seed_principal.snapshot(deployment)

    def test_active_or_unknown_seed_execution_prevents_diagnostic(self):
        deployment, resources, _ = self.fixtures()
        for item in [None, {"properties": None}, {"properties": {"status": "Running"}},
                     {"properties": {"status": "Processing"}}, {"properties": {"status": None}}]:
            with self.subTest(execution=item):
                resources["executions"] = [item]
                with self.assertRaises(seed_principal.auth.EvidenceError):
                    seed_principal.require_no_active_executions(deployment, "seed-job")
        resources["executions"] = [{"properties": {"status": "Succeeded"}}]
        seed_principal.require_no_active_executions(deployment, "seed-job")

    def test_override_removes_seed_environment_and_mounts_and_uses_read_only_sql(self):
        _, resources, config = self.fixtures()
        original = resources["job"]["properties"]["template"]
        saved = copy.deepcopy(original)
        source = (ROOT / "tests/scripts/seed-sql-principal-probe.ps1").read_text()
        image = "registry.azurecr.io/seed-job@sha256:" + "d" * 64
        override = seed_principal.probe_template(original, config, source, image)
        self.assertEqual(original, saved)
        container = override["containers"][0]
        self.assertEqual(container["command"], ["pwsh"])
        self.assertEqual(container["image"], image)
        self.assertEqual(container["args"][:3], ["-NoLogo", "-NoProfile", "-Command"])
        self.assertEqual(container["env"], [])
        self.assertEqual(container["volumeMounts"], [])
        self.assertEqual(override["volumes"], [])
        self.assertNotIn("seed-database.ps1", container["args"][3])
        self.assertIn("sys.database_principals", source)
        query = source.split("$command.CommandText = @'\n", 1)[1].split("\n'@", 1)[0]
        query_without_literals = re.sub(r"'(?:''|[^'])*'", "''", query)
        self.assertIsNone(re.search(r"\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|EXEC(?:UTE)?)\b",
                                    query_without_literals, re.I))
        self.assertNotIn("ExecuteNonQuery", source)
        for key, invalid in [("nonce", "x"), ("clientId", "bad"), ("database", "db;DROP TABLE x"),
                             ("sqlHost", "other;attack"), ("seedName", "bad'name"),
                             ("runtimeName", "bad'name"), ("runtimeClientId", "bad")]:
            with self.subTest(key=key):
                with self.assertRaises(seed_principal.auth.EvidenceError):
                    seed_principal.probe_template(original, {**config, key: invalid}, source, image)
        with self.assertRaises(seed_principal.auth.EvidenceError):
            seed_principal.probe_template(original, config, source, "registry.azurecr.io/seed-job:latest")

    def test_role_closure_query_finds_nested_roles_grants_and_incomplete_paths(self):
        source = (ROOT / "tests/scripts/seed-sql-principal-probe.ps1").read_text()
        query = source.split("$command.CommandText = @'\n", 1)[1].split("\n'@", 1)[0]
        ctes = query.split("\nSELECT DB_NAME()", 1)[0]

        def observe(principals, memberships, permissions):
            connection = sqlite3.connect(":memory:")
            try:
                connection.executescript("""
                    ATTACH DATABASE ':memory:' AS sys;
                    CREATE TABLE sys.database_principals (principal_id INTEGER, type TEXT, name TEXT);
                    CREATE TABLE sys.database_role_members (member_principal_id INTEGER, role_principal_id INTEGER);
                    CREATE TABLE sys.database_permissions
                        (grantee_principal_id INTEGER, class INTEGER, permission_name TEXT, state TEXT,
                         major_id INTEGER, minor_id INTEGER);
                """)
                connection.executemany("INSERT INTO sys.database_principals VALUES (?, ?, ?)", principals)
                connection.executemany("INSERT INTO sys.database_role_members VALUES (?, ?)", memberships)
                connection.executemany("INSERT INTO sys.database_permissions VALUES (?, ?, ?, ?, ?, ?)",
                                       [(*row, 0, 0) if len(row) == 4 else row for row in permissions])
                return connection.execute(ctes + """
                    SELECT PrivilegedRoleCount, TruncatedPathCount, PublicRoleCount, PrivilegedGrantCount,
                           PrivilegedScopedGrantCount
                    FROM ExternalRoleEvidence
                """).fetchone()
            finally:
                connection.close()

        principals = [(1, "E", "runtime"), (2, "R", "child"), (3, "R", "peer"),
                      (4, "R", "db_owner"), (5, "X", "group"), (6, "S", "sql-user"),
                      (7, "R", "public")]
        memberships = [(1, 2), (2, 4), (1, 3), (3, 4), (5, 4), (6, 4)]
        permissions = [(2, 0, "ALTER ANY ROLE", "G"), (4, 0, "CREATE TABLE", "W"),
                       (7, 0, "CONTROL", "G"), (1, 0, "CREATE TABLE", "D"),
                       (2, 1, "CONTROL", "G"), (3, 0, "EXECUTE", "G")]
        self.assertEqual(observe(principals, memberships, []), (2, 0, 1, 0, 0))
        self.assertEqual(observe(principals, memberships, permissions), (2, 0, 1, 5, 3))
        self.assertEqual(observe(principals[:-1], memberships, permissions), (2, 0, 0, 3, 3))
        scoped_permissions = [
            (2, 1, "CONTROL", "G", 100, 0), (2, 1, "CONTROL", "G", 101, 0),
            (2, 3, "ALTER", "G"), (3, 4, "IMPERSONATE", "G"),
            (7, 3, "TAKE OWNERSHIP", "G"), (1, 0, "EXECUTE", "W"),
            (1, 1, "SELECT", "W", 100, 1), (1, 1, "SELECT", "W", 100, 2),
            (7, 10, "REFERENCES", "W"),
            (6, 1, "CONTROL", "G"), (1, 1, "CONTROL", "D"),
            (1, 3, "ALTER", "R"), (3, 1, "SELECT", "G"), (7, 1, "EXECUTE", "G"),
        ]
        self.assertEqual(observe(principals, memberships, scoped_permissions), (2, 0, 1, 0, 11))
        self.assertEqual(observe(principals, [], scoped_permissions), (0, 0, 1, 0, 7))

        cycle_principals = [(1, "E", "runtime"), (2, "R", "a"), (3, "R", "b"), (7, "R", "public")]
        self.assertEqual(observe(cycle_principals, [(1, 2), (2, 3), (3, 2)], []), (0, 1, 1, 0, 0))
        chain_principals = [(1, "E", "runtime"), (7, "R", "public")]
        chain_principals += [(number, "R", "db_ddladmin" if number == 165 else "role")
                             for number in range(101, 166)]
        chain_memberships = [(1, 101)] + [(number, number + 1) for number in range(101, 165)]
        self.assertEqual(observe(chain_principals, chain_memberships, []), (0, 1, 1, 0, 0))

    def test_execution_binding_rejects_seed_or_unreviewed_overrides(self):
        _, resources, config = self.fixtures()
        image = "registry.azurecr.io/seed-job@sha256:" + "d" * 64
        template = seed_principal.probe_template(resources["job"]["properties"]["template"], config, "safe", image)
        observed = copy.deepcopy(template)
        observed["containers"][0]["env"] = [{"name": "OTEL_SERVICE_NAME", "value": "seed"}]
        self.assertTrue(seed_principal.execution_matches(observed, template))
        for defect in ["command", "args", "image", "env", "env-prefix", "env-secret", "env-duplicate",
                       "mount", "volume", "init", "sidecar"]:
            with self.subTest(defect=defect):
                other = copy.deepcopy(observed)
                container = other["containers"][0]
                if defect == "command":
                    container["command"] = []
                elif defect == "args":
                    container["args"] = []
                elif defect == "image":
                    container["image"] = "foreign"
                elif defect == "env":
                    container["env"].append({"name": "SQL_SERVER_NAME", "value": "sql"})
                elif defect == "env-prefix":
                    container["env"].append({"name": "OTEL_UNREVIEWED", "value": "sql"})
                elif defect == "env-secret":
                    container["env"][0]["secretRef"] = "secret"
                elif defect == "env-duplicate":
                    container["env"].append(container["env"][0])
                elif defect == "mount":
                    container["volumeMounts"] = [{"mountPath": "/logs"}]
                elif defect == "volume":
                    other["volumes"] = [{}]
                elif defect == "init":
                    other["initContainers"] = [{}]
                else:
                    other["containers"].append({})
                self.assertFalse(seed_principal.execution_matches(other, template))

    def test_result_rejects_duplicates_inconsistent_status_and_unreviewed_fields(self):
        nonce = "a" * 32
        result = self.evidence()
        marker = "AUTH_SEED_SQL_PRINCIPAL:" + nonce + ":"
        line = marker + json.dumps(result)
        self.assertEqual(seed_principal.parse_evidence("private-sentinel\n" + line, nonce), result)
        malformed = [line + "\n" + line, marker + "not-json",
                     marker + json.dumps({**result, "secret": "private-sentinel"}),
                     marker + json.dumps({**result, "session": "FAIL"}),
                     marker + json.dumps({**result, "owner": 1}),
                     marker + json.dumps({**result, "principalCount": 0}),
                     marker + json.dumps({**result, "privilegedExternalRoleCount": 1}),
                     marker + json.dumps({**result, "permissionEntries": 0}),
                     marker + json.dumps({**result, "transitivePrivilegedRoleCount": None}),
                     marker + json.dumps({**result, "transitivePrivilegedRoleCount": 1}),
                     marker + json.dumps({**result, "truncatedRolePathCount": 1}),
                     marker + json.dumps({**result, "publicRoleCount": 0}),
                     marker + json.dumps({**result, "privilegedDatabaseGrantCount": 1}),
                     marker + json.dumps({**result, "privilegedScopedGrantCount": 1}),
                     marker + json.dumps({**result, "privilegedScopedGrantCount": None}),
                     marker + json.dumps({**result, "status": "FAIL", "externalRoleClosure": "FAIL",
                                          "privilegedExternalRoleCount": 1, "transitivePrivilegedRoleCount": 1}),
                     marker + json.dumps({**result, "status": "FAIL", "externalAdminRoles": "FAIL",
                                          "privilegedExternalRoleCount": 1})]
        for log in malformed:
            with self.subTest(log=log):
                with self.assertRaises(seed_principal.auth.EvidenceError) as error:
                    seed_principal.parse_evidence(log, nonce)
                self.assertNotIn("private-sentinel", str(error.exception))
        blocked = {**result, "status": "BLOCKED", "phase": "sql-connect",
                   "externalRoleClosure": "BLOCKED", "externalDatabaseAdminGrants": "BLOCKED",
                   "externalScopedAdminGrants": "BLOCKED",
                   **{field: None for field in seed_principal.ROLE_COUNTS}}
        self.assertEqual(seed_principal.parse_evidence(marker + json.dumps(blocked), nonce), blocked)

    def test_completed_evidence_retries_only_missing_logs(self):
        result = self.evidence()
        nonce = "a" * 32
        marker = "AUTH_SEED_SQL_PRINCIPAL:" + nonce + ":"
        line = marker + json.dumps(result)
        with patch.object(seed_principal, "execution_log", side_effect=["", line]) as log, \
                patch.object(seed_principal.time, "sleep") as sleep:
            self.assertEqual(seed_principal.completed_evidence(None, "job", "execution", "container", nonce), result)
            self.assertEqual(log.call_count, 2)
            sleep.assert_called_once_with(5)
        with patch.object(seed_principal, "execution_log", return_value=line + "\n" + line) as log, \
                patch.object(seed_principal.time, "sleep") as sleep, \
                self.assertRaises(seed_principal.auth.EvidenceError):
            seed_principal.completed_evidence(None, "job", "execution", "container", nonce)
        self.assertEqual(log.call_count, 1)
        sleep.assert_not_called()

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell is required for the seed-container probe")
    def test_powershell_checks_token_before_sql_and_withholds_session_details(self):
        _, _, config = self.fixtures()
        config["sqlHost"] = "sql-server.invalid"
        source = (ROOT / "tests/scripts/seed-sql-principal-probe.ps1").read_text()
        type_lookup = "$type = [System.Type]::GetType('Microsoft.Data.SqlClient.SqlConnection, Microsoft.Data.SqlClient')"
        self.assertIn(type_lookup, source)
        source = source.replace(type_lookup, "$type = [Microsoft.Data.SqlClient.SqlConnection]")
        fake_sql = """
            using System;
            using System.Data;
            namespace Microsoft.Data.SqlClient {
                public sealed class SqlConnection : IDisposable {
                    public SqlConnection(string value) { }
                    public string AccessToken { get; set; }
                    public void Open() {
                        if (Environment.GetEnvironmentVariable("SEED_TEST_SQL_FAILURE") == "1")
                            throw new InvalidOperationException("private-error-sentinel");
                        Console.WriteLine("FAKE_SQL_OPEN");
                    }
                    public Command CreateCommand() { return new Command(); }
                    public void Dispose() { }
                }
                public sealed class Command {
                    public int CommandTimeout { get; set; }
                    public string CommandText { get; set; }
                    public Parameters Parameters { get; } = new Parameters();
                    public Parameter CreateParameter() { return new Parameter(); }
                    public Reader ExecuteReader() { return new Reader(); }
                }
                public sealed class Parameters { public int Add(Parameter value) { return 0; } }
                public sealed class Parameter {
                    public string ParameterName { get; set; }
                    public DbType DbType { get; set; }
                    public object Value { get; set; }
                }
                public sealed class Reader : IDisposable {
                    private readonly bool match = Environment.GetEnvironmentVariable("SEED_TEST_MISMATCH") != "1";
                    private readonly string mode = Environment.GetEnvironmentVariable("SEED_TEST_CATALOG");
                    public bool Read() { return true; }
                    public bool IsDBNull(int index) { return mode == "scoped-missing" && index == 18; }
                    public object GetValue(int index) {
                        object[] values = { "AdventureWorks", match ? "seed-identity" : "private-login-sentinel",
                            match ? "seed-identity" : "private-login-sentinel", "dbo", match ? 1 : 0, 1, 1,
                            mode == "other" ? 2 : 1, mode == "missing" ? 0 : 1, 2, 1,
                            mode == "privileged" ? 1 : 0, 0, 128,
                            mode == "privileged" || mode == "nested" ? 1 : 0,
                            mode == "truncated" ? 1 : 0, mode == "public-missing" ? 0 : 1,
                            mode == "grant" ? 1 : 0, mode == "scoped-grant" ? 1 : 0 };
                        return values[index];
                    }
                    public void Dispose() { }
                }
            }
        """
        for scenario in ["valid", "token-mismatch", "token-malformed", "sql-mismatch", "sql-error",
                         "catalog-other", "catalog-missing", "catalog-privileged", "catalog-nested",
                         "catalog-truncated", "catalog-public-missing", "catalog-grant", "catalog-scoped-grant",
                         "catalog-scoped-missing"]:
            with self.subTest(scenario=scenario), TemporaryDirectory() as output:
                claims = {"oid": config["principalId"], "tid": config["tenantId"],
                          "appid": config["clientId"], "aud": "https://database.windows.net/"}
                if scenario == "token-mismatch":
                    claims["oid"] = "44444444-4444-4444-8444-444444444444"
                elif scenario == "token-malformed":
                    del claims["oid"]
                payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
                dll = (Path(output) / "Microsoft.Data.SqlClient.dll").as_posix().replace("'", "''")
                setup = f"""
                    $seedProbeConfig = '{json.dumps(config)}' | ConvertFrom-Json
                    $fakeToken = ConvertTo-SecureString -String 'fake.{payload}.signature' -AsPlainText -Force
                    $fakeSql = @'
{fake_sql}
'@
                    $null = Add-Type -TypeDefinition $fakeSql -OutputAssembly '{dll}'
                    $null = [Reflection.Assembly]::LoadFrom('{dll}')
                    function Import-Module {{ [CmdletBinding()]param([string]$Name) }}
                    function Disable-AzContextAutosave {{ [CmdletBinding()]param([string]$Scope) }}
                    function Connect-AzAccount {{ [CmdletBinding()]param([switch]$Identity,[string]$AccountId,[string]$TenantId) }}
                    function Get-AzAccessToken {{ [CmdletBinding()]param([string]$ResourceUrl); [pscustomobject]@{{Token=$fakeToken}} }}
                """
                environment = {**os.environ, "SEED_TEST_MISMATCH": "1" if scenario == "sql-mismatch" else "0",
                               "SEED_TEST_SQL_FAILURE": "1" if scenario == "sql-error" else "0",
                               "SEED_TEST_CATALOG": scenario.removeprefix("catalog-")}
                process = subprocess.run(["pwsh", "-NoLogo", "-NoProfile", "-Command", setup + "\n" + source],
                                         cwd=ROOT, capture_output=True, text=True, timeout=60, env=environment)
                evidence = seed_principal.parse_evidence(process.stdout, config["nonce"])
                self.assertNotIn("private-login-sentinel", process.stdout + process.stderr)
                self.assertNotIn("private-error-sentinel", process.stdout + process.stderr)
                if scenario == "valid":
                    self.assertEqual(process.returncode, 0, f"{evidence}; stderr={process.stderr}")
                    self.assertEqual(evidence["status"], "PASS")
                    self.assertIn("FAKE_SQL_OPEN", process.stdout)
                elif scenario in {"token-mismatch", "token-malformed"}:
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(evidence["token"], "FAIL")
                    self.assertNotIn("FAKE_SQL_OPEN", process.stdout)
                elif scenario == "sql-mismatch":
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(evidence["session"], "FAIL", f"{evidence}; stderr={process.stderr}")
                elif scenario == "sql-error":
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(evidence["status"], "BLOCKED")
                    self.assertEqual(evidence["phase"], "sql-connect")
                elif scenario == "catalog-other":
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(evidence["externalInventory"], "BLOCKED")
                elif scenario == "catalog-missing":
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(evidence["runtimePrincipal"], "FAIL")
                elif scenario == "catalog-privileged":
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(evidence["externalAdminRoles"], "FAIL")
                elif scenario == "catalog-nested":
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(evidence["externalAdminRoles"], "PASS")
                    self.assertEqual(evidence["externalRoleClosure"], "FAIL")
                elif scenario == "catalog-truncated":
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(evidence["externalRoleClosure"], "BLOCKED")
                    self.assertEqual(evidence["externalDatabaseAdminGrants"], "BLOCKED")
                    self.assertEqual(evidence["externalScopedAdminGrants"], "BLOCKED")
                elif scenario == "catalog-public-missing":
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(evidence["externalRoleClosure"], "PASS")
                    self.assertEqual(evidence["externalDatabaseAdminGrants"], "BLOCKED")
                    self.assertEqual(evidence["externalScopedAdminGrants"], "BLOCKED")
                elif scenario == "catalog-scoped-grant":
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(evidence["externalDatabaseAdminGrants"], "PASS")
                    self.assertEqual(evidence["externalScopedAdminGrants"], "FAIL")
                elif scenario == "catalog-scoped-missing":
                    self.assertNotEqual(process.returncode, 0)
                    for field in ["externalRoleClosure", "externalDatabaseAdminGrants", "externalScopedAdminGrants"]:
                        self.assertEqual(evidence[field], "BLOCKED")
                else:
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(evidence["externalDatabaseAdminGrants"], "FAIL")

    def test_confirmed_override_records_sanitized_evidence_and_uncertain_start_is_not_retried(self):
        deployment, resources, config = self.fixtures()
        seed = resources["seed"]
        job = resources["job"]
        before = {"jobId": job["id"], "jobName": "seed-job", "identity": job["identity"],
                  "template": job["properties"]["template"], "configuration": job["properties"]["configuration"],
                  "seed": seed, "runtime": resources["runtime"], "server": resources["server"],
                  "database": resources["database"],
                  "tenantId": config["tenantId"], "probeImage": "registry.azurecr.io/seed-job@sha256:" + "d" * 64,
                  "probe": {key: value for key, value in config.items() if key != "nonce"}}
        result = self.evidence()
        for uncertain in [False, True]:
            with self.subTest(uncertain=uncertain), TemporaryDirectory() as output:
                report = seed_principal.auth.Report(Path(output))
                recorded = {}

                def azure(*args):
                    if args[:3] == ("containerapp", "job", "start"):
                        recorded["starts"] = recorded.get("starts", 0) + 1
                        recorded["template"] = json.loads(Path(args[-1]).read_text())
                        if uncertain:
                            raise seed_principal.auth.EvidenceError("Start could not be confirmed")
                        return {"name": "seed-job-123"}
                    if args[:4] == ("containerapp", "job", "execution", "show"):
                        return {"id": "/jobs/seed-job/executions/seed-job-123", "name": "seed-job-123",
                                "properties": {"status": "Succeeded", "template": recorded["template"]}}
                    self.fail("Unexpected Azure operation")

                deployment.azure = azure
                with patch.object(seed_principal, "snapshot", return_value=before), \
                        patch.object(seed_principal, "require_no_active_executions"), \
                        patch.object(seed_principal, "execution_log", return_value="not retained"), \
                        patch.object(seed_principal, "parse_evidence", return_value=result):
                    if uncertain:
                        with self.assertRaises(seed_principal.auth.EvidenceError):
                            seed_principal.run(report, deployment, 30)
                    else:
                        seed_principal.run(report, deployment, 30)
                self.assertEqual(recorded["starts"], 1)
                ledger = json.loads((Path(output) / "seed-sql-principal-ledger.json").read_text())
                self.assertEqual(ledger["state"], "start-uncertain" if uncertain else "finished")
                self.assertEqual(recorded["template"]["containers"][0]["env"], [])
                if not uncertain:
                    self.assertTrue(all(item["status"] in {"PASS", "ACCEPTED_EXCEPTION"} for item in report.checks))
                    self.assertNotIn("not retained", json.dumps(report.checks))


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
            definition("legacy", "av-deployment-script-role-demo", [group], rbac.LEGACY_ACTIONS),
        ]
        assignments = [
            assignment(rbac.ACR_PULL, acr),
            assignment(rbac.COMMUNICATION_EMAIL_OWNER, communication),
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
        for mutation in ["no-pull", "no-email", "broad-email", "wrong-principal", "conditional-email", "wrong-role"]:
            with self.subTest(mutation=mutation):
                assignments, definitions, *args = copy.deepcopy(self.fixtures())
                if mutation == "no-pull":
                    assignments.pop(0)
                elif mutation == "no-email":
                    assignments.pop(1)
                elif mutation == "broad-email":
                    assignments[1]["scope"] = args[1]
                elif mutation == "wrong-principal":
                    assignments[1]["principalId"] = "other"
                elif mutation == "conditional-email":
                    assignments[1]["condition"] = "unreviewed"
                else:
                    assignments[1]["roleDefinitionId"] = "/roles/" + rbac.CONTRIBUTOR
                with self.assertRaises(rbac.ReconciliationError):
                    rbac.retirement_plan(assignments, definitions, *args)

    def test_unexpected_legacy_definition_fails_instead_of_deleting_it(self):
        for key in ["actions", "dataActions", "notActions"]:
            with self.subTest(key=key):
                values = copy.deepcopy(self.fixtures())
                values[1][0]["permissions"][0][key].append("unexpected")
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
        self.assertNotIn("communicationServiceAdminRoleAssignment", communication)
        self.assertNotIn("aadAdminObjectId", communication)
        self.assertIn("09976791-48a7-449e-bb21-39d1a415f350", communication)
        self.assertNotIn("resource emailSenderRole", communication)
        self.assertNotIn("principalId: identity.properties.principalId\n    principalType: 'ServicePrincipal'\n    roleDefinitionId:",
                         communication)
        self.assertIn("resource acrPullAssignment", (ROOT / "infra/modules/aca.bicep").read_text())
        hook = (ROOT / "scripts/hooks/postprovision.sh").read_text()
        self.assertIn('utilities/reconcile-runtime-rbac.py" --apply', hook)
        self.assertLess(hook.index('utilities/reconcile-runtime-rbac.py" --apply'), hook.index("Preparing the MCP"))
        self.assertIn('ensure_project_role "$_USER_OID" User "19c28022-e58e-450d-a464-0b2a53034789"', hook)
        dashboard = hook.split("# Check effective Aspire Dashboard permissions", 1)[1].split(
            'echo "Preparing the MCP OAuth signing certificate..."', 1)[0]
        self.assertIn("Microsoft.Authorization/permissions?api-version=2022-04-01", dashboard)
        self.assertIn("Microsoft.App/managedEnvironments/write", dashboard)
        self.assertNotIn("az role assignment create", dashboard)
        self.assertNotIn('--role "Contributor"', dashboard)
        self.assertNotIn("_CUSTOM_ROLE_NAME", hook)
        webpubsub = (ROOT / "infra/modules/webpubsub.bicep").read_text()
        aiservices = (ROOT / "infra/modules/aiservices.bicep").read_text()
        self.assertNotIn("resource webPubSubRuntimeRole", webpubsub)
        self.assertNotIn("resource foundryAgentsRoleDefinition", aiservices)
        self.assertIn("resource foundryAgentsProjectMiRoleAssignment",
                      aiservices)

    def test_seed_readiness_checks_file_data_not_management_share_properties(self):
        source = (ROOT / "api-functions/Services/DependencyHealthService.cs").read_text()
        probe = source.split('yield return new("files",', 1)[1].split("foreach (var probe", 1)[0]
        self.assertIn("ShareTokenIntent.Backup", probe)
        self.assertIn("await client.GetRootDirectoryClient().GetPropertiesAsync(cancellationToken: ct)", probe)
        self.assertNotIn("await client.GetPropertiesAsync(", probe)


class RuntimeKeyVaultProbeTests(unittest.TestCase):
    def fixtures(self):
        values = {
            "MCP_SIGNING_KEY_VAULT_NAME": "demo",
            "MCP_SIGNING_KEY_VAULT_URI": "https://demo.vault.azure.net/",
            "MCP_SIGNING_CERTIFICATE_NAME": "mcp-signing",
            "SERVICE_API_MCP_NAME": "mcp",
        }
        identity = {"id": "/identity", "clientId": "client"}
        vault = {"properties": {"enableRbacAuthorization": True, "accessPolicies": [],
                                "vaultUri": values["MCP_SIGNING_KEY_VAULT_URI"]}}
        app = {"identity": {"userAssignedIdentities": {"/identity": {}}},
               "properties": {"latestRevisionName": "mcp--rev1", "latestReadyRevisionName": "mcp--rev1",
                              "provisioningState": "Succeeded", "runningStatus": "Running",
                              "template": {"containers": [{"env": [
                   {"name": "MCP_SIGNING_KEY_VAULT_URI", "value": values["MCP_SIGNING_KEY_VAULT_URI"]},
                   {"name": "MCP_SIGNING_CERTIFICATE_NAME", "value": "mcp-signing"},
                   {"name": "MCP_KEYVAULT_MANAGED_IDENTITY_CLIENT_ID", "value": "client"},
               ]}]}}}
        deployment = SimpleNamespace(group="group", subscription="subscription", required=lambda key: values[key],
                                     arm=lambda *_: vault, azure=lambda *_: app)
        return deployment, identity, values, vault, app

    def test_selected_vault_matches_rbac_and_deployed_mcp_identity(self):
        deployment, identity, *_ = self.fixtures()
        self.assertEqual(probe.selected_keyvault_config(deployment, identity),
                         {"uri": "https://demo.vault.azure.net", "certificate": "mcp-signing"})

    def test_selected_vault_rejects_mismatched_target_identity_or_configuration(self):
        for defect in ["uri", "rbac", "access-policy", "attached-identity", "mcp-certificate",
                       "mcp-client", "duplicate-env", "invalid-certificate"]:
            with self.subTest(defect=defect):
                deployment, identity, values, vault, app = self.fixtures()
                env = app["properties"]["template"]["containers"][0]["env"]
                if defect == "uri":
                    vault["properties"]["vaultUri"] = "https://other.vault.azure.net/"
                elif defect == "rbac":
                    vault["properties"]["enableRbacAuthorization"] = False
                elif defect == "access-policy":
                    vault["properties"]["accessPolicies"] = [{}]
                elif defect == "attached-identity":
                    app["identity"]["userAssignedIdentities"] = {"/other": {}}
                elif defect == "mcp-certificate":
                    env[1]["value"] = "other"
                elif defect == "mcp-client":
                    env[2]["value"] = "other"
                elif defect == "duplicate-env":
                    env.append(copy.deepcopy(env[0]))
                else:
                    values["MCP_SIGNING_CERTIFICATE_NAME"] = "../other"
                with self.assertRaises(probe.auth.EvidenceError):
                    probe.selected_keyvault_config(deployment, identity)

    def test_signing_log_binds_current_revision_provider_and_selected_identity(self):
        deployment, identity, *_ = self.fixtures()
        keyvault = {"uri": "https://demo.vault.azure.net", "certificate": "mcp-signing"}
        records = [
            {"Log": "F info: AdventureWorks.Auth.KeyVaultCertificateSigningKeyProvider[0]"},
            {"Log": "F       Loaded MCP signing certificate 'mcp-signing' from Key Vault "
                    "(kid ABCD1234, attempt 1).", "TimeStamp": "2020-01-01T00:00:00.1234567+00:00"},
            {"Log": "private log content that must not appear in the report"},
        ]
        report = probe.auth.Report(Path("."))
        with patch.object(probe.auth, "command", return_value="\n".join(map(json.dumps, records))) as command:
            probe.mcp_signing_provider_log(report, deployment, identity, keyvault)
        self.assertEqual(report.checks[0]["status"], "PASS")
        self.assertNotIn("ABCD1234", json.dumps(report.checks))
        self.assertNotIn("private log content", json.dumps(report.checks))
        self.assertIn("mcp--rev1", command.call_args.args[0])

    def test_signing_log_does_not_credit_missing_stale_or_changed_evidence(self):
        keyvault = {"uri": "https://demo.vault.azure.net", "certificate": "mcp-signing"}
        category = {"Log": "F info: AdventureWorks.Auth.KeyVaultCertificateSigningKeyProvider[0]"}
        message = {"Log": "F Loaded MCP signing certificate 'mcp-signing' from Key Vault "
                          "(kid ABCD, attempt 1).", "TimeStamp": "2020-01-01T00:00:00Z"}
        for defect in ["missing-category", "wrong-certificate", "bad-timestamp", "future-timestamp", "malformed-log",
                       "not-ready", "changed-revision", "changed-identity"]:
            with self.subTest(defect=defect):
                deployment, identity, _, _, app = self.fixtures()
                records = [copy.deepcopy(category), copy.deepcopy(message)]
                current = copy.deepcopy(app)
                if defect == "missing-category":
                    records.pop(0)
                elif defect == "wrong-certificate":
                    records[1]["Log"] = records[1]["Log"].replace("mcp-signing", "other")
                elif defect == "bad-timestamp":
                    records[1]["TimeStamp"] = "not-a-date"
                elif defect == "future-timestamp":
                    records[1]["TimeStamp"] = "9999-01-01T00:00:00Z"
                elif defect == "not-ready":
                    app["properties"]["latestReadyRevisionName"] = "older"
                elif defect == "changed-revision":
                    current["properties"]["latestRevisionName"] = "mcp--rev2"
                elif defect == "changed-identity":
                    current["identity"]["userAssignedIdentities"] = {"/other": {}}
                deployment.azure = MagicMock(side_effect=[app, current])
                raw = "invalid-json" if defect == "malformed-log" else "\n".join(map(json.dumps, records))
                report = probe.auth.Report(Path("."))
                with patch.object(probe.auth, "command", return_value=raw), \
                        self.assertRaises(probe.auth.EvidenceError):
                    probe.mcp_signing_provider_log(report, deployment, identity, keyvault)
                self.assertFalse(report.checks)


class RuntimeServiceProfileTests(unittest.TestCase):
    def fixtures(self):
        functions = "b2b35cbf-5e15-4f4a-a2c2-7f450bb88b39"
        hosted = "46d650b8-8ee8-44aa-a7ba-5b917737fa5b"
        values = {"SERVICE_API_MCP_NAME": "mcp", "API_MCP_URL": "https://mcp.example.test/mcp"}
        env = [
            {"name": "MCP_TRUSTED_SERVICE_PRINCIPAL_IDS", "value": functions + "," + hosted},
            {"name": "MCP_FUNCTIONS_PRINCIPAL_ID", "value": functions},
            {"name": "MCP_HOSTED_MANUFACTURING_PRINCIPAL_ID", "value": hosted},
            {"name": "MCP_PUBLIC_BASE_URL", "value": "https://mcp.example.test"},
        ]
        app = {"properties": {"latestRevisionName": "mcp--rev1", "latestReadyRevisionName": "mcp--rev1",
                              "provisioningState": "Succeeded",
                              "configuration": {"ingress": {"fqdn": "mcp.example.test", "external": True}},
                              "template": {"containers": [{"env": env}]}}}
        agents = {"manufacturing-agent": {"versions": {"latest": {
            "definition": {"kind": "hosted"}, "instance_identity": {"principal_id": hosted},
        }}}}
        deployment = SimpleNamespace(group="group", required=lambda key: values[key], azure=lambda *_: app)
        return deployment, {"principalId": functions}, app, agents

    def test_selected_profile_binds_ready_revision_and_both_deployed_principals(self):
        deployment, identity, _, agents = self.fixtures()
        with patch.object(probe.auth, "fetch_agents", return_value=agents):
            selected = probe.selected_service_profile(deployment, identity)
        self.assertEqual(selected["origin"], "https://mcp.example.test")
        self.assertEqual(selected["revision"], "mcp--rev1")
        self.assertEqual(selected["hosted"], agents["manufacturing-agent"]["versions"]["latest"]["instance_identity"]["principal_id"])

    def test_selected_profile_rejects_stale_untrusted_or_foreign_targets(self):
        for defect in ["stale-revision", "wrong-profile", "extra-trust", "duplicate-env",
                       "foreign-issuer", "foreign-audience", "foreign-ingress", "wrong-agent-kind"]:
            with self.subTest(defect=defect):
                deployment, identity, app, agents = self.fixtures()
                env = app["properties"]["template"]["containers"][0]["env"]
                if defect == "stale-revision":
                    app["properties"]["latestReadyRevisionName"] = "older"
                elif defect == "wrong-profile":
                    env[1]["value"] = env[2]["value"]
                elif defect == "extra-trust":
                    env[0]["value"] += ",3a3f63e6-0000-0000-0000-000000000003"
                elif defect == "duplicate-env":
                    env.append(copy.deepcopy(env[1]))
                elif defect == "foreign-issuer":
                    env[3]["value"] = "https://other.example.test"
                elif defect == "foreign-audience":
                    env.append({"name": "MCP_RESOURCE_IDENTIFIER", "value": "https://other.example.test/mcp"})
                elif defect == "foreign-ingress":
                    app["properties"]["configuration"]["ingress"]["fqdn"] = "other.example.test"
                else:
                    agents["manufacturing-agent"]["versions"]["latest"]["definition"]["kind"] = "prompt"
                with patch.object(probe.auth, "fetch_agents", return_value=agents), \
                        self.assertRaises(probe.auth.EvidenceError):
                    probe.selected_service_profile(deployment, identity)


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

    def test_manufacturing_receiver_binds_the_requested_group_and_step_correlation(self):
        deployment = SimpleNamespace(required=lambda key: "https://functions.example.test")
        helper = probe.auth.load_auth_helper()
        process = MagicMock()
        process.stdin = self.CapturedInput()
        probe_id = "12345678-1234-4123-8123-123456789abc"
        with patch.object(probe.auth, "selected_webpubsub_resource",
                          return_value=("push.example.test", {"disableAadAuth": False})), \
                patch.object(probe.auth, "load_auth_helper", return_value=helper), \
                patch.object(probe.auth, "internal_token_target",
                             return_value=("https://mcp.example.test", "audience")), \
                patch.object(helper, "session", return_value={"access_token": "secret-user-token"}) as session, \
                patch.object(probe.auth, "http", return_value=(200, {}, b"capability")), \
                patch.object(probe.auth, "webpubsub_group_claims",
                             return_value=({"manufacturing-agent"}, 600)), \
                patch.object(probe.auth, "webpubsub_socket_target",
                             return_value="/client/hubs/adventureworks?access_token=secret-capability"), \
                patch.object(probe.subprocess, "Popen", return_value=process), \
                patch.object(probe, "receiver_line", return_value="SOCKET_READY"):
            started, config = probe.start_webpubsub_receiver(
                deployment, identity="manufacturing", group="manufacturing-agent", probe_id=probe_id)
        self.assertIs(started, process)
        self.assertEqual(config["probeId"], probe_id)
        self.assertEqual(json.loads(process.stdin.value)["kind"], "functions-step")
        self.assertEqual(session.call_args.args[1].identity, "manufacturing")

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

    def test_shared_runtime_transport_accepts_detail_free_report_recovery_checks(self):
        deployment = SimpleNamespace(group="group", subscription="subscription")
        document = {"checks": [{"name": "runtime-identity", "status": "PASS"},
                               {"name": "report-readback", "status": "PASS"}],
                    "runId": "test-run", "prefix": "test-prefix", "artifacts": {}}
        for marker in ["AUTH_ASSURANCE_DOWNLOAD_RESULT", "AUTH_RUNTIME_RBAC_RESULT"]:
            with self.subTest(marker=marker):
                payload = ("Welcome to Node\n" + marker + ":" + json.dumps(document) + "\n").encode()
                process = MagicMock()
                process.poll.return_value = 0
                with patch.object(probe.pty, "openpty", return_value=(10, 11)), \
                        patch.object(probe.subprocess, "Popen", return_value=process), \
                        patch.object(probe.select, "select", return_value=([10], [], [])), \
                        patch.object(probe.os, "read", return_value=payload), \
                        patch.object(probe.os, "write"), \
                        patch.object(probe.time, "sleep"), \
                        patch.object(probe.os, "close"):
                    if marker == "AUTH_RUNTIME_RBAC_RESULT":
                        with self.assertRaises(probe.auth.EvidenceError):
                            probe.execute(deployment, "admin", "", marker=marker)
                    else:
                        self.assertEqual(probe.execute(deployment, "admin", "", marker=marker), document)

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


class FunctionsPushProbeTests(unittest.TestCase):
    discovered = {
        "app": "admin", "storageResourceId": "/storage", "principalId": "principal",
        "tableEndpoint": "https://table.example.test/", "clientId": "client", "tenantId": "tenant",
    }

    @staticmethod
    def document(*names):
        return {"checks": [{"name": name, "status": "PASS", "detail": "verified"} for name in names],
                "etagSha256": "a" * 64}

    def test_confirmed_callback_is_correlated_and_fixture_is_cleaned(self):
        with TemporaryDirectory() as output:
            report = functions_push.auth.Report(Path(output))
            deployment = SimpleNamespace(environment="demo",
                                         required=lambda key: "https://functions.example.test")
            created = self.document("fixture-identity", "fixture-absent-before", "fixture-created",
                                    "fixture-confirmed", "fixture-baseline-etag")
            inspected = self.document("fixture-identity", "fixture-owned", "fixture-no-steps",
                                      "fixture-baseline-etag")
            cleaned = self.document("fixture-identity", "fixture-owned", "fixture-safe-to-delete",
                                    "fixture-step-persisted", "fixture-etag", "fixture-deleted", "fixture-absent")
            with patch.object(functions_push, "discover", return_value=self.discovered), \
                    patch.object(functions_push, "manufacturing_token", return_value="secret-token"), \
                    patch.object(functions_push, "dab_control"), \
                    patch.object(functions_push, "consumer_token", return_value="consumer-token"), \
                    patch.object(functions_push, "denied_callbacks") as denied, \
                    patch.object(functions_push.runtime, "start_webpubsub_receiver",
                                 return_value=(object(), {})), \
                    patch.object(functions_push.runtime, "stop_receiver"), \
                    patch.object(functions_push.runtime, "receiver_line", return_value="MESSAGE_RECEIVED"), \
                    patch.object(functions_push, "fixture_operation", side_effect=[created, inspected, cleaned]) as fixture, \
                    patch.object(functions_push.auth, "http", return_value=(204, {}, b"")) as http:
                functions_push.run(report, deployment)
            ledger = json.loads((Path(output) / "fixture-ledger.json").read_text())
            self.assertEqual((ledger["creation"], ledger["cleanup"]), ("confirmed", "confirmed"))
            self.assertEqual(fixture.call_args_list[1].args[-1], "inspect")
            self.assertEqual(fixture.call_args_list[2].args[-2:], ("cleanup", "present"))
            denied.assert_called_once()
            self.assertEqual(http.call_count, 1)
            self.assertEqual(http.call_args.kwargs["data"]["key"], "auth-assurance-" + ledger["probeId"])
            self.assertEqual({item["status"] for item in report.checks}, {"PASS"})
            self.assertNotIn("secret-token", json.dumps(ledger))

    def test_callback_transport_error_still_cleans_the_exact_fixture(self):
        with TemporaryDirectory() as output:
            report = functions_push.auth.Report(Path(output))
            deployment = SimpleNamespace(environment="demo",
                                         required=lambda key: "https://functions.example.test")
            created = self.document("fixture-identity", "fixture-absent-before", "fixture-created",
                                    "fixture-confirmed", "fixture-baseline-etag")
            inspected = self.document("fixture-identity", "fixture-owned", "fixture-no-steps",
                                      "fixture-baseline-etag")
            cleaned = self.document("fixture-identity", "fixture-owned", "fixture-safe-to-delete",
                                    "fixture-etag", "fixture-deleted", "fixture-absent")
            with patch.object(functions_push, "discover", return_value=self.discovered), \
                    patch.object(functions_push, "manufacturing_token", return_value="token"), \
                    patch.object(functions_push, "dab_control"), \
                    patch.object(functions_push, "consumer_token", return_value="consumer-token"), \
                    patch.object(functions_push, "denied_callbacks"), \
                    patch.object(functions_push.runtime, "start_webpubsub_receiver",
                                 return_value=(object(), {})), \
                    patch.object(functions_push.runtime, "stop_receiver"), \
                    patch.object(functions_push, "fixture_operation", side_effect=[created, inspected, cleaned]) as fixture, \
                    patch.object(functions_push.auth, "http",
                                 side_effect=functions_push.auth.EvidenceError("uncertain callback")) as http:
                with self.assertRaisesRegex(functions_push.auth.EvidenceError, "uncertain callback"):
                    functions_push.run(report, deployment)
            ledger = json.loads((Path(output) / "fixture-ledger.json").read_text())
            self.assertEqual(ledger["cleanup"], "confirmed")
            self.assertEqual(fixture.call_args_list[2].args[-2:], ("cleanup", "unknown"))
            self.assertEqual(http.call_count, 1)

    def test_uncertain_insert_and_absent_row_remain_blocked(self):
        with TemporaryDirectory() as output:
            report = functions_push.auth.Report(Path(output))
            deployment = SimpleNamespace(environment="demo", required=lambda key: "https://functions.example.test")
            absent = self.document("fixture-identity", "fixture-absent")
            with patch.object(functions_push, "discover", return_value=self.discovered), \
                    patch.object(functions_push, "manufacturing_token", return_value="token"), \
                    patch.object(functions_push, "dab_control"), \
                    patch.object(functions_push, "consumer_token", return_value="consumer-token"), \
                    patch.object(functions_push.runtime, "start_webpubsub_receiver",
                                 return_value=(object(), {})), \
                    patch.object(functions_push.runtime, "stop_receiver"), \
                    patch.object(functions_push, "fixture_operation",
                                 side_effect=[functions_push.auth.EvidenceError("uncertain insert"), absent]), \
                    patch.object(functions_push.auth, "http") as http:
                with self.assertRaisesRegex(functions_push.auth.EvidenceError, "uncertain insert"):
                    functions_push.run(report, deployment)
            ledger = json.loads((Path(output) / "fixture-ledger.json").read_text())
            self.assertEqual((ledger["creation"], ledger["cleanup"]), ("requested", "unconfirmed"))
            self.assertEqual(next(item for item in report.checks if item["id"] == "functions-push:cleanup")["status"],
                             "BLOCKED")
            http.assert_not_called()

    def test_denials_require_correct_challenges_and_stop_after_unexpected_success(self):
        deployment = SimpleNamespace(required=lambda key: "https://mcp.example.test/mcp")
        payload = {"key": "auth-assurance-id", "label": "Authentication assurance", "status": "started"}
        cases = [(401, "missing_token"), (401, "invalid_token"), (401, "invalid_token"),
                 (403, "insufficient_scope")]
        responses = [
            (status, {"WWW-Authenticate": ('Bearer resource_metadata="https://mcp.example.test/'
                                            f'.well-known/oauth-protected-resource", error="{error}"')},
             json.dumps({"error": error}).encode())
            for status, error in cases
        ]
        with TemporaryDirectory() as output:
            report = functions_push.auth.Report(Path(output))
            with patch.object(functions_push.auth, "http", side_effect=responses) as http:
                functions_push.denied_callbacks(report, deployment, "https://functions.example.test/callback",
                                                payload, "dab-token", "consumer-token")
            self.assertEqual(http.call_count, 4)
            self.assertTrue(all(item["status"] == "PASS" for item in report.checks))
            report = functions_push.auth.Report(Path(output))
            with patch.object(functions_push.auth, "http", return_value=(204, {}, b"")) as http:
                with self.assertRaisesRegex(functions_push.auth.EvidenceError, "denial failed"):
                    functions_push.denied_callbacks(report, deployment, "https://functions.example.test/callback",
                                                    payload, "dab-token", "consumer-token")
            self.assertEqual(http.call_count, 1)

    def test_missing_consumer_is_explicitly_blocked(self):
        report = MagicMock()
        with patch.object(functions_push.auth, "retained_consumer_fixtures",
                          side_effect=functions_push.auth.EvidenceError("fixture unavailable")):
            self.assertIsNone(functions_push.consumer_token(report, SimpleNamespace()))
        self.assertEqual(report.add.call_args.args[:3],
                         ("functions-push:deny-insufficient-scope", "live-denials", "BLOCKED"))

    def test_wrong_audience_token_must_first_read_a_real_dab_product(self):
        helper = SimpleNamespace(IDENTITIES={"manufacturing": ("", "", "", "", "manufacturing-engineer")})
        deployment = SimpleNamespace(required=lambda key: "https://dab.example.test/graphql/")
        valid = b'{"data":{"products":{"items":[{"ProductID":1}]}}}'
        invalid = b'{"data":{"products":{"items":[]}},"errors":[{"message":"denied"}]}'
        with TemporaryDirectory() as output:
            with patch.object(functions_push.auth, "load_auth_helper", return_value=helper), \
                    patch.object(functions_push.auth, "http", return_value=(200, {}, valid)):
                functions_push.dab_control(functions_push.auth.Report(Path(output)), deployment, "token")
            with patch.object(functions_push.auth, "load_auth_helper", return_value=helper), \
                    patch.object(functions_push.auth, "http", return_value=(200, {}, invalid)):
                with self.assertRaisesRegex(functions_push.auth.EvidenceError, "positive control failed"):
                    functions_push.dab_control(functions_push.auth.Report(Path(output)), deployment, "token")

    def test_changed_fixture_state_stops_before_authorized_callback(self):
        with TemporaryDirectory() as output:
            report = functions_push.auth.Report(Path(output))
            deployment = SimpleNamespace(environment="demo", required=lambda key: "https://functions.example.test")
            created = self.document("fixture-identity", "fixture-absent-before", "fixture-created",
                                    "fixture-confirmed", "fixture-baseline-etag")
            inspected = self.document("fixture-identity", "fixture-owned", "fixture-no-steps",
                                      "fixture-baseline-etag")
            inspected["etagSha256"] = "b" * 64
            cleaned = self.document("fixture-identity", "fixture-owned", "fixture-safe-to-delete",
                                    "fixture-etag", "fixture-deleted", "fixture-absent")
            with patch.object(functions_push, "discover", return_value=self.discovered), \
                    patch.object(functions_push, "manufacturing_token", return_value="token"), \
                    patch.object(functions_push, "dab_control"), \
                    patch.object(functions_push, "consumer_token", return_value="consumer-token"), \
                    patch.object(functions_push, "denied_callbacks"), \
                    patch.object(functions_push.runtime, "start_webpubsub_receiver", return_value=(object(), {})), \
                    patch.object(functions_push.runtime, "stop_receiver"), \
                    patch.object(functions_push, "fixture_operation", side_effect=[created, inspected, cleaned]), \
                    patch.object(functions_push.auth, "http") as http:
                with self.assertRaisesRegex(functions_push.auth.EvidenceError, "not unchanged"):
                    functions_push.run(report, deployment)
            http.assert_not_called()
            self.assertEqual(next(item for item in report.checks
                                  if item["id"] == "functions-push:denials-unchanged")["status"], "FAIL")

    def test_recovery_refuses_a_different_deployment(self):
        with TemporaryDirectory() as output:
            path = Path(output) / "ledger.json"
            path.write_text(json.dumps({
                "version": 1, "environment": "demo", "creation": "confirmed",
                "probeId": "12345678-1234-4123-8123-123456789abc", "enqueuedAt": "2026-01-01T12:00:00Z",
                "storageResourceId": "/different-storage", "principalId": "principal", "app": "admin",
            }))
            deployment = SimpleNamespace(environment="demo")
            with patch.object(functions_push, "discover", return_value=self.discovered), \
                    patch.object(functions_push, "fixture_operation") as fixture:
                with self.assertRaisesRegex(functions_push.auth.EvidenceError, "original deployment"):
                    functions_push.recover(functions_push.auth.Report(Path(output)), deployment, path)
                fixture.assert_not_called()


if __name__ == "__main__":
    unittest.main()
