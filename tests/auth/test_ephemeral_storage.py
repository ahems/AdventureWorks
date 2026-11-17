import json
import importlib.util
import os
import re
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ephemeral_storage import (
    MutationRunLedger, TemporaryTableCleanupError, TemporaryTableCreationError, new_table_name, temporary_table,
)

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "assurance_entrypoint", ROOT / "tests/auth/container/entrypoint.py")
entrypoint = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(entrypoint)


class TableService:
    def __init__(self, fail_create=False, fail_delete=False):
        self.fail_create = fail_create
        self.fail_delete = fail_delete
        self.created = []
        self.deleted = []
        self.table = object()
        self.entities = {}
        self.closed = False

    def create_table(self, name):
        if self.fail_create:
            raise RuntimeError("create failed")
        self.created.append(name)
        self.table = self
        return self

    def create_entity(self, entity):
        self.entities[(entity["PartitionKey"], entity["RowKey"])] = dict(entity)

    def upsert_entity(self, entity):
        self.entities[(entity["PartitionKey"], entity["RowKey"])] = dict(entity)

    def get_entity(self, partition_key, row_key):
        return self.entities[(partition_key, row_key)]

    def query_entities(self, query_filter):
        partition_key = query_filter.split("'")[1]
        return [entity for (partition, _), entity in self.entities.items() if partition == partition_key]

    def delete_table(self, name):
        if self.fail_delete:
            raise RuntimeError("delete failed")
        self.deleted.append(name)

    def close(self):
        self.closed = True


