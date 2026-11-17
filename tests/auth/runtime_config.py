"""Restricted configuration handoff for a private assurance job, never an azd replacement."""

import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit


VALUE_KEYS = {
    "AZURE_ENV_NAME", "AZURE_SUBSCRIPTION_ID", "AZURE_RESOURCE_GROUP",
    "API_URL", "API_FUNCTIONS_URL", "API_MCP_URL", "APP_URL", "APP_ADMIN_URL",
    "APP_MANUFACTURING_URL", "MCP_INSPECTOR_URL", "SERVICE_APP_NAME",
    "MCP_RESOURCE_IDENTIFIER", "DAB_RESOURCE_IDENTIFIER", "FUNCTIONS_RESOURCE_IDENTIFIER",
    "MCP_SIGNING_KEY_VAULT_NAME", "MCP_SIGNING_KEY_VAULT_URI",
}
VALUE_KEYS.update("AUTH_TEST_CONSUMER_" + label + "_" + suffix
                  for label in ["A", "B"]
                  for suffix in ["EMAIL", "PASSWORD", "BUSINESS_ENTITY_ID", "STATE"])


def load():
    path = os.environ.get("AUTH_ASSURANCE_MANIFEST_FILE")
    if not path:
        return None
    document = json.loads(Path(path).read_text())
    if document.get("schemaVersion") != 1 or not isinstance(document.get("values"), dict):
        raise ValueError("Invalid private assurance configuration")
    if set(document["values"]) - VALUE_KEYS:
        raise ValueError("Unreviewed environment value in private assurance configuration")
    storage = document.get("storage")
    if storage is not None:
        if not isinstance(storage, dict) or set(storage) - {
                "endpoint", "prefix", "tableEndpoint", "mutationTableName"}:
            raise ValueError("Invalid private storage configuration")
        for key in ["endpoint", "prefix"]:
            if not isinstance(storage.get(key), str) or not storage[key]:
                raise ValueError("Invalid private storage configuration")
        table_endpoint = storage.get("tableEndpoint")
        table_name = storage.get("mutationTableName")
        if (table_endpoint is None) != (table_name is None):
            raise ValueError("Temporary table endpoint and name must be configured together")
        if table_endpoint is not None:
            if not isinstance(table_endpoint, str) or not isinstance(table_name, str):
                raise ValueError("Invalid temporary test-table configuration")
            parsed = urlsplit(table_endpoint)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/")
                    or parsed.query or parsed.fragment or parsed.username or parsed.password
                    or not re.fullmatch(r"awtest[0-9a-f]{32}", table_name)):
                raise ValueError("Invalid temporary test-table configuration")
    flags = ["addressOnly", "browserOnly", "sqlOnly", "mutations"]
    for flag in flags:
        if flag in document and type(document[flag]) is not bool:
            raise ValueError("Invalid private assurance execution mode")
    if sum(document.get(flag, False) for flag in flags) > 1:
        raise ValueError("Private assurance execution modes are mutually exclusive")
    return document
