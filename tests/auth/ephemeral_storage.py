"""Temporary Azure Table Storage fixtures for private assurance tests."""

from contextlib import contextmanager
import re
import uuid


TABLE_NAME_PATTERN = re.compile(r"awtest[0-9a-f]{32}\Z")
RUN_ID_PATTERN = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")


class TemporaryTableCleanupError(RuntimeError):
    def __init__(self, table_name):
        super().__init__(f"Temporary assurance table cleanup failed: {table_name}")
        self.table_name = table_name


class TemporaryTableCreationError(RuntimeError):
    def __init__(self, table_name):
        super().__init__(f"Temporary assurance table creation was not confirmed: {table_name}")
        self.table_name = table_name


class MutationRunLedger:
    _FIELDS = ("kind", "state", "id", "owner", "marker", "entity", "label")

    def __init__(self, table_client, run_id):
        if not isinstance(run_id, str) or not RUN_ID_PATTERN.fullmatch(run_id):
            raise ValueError("Mutation ledger run identity is invalid")
        self._table = table_client
        self._run_id = run_id
        self._row_keys = {}

    def record(self, residual):
        row_key = "mutation-" + uuid.uuid4().hex
        self._row_keys[id(residual)] = row_key
        self._table.create_entity(self._entity(residual, row_key))

    def update(self, residual):
        row_key = self._row_keys.get(id(residual))
        if row_key is None:
            raise ValueError("Mutation ledger entry was not recorded")
        self._table.upsert_entity(self._entity(residual, row_key))

    def snapshot(self):
        return [
            {key: value for key, value in entity.items()
             if key in {"PartitionKey", "RowKey", *self._FIELDS}}
            for entity in self._table.query_entities(
                query_filter=f"PartitionKey eq '{self._run_id}'")
            if entity.get("RowKey") != "persistence-probe"
        ]

    def _entity(self, residual, row_key):
        entity = {
            "PartitionKey": self._run_id,
            "RowKey": row_key,
        }
        for key in self._FIELDS:
            value = residual.get(key)
            if isinstance(value, (str, int, bool)):
                entity[key] = value
        return entity


def new_table_name():
    return "awtest" + uuid.uuid4().hex


@contextmanager
def temporary_table(service_client, table_name):
    if not isinstance(table_name, str) or not TABLE_NAME_PATTERN.fullmatch(table_name):
        raise ValueError("Temporary test table name is not a generated assurance name")

    try:
        table_client = service_client.create_table(table_name)
    except Exception as error:
        raise TemporaryTableCreationError(table_name) from error
    try:
        yield table_client
    finally:
        try:
            service_client.delete_table(table_name)
        except Exception as error:
            raise TemporaryTableCleanupError(table_name) from error