class EphemeralStorageTests(unittest.TestCase):
    def test_names_are_random_and_valid_azure_table_names(self):
        names = {new_table_name() for _ in range(32)}
        self.assertEqual(len(names), 32)
        self.assertTrue(all(re.fullmatch(r"awtest[0-9a-f]{32}", name) for name in names))

    def test_table_is_deleted_after_successful_use(self):
        service = TableService()
        name = new_table_name()

        with temporary_table(service, name) as table:
            self.assertIs(table, service.table)

        self.assertEqual(service.created, [name])
        self.assertEqual(service.deleted, [name])

    def test_table_is_deleted_when_test_body_fails(self):
        service = TableService()
        name = new_table_name()

        with self.assertRaisesRegex(RuntimeError, "test failed"):
            with temporary_table(service, name):
                raise RuntimeError("test failed")

        self.assertEqual(service.deleted, [name])

    def test_invalid_or_uncreated_table_is_never_deleted(self):
        service = TableService(fail_create=True)
        with self.assertRaises(ValueError):
            with temporary_table(service, "appBusinessData"):
                self.fail("invalid table names must not be created")
        self.assertEqual(service.deleted, [])

        with self.assertRaises(TemporaryTableCreationError):
            with temporary_table(service, new_table_name()):
                self.fail("failed creation must not yield a table")
        self.assertEqual(service.deleted, [])

    def test_uncertain_create_is_reported_without_deleting_or_starting_mutations(self):
        class UncertainTableService(TableService):
            def create_table(self, name):
                self.created.append(name)
                raise TimeoutError("private transport detail")

        service = UncertainTableService()
        name = new_table_name()
        configuration = {
            "runId": "20261113T120000Z-8b2bc931-cd54-4f4f-8963-acde3143ad21",
            "storage": {"tableEndpoint": "https://selected.table.core.windows.net",
                        "mutationTableName": name},
        }
        ran = []
        result = entrypoint.temporary_storage_check(
            configuration, object(), service_factory=lambda endpoint, credential: service,
            run_checks=lambda: ran.append(True))

        check, = result["checks"]
        self.assertEqual(check["status"], "FAIL")
        self.assertIn(name, check["detail"])
        self.assertIn("not confirmed", check["detail"])
        self.assertNotIn("private transport detail", check["detail"])
        self.assertEqual(service.created, [name])
        self.assertEqual(service.deleted, [])
        self.assertEqual(ran, [])
        self.assertTrue(service.closed)

    def test_cleanup_failure_is_not_silenced(self):
        service = TableService(fail_delete=True)
        with self.assertRaises(TemporaryTableCleanupError) as raised:
            with temporary_table(service, new_table_name()):
                pass
        self.assertRegex(str(raised.exception), r"^Temporary assurance table cleanup failed: awtest[0-9a-f]{32}$")

    def test_private_probe_persists_and_removes_only_the_named_run_table(self):
        service = TableService()
        name = new_table_name()
        configuration = {
            "runId": "20261113T120000Z-8b2bc931-cd54-4f4f-8963-acde3143ad21",
            "storage": {"tableEndpoint": "https://selected.table.core.windows.net",
                        "mutationTableName": name},
        }

        result = entrypoint.temporary_storage_check(
            configuration, object(), service_factory=lambda endpoint, credential: service)

        check, = result["checks"]
        self.assertEqual(check["id"], "storage:temporary-assurance-table")
        self.assertEqual(check["status"], "PASS")
        self.assertIn(name, check["detail"])
        self.assertEqual(service.created, [name])
        self.assertEqual(service.deleted, [name])
        self.assertTrue(service.closed)

    def test_private_probe_keeps_table_available_for_mutations_and_snapshots_ledger(self):
        service = TableService()
        name = new_table_name()
        configuration = {
            "runId": "20261113T120000Z-8b2bc931-cd54-4f4f-8963-acde3143ad21",
            "storage": {"tableEndpoint": "https://selected.table.core.windows.net",
                        "mutationTableName": name},
        }

        def run_checks():
            self.assertEqual(service.deleted, [])
            service.create_entity({
                "PartitionKey": configuration["runId"],
                "RowKey": "mutation-example",
                "kind": "review",
                "state": "creation-requested",
            })

        result = entrypoint.temporary_storage_check(
            configuration, object(), service_factory=lambda endpoint, credential: service,
            run_checks=run_checks)

        self.assertEqual(result["mutationLedger"], [{
            "PartitionKey": configuration["runId"],
            "RowKey": "mutation-example",
            "kind": "review",
            "state": "creation-requested",
        }])
        self.assertEqual(service.deleted, [name])

    def test_private_probe_does_not_run_mutations_when_table_creation_fails(self):
        service = TableService(fail_create=True)
        ran = []
        configuration = {
            "runId": "20261113T120000Z-8b2bc931-cd54-4f4f-8963-acde3143ad21",
            "storage": {"tableEndpoint": "https://selected.table.core.windows.net",
                        "mutationTableName": new_table_name()},
        }

        result = entrypoint.temporary_storage_check(
            configuration, object(), service_factory=lambda endpoint, credential: service,
            run_checks=lambda: ran.append(True))

        self.assertEqual(result["checks"][0]["status"], "FAIL")
        self.assertEqual(ran, [])

    def test_private_probe_deletes_table_if_mutation_suite_raises(self):
        service = TableService()
        name = new_table_name()
        configuration = {
            "runId": "20261113T120000Z-8b2bc931-cd54-4f4f-8963-acde3143ad21",
            "storage": {"tableEndpoint": "https://selected.table.core.windows.net",
                        "mutationTableName": name},
        }

        def fail_suite():
            raise RuntimeError("suite failed")

        with self.assertRaisesRegex(RuntimeError, "suite failed"):
            entrypoint.temporary_storage_check(
                configuration, object(), service_factory=lambda endpoint, credential: service,
                run_checks=fail_suite)

        self.assertEqual(service.deleted, [name])
        self.assertTrue(service.closed)

    def test_nested_creation_failure_is_not_misattributed_to_the_outer_table(self):
        service = TableService()
        name, nested_name = new_table_name(), new_table_name()
        configuration = {
            "runId": "20261113T120000Z-8b2bc931-cd54-4f4f-8963-acde3143ad21",
            "storage": {"tableEndpoint": "https://selected.table.core.windows.net",
                        "mutationTableName": name},
        }

        def fail_nested():
            raise TemporaryTableCreationError(nested_name)

        with self.assertRaises(TemporaryTableCreationError) as raised:
            entrypoint.temporary_storage_check(
                configuration, object(), service_factory=lambda endpoint, credential: service,
                run_checks=fail_nested)
        self.assertEqual(raised.exception.table_name, nested_name)
        self.assertEqual(service.deleted, [name])
        self.assertTrue(service.closed)

    def test_private_probe_surfaces_failed_table_cleanup(self):
        service = TableService(fail_delete=True)
        name = new_table_name()
        configuration = {
            "runId": "20261113T120000Z-8b2bc931-cd54-4f4f-8963-acde3143ad21",
            "storage": {"tableEndpoint": "https://selected.table.core.windows.net",
                        "mutationTableName": name},
        }

        result = entrypoint.temporary_storage_check(
            configuration, object(), service_factory=lambda endpoint, credential: service)

        check, = result["checks"]
        self.assertEqual(check["status"], "FAIL")
        self.assertIn(name, check["detail"])
        self.assertTrue(service.closed)

    def test_mutation_ledger_persists_updates_without_credentials(self):
        service = TableService()
        name = new_table_name()
        with temporary_table(service, name) as table:
            run_id = "20261113T120000Z-8b2bc931-cd54-4f4f-8963-acde3143ad21"
            ledger = MutationRunLedger(table, run_id)
            residual = {"kind": "review", "state": "creation-requested", "owner": 42,
                        "password": "must-not-persist", "email": "must-not-persist"}
            ledger.record(residual)
            self.assertEqual(len(ledger.snapshot()), 1)

            residual.update({"state": "retained", "id": 99})
            ledger.update(residual)
            saved, = ledger.snapshot()
            self.assertEqual(saved["state"], "retained")
            self.assertEqual(saved["id"], 99)
            self.assertEqual(saved["owner"], 42)
            self.assertNotIn("password", saved)
            self.assertNotIn("email", saved)

        self.assertEqual(service.deleted, [name])

    def test_mutation_ledger_rejects_unrecorded_updates(self):
        ledger = MutationRunLedger(TableService(), "20261113T120000Z-8b2bc931-cd54-4f4f-8963-acde3143ad21")
        with self.assertRaises(ValueError):
            ledger.update({"state": "retained"})
        with self.assertRaises(ValueError):
            MutationRunLedger(TableService(), "other-run")

    def test_read_only_profiles_do_not_create_test_tables(self):
        self.assertIsNone(entrypoint.temporary_storage_check(
            {"storage": {"endpoint": "https://selected.blob.core.windows.net"}},
            object()))

    def test_runtime_config_accepts_only_valid_temporary_table_metadata(self):
        table_name = new_table_name()
        valid = {
            "schemaVersion": 1,
            "values": {},
            "storage": {
                "endpoint": "https://selected.blob.core.windows.net/",
                "prefix": "auth-assurance/test/",
                "tableEndpoint": "https://selected.table.core.windows.net/",
                "mutationTableName": table_name,
            },
        }
        invalid_storage = [
            {**valid["storage"], "extra": "not-allowed"},
            {**valid["storage"], "mutationTableName": "shoppingSimulator"},
            {**valid["storage"], "tableEndpoint": "http://selected.table.core.windows.net"},
            {key: value for key, value in valid["storage"].items() if key != "mutationTableName"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "configuration.json"
            for storage in [valid["storage"], *invalid_storage]:
                path.write_text(json.dumps({**valid, "storage": storage}))
                with patch.dict(os.environ, {"AUTH_ASSURANCE_MANIFEST_FILE": str(path)}):
                    if storage is valid["storage"]:
                        self.assertEqual(entrypoint.runtime_config.load()["storage"], storage)
                    else:
                        with self.assertRaises(ValueError):
                            entrypoint.runtime_config.load()


if __name__ == "__main__":
    unittest.main()
