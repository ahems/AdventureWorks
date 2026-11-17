#!/usr/bin/env python3
"""Authentication assurance. Never treats unavailable evidence as conformance."""

import argparse
import base64
import binascii
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import fcntl
import fnmatch
import http.client as http_client
import http.cookiejar as cookiejar
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
import yaml

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = Path(__file__).with_name("contracts.json")
STATUSES = {"PASS", "FAIL", "BLOCKED", "ACCEPTED_EXCEPTION", "NOT_APPLICABLE"}


class EvidenceError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def command(args, *, environment=None, timeout=180):
    try:
        result = subprocess.run(args, cwd=ROOT, env=environment, capture_output=True,
                                text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise EvidenceError(f"{args[0]} unavailable or timed out") from error
    if result.returncode:
        # CLI output may contain tokens or application settings. Never echo it.
        raise EvidenceError(f"{args[0]} {args[1]} exited {result.returncode}")
    return result.stdout


def json_command(args, *, allow_empty=False, **kwargs):
    try:
        raw = command(args, **kwargs)
        if allow_empty and not raw.strip():
            return None
        return json.loads(raw)
    except ValueError as error:
        raise EvidenceError(f"{args[0]} returned invalid JSON") from error


def https_url(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or
            parsed.password or parsed.query or parsed.fragment):
        raise EvidenceError("Expected an absolute deployment HTTPS URL without credentials/query/fragment")
    return value.rstrip("/")


def origin(value):
    parsed = urllib.parse.urlsplit(https_url(value))
    return f"{parsed.scheme}://{parsed.netloc}"


def deployment_origin_inventory(deployment):
    sources = {
        "storefront": "APP_URL",
        "admin": "APP_ADMIN_URL",
        "manufacturing": "APP_MANUFACTURING_URL",
        "mcp-inspector": "MCP_INSPECTOR_URL",
        "dab": "API_URL",
        "functions": "API_FUNCTIONS_URL",
        "mcp": "API_MCP_URL",
    }
    return [
        {
            "id": "origin:" + surface,
            "sourceKey": key,
            "origin": origin(deployment.required(key)),
        }
        for surface, key in sources.items()
    ]


def record_deployment_origin_inventory(report, deployment):
    try:
        inventory = deployment_origin_inventory(deployment)
    except EvidenceError as error:
        report.add("inventory:deployment-origins", "inventory", "FAIL", str(error))
        return
    report.inventory["deploymentOrigins"] = inventory
    report.provenance["deploymentOriginInventorySha256"] = hashlib.sha256(
        json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    report.check(
        "inventory:deployment-origins", "inventory",
        len(inventory) == 7 and len({item["id"] for item in inventory}) == len(inventory),
        "Every configured site and API has a stable origin identity",
    )


def route_path(route):
    def substitute(match):
        specification = match.group(1).lstrip("*").rstrip("?")
        if ":guid" in specification:
            return "11111111-1111-1111-1111-111111111111"
        return "1" if re.search(r":(?:int|long|decimal|double|float)", specification) else "auth-validation"
    return re.sub(r"\{([^{}]+)\}", substitute, route)


def reviewed_function_read_routes():
    try:
        routes = json.loads(CONTRACTS.read_text())["safeFunctionReadRoutes"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise EvidenceError("Reviewed Functions read-route contract is unavailable or invalid") from error
    if not isinstance(routes, dict) or not routes:
        raise EvidenceError("Reviewed Functions read-route contract is empty or invalid")
    for name, route in routes.items():
        if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_]+", name) or
                not isinstance(route, str) or not route or route != route.strip("/") or
                any(char in route for char in "?#\\") or
                any(segment in {".", ".."} for segment in route.split("/"))):
            raise EvidenceError("Reviewed Functions read-route contract contains an invalid entry")
    return routes


def is_reviewed_function_read(function, routes):
    policy = function.get("Policy")
    name = function.get("Name")
    return (isinstance(policy, dict) and policy.get("IsAnonymous") is False and
            function.get("Methods") == ["GET"] and
            name in routes and routes[name] == function.get("Route"))


def http(method, url, *, token=None, data=None, form=None, headers=None, timeout=90, opener=None):
    parsed = urllib.parse.urlsplit(url)
    https_url(urllib.parse.urlunsplit(parsed._replace(query="", fragment="")))
    if parsed.fragment:
        raise EvidenceError("HTTP request URLs must not contain fragments")
    request_headers = {"Accept": "application/json, text/event-stream"}
    request_headers.update(headers or {})
    if token:
        request_headers["Authorization"] = "Bearer " + token
    body = None if data is None else json.dumps(data).encode()
    if body is not None:
        request_headers["Content-Type"] = "application/json"
    if form is not None:
        if data is not None:
            raise EvidenceError("HTTP request cannot contain both JSON and form data")
        body = urllib.parse.urlencode(form).encode()
        request_headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(url, method=method, headers=request_headers, data=body)
    opener = opener or urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.headers, response.read(2 * 1024 * 1024)
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.headers, error.read(2 * 1024 * 1024)
    except (urllib.error.URLError, TimeoutError) as error:
        raise EvidenceError("Network/TLS/timeout failure; not an authorization denial") from error


def action_names(permission):
    actions = permission.get("actions")
    if not isinstance(actions, list) or not actions:
        raise EvidenceError("DAB permission has no actions")
    names = [action if isinstance(action, str) else action["action"] for action in actions]
    if any(name not in {"read", "create", "update", "delete", "execute", "*"} for name in names):
        raise EvidenceError("Unsupported DAB permission action")
    return names


def review_denial_body(base):
    status, _, body = http("GET", base + "/api/Product/ProductID/0")
    try:
        document = json.loads(body)
    except ValueError as error:
        raise EvidenceError("Review-denial fixture lookup returned invalid JSON") from error
    if status != 200 or document.get("value") != []:
        raise EvidenceError("Cannot establish a nonexistent product for a non-persistable review denial")
    return {
        "ProductID": 0, "ReviewerName": "Authentication assurance",
        "ReviewDate": datetime.now(timezone.utc).isoformat(),
        "EmailAddress": "auth-assurance@example.invalid", "Rating": 5,
        "Comments": "AUTH-DENIAL-NONEXISTENT-PRODUCT", "UserID": 0,
    }


def passwordless_sql(value):
    if not isinstance(value, str) or not value:
        return False
    fields = {}
    for part in value.split(";"):
        if not part.strip():
            continue
        key, separator, item = part.partition("=")
        if not separator:
            return False
        key = key.strip().lower().replace(" ", "")
        if key in fields:
            return False
        fields[key] = item.strip().lower().replace(" ", "")
    return (fields.get("authentication") in {"activedirectorydefault", "activedirectorymanagedidentity",
                                            "activedirectorymsi"} and
            not any(key in fields for key in ["password", "pwd", "userid", "uid", "accesstoken"]))


def sensitive_management_grants(definition, scope=None):
    probes = [
        "Microsoft.Authorization/roleAssignments/write",
        "Microsoft.Authorization/roleAssignments/delete",
        "Microsoft.ManagedIdentity/userAssignedIdentities/assign/action",
        "Microsoft.Resources/deployments/write",
        "Microsoft.Resources/deploymentScripts/write",
        "Microsoft.ContainerInstance/containerGroups/write",
        "Microsoft.Storage/storageAccounts/write",
        "Microsoft.Storage/storageAccounts/delete",
        "Microsoft.Storage/storageAccounts/listKeys/action",
        "Microsoft.Storage/storageAccounts/regenerateKey/action",
        "Microsoft.ContainerRegistry/registries/write",
        "Microsoft.ContainerRegistry/registries/delete",
        "Microsoft.ContainerRegistry/registries/listCredentials/action",
        "Microsoft.KeyVault/vaults/write",
        "Microsoft.KeyVault/vaults/accessPolicies/write",
        "Microsoft.Communication/communicationServices/write",
        "Microsoft.Communication/communicationServices/delete",
        "Microsoft.Communication/communicationServices/listKeys/action",
        "Microsoft.Communication/communicationServices/regenerateKey/action",
        "Microsoft.SignalRService/webPubSub/write",
        "Microsoft.SignalRService/webPubSub/delete",
        "Microsoft.SignalRService/webPubSub/listKeys/action",
        "Microsoft.SignalRService/webPubSub/regenerateKey/action",
        "Microsoft.CognitiveServices/accounts/write",
        "Microsoft.CognitiveServices/accounts/listKeys/action",
        "Microsoft.CognitiveServices/accounts/regenerateKey/action",
        "Microsoft.CognitiveServices/accounts/deployments/write",
        "Microsoft.CognitiveServices/accounts/deployments/delete",
        "Microsoft.CognitiveServices/accounts/raiPolicies/write",
        "Microsoft.CognitiveServices/accounts/raiPolicies/delete",
        "Microsoft.CognitiveServices/accounts/commitmentplans/write",
        "Microsoft.CognitiveServices/accounts/commitmentplans/delete",
    ]
    if scope is not None:
        if not isinstance(scope, str):
            raise EvidenceError("Role assignment scope is invalid")
        parts = scope.lower().strip("/").split("/")
        broad_scope = (scope == "/" or (len(parts) == 2 and parts[0] == "subscriptions") or
                       (len(parts) == 4 and parts[0] == "subscriptions" and parts[2] == "resourcegroups") or
                       (len(parts) == 4 and parts[:3] == ["providers", "microsoft.management", "managementgroups"]))
        if not broad_scope:
            if "providers" not in parts:
                raise EvidenceError("Role assignment scope cannot be evaluated")
            provider_index = max(index for index, part in enumerate(parts) if part == "providers")
            suffix = parts[provider_index + 1:]
            if len(suffix) < 3 or len(suffix) % 2 != 1:
                raise EvidenceError("Role assignment resource scope is incomplete")
            prefix = suffix[0] + "/" + "/".join(suffix[1::2]) + "/"
            probes = [operation for operation in probes if
                      operation.lower().startswith(prefix) or
                      operation.lower().startswith("microsoft.authorization/roleassignments/")]
    permissions = definition.get("permissions")
    if not isinstance(permissions, list) or not permissions:
        raise EvidenceError("Role definition permissions are unavailable")
    granted = set()
    for permission in permissions:
        if not isinstance(permission, dict):
            raise EvidenceError("Role definition permission block has invalid shape")
        actions, excluded = permission.get("actions"), permission.get("notActions", [])
        if (not isinstance(actions, list) or not isinstance(excluded, list) or
                any(not isinstance(action, str) or not action for action in actions + excluded)):
            raise EvidenceError("Role definition actions have invalid shape")
        for operation in probes:
            if (any(fnmatch.fnmatchcase(operation.lower(), action.lower()) for action in actions) and
                    not any(fnmatch.fnmatchcase(operation.lower(), action.lower()) for action in excluded)):
                granted.add(operation)
    return sorted(granted)


def reviewed_email_sender(definition, assignment, communication_scope, principal):
    rule = json.loads(CONTRACTS.read_text())["runtimeEmailRole"]
    permissions = definition.get("permissions")
    if not isinstance(permissions, list) or len(permissions) != 1 or not isinstance(permissions[0], dict):
        return False
    block = permissions[0]
    actions = block.get("actions")
    scopes = definition.get("assignableScopes")
    return (isinstance(actions, list) and all(isinstance(item, str) for item in actions) and
            {item.lower() for item in actions} == {item.lower() for item in rule["actions"]} and
            not any(block.get(key) for key in ["dataActions", "notActions", "notDataActions"]) and
            definition.get("roleName", "").startswith(rule["roleNamePrefix"]) and
            isinstance(scopes, list) and len(scopes) == 1 and
            scopes[0].lower() == communication_scope.lower() and
            assignment.get("scope", "").lower() == communication_scope.lower() and
            assignment.get("principalId", "").lower() == principal.lower() and
            not assignment.get("condition") and not assignment.get("conditionVersion"))


def reviewed_webpubsub_runtime(definition, assignment, webpubsub_scope, principal):
    rule = json.loads(CONTRACTS.read_text())["runtimeWebPubSubRole"]
    permissions = definition.get("permissions")
    if not isinstance(permissions, list) or len(permissions) != 1 or not isinstance(permissions[0], dict):
        return False
    block = permissions[0]
    actions = block.get("dataActions")
    scopes = definition.get("assignableScopes")
    assignment_scope = assignment.get("scope")
    assignment_principal = assignment.get("principalId")
    return (isinstance(actions, list) and all(isinstance(item, str) for item in actions) and
            len(actions) == len(rule["dataActions"]) and
            {item.lower() for item in actions} == {item.lower() for item in rule["dataActions"]} and
            all(block.get(key) == [] for key in ["actions", "notActions", "notDataActions"]) and
            not block.get("condition") and not block.get("conditionVersion") and
            definition.get("roleType") == "CustomRole" and
            isinstance(definition.get("roleName"), str) and
            definition["roleName"].startswith(rule["roleNamePrefix"]) and
            isinstance(scopes, list) and len(scopes) == 1 and
            isinstance(scopes[0], str) and scopes[0].lower() == webpubsub_scope.lower() and
            isinstance(assignment_scope, str) and assignment_scope.lower() == webpubsub_scope.lower() and
            isinstance(assignment_principal, str) and assignment_principal.lower() == principal.lower() and
            not assignment.get("condition") and not assignment.get("conditionVersion"))


def unreviewed_webpubsub_data_grants(definition, reviewed_role=False):
    permissions = definition.get("permissions")
    if not isinstance(permissions, list) or not permissions:
        raise EvidenceError("Role definition permissions are unavailable")
    allowed = {action.lower() for action in
               json.loads(CONTRACTS.read_text())["runtimeWebPubSubRole"]["dataActions"]}
    resource_prefix = "microsoft.signalrservice/webpubsub/"
    unreviewed = set()
    for block in permissions:
        actions = block.get("dataActions") if isinstance(block, dict) else None
        excluded = block.get("notDataActions") if isinstance(block, dict) else None
        if (not isinstance(actions, list) or not isinstance(excluded, list) or
                any(not isinstance(action, str) or not action or action.strip() != action
                    for action in actions + excluded)):
            raise EvidenceError("Role definition data actions have invalid shape")
        for action in actions:
            pattern = action.lower()
            prefix = re.split(r"[*?\[]", pattern, maxsplit=1)[0]
            applies = (pattern.startswith(resource_prefix) or
                       (prefix != pattern and resource_prefix.startswith(prefix)))
            if applies and (not reviewed_role or pattern not in allowed):
                unreviewed.add(action)
    return sorted(unreviewed)


def role_scope_overlaps(scope, target):
    if not isinstance(scope, str) or not scope or not isinstance(target, str) or not target:
        raise EvidenceError("Role assignment scope is invalid")
    scope, target = scope.lower().rstrip("/"), target.lower().rstrip("/")
    return (not scope or target == scope or target.startswith(scope + "/") or
            scope.startswith(target + "/") or
            scope.startswith("/providers/microsoft.management/managementgroups/"))


def mcp_document(body):
    try:
        text = body.decode("utf-8")
        if text.lstrip().startswith("{"):
            document = json.loads(text)
        else:
            frames = [json.loads(line[5:].strip()) for line in text.splitlines()
                      if line.startswith("data:")]
            document = next(frame for frame in reversed(frames)
                            if isinstance(frame, dict) and ("result" in frame or "error" in frame))
        if not isinstance(document, dict):
            raise ValueError("not an object")
        return document
    except (ValueError, StopIteration, UnicodeError) as error:
        raise EvidenceError("MCP response has no valid JSON-RPC result/error") from error


def fetch_agents(deployment):
    base = https_url(deployment.required("AI_FOUNDRY_PROJECT_ENDPOINT")) + "/agents"
    url = base + "?api-version=2025-11-15-preview"
    agents = {}
    cursors = set()
    for _ in range(100):
        page = deployment.azure("rest", "--method", "get", "--resource", "https://ai.azure.com",
                                "--url", url)
        if not isinstance(page, dict) or not isinstance(page.get("data"), list):
            raise EvidenceError("Unsupported Foundry agent list shape")
        for item in page["data"]:
            name = item.get("name")
            if not isinstance(name, str) or name in agents:
                raise EvidenceError("Missing or repeated agent name in pagination")
            agents[name] = item
        if not page.get("has_more"):
            if not agents:
                raise EvidenceError("Deployed Foundry agent discovery is empty")
            return agents
        cursor = page.get("last_id")
        if not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise EvidenceError("Missing/repeated Foundry pagination cursor")
        cursors.add(cursor)
        url = base + "?" + urllib.parse.urlencode(
            {"api-version": "2025-11-15-preview", "after": cursor})
    raise EvidenceError("Foundry pagination exceeded bounded discovery limit")


def fetch_agent_versions(deployment, name):
    if not isinstance(name, str) or not name:
        raise EvidenceError("Foundry agent name is missing")
    base = (https_url(deployment.required("AI_FOUNDRY_PROJECT_ENDPOINT")) +
            "/agents/" + urllib.parse.quote(name, safe="") + "/versions")
    url = base + "?api-version=2025-11-15-preview"
    versions = {}
    cursors = set()
    for _ in range(100):
        page = deployment.azure("rest", "--method", "get", "--resource", "https://ai.azure.com",
                                "--url", url)
        if not isinstance(page, dict) or not isinstance(page.get("data"), list):
            raise EvidenceError("Unsupported Foundry agent-version list shape")
        for item in page["data"]:
            version = item.get("version") if isinstance(item, dict) else None
            definition = item.get("definition") if isinstance(item, dict) else None
            if (not isinstance(version, str) or not version or version in versions or
                    not isinstance(definition, dict) or item.get("name") != name):
                raise EvidenceError("Missing, repeated or malformed Foundry agent version")
            versions[version] = item
        if not page.get("has_more"):
            if not versions:
                raise EvidenceError("Deployed Foundry agent has no discoverable versions")
            return versions
        cursor = page.get("last_id")
        if not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise EvidenceError("Missing/repeated Foundry agent-version pagination cursor")
        cursors.add(cursor)
        url = base + "?" + urllib.parse.urlencode(
            {"api-version": "2025-11-15-preview", "after": cursor})
    raise EvidenceError("Foundry agent-version pagination exceeded bounded discovery limit")


def foundry_agent_version_id(name, version):
    if not isinstance(name, str) or not name or not isinstance(version, str) or not version:
        raise EvidenceError("Foundry agent name or version is missing")
    return f"foundry:agent:{name}:version:{version}"


def foundry_agent_identity_present(agent_version):
    identity = agent_version.get("instance_identity")
    principal_id = identity.get("principal_id") if isinstance(identity, dict) else None
    if not isinstance(principal_id, str) or not principal_id.strip():
        return False
    try:
        uuid.UUID(principal_id)
    except ValueError:
        return False
    return True


def parse_principal_id_allowlist(value):
    if not isinstance(value, str) or not value.strip():
        raise EvidenceError("Managed-identity trust allow-list is empty")
    values = re.split(r"[,;\s]+", value.strip())
    try:
        normalized = [str(uuid.UUID(item)) for item in values if item]
    except ValueError as error:
        raise EvidenceError("Managed-identity trust allow-list contains an invalid principal ID") from error
    if len(normalized) != len(values) or len(normalized) != len(set(normalized)):
        raise EvidenceError("Managed-identity trust allow-list has empty or duplicate principal IDs")
    return set(normalized)


def seed_acr_pull_is_exact(assignments, principal_id, registry_scope):
    acr_pull_id = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
    if not isinstance(assignments, list) or len(assignments) != 1:
        return False
    assignment = assignments[0]
    return (isinstance(assignment, dict) and
            str(assignment.get("principalId", "")).lower() == principal_id.lower() and
            isinstance(assignment.get("roleDefinitionId"), str) and
            assignment["roleDefinitionId"].lower().endswith("/" + acr_pull_id) and
            isinstance(assignment.get("scope"), str) and
            assignment["scope"].lower() == registry_scope.lower() and
            not assignment.get("condition"))


def seed_sql_admin_matches(properties, identity, tenant_id):
    return (isinstance(properties, dict) and isinstance(identity, dict) and
            properties.get("administratorType") == "ActiveDirectory" and
            str(properties.get("sid", "")).lower() == str(identity.get("principalId", "")).lower() and
            str(properties.get("login", "")).lower() == str(identity.get("name", "")).lower() and
            str(properties.get("tenantId", "")).lower() == str(tenant_id).lower())


def foundry_custom_role_assignment_matches_source(assignments, project_scope):
    prefix = "AdventureWorks Foundry Agents "
    if not isinstance(assignments, list):
        return False
    foundry_roles = [item for item in assignments if isinstance(item, dict) and
                     isinstance(item.get("roleDefinitionName"), str) and
                     item["roleDefinitionName"].startswith(prefix)]
    if len(foundry_roles) != 1:
        return False
    role_name, scope = (foundry_roles[0].get("roleDefinitionName"),
                        foundry_roles[0].get("scope"))
    return (re.fullmatch(re.escape(prefix) + r"[a-z0-9]{13}", role_name) is not None and
            isinstance(scope, str) and scope.lower() == project_scope.lower())


def foundry_builtin_role_assignments_match_source(assignments, account_scope, project_scope):
    if not isinstance(assignments, list):
        return False
    expected = [
        ("Cognitive Services OpenAI User", account_scope.lower()),
        ("Azure AI Developer", account_scope.lower()),
        ("Azure AI Developer", project_scope.lower()),
    ]
    actual = []
    for item in assignments:
        if not isinstance(item, dict) or item.get("roleDefinitionName") not in {
                "Cognitive Services OpenAI User", "Cognitive Services OpenAI Contributor", "Azure AI Developer"}:
            continue
        scope = item.get("scope")
        if not isinstance(scope, str):
            return False
        actual.append((item["roleDefinitionName"], scope.lower()))
    return sorted(actual) == sorted(expected)


def foundry_project_scope(subscription, resource_group, account_name, endpoint):
    parsed = urllib.parse.urlsplit(https_url(endpoint))
    path = parsed.path.rstrip("/").split("/")
    if len(path) < 4 or path[-3] != "api" or path[-2] != "projects" or not path[-1]:
        raise EvidenceError("Foundry project endpoint has no static project name")
    return (f"/subscriptions/{subscription}/resourceGroups/{resource_group}"
            f"/providers/Microsoft.CognitiveServices/accounts/{account_name}/projects/{path[-1]}")


def container_registry_identity_is_valid(app, identity_id, registry_server):
    if not isinstance(app, dict):
        return False
    attached = (app.get("identity") or {}).get("userAssignedIdentities", {})
    properties = app.get("properties") or {}
    registries = (properties.get("configuration") or {}).get("registries")
    if (not isinstance(attached, dict) or identity_id.lower() not in
            {resource.lower() for resource in attached} or
            not isinstance(registries, list) or len(registries) != 1 or
            not isinstance(registries[0], dict)):
        return False
    server, configured_identity = registries[0].get("server"), registries[0].get("identity")
    return (isinstance(server, str) and server.lower() == registry_server.lower() and
            isinstance(configured_identity, str) and configured_identity.lower() == identity_id.lower() and
            registries[0].get("username") in (None, "") and
            registries[0].get("passwordSecretRef") in (None, ""))


def selected_resource_host(value, resource):
    try:
        parsed = urllib.parse.urlsplit("https://" + value)
        if (not parsed.hostname or parsed.hostname != value.lower() or "." not in parsed.hostname or
                parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise ValueError("Invalid host")
        return parsed.hostname
    except ValueError as error:
        raise EvidenceError(f"Selected {resource} endpoint is invalid") from error


def container_registry_authentication(report, deployment):
    server = selected_resource_host(deployment.required("AZURE_CONTAINER_REGISTRY_ENDPOINT"), "container registry")
    name = server.split(".", 1)[0]
    registry = deployment.azure(
        "acr", "show", "--resource-group", deployment.group, "--name", name, "--query",
        "{id:id,loginServer:loginServer,adminUserEnabled:adminUserEnabled,anonymousPullEnabled:anonymousPullEnabled}")
    scope = (f"/subscriptions/{deployment.subscription}/resourceGroups/{deployment.group}"
             f"/providers/Microsoft.ContainerRegistry/registries/{name}")
    if (not isinstance(registry, dict) or not isinstance(registry.get("id"), str) or
            registry["id"].lower() != scope.lower() or
            not isinstance(registry.get("loginServer"), str) or
            registry["loginServer"].lower() != server or
            type(registry.get("adminUserEnabled")) is not bool or
            type(registry.get("anonymousPullEnabled")) is not bool):
        raise EvidenceError("Selected registry authentication evidence is incomplete or inconsistent")
    report.check("infra:acr-admin-user-disabled", "infra", not registry["adminUserEnabled"],
                 "Selected ACR shared admin user is disabled; managed-identity image pulls are checked separately")
    report.check("infra:acr-anonymous-pull-disabled", "infra", not registry["anonymousPullEnabled"],
                 "Selected ACR does not permit anonymous image pulls")

    def repository_tokens():
        tokens = deployment.azure("acr", "token", "list", "--registry", name,
                                  "--query", "[].{status:status}")
        if (not isinstance(tokens, list) or
                any(not isinstance(token, dict) or not isinstance(token.get("status"), str) or
                    token["status"].lower() not in {"enabled", "disabled"} for token in tokens)):
            raise EvidenceError("Selected registry token inventory is incomplete or inconsistent")
        report.check("infra:acr-repository-tokens-disabled", "infra",
                     all(token["status"].lower() == "disabled" for token in tokens),
                     "Selected ACR has no enabled non-Entra repository-scoped tokens; credential values are not requested")

    report.guarded("infra:acr-repository-tokens-disabled", "infra", repository_tokens)


def selected_webpubsub_resource(deployment):
    host = selected_resource_host(deployment.required("WEB_PUBSUB_HOST_NAME"), "Web PubSub")
    name = host.split(".", 1)[0]
    resource = deployment.arm("Microsoft.SignalRService/webPubSub/" + name, "2024-03-01")
    scope = (f"/subscriptions/{deployment.subscription}/resourceGroups/{deployment.group}"
             f"/providers/Microsoft.SignalRService/webPubSub/{name}")
    if (not isinstance(resource, dict) or not isinstance(resource.get("id"), str) or
            resource["id"].lower() != scope.lower()):
        raise EvidenceError("Selected Web PubSub resource does not match the deployment")
    properties = resource.get("properties")
    if (not isinstance(properties, dict) or not isinstance(properties.get("hostName"), str) or
            properties["hostName"].lower() != host):
        raise EvidenceError("Selected Web PubSub host does not match the deployed resource")
    return host, properties


def webpubsub_authentication(report, deployment):
    _, properties = selected_webpubsub_resource(deployment)
    if (type(properties.get("disableLocalAuth")) is not bool or
            type(properties.get("disableAadAuth")) is not bool):
        raise EvidenceError("Selected Web PubSub authentication evidence is incomplete or inconsistent")
    report.check("infra:webpubsub-local-auth-disabled", "infra", properties["disableLocalAuth"],
                 "Selected Web PubSub disables local access-key authentication; client capability tokens are checked separately")
    report.check("infra:webpubsub-entra-auth-enabled", "infra", not properties["disableAadAuth"],
                 "Selected Web PubSub permits Entra authentication; the actual workload principal is checked separately")


def communication_authentication(report, deployment):
    name = deployment.required("COMMUNICATION_SERVICE_NAME")
    endpoint = urllib.parse.urlsplit(https_url(deployment.required("COMMUNICATION_SERVICE_ENDPOINT")))
    host = selected_resource_host(endpoint.netloc, "Communication Services")
    if host != name.lower() + ".communication.azure.com" or endpoint.path not in ("", "/"):
        raise EvidenceError("Selected Communication Services endpoint does not match the deployment")
    resource = deployment.arm("Microsoft.Communication/communicationServices/" + name, "2025-05-01")
    scope = (f"/subscriptions/{deployment.subscription}/resourceGroups/{deployment.group}"
             f"/providers/Microsoft.Communication/communicationServices/{name}")
    if (not isinstance(resource, dict) or not isinstance(resource.get("id"), str) or
            resource["id"].lower() != scope.lower()):
        raise EvidenceError("Selected Communication Services resource does not match the deployment")
    properties = resource.get("properties")
    if not isinstance(properties, dict):
        raise EvidenceError("Selected Communication Services authentication evidence is incomplete")
    regional_host = properties.get("hostName")
    if not isinstance(regional_host, str):
        raise EvidenceError("Selected Communication Services host metadata is incomplete")
    regional_host = selected_resource_host(regional_host, "Communication Services")
    if not (regional_host == host or
            (regional_host.startswith(name.lower() + ".") and
             regional_host.endswith(".communication.azure.com"))):
        raise EvidenceError("Selected Communication Services host metadata is inconsistent")
    local_auth = properties.get("disableLocalAuth")
    if local_auth is None:
        report.add("infra:communication-local-auth-disabled", "infra", "BLOCKED",
                   "Communication Services does not report whether local access-key authentication is disabled")
    elif type(local_auth) is bool:
        report.check("infra:communication-local-auth-disabled", "infra", local_auth,
                     "Selected Communication Services disables local access-key authentication")
    else:
        raise EvidenceError("Selected Communication Services local authentication evidence is invalid")


def function_identity_binding_is_valid(function_app, settings, identity):
    if not isinstance(function_app, dict) or not isinstance(settings, dict) or not isinstance(identity, dict):
        return False
    identity_id, client_id = identity.get("id"), identity.get("clientId")
    if not isinstance(identity_id, str) or not isinstance(client_id, str):
        return False
    attached = ((function_app.get("identity") or {}).get("userAssignedIdentities") or {})
    return (isinstance(attached, dict) and
            identity_id.lower() in {resource.lower() for resource in attached} and
            settings.get("AZURE_CLIENT_ID") == client_id and
            settings.get("AzureWebJobsStorage__clientId") == client_id)


def https_root_endpoints_match(configured, endpoint):
    if not isinstance(configured, str) or not isinstance(endpoint, str):
        return False
    try:
        selected = urllib.parse.urlsplit(https_url(endpoint))
        target = urllib.parse.urlsplit(https_url(configured))
    except (ValueError, EvidenceError):
        return False
    return (selected.path in {"", "/"} and target.path in {"", "/"} and
            selected.netloc.lower() == target.netloc.lower())


def function_storage_target_is_valid(settings, account, service):
    if not isinstance(settings, dict) or not isinstance(account, dict):
        return False
    name = account.get("name")
    endpoints = account.get("primaryEndpoints")
    if not isinstance(endpoints, dict):
        return False
    endpoint = endpoints.get(service)
    if not isinstance(name, str) or not name or settings.get("AzureWebJobsStorage__accountName") != name:
        return False
    configured = settings.get("AzureWebJobsStorage__" + service + "ServiceUri")
    if configured is None:
        configured = f"https://{name}.{service}.core.windows.net"
    return https_root_endpoints_match(configured, endpoint)


def function_webpubsub_target_is_valid(settings, host):
    if not isinstance(settings, dict) or not isinstance(host, str) or not host:
        return False
    configured = settings.get("WEB_PUBSUB_HOST_NAME")
    if not isinstance(configured, str):
        return False
    return https_root_endpoints_match("https://" + configured, "https://" + host)


def function_communication_target_is_valid(settings, endpoint):
    return (isinstance(settings, dict) and
            https_root_endpoints_match(settings.get("COMMUNICATION_SERVICE_ENDPOINT"), endpoint))


def mcp_keyvault_configuration_is_valid(settings, vault_uri, certificate_name, client_id):
    configured_uri = settings.get("MCP_SIGNING_KEY_VAULT_URI") if isinstance(settings, dict) else None
    return (isinstance(settings, dict) and
            all(isinstance(value, str) and value for value in [vault_uri, certificate_name, client_id]) and
            isinstance(configured_uri, str) and configured_uri.rstrip("/") == vault_uri.rstrip("/") and
            settings.get("MCP_SIGNING_CERTIFICATE_NAME") == certificate_name and
            settings.get("MCP_KEYVAULT_MANAGED_IDENTITY_CLIENT_ID") == client_id)


def key_vault_private_dns_zone_name(vault_name, vault_uri):
    parsed = urllib.parse.urlsplit(https_url(vault_uri))
    prefix = vault_name.lower() + ".vault."
    host = parsed.hostname.lower() if parsed.hostname else ""
    if parsed.path not in {"", "/"} or not host.startswith(prefix) or not host[len(prefix):]:
        raise EvidenceError("Key Vault URI does not match the selected vault")
    return "privatelink.vaultcore." + host[len(prefix):]


def key_vault_private_link_is_valid(vault_name, vault, endpoint, zone, group, link, environment, app, nic):
    if not all(isinstance(item, dict) for item in [vault, endpoint, zone, group, link, environment, app, nic]):
        return False
    environment_properties = environment.get("properties")
    vnet_configuration = (environment_properties.get("vnetConfiguration")
                          if isinstance(environment_properties, dict) else None)
    aca_subnet = (vnet_configuration.get("infrastructureSubnetId")
                  if isinstance(vnet_configuration, dict) else None)
    if not isinstance(aca_subnet, str) or "/subnets/" not in aca_subnet.lower():
        return False
    network_id = aca_subnet.lower().rsplit("/subnets/", 1)[0]
    subnet = endpoint.get("subnet")
    subnet_id = subnet.get("id") if isinstance(subnet, dict) else None
    link_vnet = link.get("virtualNetwork")
    link_vnet_id = link_vnet.get("id") if isinstance(link_vnet, dict) else None
    app_properties = app.get("properties")
    app_environment = (app_properties.get("managedEnvironmentId") or app_properties.get("environmentId")
                       if isinstance(app_properties, dict) else None)
    environment_id = environment.get("id")
    endpoint_id, nic_id = endpoint.get("id"), nic.get("id")
    nic_endpoint = nic.get("privateEndpoint")
    nic_endpoint_id = nic_endpoint.get("id") if isinstance(nic_endpoint, dict) else None
    nic_refs = endpoint.get("networkInterfaces")
    ip_configs = nic.get("ipConfigurations")
    vault_id, zone_id = vault.get("id"), zone.get("id")
    connections = endpoint.get("privateLinkServiceConnections")
    configs = group.get("privateDnsZoneConfigs")
    if (not all(isinstance(value, str) and value for value in [
                subnet_id, link_vnet_id, vault_id, zone_id, environment_id, app_environment,
                endpoint_id, nic_id, nic_endpoint_id]) or
            not isinstance(nic_refs, list) or len(nic_refs) != 1 or not isinstance(nic_refs[0], dict) or
            not isinstance(nic_refs[0].get("id"), str) or not isinstance(ip_configs, list) or not ip_configs or
            not isinstance(connections, list) or len(connections) != 1 or
            not isinstance(connections[0], dict) or
            not isinstance(configs, list) or len(configs) != 1 or not isinstance(configs[0], dict)):
        return False
    connection = connections[0]
    connection_state = connection.get("privateLinkServiceConnectionState")
    service_id = connection.get("privateLinkServiceId")
    config_zone_id = configs[0].get("privateDnsZoneId")
    records = configs[0].get("recordSets")
    if not isinstance(records, list):
        return False
    nic_addresses = set()
    for config in ip_configs:
        if not isinstance(config, dict) or not isinstance(config.get("privateIPAddress"), str):
            return False
        config_subnet = config.get("subnet")
        if not isinstance(config_subnet, dict) or not isinstance(config_subnet.get("id"), str) or \
                config_subnet["id"].lower() != subnet_id.lower():
            return False
        nic_addresses.add(config["privateIPAddress"])
    valid_record = False
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("recordSetName"), str) or \
                record["recordSetName"].lower() != vault_name.lower() or record.get("recordType") != "A":
            continue
        addresses = record.get("ipAddresses")
        if not isinstance(addresses, list) or not addresses:
            continue
        try:
            parsed = [ipaddress.ip_address(address) for address in addresses]
        except (ValueError, TypeError):
            continue
        private_ranges = [ipaddress.ip_network(value) for value in
                          ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]]
        if (set(addresses) == nic_addresses and
                all(any(address in network for network in private_ranges) for address in parsed)):
            valid_record = True
            break
    return (endpoint.get("provisioningState") == "Succeeded" and
            nic.get("provisioningState") == "Succeeded" and
            nic_refs[0]["id"].lower() == nic_id.lower() and nic_endpoint_id.lower() == endpoint_id.lower() and
            app_environment.lower() == environment_id.lower() and
            subnet_id.lower() == network_id + "/subnets/private-endpoints" and
            isinstance(service_id, str) and service_id.lower() == vault_id.lower() and
            connection.get("groupIds") == ["vault"] and isinstance(connection_state, dict) and
            connection_state.get("status") == "Approved" and
            group.get("name") == "default" and group.get("provisioningState") == "Succeeded" and
            isinstance(config_zone_id, str) and config_zone_id.lower() == zone_id.lower() and
            configs[0].get("name") == "vault" and valid_record and
            link_vnet_id.lower() == network_id and link.get("registrationEnabled") is False and
            link.get("virtualNetworkLinkState") == "Completed")


def key_vault_network_evidence(report, deployment):
    d = deployment
    name = d.required("MCP_SIGNING_KEY_VAULT_NAME")
    vault = d.arm("Microsoft.KeyVault/vaults/" + name, "2023-07-01")
    properties = vault.get("properties")
    if not isinstance(properties, dict):
        raise EvidenceError("Key Vault network properties are unavailable")
    uri = properties.get("vaultUri")
    if not isinstance(uri, str) or uri.rstrip("/") != d.required("MCP_SIGNING_KEY_VAULT_URI").rstrip("/"):
        raise EvidenceError("Selected Key Vault URI does not match the deployed vault")
    zone_name = key_vault_private_dns_zone_name(name, uri)
    acls = properties.get("networkAcls")
    report.check("infra:keyvault-firewall", "infra",
                 isinstance(acls, dict) and acls.get("defaultAction") == "Deny" and
                 properties.get("publicNetworkAccess") == "Enabled",
                 "Key Vault denies public traffic by default while retaining the temporary deployment-host rule workflow")
    endpoints = d.azure("network", "private-endpoint", "list", "-g", d.group)
    zones = d.azure("network", "private-dns", "zone", "list", "-g", d.group)
    if not isinstance(endpoints, list) or not isinstance(zones, list):
        raise EvidenceError("Key Vault private endpoint or DNS zone inventory is unavailable")
    endpoint_name = name + "-private-endpoint"
    endpoints = [item for item in endpoints if isinstance(item, dict) and
                 str(item.get("name", "")).lower() == endpoint_name.lower()]
    zones = [item for item in zones if isinstance(item, dict) and
             str(item.get("name", "")).lower() == zone_name.lower()]
    if len(endpoints) != 1 or len(zones) != 1:
        report.check("infra:keyvault-private-link", "infra", False,
                     "The selected vault needs exactly one private endpoint and cloud-correct private DNS zone")
        return
    groups = d.azure("network", "private-endpoint", "dns-zone-group", "list", "-g", d.group,
                     "--endpoint-name", endpoint_name)
    links = d.azure("network", "private-dns", "link", "vnet", "list", "-g", d.group, "-z", zone_name)
    environment = d.azure("containerapp", "env", "show", "-g", d.group,
                          "-n", d.required("CONTAINER_APP_ENVIRONMENT_NAME"))
    app = d.azure("containerapp", "show", "-g", d.group, "-n", d.required("SERVICE_API_MCP_NAME"))
    if not isinstance(groups, list) or not isinstance(links, list):
        raise EvidenceError("Key Vault DNS zone-group or VNet-link inventory is unavailable")
    groups = [item for item in groups if isinstance(item, dict) and item.get("name") == "default"]
    links = [item for item in links if isinstance(item, dict) and
             str(item.get("name", "")).lower() == (name + "-link").lower()]
    interfaces = endpoints[0].get("networkInterfaces")
    if (not isinstance(interfaces, list) or len(interfaces) != 1 or not isinstance(interfaces[0], dict) or
            not isinstance(interfaces[0].get("id"), str) or not interfaces[0]["id"]):
        report.check("infra:keyvault-private-link", "infra", False,
                     "The vault private endpoint does not expose exactly one network interface")
        return
    nic = d.azure("network", "nic", "show", "--ids", interfaces[0]["id"])
    valid = (len(groups) == 1 and len(links) == 1 and
             key_vault_private_link_is_valid(name, vault, endpoints[0], zones[0],
                                             groups[0], links[0], environment, app, nic))
    report.check("infra:keyvault-private-link", "infra", valid,
                 "The approved vault endpoint, private DNS A record and VNet link match the Container Apps network")


def mcp_allowed_tool_names(tool):
    allowed = tool.get("allowed_tools")
    if isinstance(allowed, dict):
        allowed = allowed.get("tool_names")
    if (not isinstance(allowed, list) or not allowed or
            any(not isinstance(name, str) or not name or name != name.strip() or
                any(char.isspace() for char in name) for name in allowed) or
            len(allowed) != len(set(allowed))):
        return None
    return sorted(allowed)


def workflow_invocations(workflow):
    if not isinstance(workflow, str) or not workflow or len(workflow.encode()) > 256 * 1024:
        raise EvidenceError("Workflow definition is missing or exceeds the discovery bound")

    class UniqueLoader(yaml.SafeLoader):
        def construct_mapping(self, node, deep=False):
            keys = []
            for key_node, _ in node.value:
                key = self.construct_object(key_node, deep=deep)
                if not isinstance(key, str) or key in keys:
                    raise EvidenceError("Workflow mapping has duplicate or unsupported keys")
                keys.append(key)
            return super().construct_mapping(node, deep=deep)

    # Foundry accepts unquoted single-line Power Fx values containing YAML colons.
    yaml_workflow = re.sub(
        r"^([ \t]*(?:-[ \t]+)?[A-Za-z][A-Za-z0-9_-]*:[ \t]*)(=.*)$",
        lambda match: match[1] + json.dumps(match[2]),
        workflow, flags=re.MULTILINE,
    )
    try:
        document = yaml.load(yaml_workflow, Loader=UniqueLoader)
    except (yaml.YAMLError, RecursionError) as error:
        raise EvidenceError("Workflow definition is not supported YAML") from error
    if not isinstance(document, dict) or document.get("kind") != "Workflow":
        raise EvidenceError("Workflow definition has no classified root")
    invocations = []
    ids = set()
    nodes = 0

    def visit(value, path, ancestors):
        nonlocal nodes
        nodes += 1
        if nodes > 10000 or len(path) > 64 or id(value) in ancestors:
            raise EvidenceError("Workflow structure is cyclic or exceeds the discovery bound")
        if isinstance(value, dict):
            if value.get("kind") == "InvokeAzureAgent":
                action_id = value.get("id")
                agent = value.get("agent")
                name = agent.get("name") if isinstance(agent, dict) else None
                if (not isinstance(action_id, str) or
                        re.fullmatch(r"[A-Za-z0-9_-]+", action_id) is None or action_id in ids or
                        not isinstance(name, str) or re.fullmatch(r"[A-Za-z0-9_-]+", name) is None):
                    raise EvidenceError("Workflow invocation has a missing, dynamic or duplicate identity")
                version = agent.get("version")
                if type(version) is int and version > 0:
                    version = str(version)
                if version is not None and (
                        not isinstance(version, str) or re.fullmatch(r"[1-9][0-9]*", version) is None):
                    raise EvidenceError("Workflow invocation has an unsupported agent-version binding")
                ids.add(action_id)
                invocations.append({
                    "actionId": action_id,
                    "agent": name,
                    "version": version,
                    "path": "/".join(path),
                })
            for key, child in value.items():
                visit(child, path + [key], ancestors | {id(value)})
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, path + [str(index)], ancestors | {id(value)})

    visit(document, [], set())
    if not invocations:
        raise EvidenceError("Workflow definition has no discoverable agent invocations")
    return invocations


def summarize_agent_version(name, version, record, custom_origin, dab_origin):
    version_id = foundry_agent_version_id(name, version)
    definition = record.get("definition")
    if not isinstance(definition, dict):
        raise EvidenceError("Foundry agent version has no supported definition")
    kind = definition.get("kind")
    if not isinstance(kind, str) or not kind:
        raise EvidenceError("Foundry agent version has no classified kind")

    refs = []
    invocations = []
    if kind == "workflow":
        invocations = workflow_invocations(definition.get("workflow"))
        for invocation in invocations:
            invocation["surfaceId"] = f"{version_id}:invoke:{invocation['actionId']}"
        refs = [invocation["agent"] for invocation in invocations]

    configured_tools = definition.get("tools", [])
    if not isinstance(configured_tools, list):
        raise EvidenceError("Unsupported Foundry agent tool-list shape")
    tools = []
    for index, tool in enumerate(configured_tools):
        if (not isinstance(tool, dict) or not isinstance(tool.get("type"), str) or
                not tool["type"] or any(char.isspace() for char in tool["type"])):
            raise EvidenceError("Unsupported Foundry agent tool definition")
        tool_type = tool["type"]
        summary = {"type": tool_type}
        if tool_type == "mcp":
            target = tool.get("server_url")
            tool_origin = origin(target) if isinstance(target, str) else None
            server_label = tool.get("server_label")
            if (not isinstance(server_label, str) or not server_label or
                    any(char.isspace() for char in server_label)):
                raise EvidenceError("Deployed MCP agent tool has no server label")
            headers = tool.get("headers", {})
            if (not isinstance(headers, dict) or
                    any(not isinstance(key, str) for key in headers)):
                raise EvidenceError("Deployed MCP agent tool has invalid headers")
            server_id = f"{version_id}:mcp-server:{server_label}"
            allowed_tools = mcp_allowed_tool_names(tool)
            summary.update({
                "server": server_label,
                "resource": "custom-mcp" if tool_origin == custom_origin else
                "dab-mcp" if tool_origin == dab_origin else "unclassified",
                "targetOrigin": tool_origin,
                "surfaceId": server_id,
                "allowedTools": allowed_tools,
                "surfaceIds": ([f"{server_id}:tool:{tool_name}" for tool_name in allowed_tools]
                               if allowed_tools else []),
                "hasStoredAuthorization": any(
                    key.lower() == "authorization" for key in headers
                ),
                "hasStoredCredentialHeaders": any(key.lower() in {
                    "authorization", "proxy-authorization", "api-key", "x-api-key",
                    "ocp-apim-subscription-key", "x-functions-key",
                } for key in headers),
                "hasStaticHeaders": bool(headers),
                "definitionIndex": index,
            })
        else:
            tool_name = tool.get("name")
            stable_name = tool_name if isinstance(tool_name, str) and tool_name else tool_type
            summary.update({
                "surfaceId": f"{version_id}:tool:{tool_type}:{stable_name}",
                "surfaceIds": [f"{version_id}:tool:{tool_type}:{stable_name}"],
                "definitionIndex": index,
            })
        tools.append(summary)

    return {
        "id": "foundry:agent:" + name,
        "versionId": version_id,
        "name": name,
        "version": version,
        "kind": kind,
        "definitionSha256": hashlib.sha256(
            json.dumps(definition, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
        "tools": tools,
        "agentReferences": sorted(set(refs)),
        "agentReferenceIds": [
            f"{version_id}:subagent:{reference}" for reference in sorted(set(refs))
        ],
        "workflowShapeValid": True,
        "workflowInvocations": invocations,
        "hasInstanceIdentity": foundry_agent_identity_present(record),
    }


def agent_header_status(tool):
    if tool["hasStoredCredentialHeaders"]:
        return "FAIL"
    return "BLOCKED" if tool["hasStaticHeaders"] else "PASS"


def agent_dependency_edges(versions):
    latest = {item["name"]: item["versionId"] for item in versions if item["isLatest"]}
    pinned = {(item["name"], item["version"]): item["versionId"] for item in versions}
    edges = []
    for item in versions:
        for invocation in item["workflowInvocations"]:
            target = (pinned.get((invocation["agent"], invocation["version"]))
                      if invocation["version"] is not None else latest.get(invocation["agent"]))
            edges.append({
                "id": invocation["surfaceId"],
                "kind": "subagent",
                "from": item["versionId"],
                "to": target,
                "actionId": invocation["actionId"],
                "workflowPath": invocation["path"],
                "binding": "version" if invocation["version"] is not None else "latest",
                "resolved": target is not None,
            })
    return edges


AGENT_TOOL_RUNTIME_BLOCKED_DETAIL = (
    "This agent version and tool require correlated runtime identity, authorization and "
    "effect evidence; a configured tool or another agent's invocation is not proof."
)


def agent_tool_runtime_evidence(report, versions):
    if not versions:
        raise EvidenceError("Agent tool inventory is empty")
    edges = []
    seen = set()
    for version in versions:
        parents = set()
        for tool in version["tools"]:
            surface = tool["surfaceId"]
            if surface in parents:
                raise EvidenceError("An agent version contains duplicate tool or MCP server identities")
            parents.add(surface)
            if tool["type"] == "mcp":
                names = tool.get("allowedTools") or [None]
                surfaces = tool.get("surfaceIds") or [surface]
                if (len(names) != len(surfaces) or
                        surfaces != ([f"{surface}:tool:{name}" for name in names] if names != [None] else [surface])):
                    raise EvidenceError("An MCP tool inventory has inconsistent surface identities")
                entries = [{
                    "id": tool_id, "kind": "mcp-tool", "from": version["versionId"],
                    "toOrigin": tool.get("targetOrigin"), "tool": name,
                } for name, tool_id in zip(names, surfaces)]
            else:
                if tool.get("surfaceIds") != [surface]:
                    raise EvidenceError("An agent tool inventory has inconsistent surface identities")
                entries = [{
                    "id": surface, "kind": "agent-tool", "from": version["versionId"],
                    "toolType": tool["type"],
                }]
            for edge in entries:
                if edge["id"] in seen:
                    raise EvidenceError("Agent tool surface identities are not unique")
                seen.add(edge["id"])
                edges.append(edge)
    for edge in edges:
        report.add("agent-tool-path:" + edge["id"], "agents", "BLOCKED", AGENT_TOOL_RUNTIME_BLOCKED_DETAIL)
    return edges


def agent_version_inventory_sha256(summaries):
    inventory = []
    for summary in summaries:
        name, version = summary.get("name"), summary.get("version")
        version_id, definition_hash = summary.get("versionId"), summary.get("definitionSha256")
        if (not isinstance(name, str) or not name or not isinstance(version, str) or not version or
                version_id != foundry_agent_version_id(name, version) or
                not isinstance(definition_hash, str) or
                re.fullmatch(r"[a-f0-9]{64}", definition_hash) is None):
            raise EvidenceError("Foundry agent-version inventory cannot be fingerprinted")
        inventory.append({
            "name": name,
            "version": version,
            "definitionSha256": definition_hash,
        })
    if not inventory:
        raise EvidenceError("Foundry agent-version inventory is empty")
    canonical = json.dumps(sorted(inventory, key=lambda item: (item["name"], item["version"])),
                           sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def agent_provisioner_tool_inventory(directory):
    scripts = sorted(Path(directory).glob("*.sh"))
    if not scripts:
        raise EvidenceError("Agent provisioner discovery is empty")
    inventory = {}
    for path in scripts:
        matches = re.findall(r"(?m)^\s*ALLOWED_TOOLS='([^']*)'\s*$", path.read_text())
        if len(matches) > 1:
            raise EvidenceError(f"Agent provisioner {path.stem} declares multiple MCP allow-lists")
        try:
            names = json.loads(matches[0]) if matches else []
        except ValueError as error:
            raise EvidenceError(f"Agent provisioner {path.stem} has invalid MCP allow-list JSON") from error
        if (not isinstance(names, list) or
                any(not isinstance(name, str) or not name or name != name.strip() or
                    any(char.isspace() for char in name) for name in names) or
                len(names) != len(set(names))):
            raise EvidenceError(f"Agent provisioner {path.stem} has an invalid MCP allow-list")
        inventory[path.stem] = sorted(names)
    return inventory


def agent_source_inventory(directory):
    scripts = sorted(Path(directory).glob("*.sh"))
    if not scripts:
        raise EvidenceError("Agent provisioner discovery is empty")
    tool_inventory = agent_provisioner_tool_inventory(directory)
    inventory = {}
    for path in scripts:
        source = path.read_text()
        names = re.findall(r'\bupsert_agent\s+"([^"]+)"', source)
        names.extend(re.findall(
            r'(?m)^\s*(?:INTENT_)?AGENT_NAME="([^"]+)"\s*$', source))
        if not names or any(not name for name in names) or len(names) != len(set(names)):
            raise EvidenceError(f"Agent provisioner {path.stem} has missing or duplicate agent names")
        for name in names:
            if name in inventory:
                raise EvidenceError(f"Agent {name} is declared by multiple provisioners")
            inventory[name] = tool_inventory[path.stem] if name in re.findall(
                r'\bupsert_agent\s+"([^"]+)"', source) else []
    return inventory


def consumer_chat_tool_contract(report, provisioner_tools, tools):
    configured = provisioner_tools.get("eshop-chat-agent")
    policies = {item["Name"]: item.get("Policy") for item in tools}
    scopes = set(ConsumerSession.scopes.split())
    invalid = [] if isinstance(configured, list) else ["missing-agent"]
    for name in configured if isinstance(configured, list) else []:
        policy = policies.get(name)
        if (not isinstance(policy, dict) or policy.get("Mode") not in {"Public", "SelfOrInternal"} or
                policy.get("RequiredScope") not in scopes):
            invalid.append(name)
    report.check("inventory:consumer-chat-tool-policy", "contracts",
                 isinstance(configured, list) and bool(configured) and not invalid,
                 "Customer chat tools must be callable by the reviewed consumer scope set and category; "
                 "deployed tokens and dispatch remain separate evidence" +
                 (": " + ", ".join(sorted(invalid)) if invalid else ""))


def agent_tool_allowlist_matches(expected, tools):
    actual = [tool for tool in tools if tool.get("type") == "mcp"]
    if not expected:
        return not actual
    return (len(actual) == 1 and actual[0].get("server") == "adventureworks_mcp" and
            actual[0].get("allowedTools") == expected)


def agent_workflow_inventory(directory, workflow_directory):
    workflow_directory = Path(workflow_directory).resolve()
    declared_files = set(workflow_directory.glob("*.yaml"))
    covered_files = set()
    inventory = {}
    for script in sorted(Path(directory).glob("*.sh")):
        source = script.read_text()
        if "YAML_PATH=" not in source:
            continue
        paths = re.findall(
            r'(?m)^\s*YAML_PATH="\$\(cd "\$\(dirname "\$0"\)" && pwd\)/([^"]+)"\s*$', source)
        names = re.findall(r'(?m)^\s*AGENT_NAME="([^"]+)"\s*$', source)
        if len(paths) != 1 or len(names) != 1 or names[0] in inventory:
            raise EvidenceError("Workflow provisioner has an unclassified file or agent binding")
        path = (script.parent / paths[0]).resolve()
        if path not in declared_files or path in covered_files:
            raise EvidenceError("Workflow source is missing, outside discovery or multiply provisioned")
        covered_files.add(path)
        inventory[names[0]] = {
            "source": "workflows/" + path.name,
            "invocations": workflow_invocations(path.read_text()),
        }
    if not declared_files or covered_files != declared_files:
        raise EvidenceError("Workflow files are missing or not covered by classified provisioners")
    return inventory


def dab_inventory(config):
    entities = config.get("entities")
    if not isinstance(entities, dict) or not entities:
        raise EvidenceError("DAB entity discovery is empty")
    operations = []
    seen_surface_ids = set()
    for name, entity in entities.items():
        if not isinstance(name, str) or not name or not isinstance(entity, dict):
            raise EvidenceError("DAB entity discovery has invalid shape")
        permissions = entity.get("permissions")
        if not isinstance(permissions, list) or not permissions:
            raise EvidenceError(f"DAB entity {name} has no permissions")
        for permission in permissions:
            if not isinstance(permission, dict) or not isinstance(permission.get("role"), str) or not permission["role"]:
                raise EvidenceError(f"DAB entity {name} has an invalid role permission")
            if "fields" in permission:
                raise EvidenceError(f"DAB entity {name} fields must be declared on each action, not its role")
            for definition in permission.get("actions", []):
                if not isinstance(definition, dict):
                    continue
                policy = definition.get("policy", {}).get("database", "")
                referenced = set(re.findall(r"@item\.([A-Za-z_][A-Za-z0-9_]*)", policy))
                fields = definition.get("fields", {})
                included = set(fields.get("include", ["*"]))
                excluded = set(fields.get("exclude", []))
                inaccessible = referenced & excluded
                if "*" in excluded:
                    inaccessible |= referenced
                if "*" not in included:
                    inaccessible |= referenced - included
                if inaccessible:
                    raise EvidenceError(
                        f"DAB {name} {definition['action']} policy references inaccessible fields: "
                        + ", ".join(sorted(inaccessible)))
            for action in action_names(permission):
                surface_id = f"dab:{name}:{permission['role']}:{action}"
                if surface_id in seen_surface_ids:
                    raise EvidenceError("Duplicate DAB entity/role/action surface")
                seen_surface_ids.add(surface_id)
                operations.append({"id": surface_id, "entity": name, "role": permission["role"],
                                   "action": action, "rest": entity.get("rest", True),
                                   "graphql": entity.get("graphql", True), "source": entity["source"],
                                   "permission": permission})
    return operations


def mcp_surface_inventory(tools):
    if not isinstance(tools, list) or not tools:
        raise EvidenceError("MCP tool discovery is empty")
    surfaces = []
    seen_names = set()
    for tool in tools:
        if not isinstance(tool, dict):
            raise EvidenceError("MCP tool surface has invalid shape")
        name = tool.get("Name")
        if (not isinstance(name, str) or not name or name in seen_names or
                not isinstance(tool.get("Policy"), dict)):
            raise EvidenceError("MCP tool name or authorization policy is missing, invalid or duplicated")
        seen_names.add(name)
        surfaces.append({"id": f"mcp:tool:{name}", "name": name, "policy": tool["Policy"]})
    return surfaces


def function_surface_inventory(functions):
    if not isinstance(functions, list) or not functions:
        raise EvidenceError("Functions surface discovery is empty")

    surfaces = []
    seen_names = set()
    seen_surface_ids = set()
    for function in functions:
        if not isinstance(function, dict):
            raise EvidenceError("Functions surface has invalid shape")
        name = function.get("Name")
        triggers = function.get("Triggers")
        if (not isinstance(name, str) or not name or name in seen_names or
                not isinstance(triggers, list) or not triggers or
                any(not isinstance(trigger, str) or not trigger for trigger in triggers) or
                len(triggers) != len(set(triggers))):
            raise EvidenceError("Function name or trigger discovery is missing, invalid or duplicated")
        seen_names.add(name)

        for trigger in sorted(triggers):
            surface_id = f"function:trigger:{name}:{trigger}"
            if surface_id in seen_surface_ids:
                raise EvidenceError("Duplicate Functions trigger surface")
            seen_surface_ids.add(surface_id)
            surfaces.append({"id": surface_id, "kind": "trigger", "name": name, "trigger": trigger})

        route = function.get("Route")
        methods = function.get("Methods")
        if route is None:
            if methods not in (None, []):
                raise EvidenceError(f"Non-HTTP function {name} has HTTP methods")
            continue
        if (not isinstance(route, str) or not route or not isinstance(methods, list) or not methods or
                any(not isinstance(method, str) or not method for method in methods) or
                len(methods) != len(set(method.upper() for method in methods))):
            raise EvidenceError(f"HTTP route discovery for {name} is incomplete or invalid")
        if not isinstance(function.get("Policy"), dict):
            raise EvidenceError(f"HTTP function {name} has no authorization policy")

        for method in sorted({item.upper() for item in methods}):
            route_key = route.strip("/").lower()
            surface_id = f"function:http:{method}:{route_key}"
            if surface_id in seen_surface_ids:
                raise EvidenceError("Duplicate Functions HTTP method/route surface")
            seen_surface_ids.add(surface_id)
            surfaces.append({
                "id": surface_id,
                "kind": "http",
                "name": name,
                "method": method,
                "route": route,
                "policy": function["Policy"],
            })
    return surfaces


def valid_functions_host_evidence(inventory, document):
    from functions_host import HostFailure, expected_case_ids, inventory_digest

    if not isinstance(document, dict):
        return False
    try:
        expected = expected_case_ids(inventory)
        disabled = sorted(item["Name"] for item in inventory if item["Route"] is None)
    except (HostFailure, EvidenceError, KeyError, TypeError, ValueError):
        return False
    cases = document.get("cases")
    if not isinstance(cases, list) or any(not isinstance(case, dict) for case in cases):
        return False
    ids = [case.get("id") for case in cases]
    return (
        document.get("schemaVersion") == 1
        and document.get("complete") is True
        and document.get("network") == "loopback-only"
        and document.get("inventorySha256") == inventory_digest(inventory)
        and isinstance(document.get("workerSha256"), str)
        and re.fullmatch(r"[0-9a-f]{64}", document["workerSha256"]) is not None
        and document.get("disabledNonHttpFunctions") == disabled
        and all(case.get("status") == "PASS" and isinstance(case.get("id"), str) for case in cases)
        and len(ids) == len(set(ids)) == len(expected)
        and set(ids) == set(expected)
    )


def functions_host_tests(report):
    obligation = next(check for check in report.checks
                      if check["id"] == "required:functions-middleware-host-denials")
    inventory_file = report.output / "functions.json"
    evidence_file = report.output / "functions-host.json"
    try:
        result = subprocess.run(
            [sys.executable, "-B", str(Path(__file__).with_name("functions_host.py")),
             "--inventory", str(inventory_file), "--output", str(evidence_file)],
            cwd=ROOT, capture_output=True, text=True, timeout=1500, check=False)
    except (OSError, subprocess.TimeoutExpired):
        obligation["detail"] = "The isolated Functions host runner is unavailable or timed out."
        return
    if result.returncode:
        obligation["status"] = "BLOCKED" if result.returncode == 2 else "FAIL"
        detail = result.stderr.strip().splitlines()
        obligation["detail"] = detail[-1][:500] if detail else "The isolated Functions host runner failed."
        return
    try:
        inventory = json.loads(inventory_file.read_text())
        document = json.loads(evidence_file.read_text())
    except (OSError, ValueError):
        obligation["status"] = "FAIL"
        obligation["detail"] = "The isolated Functions host evidence is missing or malformed."
        return
    if not valid_functions_host_evidence(inventory, document):
        obligation["status"] = "FAIL"
        obligation["detail"] = "The isolated Functions host evidence is incomplete or does not match the current inventory."
        return
    obligation["status"] = "PASS"
    obligation["detail"] = (
        f"{len(document['cases'])} exact route/method and control cases passed through the real, "
        "loopback-only worker; non-HTTP triggers were disabled and denied handlers were not entered."
    )
    report.inventory["functionsHost"] = {
        "caseCount": len(document["cases"]),
        "disabledNonHttpCount": len(document["disabledNonHttpFunctions"]),
        "inventorySha256": document["inventorySha256"],
        "workerSha256": document["workerSha256"],
        "evidence": "functions-host.json",
    }


class Report:
    def __init__(self, output):
        self.output = output
        self.checks = []
        self.inventory = {}
        self.provenance = {}

    def add(self, check_id, group, status, detail):
        if status not in STATUSES:
            raise ValueError("Invalid check status")
        if any(check["id"] == check_id for check in self.checks):
            raise ValueError(f"Duplicate assertion ID: {check_id}")
        self.checks.append({"id": check_id, "group": group, "status": status, "detail": detail})

    def check(self, check_id, group, condition, detail):
        self.add(check_id, group, "PASS" if condition else "FAIL", detail)

    def guarded(self, check_id, group, work):
        try:
            work()
        except EvidenceError as error:
            self.add(check_id, group, "BLOCKED", str(error))

    def save(self):
        groups = {}
        for group in sorted({check["group"] for check in self.checks}):
            counts = Counter(check["status"] for check in self.checks if check["group"] == group)
            applicable = counts["PASS"] + counts["FAIL"] + counts["BLOCKED"]
            groups[group] = {"counts": dict(counts), "applicable": applicable,
                             "completed": counts["PASS"] + counts["FAIL"],
                             "passed": counts["PASS"]}
        counts = Counter(check["status"] for check in self.checks)
        outcome = "FAIL" if counts["FAIL"] else "BLOCKED" if counts["BLOCKED"] else "PASS"
        document = {"schemaVersion": 1, "outcome": outcome,
                    "scope": "Partial assurance; see required blocked obligations",
                    "createdAt": datetime.now(timezone.utc).isoformat(),
                    "provenance": self.provenance, "groups": groups,
                    "checks": self.checks, "inventory": self.inventory}
        (self.output / "report.json").write_text(json.dumps(document, indent=2) + "\n")
        suite = ET.Element("testsuite", name="authentication-assurance", tests=str(len(self.checks)),
                           failures=str(counts["FAIL"]), errors=str(counts["BLOCKED"]))
        for check in self.checks:
            case = ET.SubElement(suite, "testcase", name=check["id"], classname=check["group"])
            if check["status"] in {"FAIL", "BLOCKED"}:
                ET.SubElement(case, "failure" if check["status"] == "FAIL" else "error",
                              message=check["detail"])
            elif check["status"] != "PASS":
                ET.SubElement(case, "skipped", message=check["status"] + ": " + check["detail"])
        ET.ElementTree(suite).write(self.output / "junit.xml", encoding="utf-8", xml_declaration=True)
        lines = ["# Authentication assurance", "", f"Outcome: **{outcome}**",
                 "", "This report does not establish complete end-to-end conformance.", "",
                 "| Group | Passed | Completed / applicable | Exceptions |",
                 "| --- | ---: | ---: | ---: |"]
        for group, summary in groups.items():
            lines.append(f"| {group} | {summary['passed']} | "
                         f"{summary['completed']} / {summary['applicable']} | "
                         f"{summary['counts'].get('ACCEPTED_EXCEPTION', 0)} |")
        lines += ["", "## Failures and missing evidence", ""]
        lines += [f"- `{check['id']}` ({check['status']}): {check['detail']}"
                  for check in self.checks if check["status"] in {"FAIL", "BLOCKED"}]
        (self.output / "report.md").write_text("\n".join(lines) + "\n")
        print(f"Authentication assurance: {outcome}; {dict(counts)}")
        print(f"Evidence: {self.output / 'report.json'}")
        return 1 if counts["FAIL"] else 2 if counts["BLOCKED"] else 0


def export_inventory(report, offline):
    environment = dict(os.environ)
    environment["AUTH_FUNCTIONS_INVENTORY"] = str(report.output / "functions.json")
    environment["AUTH_MCP_INVENTORY"] = str(report.output / "mcp.json")
    projects = ["api-functions.Tests/api-functions.Tests.csproj",
                "api-mcp/AdventureWorks.Tests/AdventureWorks.Tests.csproj"]
    for project, filename in zip(projects, ["functions.json", "mcp.json"]):
        args = ["dotnet", "test", project, "--no-restore", "--verbosity", "minimal"]
        if not offline:
            args += ["--filter", "FullyQualifiedName~AuthInventoryTests"]
        args += ["--logger", "trx;LogFileName=" + filename.removesuffix(".json") + "-tests.trx",
                 "--results-directory", str(report.output / "dotnet")]
        try:
            try:
                output = command(args, environment=environment, timeout=600)
            except EvidenceError:
                if (ROOT / Path(project).parent / "obj/project.assets.json").is_file():
                    raise
                command(["dotnet", "restore", project], environment=environment, timeout=600)
                output = command(args, environment=environment, timeout=600)
            (report.output / (filename + ".test.log")).write_text(output)
            report.add("offline:" + filename, "offline", "PASS",
                       "Test runner passed; reflected inventory exported")
        except EvidenceError as error:
            report.add("offline:" + filename, "offline", "FAIL", str(error))
            raise EvidenceError("Inventory export failed; classification was not attempted") from error
        path = report.output / filename
        if not path.exists():
            raise EvidenceError("Successful tests did not export an inventory")
        inventory = json.loads(path.read_text())
        if not isinstance(inventory, list) or not inventory:
            raise EvidenceError("Reflected inventory is empty")
        if filename == "functions.json":
            surfaces = function_surface_inventory(inventory)
            ids_by_name = {}
            for surface in surfaces:
                ids_by_name.setdefault(surface["name"], []).append(surface["id"])
            for function in inventory:
                function["SurfaceIds"] = sorted(ids_by_name[function["Name"]])
            report.inventory["functionSurfaces"] = surfaces
        elif filename == "mcp.json":
            surfaces = mcp_surface_inventory(inventory)
            for tool, surface in zip(inventory, surfaces):
                tool["SurfaceId"] = surface["id"]
            report.inventory["mcpToolSurfaces"] = surfaces
        report.inventory[filename.removesuffix(".json")] = inventory


def offline_tests(report):
    commands = [
        ("python:auth", ["python3", "-B", "-m", "unittest", "discover", "-s", "tests/scripts",
                         "-p", "test_azure_auth.py"]),
        ("python:hosted", ["python3", "-B", "-m", "unittest", "discover", "-s", "tests/scripts",
                           "-p", "test_hosted_agent_mcp_trust.py"]),
        ("python:agent-tools", ["python3", "-B", "-m", "unittest", "discover", "-s", "tests/scripts",
                                "-p", "test_agent_tools_config.py"]),
        ("python:keyvault-hook", ["python3", "-B", "tests/scripts/test_keyvault_firewall.py",
                                   "KeyVaultFirewallTests"]),
        ("python:assurance", ["python3", "-B", "-m", "unittest", "discover", "-s", "tests/auth",
                              "-p", "test_*.py"]),
        ("python:seed-storage", ["python3", "-B", "-m", "unittest", "discover", "-s", "seed-job/tests",
                                 "-p", "test_seed*.py"]),
        ("node:inspector", ["npm", "--prefix", "mcp-inspector", "test"]),
        ("node:manufacturing-session", ["npm", "--prefix", "app-manufacturing", "test", "--",
                                        "src/hooks/useWebPubSub.test.ts", "src/lib/dabFetch.test.ts",
                                        "src/components/ShortagesPanel.test.tsx"]),
        ("node:auth", ["node", "--experimental-vm-modules", "--test",
                       "tests/scripts/test-route-auth.mjs", "tests/scripts/test-internal-session-races.mjs",
                       "tests/scripts/test-internal-request-sessions.mjs", "tests/scripts/test-live-updates.mjs",
                       "tests/scripts/test-eshop-chat.mjs", "tests/scripts/test-auth-browser-network-policy.mjs",
                       "tests/scripts/test-review-auth.mjs", "tests/scripts/test-guest-cart-auth.mjs",
                       "tests/scripts/test-cart-provider-auth.mjs", "tests/scripts/test-runtime-rbac.cjs",
                       "tests/scripts/test-read-auth-reports.cjs", "tests/scripts/test-payment-methods-auth.mjs",
                       "tests/scripts/test-address-auth.mjs", "tests/scripts/test-order-detail-auth.mjs"]),
    ]
    for name, args in commands:
        try:
            environment = {key: value for key, value in os.environ.items()
                           if not key.startswith("AUTH_ASSURANCE_")}
            command(args, environment=environment, timeout=180)
            report.add(name, "offline", "PASS", "Configured test runner passed")
        except EvidenceError as error:
            report.add(name, "offline", "FAIL", str(error))


def current_test_evidence(report, prefix):
    results = {}
    sources = {}
    for path in sorted((report.output / "dotnet").glob("*.trx")):
        try:
            tree = ET.parse(path)
        except ET.ParseError as error:
            raise EvidenceError("Malformed current-run .NET evidence") from error
        matching = [result for result in tree.findall(".//{*}UnitTestResult")
                    if result.get("testName", "").startswith(prefix)]
        if matching:
            sources[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        for result in matching:
            results.setdefault(result.get("testName"), []).append(result.get("outcome"))
    return results, sources


def assertion_evidence(report):
    prefix = "AdventureWorks.Tests.ManagedIdentityAssertionValidatorTests."
    expected = {
        prefix + "Real_validator_rejects_cryptographic_claim_and_lifetime_negatives(negative: \"" + case + "\")"
        for case in ["issuer", "tenant", "audience", "signature", "unsigned", "expired", "future",
                     "missing-expiry", "missing-oid", "untrusted-oid", "malformed"]
    }
    expected.update(prefix + "Real_signature_accepts_only_supported_issuer_and_audience_forms(v1: " +
                    v1 + ", uri: " + uri + ")" for v1 in ["False", "True"] for uri in ["False", "True"])
    expected.update(prefix + name for name in [
        "Disabled_and_empty_grants_do_not_fetch_keys",
        "Keys_are_cached_and_unknown_key_refresh_is_throttled_then_accepts_rotation",
        "Expired_key_cache_is_not_an_unbounded_outage_fallback",
        "Unknown_key_refresh_outage_can_retain_only_still_fresh_keys",
        "Invalid_jwks_is_rejected_without_using_an_empty_key_set",
        "Concurrent_first_use_fetches_keys_once",
        "Caller_cancellation_is_propagated",
        "Real_assertions_are_enforced_through_token_endpoint_and_issued_token_signature",
    ])
    results, sources = current_test_evidence(report, prefix)
    failed = any(outcome not in {"Passed", "NotExecuted"} for outcomes in results.values() for outcome in outcomes)
    complete = all(results.get(name) == ["Passed"] for name in expected)
    status = "FAIL" if failed else "PASS" if complete else "BLOCKED"
    report.add("required:entra-assertion-real-signature-negatives", "required", status,
               "Current-run TRX must prove all 23 real-validator/endpoint cases passed exactly once; "
               "deployed workload exchanges remain separate. Evidence SHA256: " + json.dumps(sources, sort_keys=True))


def middleware_evidence(report):
    prefix = "ApiFunctions.Tests.FunctionsAuthorizationMiddlewareTests."
    expected = set()
    functions = report.inventory.get("functions", [])
    for function in functions:
        policy = function.get("Policy")
        if policy is None:
            continue
        cases = ["Explicit_public_policies_remain_public_even_with_unusable_token"] if policy["IsAnonymous"] else [
            "Every_protected_policy_denies_missing_token_before_handler",
            "Every_protected_policy_denies_wrong_scope_before_handler",
            "Every_protected_policy_accepts_matching_internal_token_and_projects_signed_owner",
            "Consumer_category_follows_actual_policy_not_forged_internal_headers",
        ]
        expected.update(prefix + case + '(function: "' + function["Name"] + '")' for case in cases)
    expected.update(prefix + 'Cryptographic_and_configuration_denials_never_reach_handler(defect: "' + defect + '")'
                    for defect in ["mcp", "dab", "issuer", "expired", "signature", "category", "malformed", "unconfigured"])
    expected.add(prefix + "Unclassified_http_function_is_denied_even_with_valid_admin_token")
    expected.update(prefix + "Explicit_non_enforcing_modes_and_non_http_triggers_preserve_passthrough(mode: " +
                    mode + ", http: " + http + ")" for mode, http in [
                        ("Disabled", "True"), ("Audit", "True"), ("Enforced", "False")])
    results, sources = current_test_evidence(report, prefix)
    failed = any(outcome not in {"Passed", "NotExecuted"} for values in results.values() for outcome in values)
    complete = any(function.get("Policy") is not None for function in functions) and \
        all(results.get(name) == ["Passed"] for name in expected)
    report.add("required:functions-worker-middleware", "required",
               "FAIL" if failed else "PASS" if complete else "BLOCKED",
               "Current-run TRX requires " + str(len(expected)) +
               " signed-token/worker HTTP policy cases exactly once, including zero handler calls on denial. "
               "Real SDK request/result features; not a running host, route binding or SQL ownership proof. "
               "Evidence SHA256: " + json.dumps(sources, sort_keys=True))


def address_ownership_evidence(report):
    prefix = "ApiFunctions.Tests.AddressOwnershipTests."
    service_prefix = "ApiFunctions.Tests.AddressServiceOwnershipTests."
    expected = {prefix + name for name in [
        "Missing_consumer_owner_never_reads_global_addresses",
        "Internal_listing_preserves_global_pagination",
        "Internal_address_delete_keeps_the_existing_service_path",
        "Internal_address_update_keeps_the_existing_service_path",
    ]}
    for owner, address in [(7, 101), (8, 102)]:
        expected.add(prefix + f"Consumer_listing_scopes_sql_before_pagination(owner: {owner}, expectedAddress: {address})")
        expected.add(prefix + f"Own_address_read_succeeds(owner: {owner}, address: {address})")
        expected.add(prefix + f"Own_address_update_uses_atomic_owner_bound_service(owner: {owner}, address: {address})")
        expected.add(prefix + f"Shared_address_update_returns_conflict_without_mutation(owner: {owner}, address: {address})")
        expected.add(prefix + f"Own_address_delete_uses_atomic_owner_bound_service(owner: {owner}, address: {address})")
        expected.add(prefix + f"Create_and_person_queries_override_supplied_other_owner(owner: {owner})")
        expected.add(prefix + f"Own_type_update_ignores_supplied_other_owner(owner: {owner}, address: {address})")
        other_address = 102 if owner == 7 else 101
        expected.update(prefix + "Other_owner_address_never_reaches_data_or_mutation" +
                        f'(owner: {owner}, address: {other_address}, operation: "{operation}")'
                        for operation in ["GET", "PUT", "DELETE", "TYPE"])
    expected.update(prefix + f'Missing_owner_denied_before_even_ownership_lookup(operation: "{operation}")'
                    for operation in ["GET", "PUT", "DELETE", "TYPE"])
    for owner in [0, -1]:
        expected.add(prefix + f"Nonpositive_consumer_owner_cannot_list_create_or_query_people(owner: {owner})")
        expected.update(prefix + f'Nonpositive_consumer_owner_denied_before_data(owner: {owner}, operation: "{operation}")'
                        for operation in ["GET", "PUT", "DELETE", "TYPE"])
    service_expected = {
        service_prefix + "Delete_failure_does_not_commit_unlinking",
        service_prefix + "Unchanged_shared_address_can_still_be_saved_without_physical_mutation",
        service_prefix + "Removed_owner_before_update_cannot_mutate_and_rolls_back",
        service_prefix + "Update_failure_does_not_commit",
        *(service_prefix + f"Delete_removes_only_the_signed_owners_links_and_unreferenced_address(owner: {owner}, address: {address})"
          for owner, address in [(7, 101), (8, 102)]),
        *(service_prefix + f"Foreign_or_missing_address_rolls_back_without_changes(owner: {owner}, address: {address})"
          for owner, address in [(8, 101), (7, 102), (7, 999)]),
        *(service_prefix + f"Shared_or_order_referenced_address_is_retained(shared: {shared})"
          for shared in ["True", "False"]),
        *(service_prefix + f"Single_read_filters_in_the_address_query(owner: {owner}, address: {address}, allowed: {allowed})"
          for owner, address, allowed in [(7, 101, "True"), (8, 102, "True"),
                                          (7, 102, "False"), (8, 101, "False")]),
        *(service_prefix + f"Owned_update_checks_links_and_orders_in_one_serializable_transaction(owner: {owner}, address: {address})"
          for owner, address in [(7, 101), (8, 102)]),
        *(service_prefix + f"Foreign_or_missing_update_never_mutates(owner: {owner}, address: {address})"
          for owner, address in [(8, 101), (7, 102), (7, 999)]),
        *(service_prefix + f'Shared_link_or_other_order_blocks_physical_update(sharing: "{sharing}")'
          for sharing in ["link", "foreign-order", "unbound-order"]),
    }
    results, sources = current_test_evidence(report, prefix)
    service_results, service_sources = current_test_evidence(report, service_prefix)
    sources.update(service_sources)
    failed = any(outcome not in {"Passed", "NotExecuted"} for selected in [results, service_results]
                 for values in selected.values() for outcome in values)
    complete = (set(results) == expected and set(service_results) == service_expected and
                all(results.get(name) == ["Passed"] for name in expected) and
                all(service_results.get(name) == ["Passed"] for name in service_expected))
    report.add("required:address-handler-ownership", "required",
               "FAIL" if failed else "PASS" if complete else "BLOCKED",
               "Current-run TRX requires 40 handler and 23 isolated SQL-transport address cases exactly once. "
               "They cover signed-owner reads, atomic update/unlink, shared/foreign-order protection and rollback; "
               "not actual SQL execution or running-host mutation proof. Evidence SHA256: " +
               json.dumps(sources, sort_keys=True))


def password_ownership_evidence(report):
    prefix = "ApiFunctions.Tests.PasswordOwnershipTests."
    expected = set()
    for operation in ["set", "verify"]:
        for owner in [7, 8]:
            expected.update(prefix + name + f'(owner: {owner}, operation: "{operation}")' for name in [
                "Consumer_own_password_reaches_only_signed_owner", "Other_consumer_password_denied_before_any_storage"])
        expected.add(prefix + f'Missing_consumer_owner_denied_before_any_storage(operation: "{operation}")')
        expected.update(prefix + "Untrusted_context_denied_before_any_storage" +
                        f'(category: "{category}", operation: "{operation}")' for category in ["anonymous", "unknown"])
        expected.update(prefix + f'Persistence_result_is_not_replaced_with_success(operation: "{operation}", result: {result})'
                        for result in ["True", "False"])
    for category in ["employee", "manufacturing", "service"]:
        for value in ["True", "False"]:
            expected.add(prefix + "Internal_reset_requires_individual_customer_before_write" +
                         f'(category: "{category}", customer: {value})')
            expected.add(prefix + f'Internal_verification_is_self_only(category: "{category}", own: {value})')
    results, sources = current_test_evidence(report, prefix)
    failed = any(outcome not in {"Passed", "NotExecuted"} for values in results.values() for outcome in values)
    complete = set(results) == expected and all(results.get(name) == ["Passed"] for name in expected)
    report.add("required:password-handler-ownership", "required",
               "FAIL" if failed else "PASS" if complete else "BLOCKED",
               "Current-run TRX requires all 30 two-owner/password handler cases exactly once. "
               "Fake persistence proves self-only verification, consumer ownership, internal customer-only resets, "
               "untrusted-context denials and zero storage calls on owner denial; not running-host/SQL mutation proof. "
               "Evidence SHA256: " + json.dumps(sources, sort_keys=True))


def cart_lifecycle_evidence(report):
    prefix = "ApiFunctions.Tests.OwnedCartLifecycleTests."
    expected = {
        prefix + f"Guest_read_enforces_exact_expiry_without_extending_lifetime(ticks: {ticks}, allowed: {allowed})"
        for ticks, allowed in [(-1, "True"), (0, "False"), (1, "False")]
    }
    for operation in ["READ", "DELETE", "RETIRE", "MERGE"]:
        expected.update(prefix + name + f'(operation: "{operation}")' for name in [
            "Expiry_during_cart_lock_stops_before_data_access_or_mutation",
            "Retired_session_cannot_be_reused_before_expiry",
        ])
    expected.update(
        prefix + "Merge_retry_is_idempotent_only_for_same_owner_before_expiry" +
        f"(owner: {owner}, ticks: {ticks}, allowed: {allowed})"
        for owner, ticks, allowed in [(7, -1, "True"), (8, -1, "False"), (7, 0, "False")]
    )
    expected.update(prefix + name for name in [
        "Merge_rechecks_expiry_after_waiting_for_the_account_lock",
        "New_session_has_fixed_lifetime_and_persists_only_hashed_proof",
        "Expected_cart_mismatch_is_denied_before_lock_or_data_access",
    ])
    results, sources = current_test_evidence(report, prefix)
    failed = any(outcome not in {"Passed", "NotExecuted"} for values in results.values() for outcome in values)
    complete = set(results) == expected and all(results.get(name) == ["Passed"] for name in expected)
    report.add("required:guest-cart-service-lifecycle", "required",
               "FAIL" if failed else "PASS" if complete else "BLOCKED",
               "Current-run TRX requires all 17 actual cart-service lifecycle cases exactly once: "
               "expiry boundaries and lock waits, retired/merged reuse, fixed lifetime and hashed proof. "
               "Uses an isolated database transport, not live SQL transactions, cleanup batch selection "
               "or deployed timer execution. Evidence SHA256: " + json.dumps(sources, sort_keys=True))


def mcp_dispatch_evidence(report):
    prefix = "AdventureWorks.Tests.McpToolDispatchTests."
    tools = report.inventory.get("mcp", [])
    expected = set()
    expected.add(prefix + "Authorized_task_opt_in_preserves_background_dispatch")
    expected.update(prefix + "Catalogue_only_service_cannot_dispatch_purchase_history_recommendations" +
                    f"(task: {task})" for task in ["False", "True"])
    expected.update(
        prefix + "Task_handlers_bind_owner_and_recheck_scope_before_reads_updates_or_cancellation" +
        f"(owner: {owner})" for owner in [71, 72])
    for tool in tools:
        name = tool["Name"]
        expected.update(prefix + "Every_tool_denial_stops_real_http_dispatch" +
                        f'(name: "{name}", reason: "{reason}")'
                        for reason in ["anonymous", "missing-business-scope", "wrong-audience"])
        expected.add(prefix + "Every_tool_with_issued_service_scope_reaches_dispatch_once" +
                     f'(name: "{name}")')
        expected.add(prefix + "Denied_task_opt_in_returns_authorization_error_not_a_background_task" +
                     f'(name: "{name}")')
        if tool["Policy"]["Mode"] == "SelfOrInternal":
            expected.update(
                prefix + "Consumer_owner_is_injected_before_dispatch_and_foreign_owner_never_dispatches" +
                f'(name: "{name}", owner: {owner})' for owner in [71, 72])
    results, sources = current_test_evidence(report, prefix)
    failed = any(outcome not in {"Passed", "NotExecuted"} for values in results.values() for outcome in values)
    complete = bool(tools) and set(results) == expected and \
        all(results.get(name) == ["Passed"] for name in expected)
    report.add("required:mcp-tool-http-dispatch", "required",
               "FAIL" if failed else "PASS" if complete else "BLOCKED",
               "Current-run TRX requires all " + str(len(expected)) +
               " registry-derived real HTTP/OpenIddict/SDK dispatch cases exactly once: anonymous, "
               "wrong-resource and missing-scope denials, issued service-token positives, "
               "task opt-in authorization before creation, preserved authorized background dispatch, "
               "two-owner injection and malformed/foreign owner denials. An innermost sentinel "
               "replaces business execution; does not prove SQL/proxy/task behavior or deployed access. "
               "Evidence SHA256: " + json.dumps(sources, sort_keys=True))


def receipt_ownership_evidence(report):
    prefix = "ApiFunctions.Tests.ReceiptOwnershipTests."
    expected = {
        prefix + "Internal_receipt_requests_still_bind_order_to_customer_and_recipient",
        prefix + "Queue_failure_never_returns_accepted_and_invalid_JSON_never_enqueues",
    }
    expected.update(prefix + "Both_owners_read_only_their_own_receipt_before_any_blob_access" +
                    f"(owner: {owner}, download: {download})"
                    for owner in [71, 72] for download in ["False", "True"])
    expected.update(prefix + "Email_generation_binds_signed_customer_order_and_recipient_before_enqueue" +
                    f"(owner: {owner})" for owner in [71, 72])
    expected.update(prefix + "Untrusted_or_unbound_receipt_callers_reach_neither_SQL_nor_storage" +
                    f'(owner: {owner}, category: "{category}", authenticated: {authenticated})'
                    for owner, category, authenticated in [
                        ("null", "consumer", "True"), ("0", "consumer", "True"),
                        ("-1", "consumer", "True"), ("71", "unknown", "True"),
                        ("71", "consumer", "False")])
    expected.update(prefix + "Worker_revalidates_queued_order_customer_and_email_before_receipt_or_email_access" +
                    f'(order: "{order}", customer: 71, email: {email})'
                    for order, email in [("SO1072", 2071), ("SO1071", 2072), ("SO01071", 2071)])
    expected.update(prefix + "Authorized_missing_and_failed_storage_have_distinct_sanitized_responses" +
                    f"(download: {download}, storageStatus: {status}, expected: {outcome})"
                    for download, status, outcome in [
                        ("False", 404, "OK"), ("True", 404, "NotFound"),
                        ("False", 503, "InternalServerError"), ("True", 503, "InternalServerError")])
    results, sources = current_test_evidence(report, prefix)
    failed = any(outcome not in {"Passed", "NotExecuted"} for values in results.values() for outcome in values)
    complete = set(results) == expected and all(results.get(name) == ["Passed"] for name in expected)
    report.add("required:receipt-handler-ownership", "required",
               "FAIL" if failed else "PASS" if complete else "BLOCKED",
               "Twenty exact current-run actual receipt-handler cases: both owners, zero unauthorized blob/queue "
               "access, signed customer/order/email binding, internal binding, worker revalidation, "
               "confirmed queue failure and sanitized storage errors. SDK clients are isolated; "
               "does not prove SQL ownership rows or permit real email. Evidence SHA256: " +
               json.dumps(sources, sort_keys=True))


def consumer_handler_evidence(report):
    covered = {
        "CreateAddress", "DeleteAddress", "GetAddressById", "GetAddresses", "GetPersonAddresses",
        "SetAddressType", "UpdateAddress", "SetPassword", "VerifyPassword", "CheckOrderReceipt",
        "DownloadOrderReceipt", "GenerateAndSendReceipt", "GetPaymentMethods", "CreateOrderDetail",
        "GetOwnedOrderDetails", "CreateOrderHeader",
        "MergeGuestCart",
    }
    consumers = {item["Name"] for item in report.inventory.get("functions", [])
                 if (item.get("Policy") or {}).get("Tier") == "Consumer"}
    dependencies = ["required:functions-worker-middleware", "required:address-handler-ownership",
                    "required:password-handler-ownership", "required:receipt-handler-ownership"]
    gates = [[item for item in report.checks if item["id"] == check_id] for check_id in dependencies]
    prefix = "ApiFunctions.Tests."
    expected = {
        prefix + "PaymentMethodFunctionsTests.Reads_only_the_signed_person_even_with_foreign_query_and_headers" +
        f"(owner: {owner})" for owner in [71, 72]
    }
    for owner in [7, 8]:
        for name in [
                "OrderDetailFunctionsTests.Consumer_order_detail_uses_the_validated_customer_claim",
                "OrderDetailFunctionsTests.Other_owner_order_is_denied_without_a_success_response",
                "OrderDetailFunctionsTests.Consumer_reads_only_signed_owner_even_with_forged_inputs",
                "OrderDetailFunctionsTests.Consumer_cannot_read_other_or_mixed_orders",
                "OwnedCartFunctionsTests.Valid_consumer_resolves_owner_from_signed_claim_not_query",
                "OwnedCartFunctionsTests.Merge_binds_both_signed_owners_and_hashed_guest_proof"]:
            expected.add(prefix + name + f"(owner: {owner})")
    for customer, person, address in [(7, 71, 101), (8, 72, 102)]:
        expected.update(prefix + "OrderHeaderFunctionsTests." + name +
                        f"(customer: {customer}, person: {person})" for name in [
                            "Consumer_header_uses_signed_customer_and_person_not_forged_inputs",
                            "Foreign_address_or_customer_binding_returns_denial"])
        expected.add(prefix + "OrderHeaderServiceTests."
                     "Customer_and_both_addresses_are_checked_before_insert_in_one_transaction" +
                     f"(customer: {customer}, person: {person}, address: {address})")
    expected.update(prefix + "OrderHeaderServiceTests.Invalid_customer_address_or_ship_method_never_inserts" +
                    f'(defect: "{defect}")' for defect in
                    ["customer", "billing", "shipping", "missing-address", "ship-method"])
    expected.add(prefix + "OrderHeaderServiceTests.Insert_failure_rolls_back_the_guarded_transaction")
    results, sources = current_test_evidence(report, prefix)
    selected = {name: outcomes for name, outcomes in results.items()
                if name.startswith(tuple(prefix + cls for cls in [
                    "PaymentMethodFunctionsTests.", "OrderDetailFunctionsTests.", "OwnedCartFunctionsTests.",
                    "OrderHeaderFunctionsTests.", "OrderHeaderServiceTests."]))}
    failed = (any(item["status"] == "FAIL" for matches in gates for item in matches) or
              any(outcome not in {"Passed", "NotExecuted"} for values in selected.values() for outcome in values))
    complete = (consumers == covered and
                all(len(matches) == 1 and matches[0]["status"] == "PASS" for matches in gates) and
                all(selected.get(name) == ["Passed"] for name in expected))
    report.add("required:consumer-handlers-offline", "required",
               "FAIL" if failed else "PASS" if complete else "BLOCKED",
               "Exact closure over all 17 registered consumer handlers requires middleware/address/password/receipt "
               "gates plus 26 named payment/order/cart and guarded-header cases exactly once. "
               "New consumer routes require explicit coverage. Isolated stores do not prove deployed SQL "
               "ownership, transactions or side effects. Evidence SHA256: " + json.dumps(sources, sort_keys=True))


def mcp_task_ownership_evidence(report):
    prefix = "AdventureWorks.Tests.McpTaskOwnershipTests."
    expected = {
        prefix + "Creation_without_tool_authority_never_writes_a_table_entity",
        prefix + "In_memory_tasks_enforce_the_same_owner_and_scope_boundary",
    }
    expected.update(
        prefix + "Table_task_owner_and_scope_survive_recreation_and_block_all_foreign_operations" +
        f"(owner: {owner})" for owner in [71, 72])
    expected.update(
        prefix + "Table_tasks_fail_closed_for_lost_authority_and_unowned_legacy_state" +
        f'(scenario: "{scenario}")' for scenario in ["application", "scope", "category", "policy", "unbound", "legacy"])
    results, sources = current_test_evidence(report, prefix)
    failed = any(outcome not in {"Passed", "NotExecuted"} for values in results.values() for outcome in values)
    complete = set(results) == expected and all(results.get(name) == ["Passed"] for name in expected)
    report.add("required:mcp-task-ownership-offline", "required",
               "FAIL" if failed else "PASS" if complete else "BLOCKED",
               "Ten exact current-run task-store cases: persisted subject/app/category/tool/scope across recreation, "
               "both owners, no foreign writes/input events, scope/category loss, changed tool policy, wrong app, unbound/legacy denial "
               "and no creation without tool authority. Uses isolated TableClient transport and real "
               "in-memory store; actual task HTTP handlers are gated separately. "
               "Evidence SHA256: " + json.dumps(sources, sort_keys=True))


def restricted_read_fields(actions, protected, required):
    names = {action if isinstance(action, str) else action.get("action") for action in actions}
    reads = [action for action in actions if
             action == "read" or isinstance(action, dict) and action.get("action") == "read"]
    if not reads or "*" in names:
        return False
    for read in reads:
        if not isinstance(read, dict) or not isinstance(read.get("fields"), dict):
            return False
        fields = read["fields"]
        include = fields.get("include", ["*"])
        exclude = fields.get("exclude", [])
        if (not isinstance(include, list) or not isinstance(exclude, list) or
                any(not isinstance(field, str) for field in include + exclude)):
            return False
        def readable(field):
            return "*" not in exclude and field not in exclude and ("*" in include or field in include)
        if any(readable(field) for field in protected) or any(not readable(field) for field in required):
            return False
    return True


def review_contract(report, config):
    permissions = config["entities"]["ProductReview"]["permissions"]
    required = {"ProductReviewID", "ProductID", "ReviewerName", "ReviewDate", "Rating", "Comments",
                "HelpfulVotes", "UserID", "IsModerated"}
    def role_actions(role):
        return [action for permission in permissions if permission["role"] == role
                for action in permission.get("actions", [])]
    anonymous_actions = role_actions("anonymous")
    report.check("dab:reviews:anonymous-read-only", "contracts",
                 len(anonymous_actions) == 1 and
                 restricted_read_fields(anonymous_actions, {"EmailAddress"}, required),
                 "Anonymous review reads retain display fields but exclude reviewer email and all writes.")
    for role in ["authenticated", "consumer"]:
        definitions = role_actions(role)
        names = {item if isinstance(item, str) else item.get("action") for item in definitions}
        creates = [item for item in definitions if isinstance(item, dict) and item.get("action") == "create"]
        updates = [item for item in definitions if isinstance(item, dict) and item.get("action") == "update"]
        report.check("dab:reviews:email-redacted:" + role, "contracts",
                     restricted_read_fields(definitions, {"EmailAddress"}, required),
                     "Authenticated public review reads do not disclose reviewer email.")
        report.check("dab:reviews:owner-bound-create:" + role, "contracts",
                     len(creates) == 1 and
                     sum(item == "create" or isinstance(item, dict) and item.get("action") == "create"
                         for item in definitions) == 1 and not names.intersection({"*", "delete"}) and
                     creates[0].get("policy", {}).get("database") == "@item.UserID eq @claims.business_entity_id" and
                     set(creates[0].get("fields", {}).get("include", [])) ==
                     {"ProductID", "ReviewerName", "ReviewDate", "EmailAddress", "Rating", "Comments", "UserID"},
                     "Review creation binds authorship to identity and excludes moderation/vote fields")
        report.check("dab:reviews:vote-fields-owner:" + role, "contracts",
                     len(updates) == 1 and
                     sum(item == "update" or isinstance(item, dict) and item.get("action") == "update"
                         for item in definitions) == 1 and not names.intersection({"*", "delete"}) and
                     updates[0].get("fields", {}).get("include") == ["HelpfulVotes"] and
                     not updates[0].get("policy"),
                     "Authenticated review updates are vote-only; DAB policy columns must not broaden writable fields")


def order_detail_contract(report, config):
    permissions = config["entities"]["SalesOrderDetail"]["permissions"]
    for role in ["anonymous", "authenticated", "consumer"]:
        actions = [action for permission in permissions if permission["role"] == role
                   for action in permission.get("actions", [])]
        names = {item if isinstance(item, str) else item.get("action") for item in actions}
        report.check("dab:orders:detail-no-consumer-read:" + role, "contracts",
                     not names.intersection({"read", "*"}),
                     "DAB order-detail reads must be disabled for " + role +
                     "; the Functions read joins each requested order to its signed customer")
        report.check("dab:orders:detail-owner-bound-create:" + role, "contracts",
                     not names.intersection({"create", "*"}),
                     "DAB order-detail creation must be disabled for " + role +
                     "; checkout uses the owner-checked Functions write path")


def catalog_contract(report, config):
    field_contracts = {
        "Product": (
            {"StandardCost", "SafetyStockLevel", "ReorderPoint", "DaysToManufacture"},
            {"ProductID", "Name", "ProductNumber", "Color", "ListPrice", "Size",
             "SizeUnitMeasureCode", "Weight", "WeightUnitMeasureCode", "ProductLine", "Class",
             "Style", "ProductSubcategoryID", "ProductModelID", "SellStartDate", "SellEndDate",
             "DiscontinuedDate", "FinishedGoodsFlag"},
        ),
        "ProductInventory": ({"Shelf", "Bin"}, {"ProductID", "LocationID", "Quantity"}),
    }
    for role in ["anonymous", "authenticated", "consumer"]:
        for entity, (protected, required) in field_contracts.items():
            permissions = [item for item in config["entities"][entity]["permissions"] if item["role"] == role]
            actions = [action for permission in permissions for action in permission.get("actions", [])]
            names = {action if isinstance(action, str) else action.get("action") for action in actions}
            report.check(f"dab:catalog:{entity}:read-fields:{role}", "contracts",
                         restricted_read_fields(actions, protected, required),
                         "Public catalog reads retain storefront fields but exclude internal cost, "
                         "replenishment and storage-position fields.")
            report.check(f"dab:catalog:{entity}:no-write:{role}", "contracts",
                         not names.intersection({"create", "update", "delete", "*"}),
                         "Public catalog roles cannot mutate product configuration or inventory.")
        location = [item for item in config["entities"]["Location"]["permissions"] if item["role"] == role]
        report.check("dab:catalog:Location:no-access:" + role, "contracts",
                     all(not item.get("actions") for item in location),
                     "Manufacturing work-center details are unavailable to public catalog roles.")


def order_header_contract(report, config):
    permissions = config["entities"]["SalesOrderHeader"]["permissions"]
    owner_policy = "@item.CustomerID eq @claims.customer_id"
    for role in ["anonymous", "authenticated", "consumer"]:
        actions = [action for permission in permissions if permission["role"] == role
                   for action in permission.get("actions", [])]
        names = {action if isinstance(action, str) else action.get("action") for action in actions}
        if role != "anonymous":
            matches = [item for item in actions if
                       item == "read" or isinstance(item, dict) and item.get("action") == "read"]
            report.check("dab:orders:header-owner-read:" + role, "contracts",
                         "*" not in names and len(matches) == 1 and isinstance(matches[0], dict) and
                         matches[0].get("policy", {}).get("database") == owner_policy,
                         "DAB order-header reads must be scoped to the signed customer for " + role)
        else:
            report.check("dab:orders:header-no-read:anonymous", "contracts", "read" not in names,
                         "Anonymous callers cannot read order headers.")
        report.check("dab:orders:header-no-direct-write:" + role, "contracts",
                     not names.intersection({"create", "update", "delete", "*"}),
                     "Direct order-header writes are unavailable to " + role +
                     "; checkout uses the customer/address-bound Functions route.")


def customer_contract(report, config):
    permissions = config["entities"]["Customer"]["permissions"]
    for role in ["anonymous", "authenticated", "consumer"]:
        actions = [action for permission in permissions if permission["role"] == role
                   for action in permission.get("actions", [])]
        names = {action if isinstance(action, str) else action.get("action") for action in actions}
        if role != "anonymous":
            reads = [item for item in actions if
                     item == "read" or isinstance(item, dict) and item.get("action") == "read"]
            report.check("dab:customers:owner-read:" + role, "contracts",
                         len(reads) == 1 and isinstance(reads[0], dict) and
                         reads[0].get("policy", {}).get("database") ==
                         "@item.PersonID eq @claims.business_entity_id",
                         "Customer reads remain scoped to the signed person.")
            creates = [item for item in actions if
                       item == "create" or isinstance(item, dict) and item.get("action") == "create"]
            report.check("dab:customers:limited-create:" + role, "contracts",
                         len(creates) == 1 and isinstance(creates[0], dict) and
                         creates[0].get("policy", {}).get("database") ==
                         "@item.PersonID eq @claims.business_entity_id" and
                         creates[0].get("fields") == {"include": ["PersonID", "TerritoryID"]},
                         "Self-service customer creation accepts only the signed person and territory, not StoreID.")
        report.check("dab:customers:no-update-delete:" + role, "contracts",
                     not names.intersection({"update", "delete", "*"}),
                     "Public customer roles cannot rewrite existing customer/store relationships.")
        if role == "anonymous":
            report.check("dab:customers:no-anonymous-create", "contracts", "create" not in names,
                         "Anonymous callers cannot create customers directly.")
            report.check("dab:customers:no-anonymous-read", "contracts", "read" not in names,
                         "Anonymous callers cannot read customer records.")

def payment_method_contract(report, config):
    cards = config["entities"]["CreditCard"]["permissions"]
    links = config["entities"]["PersonCreditCard"]["permissions"]
    for role in ["anonymous", "authenticated", "consumer"]:
        report.check("dab:payments:no-direct-cards:" + role, "contracts",
                     all(item["role"] != role for item in cards),
                     "Saved cards use person-bound Functions with server-side masking, never broad DAB access.")
    for role in ["authenticated", "consumer"]:
        permission = next((item for item in links if item["role"] == role), {})
        actions = permission.get("actions", [])
        report.check("dab:payments:owned-links:" + role, "contracts",
                     {item.get("action") for item in actions if isinstance(item, dict)} == {"read", "delete"} and
                     all(isinstance(item, dict) and item.get("policy", {}).get("database") ==
                         "@item.BusinessEntityID eq @claims.business_entity_id" for item in actions),
                     "Self-service card links remain owner-bound read/delete only; foreign cards cannot be linked.")


def address_link_contract(report, config):
    permissions = config["entities"]["BusinessEntityAddress"]["permissions"]
    for role in ["anonymous", "authenticated", "consumer"]:
        actions = [action for permission in permissions if permission["role"] == role
                   for action in permission.get("actions", [])]
        expected = [] if role == "anonymous" else [{
            "action": "read", "policy": {
                "database": "@item.BusinessEntityID eq @claims.business_entity_id",
            },
        }]
        report.check("dab:addresses:links:" + role, "contracts", actions == expected,
                     "Consumers can only read their own address links; link creation, type changes and deletion "
                     "must use owner-checked Functions, never direct DAB writes.")


def cart_contract(report, config):
    permissions = config["entities"]["ShoppingCartItem"]["permissions"]
    report.check("dab:carts:no-anonymous-access", "contracts",
                 all(item["role"] != "anonymous" for item in permissions),
                 "Guest cart capabilities must be validated by owned Functions, never anonymous DAB CRUD")
    report.check("dab:carts:read-only-owner-policy", "contracts",
                 {item["role"] for item in permissions} == {"authenticated", "consumer"} and
                 all(item["actions"] == [{"action": "read", "policy": {
                     "database": "@item.ShoppingCartID eq @claims.business_entity_id"}}]
                     for item in permissions),
                 "DAB cart reads require signed ownership; all cart writes use owned Functions")


def contracts(report):
    contract = json.loads(CONTRACTS.read_text())
    functions = report.inventory.get("functions", [])
    safe_reads = reviewed_function_read_routes()
    report.check("inventory:reviewed-function-reads", "contracts",
                 all(len(matches := [item for item in functions if item.get("Name") == name]) == 1 and
                     is_reviewed_function_read(matches[0], safe_reads)
                     for name in safe_reads),
                 "Reviewed read probes require the exact protected function name, route and GET-only binding")
    public = {item["Name"] for item in functions if item["Policy"] and item["Policy"]["IsAnonymous"]}
    report.check("inventory:public-functions", "contracts",
                 public == set(contract["publicFunctions"]),
                 "Anonymous/alternate-enforcement registry must exactly match reviewed contract")
    group_scoped = {
        item["Name"]: item["Policy"]["RequiredScope"]
        for item in functions
        if item["Policy"] and item["Policy"]["Mode"] == "GroupScoped"
    }
    report.check("inventory:group-scoped-functions", "contracts",
                 group_scoped == contract.get("groupScopedFunctions", {}),
                 "Group-scoped authenticated routes and baseline scopes must match the reviewed contract")
    for name in sorted(public):
        classification = contract["publicFunctions"].get(name)
        report.add("exception:function:" + name, "exceptions",
                   "ACCEPTED_EXCEPTION" if classification else "FAIL",
                   classification or "Unreviewed anonymous function")
    config = json.loads((ROOT / "api/dab-config.json").read_text())
    operations = dab_inventory(config)
    review_contract(report, config)
    order_detail_contract(report, config)
    catalog_contract(report, config)
    order_header_contract(report, config)
    customer_contract(report, config)
    payment_method_contract(report, config)
    address_link_contract(report, config)
    cart_contract(report, config)
    report.inventory["dab"] = operations
    unreviewed = contract["unreviewedAnonymousDabOperations"]
    anonymous_reads = {item["entity"] for item in operations
                       if item["role"] == "anonymous" and item["action"] == "read"
                       and item["action"] not in unreviewed.get(item["entity"], [])}
    report.check("inventory:anonymous-dab-reads", "contracts",
                 anonymous_reads == set(contract["anonymousDabReads"]),
                 "Anonymous read catalog must not expand without review")
    for item in operations:
        if item["role"] == "anonymous" and (item["action"] != "read"
                                          or item["action"] in unreviewed.get(item["entity"], [])):
            report.add(f"exception:dab:{item['entity']}:{item['action']}", "exceptions", "FAIL",
                       "Anonymous operation requires explicit bounded exception acceptance and session/owner evidence")
    auth = config["runtime"]["host"].get("authentication", {})
    report.check("dab:resource-server", "contracts",
                 auth.get("provider") == "AzureAD" and
                 auth.get("jwt", {}).get("audience") == "@env('DAB_JWT_AUDIENCE')" and
                 auth.get("jwt", {}).get("issuer") == "@env('DAB_JWT_ISSUER')",
                 "DAB must validate a configured issuer and dedicated audience")
    agents = sorted(path.stem for path in (ROOT / "scripts/utilities/agents").glob("*.sh"))
    workflows = sorted(path.name for path in (ROOT / "workflows").glob("*.yaml"))
    report.inventory["agentProvisioners"] = agents
    report.inventory["workflows"] = workflows
    report.inventory["sourceWorkflowInvocations"] = agent_workflow_inventory(
        ROOT / "scripts/utilities/agents", ROOT / "workflows")
    provisioner_tools = agent_source_inventory(ROOT / "scripts/utilities/agents")
    report.inventory["agentProvisionerTools"] = provisioner_tools
    if "mcp" in report.inventory:
        registered_tools = {item["Name"] for item in report.inventory["mcp"]}
        unknown = sorted({name for names in provisioner_tools.values() for name in names} - registered_tools)
        report.check("inventory:agent-tools-registered", "contracts", not unknown,
                     "Every provisioned MCP tool name must exist in the authorization registry" +
                     (": " + ", ".join(unknown) if unknown else ""))
        consumer_chat_tool_contract(report, provisioner_tools, report.inventory["mcp"])
    report.add("inventory:caller-trust-edge-closure", "agents", "BLOCKED",
               "Provisioners are discovered; complete source/deployment caller and dependency-edge reconciliation remains required")
    for name in agents:
        report.add("agent-path:" + name, "agents", "BLOCKED",
                   "Actual deployed identity, tool calls and dependency authorization require correlated runtime evidence")
    for obligation in ["functions-middleware-host-denials", "all-ownership-handlers-two-owners",
                       "browser-real-login-all-sites", "dab-all-role-operation-decisions",
                       "mcp-task-ownership"]:
        report.add("required:" + obligation, "required", "BLOCKED",
                   "Required coverage obligation is not established by registry or helper tests")
    report.add("required:internal-session-transition-races", "required", "BLOCKED",
               "Generation-scoped portal sessions have deterministic and local two-tab Chromium tests, "
               "but overlapping callback, refresh and account-switch races still require deployed evidence.")
    assertion_evidence(report)
    middleware_evidence(report)
    address_ownership_evidence(report)
    password_ownership_evidence(report)
    receipt_ownership_evidence(report)
    cart_lifecycle_evidence(report)
    mcp_dispatch_evidence(report)
    mcp_task_ownership_evidence(report)
    consumer_handler_evidence(report)


class Deployment:
    def __init__(self, environment):
        config_spec = importlib.util.spec_from_file_location("assurance_runtime", Path(__file__).with_name("runtime_config.py"))
        config_module = importlib.util.module_from_spec(config_spec)
        config_spec.loader.exec_module(config_module)
        self.runtime = config_module.load()
        if self.runtime:
            self.values = self.runtime["values"]
            if environment and environment != self.values.get("AZURE_ENV_NAME"):
                raise EvidenceError("Private job environment does not match the requested environment")
        else:
            args = ["azd", "env", "get-values", "--output", "json", "--no-prompt"]
            if environment:
                args += ["--environment", environment]
            self.values = json_command(args)
        if not isinstance(self.values, dict):
            raise EvidenceError("azd returned no environment object")
        self.subscription = self.required("AZURE_SUBSCRIPTION_ID")
        self.group = self.required("AZURE_RESOURCE_GROUP")
        self.environment = self.required("AZURE_ENV_NAME")
        if environment and environment != self.environment:
            raise EvidenceError("Selected azd environment does not match the requested environment")

    def required(self, key):
        value = self.values.get(key)
        if not isinstance(value, str) or not value.strip():
            raise EvidenceError(f"azd value {key} is missing")
        return value.strip()

    def azure(self, *args):
        if self.runtime:
            expected = ("staticwebapp", "show", "--name", self.required("SERVICE_APP_NAME"),
                        "--resource-group", self.group)
            if args == expected:
                return {"defaultHostname": self.runtime["storefrontHostname"]}
            raise EvidenceError("ARM inspection belongs to the local deployer, not the private runtime identity")
        return json_command(["az", *args, "--subscription", self.subscription,
                             "--only-show-errors", "--output", "json"],
                            allow_empty=args[:3] == ("containerapp", "job", "delete"))

    def resource(self, provider_path):
        return (f"https://management.azure.com/subscriptions/{self.subscription}"
                f"/resourceGroups/{self.group}/providers/{provider_path}")

    def arm(self, provider_path, version):
        return self.azure("rest", "--method", "get", "--url",
                          self.resource(provider_path) + "?api-version=" + version)


def functions_dependency_readiness(report, deployment):
    endpoint = https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/health/readiness"
    status, _, raw = http("GET", endpoint)
    if status not in {200, 503}:
        raise EvidenceError(f"Functions readiness returned unexpected HTTP {status}")
    try:
        document = json.loads(raw)
        checks = document["checks"]
        checked_at = document["checkedAt"]
        if (not isinstance(checks, list) or not checks or not isinstance(checked_at, str) or
                not checked_at or document["status"] not in {"healthy", "unhealthy"}):
            raise ValueError("Invalid readiness report")
        normalized = re.sub(r"(\.\d{6})\d+(?=Z|[+-]|$)", r"\1", checked_at).replace("Z", "+00:00")
        timestamp = datetime.fromisoformat(normalized)
        if timestamp.tzinfo is None or abs((datetime.now(timezone.utc) - timestamp).total_seconds()) > 180:
            raise ValueError("Stale or undated readiness report")
        valid_statuses = {"healthy", "unhealthy", "timeout", "not-configured", "unknown", "configured"}
        by_id = {}
        for check in checks:
            if (not isinstance(check, dict) or not isinstance(check.get("id"), str) or
                    re.fullmatch(r"[a-z][a-z0-9-]*", check["id"]) is None or
                    check["id"] in by_id or type(check.get("required")) is not bool or
                    not isinstance(check.get("status"), str) or check["status"] not in valid_statuses):
                raise ValueError("Invalid readiness check")
            by_id[check["id"]] = check
        expected = {
            "sql": (True, "catalog SELECT"),
            "blobs": (True, "application-container properties"),
            "queues": (True, "application and poison-queue properties"),
            "tables": (True, "application-table partition-key reads"),
            "webpubsub-service": (False, "orders-group existence"),
            "files": (False, "seed-log directory properties"),
            "mcp": (True, "MCP liveness"),
            "mcp-ready": (True, "MCP SQL/task readiness"),
            "oauth": (True, "OAuth discovery metadata"),
        }
        if any(name not in by_id or by_id[name]["required"] is not required
               for name, (required, _) in expected.items()):
            raise ValueError("Missing or incorrectly classified readiness dependency")
        identity_probes = {"sql-identity", "blob-identity", "queue-identity", "table-identity",
                           "file-identity", "webpubsub-identity"}
        if any(by_id[name]["required"] for name in identity_probes & by_id.keys()):
            raise ValueError("Identity capabilities must be optional")
        overall = "unhealthy" if any(item["required"] and item["status"] != "healthy"
                                     for item in checks) else "healthy"
        if document["status"] != overall or status != (200 if overall == "healthy" else 503):
            raise ValueError("Readiness status contradicts required dependencies")
    except (ValueError, KeyError, TypeError) as error:
        raise EvidenceError("Functions readiness returned incomplete, stale or inconsistent evidence") from error

    configuration_only = {"openai", "foundry", "manufacturing-agent", "email", "order-emails", "telemetry"}
    report.inventory["functionsDependencyReadiness"] = {
        "checkedAt": checked_at, "httpStatus": status,
        "checks": [
            {"id": name, "status": by_id[name]["status"], "required": by_id[name]["required"],
             "evidence": "runtime-probe" if name in expected or name in identity_probes else
                         "configuration-only" if name in configuration_only else "unclassified"}
            for name in sorted(by_id)
        ],
    }
    for name, (required, operation) in expected.items():
        state = by_id[name]["status"]
        result = ("PASS" if state == "healthy" else
                  "FAIL" if required and state in {"unhealthy", "not-configured"} else "BLOCKED")
        report.add("infra:functions-dependency:" + name, "infra", result,
                   f"The deployed Functions {operation} probe reports {state}; "
                   "this does not prove the exact principal, complete effective RBAC or write permissions.")

    identity = by_id.get("sql-identity")
    bindings = [check for check in report.checks if check["id"] == "infra:functions-identity"]
    binding_verified = len(bindings) == 1 and bindings[0]["status"] == "PASS"
    identity_status = identity.get("status") if identity else None
    identity_message = identity.get("message") if identity else None
    if binding_verified and identity_status == "healthy" and identity_message == (
            "SQL principal matches the configured managed identity."):
        result = "PASS"
        detail = ("The Functions SQL connection's current external principal matches the configured "
                  "client ID, independently bound to the selected attached runtime managed identity.")
    elif binding_verified and identity_status == "unhealthy" and identity_message == (
            "SQL principal does not match the configured managed identity."):
        result = "FAIL"
        detail = "The Functions SQL connection's current principal does not match the selected managed identity."
    else:
        result = "BLOCKED"
        detail = ("A fresh SQL principal probe and a matching selected Functions identity binding are "
                  "both required; legacy, invalid, unavailable or unrecognized evidence is not proof.")
    report.add("infra:functions-sql-principal", "infra", result, detail)

    for service in ["blob", "queue", "table", "file", "webpubsub"]:
        identity = by_id.get(service + "-identity")
        targets = [check for check in report.checks
                   if check["id"] == "infra:functions-" + service + "-target"]
        target_verified = len(targets) == 1 and targets[0]["status"] == "PASS"
        identity_status = identity.get("status") if identity else None
        identity_message = identity.get("message") if identity else None
        if (binding_verified and target_verified and identity_status == "healthy" and
                identity_message == "A read succeeded using the configured managed identity."):
            result = "PASS"
            detail = (f"The selected {service} endpoint accepted a read using an SDK token whose "
                      "application ID matches the attached Functions identity; write permissions, "
                      "other resources and all effective grants remain separate.")
        elif (binding_verified and target_verified and identity_status == "unhealthy" and
              identity_message == "The service token does not match the configured managed identity."):
            result = "FAIL"
            detail = f"The {service} SDK selected a different application identity."
        else:
            result = "BLOCKED"
            detail = (f"The current {service} endpoint, attached identity and exact runtime-token "
                      "read evidence were not all verified.")
        report.add("infra:functions-" + service + "-principal", "infra", result, detail)

    for name in sorted(set(by_id) - set(expected) - configuration_only - identity_probes):
        report.add("infra:functions-dependency:" + name, "infra", "BLOCKED",
                   "New readiness dependency requires explicit classification and runtime evidence.")


def infra(report, deployment):
    d = deployment
    checks = [
        ("keyvault", lambda: d.arm("Microsoft.KeyVault/vaults/" + d.required("MCP_SIGNING_KEY_VAULT_NAME"),
                                  "2023-07-01")["properties"],
         lambda value: value.get("enableRbacAuthorization") is True and not value.get("accessPolicies"),
         "Key Vault uses RBAC without legacy access policies"),
        ("sql", lambda: d.arm("Microsoft.Sql/servers/" + d.required("SQL_SERVER_NAME") +
                              "/azureADOnlyAuthentications/Default", "2023-08-01")["properties"],
         lambda value: value.get("azureADOnlyAuthentication") is True, "SQL enforces Entra-only login"),
        ("openai", lambda: d.arm("Microsoft.CognitiveServices/accounts/" +
                                 d.required("AZURE_OPENAI_ACCOUNT_NAME"), "2025-06-01")["properties"],
         lambda value: value.get("disableLocalAuth") is True, "Foundry/OpenAI local keys are disabled"),
        ("storage", lambda: d.azure("storage", "account", "show", "-g", d.group,
                                    "-n", d.required("STORAGE_ACCOUNT_NAME")),
         lambda value: value.get("allowBlobPublicAccess") is False and value.get("allowSharedKeyAccess") is False,
         "Storage prevents anonymous blob access and disables Shared Key authorization"),
    ]
    for name, load, predicate, detail in checks:
        def verify(name=name, load=load, predicate=predicate, detail=detail):
            report.check("infra:" + name, "infra", predicate(load()), detail)
        report.guarded("infra:" + name, "infra", verify)
    report.guarded("infra:acr-authentication", "infra",
                   lambda: container_registry_authentication(report, d))
    report.guarded("infra:webpubsub-authentication", "infra",
                   lambda: webpubsub_authentication(report, d))
    report.guarded("infra:communication-authentication", "infra",
                   lambda: communication_authentication(report, d))
    report.guarded("infra:keyvault-network", "infra", lambda: key_vault_network_evidence(report, d))
    def seed_mount():
        storage_path = "Microsoft.Storage/storageAccounts/" + d.required("STORAGE_ACCOUNT_NAME")
        storage = d.arm(storage_path, "2025-06-01")["properties"]
        report.check("infra:storage-smb-oauth", "infra",
                     (storage.get("azureFilesIdentityBasedAuthentication") or {}).get(
                         "smbOAuthSettings", {}).get("isSmbOAuthEnabled") is True,
                     "Storage enables SMB OAuth for the existing seed log share")
        files = d.arm(storage_path + "/fileServices/default", "2025-06-01")["properties"]
        methods = files.get("protocolSettings", {}).get("smb", {}).get("authenticationMethods", "")
        report.check("infra:storage-smb-kerberos", "infra", "Kerberos" in methods.split(";"),
                     "SMB security settings explicitly permit Kerberos")
        identity = d.azure("identity", "show", "-g", d.group, "-n", d.required("USER_MANAGED_IDENTITY_NAME"))
        environment_path = "Microsoft.App/managedEnvironments/" + d.required("CONTAINER_APP_ENVIRONMENT_NAME")
        environment = d.arm(environment_path, "2026-03-02-preview")
        attached = (environment.get("identity") or {}).get("userAssignedIdentities", {})
        mount = d.arm(environment_path + "/storages/seed-job", "2026-03-02-preview")["properties"]["azureFile"]
        report.check("infra:seed-mount-identity", "infra",
                     identity["id"].lower() in {key.lower() for key in attached} and
                     str(mount.get("identity", "")).lower() == identity["id"].lower() and
                     mount.get("accountName") == d.required("STORAGE_ACCOUNT_NAME") and
                     mount.get("shareName") == "seed-job-logs" and mount.get("accessMode") == "ReadWrite" and
                     not mount.get("accountKey") and not mount.get("accountKeyVaultProperties"),
                     "Seed log mount explicitly uses the existing ACA environment identity, without account keys")
    report.guarded("infra:seed-mount", "infra", seed_mount)
    def functions():
        settings = d.azure("functionapp", "config", "appsettings", "list", "-g", d.group,
                           "-n", d.required("SERVICE_API_FUNCTIONS_NAME"))
        settings = {item["name"]: item.get("value", "") for item in settings}
        function_app = d.azure("functionapp", "show", "-g", d.group,
                               "-n", d.required("SERVICE_API_FUNCTIONS_NAME"))
        identity = d.azure("identity", "show", "-g", d.group,
                           "-n", d.required("USER_MANAGED_IDENTITY_NAME"))
        report.check("infra:functions-identity", "infra",
                     function_identity_binding_is_valid(function_app, settings, identity),
                     "Functions host and identity-based Storage use the selected attached UAMI")
        issuer = origin(d.required("API_MCP_URL"))
        report.check("infra:functions-mode", "infra",
                     settings.get("FUNCTIONS_OAUTH_MODE") == "enforced", "Functions enforcement is enabled")
        report.check("infra:functions-issuer", "infra",
                     settings.get("FUNCTIONS_JWT_ISSUER", "").rstrip("/") == issuer,
                     "Functions issuer matches selected MCP deployment")
        report.check("infra:functions-audience", "infra",
                     settings.get("FUNCTIONS_JWT_AUDIENCE", "").rstrip("/") ==
                     d.values.get("FUNCTIONS_RESOURCE_IDENTIFIER", issuer + "/functions").rstrip("/"),
                     "Functions audience matches canonical resource")
        report.check("infra:functions-storage-mi", "infra",
                     settings.get("AzureWebJobsStorage__credential") == "managedidentity" and
                     settings.get("AzureWebJobsStorage__accountName") == d.required("STORAGE_ACCOUNT_NAME") and
                     not settings.get("AzureWebJobsStorage"),
                     "Functions host uses identity-based Storage, not a shared-key connection string")
        def dependency_targets():
            account = d.azure("storage", "account", "show", "-g", d.group,
                              "-n", d.required("STORAGE_ACCOUNT_NAME"))
            for service in ["blob", "queue", "table", "file"]:
                report.check("infra:functions-" + service + "-target", "infra",
                             function_storage_target_is_valid(settings, account, service),
                             f"Functions {service} health probe targets the selected Storage account")
            report.check("infra:functions-webpubsub-target", "infra",
                         function_webpubsub_target_is_valid(settings, d.required("WEB_PUBSUB_HOST_NAME")),
                         "Functions Web PubSub health probe targets the selected azd host")
            report.check("infra:functions-communication-target", "infra",
                         function_communication_target_is_valid(settings, d.required("COMMUNICATION_SERVICE_ENDPOINT")),
                         "Functions email client targets the selected Communication Services endpoint")
        report.guarded("infra:functions-dependency-targets", "infra", dependency_targets)
        report.check("infra:functions-sql-passwordless", "infra",
                     passwordless_sql(settings.get("SQL_CONNECTION_STRING")),
                     "Functions SQL configuration uses Entra authentication without embedded credentials")
    report.guarded("infra:function-settings", "infra", functions)
    def seed_identity():
        identity = d.azure("identity", "show", "-g", d.group,
                           "-n", d.required("SEED_MANAGED_IDENTITY_NAME"))
        assignments = d.azure(
            "role", "assignment", "list", "--all", "--include-inherited",
            "--assignee", identity["principalId"])
        acr_scope = (f"/subscriptions/{d.subscription}/resourceGroups/{d.group}"
                     "/providers/Microsoft.ContainerRegistry/registries/" +
                     d.required("AZURE_CONTAINER_REGISTRY_ENDPOINT").split(".")[0])
        report.check("infra:seed-acr-pull", "infra",
                     seed_acr_pull_is_exact(assignments, identity["principalId"], acr_scope),
                     "Dedicated seed identity has only unconditional AcrPull at the selected registry")
        seed_job = d.azure("containerapp", "job", "show", "-g", d.group,
                           "-n", d.required("SERVICE_SEED_JOB_NAME"))
        report.check("infra:seed-job-acr-identity", "infra",
                     container_registry_identity_is_valid(
                         seed_job, identity["id"], d.required("AZURE_CONTAINER_REGISTRY_ENDPOINT")),
                     "Seed job image pulls use its attached seed identity without registry credentials")
        sql_admin = d.arm(
            "Microsoft.Sql/servers/" + d.required("SQL_SERVER_NAME") +
            "/administrators/ActiveDirectory", "2022-05-01-preview")
        report.check("infra:seed-sql-administrator", "infra",
                     seed_sql_admin_matches(sql_admin.get("properties"), identity,
                                            d.azure("account", "show").get("tenantId")),
                     "Dedicated seed identity is the selected-tenant SQL Entra administrator")
    report.guarded("infra:seed-identity", "infra", seed_identity)
    def roles():
        identity = d.azure("identity", "show", "-g", d.group,
                           "-n", d.required("USER_MANAGED_IDENTITY_NAME"))
        assignments = d.azure("role", "assignment", "list", "--all", "--include-inherited",
                              "--assignee", identity["principalId"])
        safe = [{"role": item["roleDefinitionName"], "scope": item["scope"]}
                for item in assignments]
        report.inventory["runtimeRoleAssignments"] = safe
        report.check("infra:runtime-roles-nonempty", "infra", bool(safe),
                     "Runtime identity role assignments discovered (not proof of effective data-plane access)")
        for role, resource_key in [
                ("Key Vault Secrets User", "MCP_SIGNING_KEY_VAULT_NAME"),
                ("Storage Blob Data Contributor", "STORAGE_ACCOUNT_NAME"),
                ("Storage Queue Data Contributor", "STORAGE_ACCOUNT_NAME"),
                ("Storage Table Data Contributor", "STORAGE_ACCOUNT_NAME"),
                ("Storage File Data SMB MI Admin", "STORAGE_ACCOUNT_NAME")]:
            resource_name = d.required(resource_key).lower()
            report.check("infra:role:" + role, "infra",
                         any(item["role"] in ({role, "Storage Blob Data Owner"}
                                              if role == "Storage Blob Data Contributor" else {role})
                             and item["scope"].lower().endswith("/" + resource_name)
                             for item in safe),
                         "Required resource-scoped data role: " + role)
        broad = [item["role"] for item in safe if item["role"] in
                 {"Owner", "Contributor", "User Access Administrator", "Role Based Access Control Administrator"}]
        report.check("infra:runtime-management-privileges", "infra", not broad,
                     "Runtime identity must not have broad management roles without an accepted bounded exception")
        definitions = d.azure("role", "definition", "list")
        if not isinstance(definitions, list):
            raise EvidenceError("Runtime role definitions could not be enumerated")
        by_id = {definition["name"].lower(): definition for definition in definitions
                 if isinstance(definition, dict) and isinstance(definition.get("name"), str)}
        communication_scope = (f"/subscriptions/{d.subscription}/resourceGroups/{d.group}"
                               "/providers/Microsoft.Communication/communicationServices/" +
                               d.required("COMMUNICATION_SERVICE_NAME"))
        email_replacements = []
        webpubsub_host = selected_resource_host(d.required("WEB_PUBSUB_HOST_NAME"), "Web PubSub")
        webpubsub_scope = (f"/subscriptions/{d.subscription}/resourceGroups/{d.group}"
                           "/providers/Microsoft.SignalRService/webPubSub/" + webpubsub_host.split(".", 1)[0])
        webpubsub_replacements, webpubsub_unreviewed = [], []
        acr_scope = (f"/subscriptions/{d.subscription}/resourceGroups/{d.group}"
                     "/providers/Microsoft.ContainerRegistry/registries/" +
                     d.required("AZURE_CONTAINER_REGISTRY_ENDPOINT").split(".")[0])
        report.check("infra:runtime-acr-pull", "infra",
                     any(item["roleDefinitionId"].lower().endswith("/7f951dda-4ed3-4680-a7ca-43fe172d538d")
                         and item["scope"].lower() == acr_scope.lower() and not item.get("condition")
                         for item in assignments),
                     "Unconditional AcrPull remains at the selected registry, without Contributor")
        report.check("infra:runtime-no-deployment-roles", "infra",
                     not any(item["roleDefinitionId"].lower().endswith("/f1a07417-d97a-45cb-824c-7a7467783830")
                             or item["roleDefinitionName"].startswith("av-deployment-script-role-")
                             for item in assignments),
                     "Runtime identity must not retain Managed Identity Operator or the legacy deployment-script role")
        report.inventory["runtimeRolePermissions"] = []
        for index, assignment in enumerate(assignments):
            role_id = assignment.get("roleDefinitionId")
            definition = by_id.get(role_id.rsplit("/", 1)[-1].lower()) if isinstance(role_id, str) else None
            if definition is None:
                raise EvidenceError("An assigned runtime role definition is missing; no name-only inference")
            sensitive = sensitive_management_grants(definition, assignment["scope"])
            reviewed_email = reviewed_email_sender(definition, assignment, communication_scope, identity["principalId"])
            if reviewed_email:
                email_replacements.append(assignment["id"])
            reviewed_pubsub = reviewed_webpubsub_runtime(
                definition, assignment, webpubsub_scope, identity["principalId"])
            if reviewed_pubsub:
                webpubsub_replacements.append(assignment["id"])
            if role_scope_overlaps(assignment["scope"], webpubsub_scope):
                webpubsub_unreviewed.extend(unreviewed_webpubsub_data_grants(definition, reviewed_pubsub))
            report.inventory["runtimeRolePermissions"].append({
                "role": assignment["roleDefinitionName"], "scope": assignment["scope"],
                "roleDefinitionId": role_id, "permissions": definition["permissions"],
                "condition": assignment.get("condition"), "conditionVersion": assignment.get("conditionVersion"),
                "sensitiveManagementGrants": sensitive,
            })
            if reviewed_email and sensitive == ["Microsoft.Communication/communicationServices/write"]:
                report.add("infra:runtime-sensitive-management:" + str(index), "infra", "ACCEPTED_EXCEPTION",
                           json.loads(CONTRACTS.read_text())["runtimeEmailRole"]["justification"])
            else:
                report.check("infra:runtime-sensitive-management:" + str(index), "infra", not sensitive,
                             "Potential management/key-retrieval grants require explicit review: " +
                             assignment["roleDefinitionName"] + ("; " + ", ".join(sensitive) if sensitive else
                             "; none of the enumerated sensitive operations. This is not complete effective-access proof."))
        report.check("infra:runtime-email-role", "infra", len(email_replacements) == 1,
                     "Exactly one reviewed single-resource email role with exact permissions must be assigned")
        report.check("infra:runtime-webpubsub-role", "infra",
                     len(webpubsub_replacements) == 1 and not webpubsub_unreviewed,
                     "Exactly one scoped Web PubSub runtime role and no other overlapping Web PubSub data grants; "
                     "effective access and push delivery require separate tests")
        account_scope = (f"/subscriptions/{d.subscription}/resourceGroups/{d.group}"
                         "/providers/Microsoft.CognitiveServices/accounts/" +
                         d.required("AZURE_OPENAI_ACCOUNT_NAME"))
        project_scope = foundry_project_scope(
            d.subscription, d.group, d.required("AZURE_OPENAI_ACCOUNT_NAME"),
            d.required("AI_FOUNDRY_PROJECT_ENDPOINT"))
        report.check("infra:runtime-foundry-builtin-roles", "infra",
                     foundry_builtin_role_assignments_match_source(
                         assignments, account_scope, project_scope),
                     "Foundry built-in roles match the source-declared account/project assignments")
        report.check("infra:runtime-foundry-role-source", "infra",
                     foundry_custom_role_assignment_matches_source(assignments, project_scope),
                     "Runtime Foundry custom-role bindings must match the single project-scoped Bicep role")
    report.guarded("infra:runtime-roles", "infra", roles)
    def agents():
        deployed = fetch_agents(d)
        expected = set(report.inventory.get("agentProvisionerTools", {})) | {"manufacturing-agent"}
        unexpected = set(deployed) - expected
        # Workflow provisioners also create intent sub-agents; follow those declarations.
        latest_summaries = []
        version_summaries = []
        references = set()
        custom_origin = origin(d.required("API_MCP_URL"))
        dab_origin = origin(d.required("API_URL"))
        for name, agent in sorted(deployed.items()):
            latest = agent["versions"]["latest"]
            latest_version = latest.get("version")
            versions = fetch_agent_versions(d, name)
            latest_record = versions.get(latest_version)
            if (latest_record is None or
                    latest_record.get("definition") != latest.get("definition")):
                raise EvidenceError("Foundry agent latest version disagrees with version inventory")

            provisioned_tools = report.inventory.get("agentProvisionerTools", {})
            for version, record in sorted(versions.items()):
                summary = summarize_agent_version(
                    name, version, record, custom_origin, dab_origin)
                is_latest = version == latest_version
                summary["isLatest"] = is_latest
                version_summaries.append(summary)
                if is_latest:
                    latest_summaries.append(summary)

                version_label = f"{name}:{version}"
                references.update(summary["agentReferences"])
                if summary["kind"] == "workflow":
                    workflow_check_id = (
                        "agent:workflow-shape:" + name if is_latest else
                        "agent:version:" + version_label + ":workflow-shape"
                    )
                    report.check(
                        workflow_check_id, "agents", summary["workflowShapeValid"],
                        "Every workflow agent invocation must have a resolved static reference",
                    )
                    if is_latest:
                        source_workflow = report.inventory["sourceWorkflowInvocations"].get(name)
                        deployed_invocations = [
                            {key: value for key, value in invocation.items() if key != "surfaceId"}
                            for invocation in summary["workflowInvocations"]
                        ]
                        report.check(
                            "agent:workflow-source:" + name, "agents",
                            source_workflow is not None and
                            source_workflow["invocations"] == deployed_invocations,
                            "Every latest workflow action, branch path and agent-version binding "
                            "matches its classified source provisioner",
                        )
                if is_latest:
                    report.check(
                        f"agent:instance-identity:{name}",
                        "agents",
                        summary["hasInstanceIdentity"],
                        "Deployed latest Foundry agent version must expose its assigned instance principal",
                    )
                else:
                    report.add(
                        f"agent-version-path:{name}:{version}", "agents", "BLOCKED",
                        "Historical deployed version is inventoried but has no version-pinned runtime evidence",
                    )

                mcp_tools = [tool for tool in summary["tools"] if tool.get("type") == "mcp"]
                for index, tool in enumerate(mcp_tools):
                    suffix = "" if is_latest else f":version:{version}"
                    report.check(
                        f"agent:tool-origin:{name}:{index}{suffix}", "agents",
                        tool.get("resource") != "unclassified",
                        "Deployed MCP origin must match selected custom MCP or DAB",
                    )
                    report.add(
                        f"agent:no-stored-token:{name}:{index}{suffix}", "agents",
                        agent_header_status(tool),
                        "Credential-bearing static headers are forbidden; other static headers require "
                        "review. Header values are not exported.",
                    )
                    allowed_tools = tool.get("allowedTools")
                    report.add(
                        f"agent:tool-allowlist:{name}:{index}{suffix}", "agents",
                        "PASS" if allowed_tools else "BLOCKED",
                        "MCP tool names have a complete explicit allow-list" if allowed_tools else
                        "Deployed MCP definition has no complete explicit tool allow-list",
                    )
                if is_latest and name in provisioned_tools:
                    report.check(
                        "agent:tool-allowlist-match:" + name,
                        "agents",
                        agent_tool_allowlist_matches(provisioned_tools[name], summary["tools"]),
                        "Deployed MCP servers and tool names must exactly match the source provisioner",
                    )
            if not isinstance(latest_version, str) or not latest_version:
                raise EvidenceError("Foundry agent has no versioned latest definition")

        report.inventory["deployedAgents"] = latest_summaries
        report.inventory["deployedAgentVersions"] = version_summaries
        report.inventory["agentDependencyEdges"] = (
            agent_dependency_edges(version_summaries) + agent_tool_runtime_evidence(report, version_summaries))
        edges_by_id = {edge["id"]: edge for edge in report.inventory["agentDependencyEdges"]}
        if len(edges_by_id) != len(report.inventory["agentDependencyEdges"]):
            raise EvidenceError("Agent dependency surface identities are not unique")
        for item in version_summaries:
            for invocation in item["workflowInvocations"]:
                report.check(
                    f"agent:invocation-resolved:{item['name']}:{item['version']}:{invocation['actionId']}",
                    "agents", edges_by_id[invocation["surfaceId"]]["resolved"],
                    "Workflow action resolves to its configured latest or pinned deployed agent version",
                )
                report.add(
                    f"agent-invocation-path:{item['name']}:{item['version']}:{invocation['actionId']}",
                    "agents", "BLOCKED",
                    "This workflow invocation needs correlated runtime identity/tool evidence; "
                    "another invocation of the same agent does not cover this branch",
                )
        known_obligations = {check["id"] for check in report.checks}
        for item in latest_summaries:
            check_id = "agent-path:" + item["name"]
            if check_id not in known_obligations:
                report.add(check_id, "agents", "BLOCKED",
                           "Discovered hosted/sub-agent requires actual runtime identity and dependency evidence")
        for item in version_summaries:
            for reference in item["agentReferences"]:
                report.check(
                    f"agent:version-reference:{item['name']}:{item['version']}:{reference}",
                    "agents",
                    reference in deployed,
                    "Every version-pinned workflow reference must resolve to a deployed agent",
                )
        report.check("agent:workflow-reference-closure", "agents", references <= set(deployed),
                     "All deployed workflow sub-agent references resolve")
        report.check("agent:unexpected-deployed", "agents", not (unexpected - references),
                     "Deployed agents must be explained by provisioners, hosted service or workflow references")
        report.check("agent:missing-deployed", "agents", expected <= set(deployed),
                     "Every agent provisioner/hosted service must have a deployed agent")
        report.check("agent:source-deployed-closure", "agents", set(deployed) <= expected,
                     "Every deployed agent must have a classified source provisioner or hosted-service declaration")
        report.provenance["agentVersions"] = {
            item["name"]: item["version"] for item in latest_summaries
        }
        report.provenance["agentVersionInventorySha256"] = agent_version_inventory_sha256(
            version_summaries)
    report.guarded("infra:deployed-agents", "agents", agents)
    def revisions():
        services = {}
        identity = d.azure("identity", "show", "-g", d.group,
                           "-n", d.required("USER_MANAGED_IDENTITY_NAME"))
        mcp_configuration = None
        registry_server = d.required("AZURE_CONTAINER_REGISTRY_ENDPOINT")
        for key in ["SERVICE_API_NAME", "SERVICE_API_MCP_NAME",
                    "SERVICE_APP_ADMIN_NAME", "SERVICE_APP_MANUFACTURING_NAME", "SERVICE_MCP_INSPECTOR_NAME"]:
            app = d.azure("containerapp", "show", "-g", d.group, "-n", d.required(key))
            properties = app["properties"]
            services[key] = {"latestRevision": properties.get("latestRevisionName"),
                             "readyRevision": properties.get("latestReadyRevisionName")}
            report.check("revision:" + key, "infra",
                         bool(properties.get("latestReadyRevisionName")) and
                         properties.get("latestRevisionName") == properties.get("latestReadyRevisionName"),
                         "Latest deployed Container App revision is ready")
            report.check("acr:identity:" + key, "infra",
                         container_registry_identity_is_valid(app, identity["id"], registry_server),
                         "Container App image pulls use the selected runtime identity and ACR")
            if key in {"SERVICE_API_NAME", "SERVICE_API_MCP_NAME"}:
                configured = {item["name"]: item.get("value", "") for item in
                              properties["template"]["containers"][0].get("env", [])}
                attached = app.get("identity", {}).get("userAssignedIdentities", {})
                if key == "SERVICE_API_MCP_NAME":
                    mcp_configuration = configured
                report.check("identity:" + key, "infra",
                             identity["id"].lower() in {resource.lower() for resource in attached} and
                             configured.get("AZURE_CLIENT_ID") == identity["clientId"],
                             "Attached managed identity matches selected runtime credential")
                sql_key = "DATABASE_CONNECTION_STRING" if key == "SERVICE_API_NAME" else "ConnectionStrings__AdventureWorks"
                report.check("sql-config:" + key, "infra",
                             passwordless_sql(configured.get(sql_key)),
                             "SQL configuration uses Entra authentication without embedded credentials")
                if key == "SERVICE_API_NAME":
                    issuer = origin(d.required("API_MCP_URL"))
                    report.check("dab:deployed-issuer-audience", "infra",
                                 configured.get("DAB_JWT_ISSUER", "").rstrip("/") == issuer and
                                 configured.get("DAB_JWT_AUDIENCE", "").rstrip("/") ==
                                 d.values.get("DAB_RESOURCE_IDENTIFIER", issuer + "/dab").rstrip("/"),
                                 "DAB deployment validates selected issuer and dedicated audience")
                else:
                    report.check("mcp:keyvault-runtime-identity", "infra",
                                 configured.get("MCP_KEYVAULT_MANAGED_IDENTITY_CLIENT_ID") == identity["clientId"],
                                 "Key Vault signing provider uses the configured workload identity")
                    report.check("mcp:keyvault-signing-config", "infra",
                                 mcp_keyvault_configuration_is_valid(
                                     configured, d.required("MCP_SIGNING_KEY_VAULT_URI"),
                                     d.required("MCP_SIGNING_CERTIFICATE_NAME"), identity["clientId"]),
                                 "api-mcp uses the selected vault and certificate with the runtime identity")
        report.provenance["containerRevisions"] = services
        if mcp_configuration is None:
            raise EvidenceError("api-mcp runtime configuration was not discovered")
        try:
            trusted_principals = parse_principal_id_allowlist(
                mcp_configuration.get("MCP_TRUSTED_SERVICE_PRINCIPAL_IDS"))
            agents = fetch_agents(d)
            hosted = agents.get("manufacturing-agent", {})
            latest = hosted.get("versions", {}).get("latest", {})
            hosted_identity = latest.get("instance_identity", {})
            hosted_principal = hosted_identity.get("principal_id")
            required_principals = {str(uuid.UUID(identity["principalId"]))}
            hosted_identity_valid = (latest.get("definition", {}).get("kind") == "hosted" and
                                     isinstance(hosted_principal, str) and bool(hosted_principal.strip()))
            if hosted_identity_valid:
                required_principals.add(str(uuid.UUID(hosted_principal)))
        except (EvidenceError, ValueError, KeyError, TypeError) as error:
            raise EvidenceError("Cannot resolve exact runtime/hosted-agent api-mcp trust") from error
        report.check("infra:mcp-service-grant-trust", "infra",
                     hosted_identity_valid and required_principals == trusted_principals,
                     "api-mcp trusts exactly the selected runtime and hosted manufacturing-agent principals")
        account = d.azure("account", "show")
        report.check("infra:mcp-service-grant-tenant", "infra",
                     mcp_configuration.get("MCP_ENTRA_TENANT_ID") == account.get("tenantId"),
                     "api-mcp managed-identity assertion validation uses the selected tenant")
        report.inventory["mcpTrustedServicePrincipalCount"] = len(trusted_principals)
    report.guarded("infra:revisions", "infra", revisions)
    report.guarded("infra:functions-readiness", "infra",
                   lambda: functions_dependency_readiness(report, d))
    report.guarded("guest-cart:cleanup:telemetry", "infra",
                   lambda: guest_cart_cleanup_telemetry(report, d))
    for check_id, detail in [
            ("effective-sql-grants", "Current ARM inspection is not SQL permission evidence. "
             "Standalone --sql-only verifies shared runtime effective grants privately; "
             "all other principals, server grants and executable-module escalation remain separate obligations"),
            ("workload-data-plane", "Developer role discovery is not proof of actual workload data-plane access"),
            ("all-principal-edges", "Hosted/project/seed identities and assignment conditions need edge-by-edge verification"),
            ("local-auth-exceptions", "Mount/logging/deployment credentials need exact scoped exception verification")]:
        report.add("infra:" + check_id, "infra", "BLOCKED", detail)


def guest_cart_cleanup_telemetry(report, deployment):
    resources = deployment.azure("resource", "list", "--resource-group",
                                 deployment.required("AZURE_RESOURCE_GROUP"),
                                 "--resource-type", "Microsoft.Insights/components", "--query", "[].id")
    if (not isinstance(resources, list) or len(resources) != 1 or
            not isinstance(resources[0], str) or not resources[0]):
        raise EvidenceError("A unique selected-environment telemetry resource is required")
    result = deployment.azure(
        "monitor", "app-insights", "query", "--app", resources[0], "--analytics-query",
        "requests | where timestamp > ago(24h) | where name == 'CleanupExpiredGuestCarts' "
        "| summarize invocations=count(), successes=countif(success == true), "
        "failures=countif(success == false), latest=max(timestamp)")
    try:
        table, = result["tables"]
        row, = table["rows"]
        names = [column["name"] for column in table["columns"]]
        if names != ["invocations", "successes", "failures", "latest"] or len(row) != 4:
            raise ValueError("Unexpected aggregate columns")
        total, succeeded, failed, latest = row
        if (any(type(value) is not int or value < 0 for value in [total, succeeded, failed]) or
                succeeded + failed > total or (total == 0 and latest is not None)):
            raise ValueError("Invalid aggregate values")
        if total > 0:
            if not isinstance(latest, str):
                raise ValueError("Missing aggregate timestamp")
            # Kusto emits 100-ns ticks; Python 3.10 accepts only microseconds.
            normalized = re.sub(r"(\.\d{6})\d+(?=Z$)", r"\1", latest)
            if datetime.fromisoformat(normalized.replace("Z", "+00:00")).tzinfo is None:
                raise ValueError("Missing aggregate timezone")
    except (KeyError, TypeError, ValueError) as error:
        raise EvidenceError("Guest-cart timer telemetry has an unsupported aggregate shape") from error
    report.inventory["guestCartCleanupTimer"] = dict(zip(names, row))
    report.add("guest-cart:cleanup:timer-execution", "infra",
               "FAIL" if failed else "PASS" if succeeded else "BLOCKED",
               f"Last 24h sampled timer requests: total={total}, successful={succeeded}, failed={failed}. "
               "Only aggregate telemetry is read; no timer, SQL mutation or clock change is triggered. "
               "Successful invocation does not prove expired-row selection, batch size or deletion effects; "
               "missing samples are not proof the timer never ran.")


def load_auth_helper():
    spec = importlib.util.spec_from_file_location("azure_auth", ROOT / "scripts/utilities/azure-auth.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def internal_token_target(deployment, resource):
    if resource not in {"functions", "dab", "mcp"}:
        raise EvidenceError("Unsupported internal token resource")
    base = origin(deployment.required("API_MCP_URL"))
    override = deployment.values.get(resource.upper() + "_RESOURCE_IDENTIFIER", "")
    if not isinstance(override, str):
        raise EvidenceError("Invalid selected resource identifier")
    override = override.strip()
    if not override:
        return base, base + "/" + resource
    audience = override.rstrip("/")
    if not audience:
        raise EvidenceError("Invalid selected resource identifier")
    return base, audience


def persist_fixture_values(deployment, values):
    if getattr(deployment, "runtime", None):
        raise EvidenceError("Private job requires ready reusable consumers from the selected local azd environment")
    if not isinstance(deployment.environment, str) or not deployment.environment:
        raise EvidenceError("A pinned azd environment is required for reusable test credentials")
    entries = json_command(["azd", "env", "list", "--output", "json"])
    selected = [entry for entry in entries if entry.get("Name") == deployment.environment]
    if len(selected) != 1 or not selected[0].get("HasLocal"):
        raise EvidenceError("A unique local azd environment is required for reusable test credentials")
    entry = selected[0]
    path = Path(entry["DotEnvPath"]).resolve()
    if not path.is_relative_to(ROOT / ".azure") or path.stat().st_uid != os.getuid():
        raise EvidenceError("Refusing to persist fixture credentials outside the owned local azd state")
    command(["git", "check-ignore", "--quiet", "--", str(path)])
    path.chmod(0o600)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="auth-fixtures-",
                                         suffix=".env", delete=False) as handle:
            temporary = Path(handle.name)
            for key, value in values.items():
                handle.write(key + "=" + json.dumps(str(value)) + "\n")
        command(["azd", "env", "set", "--file", str(temporary),
                 "--environment", entry["Name"], "--no-prompt"])
        path.chmod(0o600)
        deployment.values.update({key: str(value) for key, value in values.items()})
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class ConsumerSession:
    scopes = "mcp.access realtime.connect products.read customers.read customers.write orders.read orders.write"

    def __init__(self, deployment, label, email, password, business_id=None):
        self.deployment, self.label = deployment, label
        self.email, self.password, self.business_id = email, password, business_id
        self.tokens = {}

    def exchange(self, resource, scopes=None):
        base = origin(self.deployment.required("API_MCP_URL"))
        audience = self.deployment.values.get(resource.upper() + "_RESOURCE_IDENTIFIER", base + "/" + resource)
        if resource == "mcp":
            bootstrap_scopes = (self.scopes if scopes is None else scopes) + " offline_access"
            status, _, body = self.exchange("functions", bootstrap_scopes)
            if status != 200:
                raise EvidenceError(f"Consumer {self.label}/mcp bootstrap authentication returned HTTP {status}")
            try:
                refresh = json.loads(body)["refresh_token"]
                if not isinstance(refresh, str) or not refresh:
                    raise ValueError("Missing refresh token")
            except (ValueError, KeyError, TypeError) as error:
                raise EvidenceError("Consumer MCP bootstrap returned no usable refresh token") from error
            return http("POST", base + "/token", form={
                "grant_type": "refresh_token", "client_id": "adventureworks-eshop",
                "refresh_token": refresh, "resource": audience})
        return http("POST", base + "/token", form={
            "grant_type": "urn:adventureworks:params:oauth:grant-type:eshop-credentials",
            "client_id": "adventureworks-eshop", "username": self.email, "password": self.password,
            "resource": audience, "scope": self.scopes if scopes is None else scopes})

    def token(self, resource, scopes=None):
        key = (resource, scopes)
        cached = self.tokens.get(key)
        if cached and cached[1] > time.monotonic() + 60:
            return cached[0]
        status, _, body = self.exchange(resource, scopes)
        if status != 200:
            raise EvidenceError(f"Consumer {self.label}/{resource} authentication returned HTTP {status}")
        try:
            document = json.loads(body)
            token = document["access_token"]
            if not isinstance(token, str):
                raise ValueError("Invalid access token")
            payload = token.split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            if not isinstance(claims, dict):
                raise ValueError("Invalid token metadata")
            owner = int(claims["business_entity_id"]) if resource != "mcp" else self.business_id
            base = origin(self.deployment.required("API_MCP_URL"))
            audience = self.deployment.values.get(resource.upper() + "_RESOURCE_IDENTIFIER", base + "/" + resource)
            audiences = claims.get("aud")
            valid = (isinstance(token, str) and claims.get("category") == "consumer" and
                     (audiences == audience or isinstance(audiences, list) and audience in audiences) and
                     owner is not None and owner > 0 and
                     (self.business_id is None or owner == self.business_id) and
                     type(document["expires_in"]) is int and document["expires_in"] > 60)
        except (ValueError, KeyError, TypeError, IndexError) as error:
            raise EvidenceError("Consumer authorization service returned invalid token metadata") from error
        if not valid:
            raise EvidenceError("Consumer token metadata does not match the retained fixture owner")
        # Metadata only schedules renewal; the actual APIs validate token signatures and authorization.
        self.business_id = owner
        self.tokens[key] = (token, time.monotonic() + document["expires_in"])
        return token


def consumer_fixtures(report, deployment):
    sessions = []
    for label in ["A", "B"]:
        prefix = "AUTH_TEST_CONSUMER_" + label + "_"
        email, password = (deployment.values.get(prefix + key) for key in ["EMAIL", "PASSWORD"])
        pending = deployment.values.get(prefix + "STATE") == "pending"
        if not email and not password:
            email = f"auth-{uuid.uuid4().hex[:16]}-{label.lower()}@example.invalid"
            password = secrets.token_urlsafe(32)
            persist_fixture_values(deployment, {prefix + "EMAIL": email, prefix + "PASSWORD": password,
                                                prefix + "STATE": "pending"})
            pending = True
        if not isinstance(email, str) or not isinstance(password, str) or not email or not password:
            raise EvidenceError("Reusable consumer fixture credentials are incomplete; no password was reset")
        saved = deployment.values.get(prefix + "BUSINESS_ENTITY_ID")
        if saved is not None and (not str(saved).isdigit() or int(saved) <= 0):
            raise EvidenceError("Retained consumer fixture has an invalid owner ID")
        session = ConsumerSession(deployment, label, email, password, int(saved) if saved else None)
        if pending:
            status, _, _ = session.exchange("functions")
            if status in {400, 401}:
                status, _, body = http("POST", https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/signup",
                                       data={"email": email, "password": password,
                                             "firstName": "AuthFixture", "lastName": label})
                report.check("fixture:consumer:" + label + ":signup", "fixtures", status == 201,
                             f"Dedicated demo consumer registration returned HTTP {status}; no email/order call")
                if status != 201:
                    raise EvidenceError("Consumer fixture creation was not confirmed; no signup retry attempted")
                try:
                    owner = json.loads(body)["businessEntityId"]
                except (ValueError, KeyError, TypeError) as error:
                    raise EvidenceError("Signup returned invalid fixture metadata") from error
                if type(owner) is not int or owner <= 0:
                    raise EvidenceError("Signup returned an invalid fixture owner")
                session.business_id = owner
            elif status != 200:
                raise EvidenceError(f"Pending consumer authentication returned HTTP {status}")
        session.token("functions")
        if pending or saved is None:
            persist_fixture_values(deployment, {prefix + "BUSINESS_ENTITY_ID": session.business_id,
                                                prefix + "STATE": "ready"})
        report.add("fixture:consumer:" + label, "fixtures", "PASS",
                   "Reusable dedicated consumer authenticated; credentials retained only in ignored local azd state")
        sessions.append(session)
    if sessions[0].business_id == sessions[1].business_id:
        raise EvidenceError("Consumer fixtures must resolve to distinct owners")
    report.inventory["consumerFixtures"] = [{"label": session.label, "businessEntityId": session.business_id,
                                             "retained": True} for session in sessions]
    return sessions


def retained_consumer_fixtures(report, deployment):
    for label in ["A", "B"]:
        prefix = "AUTH_TEST_CONSUMER_" + label + "_"
        if (deployment.values.get(prefix + "STATE") != "ready" or
                any(not deployment.values.get(prefix + key)
                    for key in ["EMAIL", "PASSWORD", "BUSINESS_ENTITY_ID"])):
            raise EvidenceError("Two ready retained consumer fixtures are required; no account was created")
    return consumer_fixtures(report, deployment)


def guest_expiry(value):
    if not isinstance(value, str):
        raise EvidenceError("Server returned invalid guest expiry")
    normalized = re.sub(r"(\.\d{6})\d+(?=Z|[+-]|$)", r"\1", value).replace("Z", "+00:00")
    try:
        expiry = datetime.fromisoformat(normalized)
        if expiry.tzinfo is None:
            raise ValueError("Missing timezone")
        return expiry.timestamp()
    except ValueError as error:
        raise EvidenceError("Server returned invalid guest expiry") from error


def valid_guest_session(session):
    return (isinstance(session, dict) and isinstance(session.get("token"), str) and
            re.fullmatch(r"[a-fA-F0-9]{64}", session["token"]) is not None and
            isinstance(session.get("cartId"), str) and
            re.fullmatch(r"guest-[a-f0-9]{32}", session["cartId"]) is not None and
            isinstance(session.get("expiresAt"), str))


def mcp_task_scope_denial(report, deployment, token, *, tool="get_business_stats",
                         required_scope="sales.read", check_id="mcp-task:scope-before-create", task=True):
    status, _, body = http(
        "POST", origin(deployment.required("API_MCP_URL")) + "/mcp", token=token,
        headers={"MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": tool},
        data={"jsonrpc": "2.0", "id": 43, "method": "tools/call", "params": {
            "name": tool, "arguments": {},
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {
                    "extensions": {"io.modelcontextprotocol/tasks": {}} if task else {}},
            },
        }})
    if status != 200:
        raise EvidenceError(f"MCP task-capable denial probe returned HTTP {status}")
    document = mcp_document(body)
    result = document.get("result")
    report.check(check_id, "live-denials",
                 document.get("jsonrpc") == "2.0" and document.get("id") == 43 and
                 "error" not in document and isinstance(result, dict) and
                 "taskId" not in result and result.get("isError") is True and
                 result.get("content") == [{
                     "type": "text",
                     "text": f"This operation requires the '{required_scope}' scope, which your account does not have.",
                 }],
                 "Resource-bound token receives the exact business-scope denial, not data or a task ID; "
                 f"SDK task capability={task}. Read-only tool only.")


def mcp_task_ownership_live(report, deployment, consumers):
    if len(consumers) != 2:
        raise EvidenceError("Task ownership verification requires two retained consumer identities")
    url = origin(deployment.required("API_MCP_URL")) + "/mcp"
    request_id = 100
    tasks = []
    report.inventory["mcpTaskFixtures"] = tasks

    def rpc(method, params, token, routing_name, timeout=30):
        nonlocal request_id
        request_id += 1
        status, _, body = http("POST", url, token=token, timeout=timeout, headers={
            "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, "Mcp-Name": routing_name,
        }, data={"jsonrpc": "2.0", "id": request_id, "method": method, "params": {
            **params, "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {
                    "extensions": {"io.modelcontextprotocol/tasks": {}}},
            },
        }})
        if status != 200:
            raise EvidenceError(f"Task ownership read-only-tool probe returned HTTP {status}")
        document = mcp_document(body)
        if (document.get("jsonrpc") != "2.0" or document.get("id") != request_id or
                ("result" in document) == ("error" in document)):
            raise EvidenceError("Task ownership probe returned an invalid protocol envelope")
        return document

    scopes = "mcp.access products.read"
    tokens = [consumer.token("mcp", scopes) for consumer in consumers]
    for index, consumer in enumerate(consumers):
        created = rpc("tools/call", {"name": "get_categories_with_products",
                                    "arguments": {"maxProductsPerSubcategory": 1}},
                      tokens[index], "get_categories_with_products")
        result = created.get("result")
        task_id = result.get("taskId") if isinstance(result, dict) else None
        if not isinstance(task_id, str) or re.fullmatch(r"[a-f0-9]{32}", task_id) is None:
            raise EvidenceError("Task creation was not confirmed; no creation retry was attempted")
        fixture = {"label": consumer.label, "taskId": task_id,
                   "retained": True, "purpose": "SQL-read-only catalogue task"}
        tasks.append(fixture)
        report.add(f"mcp-task:{consumer.label}:created", "live-allows", "PASS",
                   "Created one owned catalogue-read task through MCP; normal completed task history is retained")

        reduced = consumer.token("mcp", "mcp.access")
        for authority, token in [("other-owner", tokens[1 - index]), ("missing-scope", reduced)]:
            for method in ["tasks/get", "tasks/update", "tasks/cancel"]:
                document = rpc(method, {"taskId": task_id, "inputResponses": {}}, token, task_id)
                error = document.get("error")
                report.check(f"mcp-task:{consumer.label}:{authority}:{method}", "live-denials",
                             isinstance(error, dict) and error.get("message") == "Task is not available." and
                             error.get("code") == -32602 and "result" not in document,
                             "Wrong owner or reduced scope cannot read, supply input to, or cancel the task")

        deadline = time.monotonic() + 30
        while True:
            document = rpc("tasks/get", {"taskId": task_id}, tokens[index], task_id,
                           timeout=max(1, min(10, deadline - time.monotonic())))
            result = document.get("result")
            if not isinstance(result, dict) or result.get("taskId") != task_id:
                raise EvidenceError("The original scoped owner could not read the confirmed task")
            status = result.get("status")
            if status != "working" or time.monotonic() >= deadline:
                break
            time.sleep(2)
        fixture["status"] = status
        tool_result = result.get("result")
        content = tool_result.get("content") if isinstance(tool_result, dict) else None
        complete = (status == "completed" and isinstance(tool_result, dict) and
                    (tool_result.get("isError") is None or tool_result.get("isError") is False) and
                    isinstance(content, list) and len(content) == 1 and
                    isinstance(content[0], dict) and content[0].get("type") == "text" and
                    isinstance(content[0].get("text"), str) and
                    content[0]["text"].startswith("AdventureWorks Product Catalogue") and
                    re.search(r"\bProductID=[1-9][0-9]*:", content[0]["text"]) is not None)
        report.check(f"mcp-task:{consumer.label}:completed", "live-allows", complete,
                     "The original scoped owner reads completed catalogue output after all foreign control denials; "
                     "only bounded protocol status reads, no application polling feature")


def no_positive_product_inventory(dab, product_id):
    product_filter = f"ProductID eq {product_id}"
    query = urllib.parse.urlencode({
        "$first": "100", "$filter": product_filter, "$select": "ProductID,LocationID,Quantity",
    })
    url = dab + "/api/ProductInventory?" + query
    seen = set()
    for _ in range(10):
        if url in seen:
            raise EvidenceError("Inventory fixture pagination repeated a cursor")
        seen.add(url)
        status, _, raw = http("GET", url)
        try:
            document = json.loads(raw)
        except ValueError as error:
            raise EvidenceError("Inventory fixture read returned invalid JSON") from error
        items = document.get("value") if isinstance(document, dict) else None
        if (status != 200 or not isinstance(items, list) or len(items) > 100 or
                any(not isinstance(item, dict) or type(item.get("ProductID")) is not int or
                    item["ProductID"] != product_id or
                    type(item.get("LocationID")) is not int or item["LocationID"] <= 0 or
                    type(item.get("Quantity")) is not int or item["Quantity"] < 0 for item in items)):
            raise EvidenceError("Inventory fixture read returned invalid rows")
        if any(item["Quantity"] > 0 for item in items):
            return False
        next_link = document.get("nextLink")
        if next_link is None:
            return True
        if not isinstance(next_link, str) or not next_link:
            raise EvidenceError("Inventory fixture returned an invalid continuation link")
        url = urllib.parse.urljoin(dab + "/", next_link)
        parsed = urllib.parse.urlsplit(url)
        parameters = urllib.parse.parse_qs(parsed.query)
        if (f"{parsed.scheme}://{parsed.netloc}" != dab or parsed.path != "/api/ProductInventory" or
                parsed.fragment or parameters.get("$filter") != [product_filter]):
            raise EvidenceError("Inventory fixture cursor escaped its reviewed DAB query")
    raise EvidenceError("Inventory fixture pagination exceeded its bounded page count")


def out_of_stock_finished_product(deployment):
    dab = origin(deployment.required("API_URL"))
    query = urllib.parse.urlencode({
        "$first": "10", "$filter": "FinishedGoodsFlag eq true", "$select": "ProductID,FinishedGoodsFlag",
    })
    status, _, raw = http("GET", dab + "/api/Product?" + query)
    try:
        document = json.loads(raw)
    except ValueError as error:
        raise EvidenceError("Finished-product fixture read returned invalid JSON") from error
    products = document.get("value") if isinstance(document, dict) else None
    if (status != 200 or not isinstance(products, list) or not products or len(products) > 10 or
            any(not isinstance(item, dict) or type(item.get("ProductID")) is not int or
                item["ProductID"] <= 0 or item.get("FinishedGoodsFlag") is not True for item in products) or
            len({item["ProductID"] for item in products}) != len(products)):
        raise EvidenceError("No valid finished-product fixture page was returned")
    for product in products:
        product_id = product["ProductID"]
        if no_positive_product_inventory(dab, product_id):
            return product_id
    raise EvidenceError("No finished product without positive inventory was found in the bounded fixture page")


def out_of_stock_product_still_valid(deployment, product_id):
    dab = origin(deployment.required("API_URL"))
    query = urllib.parse.urlencode({"$select": "ProductID,FinishedGoodsFlag"})
    status, _, raw = http("GET", f"{dab}/api/Product/ProductID/{product_id}?{query}")
    try:
        document = json.loads(raw)
    except ValueError as error:
        raise EvidenceError("Finished-product recheck returned invalid JSON") from error
    items = document.get("value") if isinstance(document, dict) else None
    if (status != 200 or not isinstance(items, list) or len(items) > 1 or
            document.get("nextLink") is not None or
            any(not isinstance(item, dict) or type(item.get("ProductID")) is not int or
                item["ProductID"] != product_id or type(item.get("FinishedGoodsFlag")) is not bool for item in items)):
        raise EvidenceError("Finished-product recheck returned invalid evidence")
    return bool(items) and items[0]["FinishedGoodsFlag"] and no_positive_product_inventory(dab, product_id)


def customer_availability_out_of_stock(report, deployment, consumers, call):
    product_id = out_of_stock_finished_product(deployment)
    responses = []
    for consumer in consumers:
        denied, text = call("get_product_availability",
                            consumer.token("mcp", "mcp.access products.read"), {"productId": product_id})
        responses.append((consumer.label, denied, text))
    if not out_of_stock_product_still_valid(deployment, product_id):
        raise EvidenceError("The out-of-stock fixture changed during the MCP checks; no result was credited")
    report.add("mcp-consumer:out-of-stock:oracle", "live-allows", "PASS",
               "Independent DAB reads before and after the MCP calls found a finished product without "
               "positive inventory at any location; no product data is exported")
    for label, denied, text in responses:
        try:
            availability = json.loads(text[0])
        except ValueError:
            availability = None
        report.check(f"mcp-consumer:{label}:availability-out-of-stock", "live-allows",
                     not denied and isinstance(availability, dict) and
                     set(availability) == {"productId", "inStock"} and
                     type(availability["productId"]) is int and availability["productId"] == product_id and
                     availability["inStock"] is False,
                     "A products-only consumer receives the independently verified out-of-stock boolean")


def consumer_mcp_tool_call(url, name, token, arguments, request_id):
    status, _, body = http("POST", url, token=token,
                           data={"jsonrpc": "2.0", "id": request_id, "method": "tools/call",
                                 "params": {"name": name, "arguments": arguments}})
    if status != 200:
        raise EvidenceError(f"Consumer MCP read-only probe returned HTTP {status}")
    document = mcp_document(body)
    result = document.get("result")
    if (document.get("jsonrpc") != "2.0" or document.get("id") != request_id or
            "error" in document or not isinstance(result, dict) or
            not isinstance(result.get("content"), list)):
        raise EvidenceError("Consumer MCP probe returned an invalid tool-result envelope")
    content = result["content"]
    if (len(content) != 1 or not isinstance(content[0], dict) or
            content[0].get("type") != "text" or not isinstance(content[0].get("text"), str) or
            result.get("isError") is not None and type(result["isError"]) is not bool):
        raise EvidenceError("Consumer MCP probe returned an unsupported tool-result shape")
    return result.get("isError") is True, [content[0]["text"]]


def consumer_mcp_owner_denials(report, deployment, consumers):
    url = origin(deployment.required("API_MCP_URL")) + "/mcp"
    request_id = 0
    available_products = {}

    def call(name, token, arguments):
        nonlocal request_id
        request_id += 1
        return consumer_mcp_tool_call(url, name, token, arguments, request_id)

    for consumer in consumers:
        for task in [False, True]:
            mcp_task_scope_denial(
                report, deployment, consumer.token("mcp", "mcp.access products.read"),
                tool="get_personalized_recommendations", required_scope="orders.read",
                check_id=f"mcp-personalized:{consumer.label}:products-only:{task}", task=task)
        missing_scope = consumer.token("mcp", "mcp.access")
        scoped = consumer.token("mcp")
        denied, text = call("get_categories_with_products", scoped, {"maxProductsPerSubcategory": 1})
        product = (re.search(r"\bProductID=([1-9][0-9]*):", text[0])
                   if not denied and text[0].startswith("AdventureWorks Product Catalogue") else None)
        report.check(f"mcp-consumer:{consumer.label}:catalogue", "live-allows", product is not None,
                     "Issued consumer MCP token reads actual in-stock catalogue rows through the SQL-backed tool")
        if product is None:
            report.add(f"mcp-consumer:{consumer.label}:availability", "live-allows", "BLOCKED",
                       "A real in-stock finished product is required for the availability positive control")
            product_id = 0
        else:
            product_id = int(product.group(1))
            denied, text = call("get_product_availability",
                                consumer.token("mcp", "mcp.access products.read"), {"productId": product_id})
            try:
                availability = json.loads(text[0])
            except ValueError:
                availability = None
            valid = (not denied and isinstance(availability, dict) and
                     set(availability) == {"productId", "inStock"} and
                     type(availability["productId"]) is int and availability["productId"] == product_id and
                     availability["inStock"] is True)
            report.check(f"mcp-consumer:{consumer.label}:availability", "live-allows", valid,
                         "A products-only consumer receives the SQL-backed in-stock result without quantity or location")
            if valid:
                available_products[consumer.label] = product_id
        denied, text = call("get_product_availability",
                            consumer.token("mcp", "mcp.access products.read"), {"productId": 0})
        try:
            missing = json.loads(text[0])
        except ValueError:
            missing = None
        report.check(f"mcp-consumer:{consumer.label}:availability-missing", "live-allows",
                     not denied and isinstance(missing, dict) and set(missing) == {"productId", "inStock"} and
                     type(missing["productId"]) is int and missing["productId"] == 0 and
                     missing["inStock"] is None,
                     "A nonexistent finished product returns a null availability without inventory details")
        denied, text = call("get_product_availability", missing_scope, {"productId": product_id})
        report.check(f"mcp-consumer:{consumer.label}:availability-scope", "live-denials",
                     denied and text == [
                         "This operation requires the 'products.read' scope, which your account does not have."],
                     "A token without products.read cannot dispatch customer availability")
        denied, text = call("check_inventory_availability", scoped, {"productId": product_id})
        report.check(f"mcp-consumer:{consumer.label}:inventory-details", "live-denials",
                     denied and text == [
                         "This operation requires the 'inventory.read' scope, which your account does not have."],
                     "The detailed inventory tool remains unavailable to consumers")
        denied, text = call("search_customers", scoped, {"searchTerm": "AuthFixture"})
        report.check(f"mcp-consumer:{consumer.label}:internal-category", "live-denials",
                     denied and text == ["This operation is restricted to internal users."],
                     "Consumer with customers.read still cannot dispatch an internal customer search")
        for tool, scope in [
            ("get_customer_orders", "orders.read"),
            ("get_order_details", "orders.read"),
            ("get_personalized_recommendations", "orders.read"),
        ]:
            base_arguments = {"orderId": 0} if tool == "get_order_details" else {}
            denied, text = call(tool, missing_scope, base_arguments)
            report.check(f"mcp-consumer:{consumer.label}:{tool}:scope", "live-denials",
                         denied and text == [
                             f"This operation requires the '{scope}' scope, which your account does not have."],
                         "Issued consumer MCP token without the business scope is denied by dispatch")
            for label, value in [
                ("foreign-zero", 0), ("malformed-string", "invalid"),
                ("malformed-array", [0]), ("malformed-object", {"id": 0}),
            ]:
                denied, text = call(tool, scoped, {**base_arguments, "customerId": value})
                check_id = f"mcp-consumer:{consumer.label}:{tool}:{label}"
                if denied and text == ["No customer profile is associated with your account."]:
                    report.add(check_id, "live-denials", "BLOCKED",
                               "Retained consumer has no Customer profile; its earlier profile denial "
                               "does not prove the owner-argument boundary. No SQL fixture was created.")
                else:
                    report.check(check_id, "live-denials",
                                 denied and text == ["You can only access your own records."],
                                 "Malformed or foreign consumer owner is denied with the exact ownership decision")
    report.guarded("mcp-consumer:out-of-stock:scenario", "live-allows",
                   lambda: customer_availability_out_of_stock(report, deployment, consumers, call))
    return available_products


def tracked_fixture_write(ledger, bucket, operation, save, request):
    attempt = {"operation": operation, "state": "pending"}
    ledger.setdefault(bucket, []).append(attempt)
    save()
    try:
        response = request()
    except EvidenceError:
        attempt["state"] = "uncertain"
        save()
        raise
    status = response[0]
    terminal_statuses = {200, 201, 204, 400, 401, 403, 404, 409}
    attempt.update({"state": "responded" if status in terminal_statuses else "uncertain", "httpStatus": status})
    save()
    return response


def consumer_cart_live(report, deployment, consumers):
    base = https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/cart"
    dab = origin(deployment.required("API_URL"))
    a, b = consumers
    guests, before = [], {}
    product = None
    ledger = {"runId": report.output.name, "accounts": [
        {"label": user.label, "businessEntityId": user.business_id} for user in consumers], "guests": []}
    path = report.output / "consumer-cart-ledger.json"

    def save():
        path.write_text(json.dumps(ledger, indent=2) + "\n")

    def require(name, condition, detail, group="ownership"):
        report.check("consumer-cart:" + name, group, condition, detail)
        if not condition:
            raise EvidenceError("Consumer cart scenario stopped after a failed assertion")

    def call(method, route, user=None, data=None, guest=None, expected=None, scopes=None):
        headers = {"X-Guest-Cart-Session": guest["token"]} if guest else {}
        token = user.token("functions", scopes) if user else None
        url = base + route
        if expected is not None:
            url += "?" + urllib.parse.urlencode({"cartId": expected})

        def request():
            status, _, body = http(method, url, token=token, headers=headers, data=data)
            try:
                return status, json.loads(body)
            except ValueError as error:
                raise EvidenceError("Consumer cart endpoint returned invalid JSON") from error

        operation = "/items/{item}" if route.startswith("/items/") else route
        try:
            if user and method in {"POST", "PATCH", "DELETE"}:
                return tracked_fixture_write(ledger, "accountWrites", f"{user.label} {method} {operation}",
                                             save, request)
            return request()
        except EvidenceError as error:
            raise EvidenceError(f"Consumer cart {method} {operation}: {error}") from error

    def uncertain_account_write():
        return any(item["state"] != "responded" for item in ledger.get("accountWrites", []))

    def rows(user):
        status, items = call("GET", "/items", user, expected=str(user.business_id))
        if (status != 200 or not isinstance(items, list) or
                any(not isinstance(item, dict) or item.get("ShoppingCartID") != str(user.business_id) or
                    type(item.get("ShoppingCartItemID")) is not int or type(item.get("ProductID")) is not int
                    for item in items)):
            raise EvidenceError("Consumer cart snapshot did not return exclusively owned rows")
        return items

    def current(user):
        return [item for item in rows(user) if item["ProductID"] == product]

    def line(user):
        items = current(user)
        if len(items) != 1 or type(items[0].get("Quantity")) is not int:
            raise EvidenceError("Expected one owned consumer fixture line; no mutation was guessed")
        return items[0]

    def guest(label, quantity):
        entry = {"label": label, "issuance": "pending", "retired": False, "cleanupEligible": False}
        ledger["guests"].append(entry)
        save()
        status, session = call("POST", "/session")
        require("guest-issued-" + label, status == 200 and valid_guest_session(session),
                "Issued an isolated guest capability for the merge transaction test", "live-allows")
        entry.update({"cartId": session["cartId"], "expiresAt": session["expiresAt"], "issuance": "confirmed"})
        guests.append((session, entry))
        save()
        status, items = call("GET", "/items", guest=session, expected=session["cartId"])
        require("guest-empty-" + label, status == 200 and items == [], "Fresh guest cart is empty before mutation")
        entry["cleanupEligible"] = True
        save()
        status, item = call("POST", "/items", data={"ProductID": product, "Quantity": quantity},
                            guest=session, expected=session["cartId"])
        require("guest-added-" + label, status == 200 and isinstance(item, dict) and
                item.get("ShoppingCartID") == session["cartId"] and item.get("Quantity") == quantity,
                "Only the isolated guest fixture was populated")
        return session, entry

    save()
    try:
        before = {user.label: rows(user) for user in consumers}
        used = {item["ProductID"] for items in before.values() for item in items}
        url = dab + "/api/Product?$first=100"
        seen = set()
        for _ in range(20):
            if url in seen:
                raise EvidenceError("Product fixture pagination repeated a cursor")
            seen.add(url)
            status, _, body = http("GET", url)
            try:
                document = json.loads(body)
            except ValueError as error:
                raise EvidenceError("Product fixture pagination returned invalid JSON") from error
            items = document.get("value") if isinstance(document, dict) else None
            if status != 200 or not isinstance(items, list):
                raise EvidenceError("Cannot discover an isolated public product fixture")
            candidates = [item["ProductID"] for item in items if isinstance(item, dict) and
                          type(item.get("ProductID")) is int and item["ProductID"] > 0 and item["ProductID"] not in used]
            if candidates:
                product = candidates[0]
                break
            next_link = document.get("nextLink")
            if not isinstance(next_link, str):
                break
            url = urllib.parse.urljoin(dab + "/", next_link)
            parsed = urllib.parse.urlsplit(url)
            if f"{parsed.scheme}://{parsed.netloc}" != dab or parsed.path != "/api/Product":
                raise EvidenceError("Product fixture cursor escaped the trusted DAB endpoint")
        if product is None:
            raise EvidenceError("No unused product available within bounded catalog pagination")
        ledger["productId"] = product
        save()
        line_ids = {}
        for user, quantity in [(a, 2), (b, 4)]:
            status, item = call("POST", "/items", user, {"ProductID": product, "Quantity": quantity},
                                expected=str(user.business_id))
            require("add-" + user.label, status == 200 and isinstance(item, dict) and
                    item.get("ShoppingCartID") == str(user.business_id) and item.get("Quantity") == quantity and
                    type(item.get("ShoppingCartItemID")) is int, "Authenticated consumer created only its own fixture",
                    "live-allows")
            line_ids[user.label] = item["ShoppingCartItemID"]
        status, _ = call("GET", "/items", a, expected=str(b.business_id))
        require("other-owner", status == 403, f"Other account cart denied with HTTP {status}", "live-denials")
        for method, data in [("PATCH", {"Quantity": 9}), ("DELETE", None)]:
            status, _ = call(method, "/items/" + str(line_ids[b.label]), a, data, expected=str(a.business_id))
            require("other-item-" + method, status == 404, f"Other account line denied with HTTP {status}", "live-denials")
        for role in ["authenticated", "consumer"]:
            for user, owner, expected_count in [(a, a.business_id, 1), (a, b.business_id, 0)]:
                query = urllib.parse.urlencode({"$filter": f"ShoppingCartID eq '{owner}' and ProductID eq {product}"})
                status, _, body = http("GET", dab + "/api/ShoppingCartItem?" + query,
                                       token=user.token("dab"), headers={"X-MS-API-ROLE": role})
                try:
                    document = json.loads(body)
                except ValueError as error:
                    raise EvidenceError("DAB consumer cart read returned invalid JSON") from error
                items = document.get("value") if isinstance(document, dict) else None
                require("dab-" + role + "-" + str(expected_count), status == 200 and
                        isinstance(items, list) and len(items) == expected_count and
                        all(isinstance(item, dict) and item.get("ShoppingCartID") == str(user.business_id)
                            for item in items),
                        "DAB read policy returns own data and filters the other consumer", "live-allows")
        status, _ = call("GET", "/items", a, expected=str(a.business_id), scopes="orders.read")
        require("read-scope-allow", status == 200, "Real read-only consumer token can read its cart", "live-allows")
        status, _ = call("POST", "/items", a, {"ProductID": product, "Quantity": 1},
                         expected=str(a.business_id), scopes="orders.read")
        require("read-scope-cannot-write", status == 403, "Real missing-write-scope token cannot mutate",
                "live-denials")
        require("denials-preserve-both", line(a)["Quantity"] == 2 and line(b)["Quantity"] == 4,
                "Denied calls changed neither fixture")
        merge, merge_entry = guest("merge", 3)
        status, _ = call("POST", "/merge", b, guest=merge, expected=str(a.business_id))
        require("merge-account-switch", status == 403, "Stale account assertion cannot merge into another user",
                "live-denials")
        status, result = call("POST", "/merge", a, guest=merge, expected=str(a.business_id))
        require("merge-success", status == 200 and isinstance(result, dict) and result.get("merged") is True,
                "Real consumer merge committed", "live-allows")
        require("merge-combines", line(a)["Quantity"] == 5,
                "Account and guest quantities combined into exactly one line")
        status, _ = call("GET", "/items", guest=merge, expected=merge["cartId"])
        require("merged-proof-retired", status == 401, "Committed merge retires guest access", "live-denials")
        merge_entry["retired"] = True
        save()
        status, result = call("POST", "/merge", a, guest=merge, expected=str(a.business_id))
        require("merge-retry-idempotent", status == 200 and isinstance(result, dict) and
                result.get("merged") is True and line(a)["Quantity"] == 5,
                "Same-account retry does not add guest quantities twice")
        status, _ = call("POST", "/merge", b, guest=merge, expected=str(b.business_id))
        require("merge-retry-other-account", status == 401 and line(b)["Quantity"] == 4,
                "Retired proof cannot be reused by the other consumer", "live-denials")
        overflow, _ = guest("overflow", 1)
        status, _ = call("PATCH", "/items/" + str(line(a)["ShoppingCartItemID"]), a,
                         {"Quantity": 32767}, expected=str(a.business_id))
        require("overflow-boundary", status == 200, "Prepared only the owned quantity-boundary fixture")
        status, _ = call("POST", "/merge", a, guest=overflow, expected=str(a.business_id))
        require("overflow-rollback", status == 409 and line(a)["Quantity"] == 32767,
                "Overflow rejected without modifying the account cart")
        status, items = call("GET", "/items", guest=overflow, expected=overflow["cartId"])
        require("overflow-preserves-guest", status == 200 and isinstance(items, list) and len(items) == 1 and
                isinstance(items[0], dict) and items[0].get("Quantity") == 1,
                "Failed merge preserves guest data and a usable proof")
    finally:
        for index, (session, entry) in enumerate(guests):
            if entry["retired"]:
                report.add("consumer-cart:guest-cleanup:" + str(index), "cleanup", "PASS",
                           "Guest already retired by the verified committed merge")
                continue
            if uncertain_account_write():
                report.add("consumer-cart:guest-cleanup:" + str(index), "cleanup", "FAIL",
                           "A consumer write may still be in flight; guest retirement was not raced.")
                continue
            try:
                if not entry["cleanupEligible"]:
                    raise EvidenceError("Fresh empty guest ownership was not proven; refusing retirement")
                status, result = call("DELETE", "/session", guest=session)
                entry["retired"] = status == 200 and isinstance(result, dict) and result.get("retired") is True
                report.check("consumer-cart:guest-cleanup:" + str(index), "cleanup", entry["retired"],
                             f"Exact merge-test guest retirement returned HTTP {status}")
            except EvidenceError as error:
                report.add("consumer-cart:guest-cleanup:" + str(index), "cleanup", "FAIL", str(error))
            finally:
                save()
        for user in consumers:
            if product is None or user.label not in before:
                continue
            if uncertain_account_write():
                report.add("consumer-cart:cleanup:" + user.label, "cleanup", "FAIL",
                           "A consumer write may still be in flight; exact fixture cleanup was not raced.")
                continue
            try:
                for item in current(user):
                    status, result = call("DELETE", "/items/" + str(item["ShoppingCartItemID"]), user,
                                          expected=str(user.business_id))
                    if status != 200 or not isinstance(result, dict) or result.get("deleted") is not True:
                        raise EvidenceError("Owned consumer fixture deletion was not confirmed")
                report.check("consumer-cart:cleanup:" + user.label, "cleanup",
                             sorted(rows(user), key=lambda item: item["ShoppingCartItemID"]) ==
                             sorted(before[user.label], key=lambda item: item["ShoppingCartItemID"]),
                             "Deleted only the run's isolated product; all pre-existing cart rows preserved")
            except EvidenceError as error:
                report.add("consumer-cart:cleanup:" + user.label, "cleanup", "FAIL", str(error))
        if any(entry["issuance"] != "confirmed" for entry in ledger["guests"]):
            report.add("consumer-cart:unknown-guest-issuance", "cleanup", "FAIL",
                       "A possible empty guest session has no confirmed proof and must expire")


def guest_cart_live(report, deployment):
    base = https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/cart"
    dab = origin(deployment.required("API_URL"))
    sessions = []
    ledger = {"runId": report.output.name, "sessions": [], "bootstrapAttempts": []}
    ledger_path = report.output / "guest-cart-ledger.json"

    def save():
        ledger_path.write_text(json.dumps(ledger, indent=2) + "\n")

    def require(name, condition, detail, group="ownership"):
        report.check("guest-cart:" + name, group, condition, detail)
        if not condition:
            raise EvidenceError("Guest-cart scenario stopped after a failed assertion")

    def call(method, path, session=None, data=None, expected=None, extra=None):
        headers = dict(extra or {})
        if session:
            headers["X-Guest-Cart-Session"] = session["token"]
        url = base + path
        if expected:
            url += "?" + urllib.parse.urlencode({"cartId": expected})
        status, _, body = http(method, url, headers=headers, data=data)
        try:
            document = json.loads(body)
        except ValueError as error:
            raise EvidenceError("Cart endpoint returned invalid JSON") from error
        return status, document

    save()
    try:
        status, _, body = http("GET", dab + "/api/Product?$first=1")
        try:
            products = json.loads(body).get("value", [])
        except (ValueError, AttributeError) as error:
            raise EvidenceError("Cart product fixture lookup returned invalid JSON") from error
        if status != 200 or not products or not isinstance(products[0].get("ProductID"), int):
            raise EvidenceError("No existing public product is available for isolated cart fixtures")
        product = products[0]["ProductID"]
        for label in ["a", "b"]:
            attempt = {"label": label, "response": "pending"}
            ledger["bootstrapAttempts"].append(attempt)
            save()
            before = datetime.now(timezone.utc).timestamp()
            status, session = call("POST", "/session")
            after = datetime.now(timezone.utc).timestamp()
            attempt.update({"response": "received", "httpStatus": status})
            save()
            valid = status == 200 and valid_guest_session(session)
            require("bootstrap-" + label, bool(valid), "Server issued a well-formed isolated guest capability", "live-allows")
            entry = {"cartId": session["cartId"], "expiresAt": session["expiresAt"],
                     "retired": False, "cleanupEligible": False}
            sessions.append((session, entry))
            ledger["sessions"].append(entry)
            attempt["response"] = "validated"
            save()
            expiry = guest_expiry(session["expiresAt"])
            require("one-day-" + label, before + 86400 - 10 <= expiry <= after + 86400 + 10,
                    "Fixed expiry is one day from issuance (10 seconds clock-skew tolerance)")
            status, items = call("GET", "/items", session, expected=session["cartId"])
            require("initial-empty-" + label, status == 200 and items == [],
                    "Newly issued cart is empty before any fixture mutation")
            entry["cleanupEligible"] = True
            save()
        a, b = sessions[0][0], sessions[1][0]
        require("distinct-sessions", a["cartId"] != b["cartId"] and a["token"] != b["token"],
                "Two independent capabilities resolve different carts")
        lines = []
        for label, session, quantity in [("a", a, 2), ("b", b, 4)]:
            status, item = call("POST", "/items", session, {"ProductID": product, "Quantity": quantity}, session["cartId"])
            require("add-" + label, status == 200 and isinstance(item, dict) and
                    item.get("ShoppingCartID") == session["cartId"] and item.get("Quantity") == quantity and
                    item.get("ProductID") == product and isinstance(item.get("ShoppingCartItemID"), int),
                    "Created only a run-owned cart item", "live-allows")
            lines.append(item["ShoppingCartItemID"])
        for label, session, extra, expected in [
                ("missing-proof", None, {}, None),
                ("forged-proof", {"token": uuid.uuid4().hex + uuid.uuid4().hex}, {}, None),
                ("invalid-bearer-no-downgrade", a, {"Authorization": "Bearer invalid-cart-test-token"}, a["cartId"])]:
            status, _ = call("GET", "/items", session, expected=expected, extra=extra)
            require(label, status == 401, f"Unauthorized cart read denied with HTTP {status}", "live-denials")
        status, _ = call("GET", "/items", a, expected=b["cartId"])
        require("cross-cart", status == 403, f"Other cart ID denied with HTTP {status}", "live-denials")
        for method, data in [("PATCH", {"Quantity": 9}), ("DELETE", None)]:
            status, _ = call(method, "/items/" + str(lines[1]), a, data, a["cartId"])
            require("cross-item-" + method, status == 404, f"Other cart item denied with HTTP {status}", "live-denials")
        status, items = call("GET", "/items", b, expected=b["cartId"])
        require("denials-preserve-other-cart", status == 200 and isinstance(items, list) and len(items) == 1 and
                isinstance(items[0], dict) and items[0].get("Quantity") == 4,
                "Cross-owner denial attempts did not alter the other run-owned cart")
        for method, path, data in [
                ("GET", "/api/ShoppingCartItem?" + urllib.parse.urlencode({
                    "$filter": "ShoppingCartID eq '" + b["cartId"] + "'", "$first": 1}), None),
                ("POST", "/api/ShoppingCartItem", {"ShoppingCartID": b["cartId"], "ProductID": product, "Quantity": 1}),
                ("PATCH", "/api/ShoppingCartItem/ShoppingCartItemID/" + str(lines[1]), {"Quantity": 9}),
                ("DELETE", "/api/ShoppingCartItem/ShoppingCartItemID/" + str(lines[1]), None)]:
            request = lambda: http(method, dab + path, data=data)
            status, _, _ = (request() if method == "GET" else
                            tracked_fixture_write(ledger, "dabWrites", method + " cart", save, request))
            require("dab-anonymous-" + method, status in {401, 403},
                    f"Anonymous DAB cart {method} denied with HTTP {status}", "live-denials")
        status, items = call("GET", "/items", b, expected=b["cartId"])
        require("dab-denials-preserve-cart", status == 200 and isinstance(items, list) and len(items) == 1 and
                isinstance(items[0], dict) and items[0].get("Quantity") == 4,
                "DAB denial attempts did not change their exact run-owned fixture")
        for quantity in [0, 32768]:
            status, _ = call("POST", "/items", a, {"ProductID": product, "Quantity": quantity}, a["cartId"])
            require("quantity-" + str(quantity), status == 400, f"Out-of-range quantity denied with HTTP {status}")
        status, item = call("PATCH", "/items/" + str(lines[0]), a, {"Quantity": 3}, a["cartId"])
        require("update-own", status == 200 and isinstance(item, dict) and item.get("Quantity") == 3,
                "Own quantity update persisted", "live-allows")
        status, item = call("POST", "/items", a, {"ProductID": product, "Quantity": 2}, a["cartId"])
        require("combine-product", status == 200 and isinstance(item, dict) and item.get("Quantity") == 5,
                "Repeated adds combine quantities on the server", "live-allows")
        status, items = call("GET", "/items", a, expected=a["cartId"])
        require("read-own", status == 200 and isinstance(items, list) and len(items) == 1 and
                isinstance(items[0], dict) and items[0].get("Quantity") == 5,
                "Persisted cart has one coalesced line with the exact total quantity", "live-allows")
    finally:
        for index, (session, entry) in enumerate(sessions):
            if any(item["state"] != "responded" for item in ledger.get("dabWrites", [])):
                report.add("guest-cart:cleanup:" + str(index), "cleanup", "FAIL",
                           "A DAB cart write may still be in flight; guest retirement was not raced.")
                continue
            if not entry["cleanupEligible"]:
                report.add("guest-cart:cleanup:" + str(index), "cleanup", "FAIL",
                           "Refusing retirement: a fresh empty fixture was not proven; expiry cleanup remains required")
                continue
            try:
                status, result = call("DELETE", "/session", session)
                confirmed = status == 200 and isinstance(result, dict) and result.get("retired") is True
                report.check("guest-cart:cleanup:" + str(index), "cleanup", confirmed,
                             f"Exact run-owned guest cart retirement returned HTTP {status}")
                entry["retired"] = confirmed
                if confirmed:
                    status, _ = call("GET", "/items", session, expected=session["cartId"])
                    report.check("guest-cart:retired-proof:" + str(index), "live-denials", status == 401,
                                 f"Retired capability rejected with HTTP {status}")
            except EvidenceError as error:
                report.add("guest-cart:cleanup-error:" + str(index), "cleanup", "FAIL", str(error))
            finally:
                save()
        if any(attempt["response"] != "validated" for attempt in ledger["bootstrapAttempts"]):
            report.add("guest-cart:unconfirmed-bootstrap", "cleanup", "FAIL",
                       "Bootstrap outcome was unconfirmed; no POST retry attempted. A possible empty session must expire.")
    report.add("guest-cart:expiry-cleanup", "ownership", "BLOCKED",
               "Live clock-advance and bounded expiry-timer execution are not yet proven")


def guest_cart_browser(report, deployment, consumer=None, other_consumer=None):
    app = deployment.azure("staticwebapp", "show", "--name", deployment.required("SERVICE_APP_NAME"),
                           "--resource-group", deployment.required("AZURE_RESOURCE_GROUP"))
    hostname = app.get("defaultHostname")
    if not isinstance(hostname, str) or not hostname:
        raise EvidenceError("Cannot discover deployed storefront hostname")
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith("AUTH_BROWSER_CONSUMER_")}
    environment["AUTH_BROWSER_SITE_URL"] = https_url("https://" + hostname)
    environment["API_FUNCTIONS_URL"] = https_url(deployment.required("API_FUNCTIONS_URL"))
    environment["API_URL"] = https_url(deployment.required("API_URL"))
    environment["API_MCP_URL"] = https_url(deployment.required("API_MCP_URL"))
    if consumer is not None:
        consumer.tokens.pop(("functions", None), None)
        environment.update({
            "AUTH_BROWSER_CONSUMER_EMAIL": consumer.email,
            "AUTH_BROWSER_CONSUMER_PASSWORD": consumer.password,
            "AUTH_BROWSER_CONSUMER_ID": str(consumer.business_id),
            "AUTH_BROWSER_CONSUMER_TOKEN": consumer.token("functions"),
        })
    if other_consumer is not None:
        other_consumer.tokens.pop(("functions", None), None)
        environment.update({
            "AUTH_BROWSER_CONSUMER_B_EMAIL": other_consumer.email,
            "AUTH_BROWSER_CONSUMER_B_PASSWORD": other_consumer.password,
            "AUTH_BROWSER_CONSUMER_B_ID": str(other_consumer.business_id),
            "AUTH_BROWSER_CONSUMER_B_TOKEN": other_consumer.token("functions"),
        })
    output = report.output / "guest-cart-browser.json"
    failure = None
    try:
        command(["node", "tests/scripts/test-guest-cart-browser.mjs", "--output", str(output)],
                environment=environment, timeout=420)
    except EvidenceError as error:
        failure = error
    if not output.exists():
        raise failure or EvidenceError("Browser runner returned no evidence")
    try:
        document = json.loads(output.read_text())
    except ValueError as error:
        report.add("browser:guest-cart:cleanup", "cleanup", "FAIL",
                   "Browser evidence is incomplete; fixture retirement is unproven")
        raise EvidenceError("Browser runner returned invalid JSON") from error
    if (not isinstance(document, dict) or not isinstance(document.get("checks"), list) or
            any(not isinstance(check, dict) for check in document["checks"])):
        report.add("browser:guest-cart:cleanup", "cleanup", "FAIL",
                   "Browser evidence has invalid shape; fixture retirement is unproven")
        raise EvidenceError("Browser runner returned invalid evidence shape")
    checks = document.get("checks", [])
    for index, check in enumerate(checks):
        status = check.get("status")
        report.add("browser:guest-cart:" + str(index), "frontend",
                   status if status in {"PASS", "FAIL", "BLOCKED"} else "FAIL",
                   check.get("name", "Unidentified browser assertion"))
    retired = [check for check in checks if check.get("name") == "exact-browser-fixture-retired"]
    if document.get("bootstrapRequested") is True and (
            len(retired) != 1 or retired[0].get("status") != "PASS"):
        report.add("browser:guest-cart:cleanup", "cleanup", "FAIL",
                   "A guest bootstrap was attempted but exact retirement was not confirmed; "
                   "the browser evidence retains any known cart ID and no cleanup is retried.")
    consumer_result = document.get("consumer")
    consumer_cleanup = [check for check in checks if check.get("name") == "exact-consumer-fixture-removed"]
    if (isinstance(consumer_result, dict) and consumer_result.get("mutationPossible") is True and
            (len(consumer_cleanup) != 1 or consumer_cleanup[0].get("status") != "PASS")):
        report.add("browser:consumer-cart:cleanup", "cleanup", "FAIL",
                   "A consumer cart mutation was possible but exact restoration was not confirmed; "
                   "no cleanup is retried.")
    expected = {"guest-add-persists", "guest-cart-survives-reload", "checkout-requires-signin",
                "no-non-cart-function-mutations", "exact-browser-fixture-retired"}
    if consumer is not None:
        expected.update({"consumer-auto-merge", "merged-guest-proof-denied", "consumer-cart-reload",
                         "exact-consumer-fixture-removed"})
    if other_consumer is not None:
        expected.update({"consumer-account-switch-logout-clears-session",
                         "consumer-new-tab-does-not-inherit-session",
                         "consumer-account-switch-isolates-cart",
                         "exact-switched-consumer-preserved"})
    assertions_match = len(checks) == len(expected) and {check.get("name") for check in checks} == expected
    if any(check.get("status") not in {"PASS", "BLOCKED"} for check in checks):
        report.add("browser:guest-cart:complete", "frontend", "FAIL",
                   "The browser runner or at least one assertion failed; inspect individual checks and cleanup.")
    elif any(check.get("status") == "BLOCKED" for check in checks):
        report.add("browser:guest-cart:complete", "frontend", "BLOCKED",
                   "Browser prerequisites are unavailable; no browser conformance claimed")
    elif failure is not None:
        report.add("browser:guest-cart:complete", "frontend", "FAIL",
                   "The browser runner failed; inspect individual checks and cleanup.")
    elif not assertions_match:
        report.add("browser:guest-cart:complete", "frontend", "FAIL",
                   "The browser runner did not produce the exact required assertions.")
    elif consumer is None or other_consumer is None:
        report.add("browser:guest-cart:complete", "frontend", "BLOCKED",
                   "Anonymous cart checks passed, but two distinct consumer sessions are required "
                   "for complete sign-in, merge and account-switch evidence.")
    else:
        report.add("browser:guest-cart:complete", "frontend", "PASS",
                   "Actual deployed browser bootstrap, persistence, checkout guard, both consumer sign-ins, "
                   "merge, account switching and exact cleanup all completed.")


def internal_session_browser(report):
    output = command(["node", "--test", "--test-reporter=tap",
                      "tests/scripts/test-internal-session-browser.mjs"], timeout=90)
    counts = re.findall(r"^# (tests|pass|fail) (\d+)$", output, re.MULTILINE)
    complete = counts == [("tests", "12"), ("pass", "12"), ("fail", "0")]
    report.check("browser:internal:cross-tab-local", "frontend", complete,
                 "Twelve two-tab Chromium cases use local source and a mock OAuth server; "
                 "they do not establish deployed portal behavior.")


def internal_browser(report, deployment):
    policy = json.loads((Path(__file__).with_name("browser-policy.json")).read_text())
    diagnostic_limit_ms = policy["startupReadTimeoutMs"] + 10000
    helper = load_auth_helper()
    environment = dict(os.environ)
    for key in ["APP_ADMIN_URL", "APP_MANUFACTURING_URL", "API_URL", "API_FUNCTIONS_URL", "API_MCP_URL"]:
        environment[key] = https_url(deployment.required(key))
    environment["DAB_RESOURCE_IDENTIFIER"] = (
        deployment.values.get("DAB_RESOURCE_IDENTIFIER") or origin(environment["API_MCP_URL"]) + "/dab")
    for label in ["admin", "manufacturing"]:
        email, password, *_ = helper.IDENTITIES[label]
        environment["AUTH_BROWSER_" + label.upper() + "_EMAIL"] = email
        environment["AUTH_BROWSER_" + label.upper() + "_PASSWORD"] = password
    output = report.output / "internal-browser.json"
    failure = None
    try:
        command(["node", "tests/scripts/test-internal-browser-auth.mjs", "--output", str(output)],
                environment=environment, timeout=policy["runnerTimeoutSeconds"])
    except EvidenceError as error:
        failure = error
    if not output.is_file():
        raise failure or EvidenceError("Internal browser runner returned no evidence")
    try:
        document = json.loads(output.read_text())
    except ValueError as error:
        raise EvidenceError("Internal browser runner returned invalid JSON") from error
    checks = document.get("checks") if isinstance(document, dict) else None
    if (not isinstance(checks, list) or not checks or
            any(not isinstance(item, dict) or not isinstance(item.get("name"), str) or
                item.get("status") not in {"PASS", "FAIL", "BLOCKED"} for item in checks)):
        raise EvidenceError("Internal browser runner returned invalid assertions")
    for index, item in enumerate(checks):
        report.add("browser:internal:" + str(index), "frontend", item["status"], item["name"])
    scenarios = {
        "anonymous-gate-no-data", "pkce-resource-role-owner", "resource-server-read", "real-refresh-exchange",
        "renewal-preserves-route", "logout-clears-resource-sessions", "logout-gates-deep-link", "no-business-mutations",
        "renewal-resource-role-owner", "renewed-resource-server-read",
        "same-origin-second-tab-owner", "same-origin-second-tab-resource-read", "no-token-to-untrusted-origin",
        "same-origin-second-tab-signout", "same-user-new-generation-owner",
        "same-user-new-generation-resource-read", "stale-second-tab-no-adoption",
    }
    expected = {label + ":" + name for label in ["admin", "manufacturing"] for name in scenarios}
    expected.update({"manufacturing:reorder-progress-current-generation",
                     "manufacturing:reorder-progress-isolated-after-login"})
    reads = document.get("reads")
    anonymous_requests = document.get("anonymousRequests")
    anonymous_requests_valid = (
        isinstance(anonymous_requests, list) and len(anonymous_requests) <= 50 and
        all(isinstance(item, dict) and set(item) == {"site", "service", "method"} and
            item.get("site") in {"admin", "manufacturing"} and
            item.get("service") in {"dab", "functions"} and
            isinstance(item.get("method"), str) and
            re.fullmatch(r"[A-Z]{1,10}", item["method"]) for item in anonymous_requests)
    )
    expected_reads = {(label, label + ":" + phase)
                      for label in ["admin", "manufacturing"]
                      for phase in ["real-dab-read", "renewal", "same-origin-second-tab",
                                    "same-user-new-generation"]}
    reads_complete = isinstance(reads, list) and len(reads) == len(expected_reads)
    if reads_complete:
        observed_reads = set()
        for read in reads:
            if not isinstance(read, dict) or (read.get("site"), read.get("phase")) not in expected_reads:
                reads_complete = False
                break
            observed_reads.add((read["site"], read["phase"]))
            startup = read["phase"].endswith(":real-dab-read")
            deadline = policy["startupReadTimeoutMs" if startup else "renewedReadTimeoutMs"]
            if (read.get("status") != 200 or read.get("valid") is not True or read.get("error") or
                    type(read.get("durationMs")) is not int or not 0 <= read["durationMs"] <= deadline or
                    read.get("timeoutMs") != deadline or read.get("startupEligible") is not startup or
                    read.get("slow") is not (read["durationMs"] >= policy["slowReadThresholdMs"])):
                reads_complete = False
                break
        reads_complete = reads_complete and observed_reads == expected_reads
    complete = (failure is None and document.get("phase") == "complete" and len(checks) == len(expected) and
                {item["name"] for item in checks} == expected and all(item["status"] == "PASS" for item in checks) and
                reads_complete and document.get("readPolicy") == policy and
                anonymous_requests_valid and
                type(document.get("blockedMutations")) is int and document["blockedMutations"] == 0 and
                type(document.get("tokenOriginViolations")) is int and document["tokenOriginViolations"] == 0)
    blocked = any(item["status"] == "BLOCKED" for item in checks)
    diagnostic = ""
    error = document.get("error")
    if isinstance(error, dict) and error.get("category") in {
            "network", "navigation", "timeout", "aborted", "javascript-reference", "javascript-type",
            "assertion-or-browser"}:
        diagnostic = "; sanitized failure category: " + error["category"]
        if error.get("operation") in {"anonymous-deep-link-navigation", "browser-flow"}:
            diagnostic += "; operation: " + error["operation"]
    if anonymous_requests_valid and anonymous_requests:
        diagnostic += "; anonymous API request attempts: " + ", ".join(sorted({
            item["site"] + "/" + item["service"] + "/" + item["method"] for item in anonymous_requests
        }))
    for read in document.get("reads", []):
        if (isinstance(read, dict) and read.get("site") in {"admin", "manufacturing"} and
                type(read.get("status")) is int and 0 <= read["status"] <= 599 and
                type(read.get("durationMs")) is int and 0 <= read["durationMs"] <= diagnostic_limit_ms):
            diagnostic += "; " + read["site"] + " DAB HTTP " + str(read["status"]) + \
                " in " + str(read["durationMs"]) + "ms"
            if read.get("error") in {"timeout", "aborted", "network"}:
                diagnostic += " (" + read["error"] + ")"
            if read["durationMs"] >= policy["slowReadThresholdMs"]:
                diagnostic += " [slow read; startup cause not established]"
            if read.get("timeoutMs") in {policy["startupReadTimeoutMs"], policy["renewedReadTimeoutMs"]}:
                diagnostic += " deadline " + str(read["timeoutMs"]) + "ms"
            if isinstance(read.get("traceId"), str) and re.fullmatch(r"[a-f0-9]{32}", read["traceId"]):
                diagnostic += " trace " + read["traceId"]
    for event in document.get("transport", [])[:48]:
        if (not isinstance(event, dict) or event.get("site") not in {"admin", "manufacturing"} or
                event.get("method") not in {"GET", "OPTIONS"} or event.get("event") not in {
                    "request", "route", "continued", "response", "finished", "failed"} or
                type(event.get("elapsedMs")) is not int or not 0 <= event["elapsedMs"] <= diagnostic_limit_ms):
            continue
        diagnostic += "; " + event["site"] + " " + event["method"] + " " + event["event"] + \
            " " + str(event["elapsedMs"]) + "ms"
        if type(event.get("status")) is int and 100 <= event["status"] <= 599:
            diagnostic += " HTTP " + str(event["status"])
        if event.get("corsFailure") is True:
            diagnostic += " CORS failure"
        if isinstance(event.get("reason"), str) and re.fullmatch(r"net::ERR_[A-Z_]{1,60}", event["reason"]):
            diagnostic += " " + event["reason"]
        if event.get("protocol") in {"h2", "h3", "http/1.1", "http/1.0", "other"}:
            diagnostic += " " + event["protocol"]
        timing = event.get("timingMs")
        if isinstance(timing, dict):
            for key in ["queued", "dnsStart", "dnsEnd", "connectStart", "connectEnd", "sslStart", "sslEnd",
                        "sendStart", "sendEnd", "receiveHeadersStart", "receiveHeadersEnd"]:
                if type(timing.get(key)) is int and -1 <= timing[key] <= diagnostic_limit_ms:
                    diagnostic += " " + key + "=" + str(timing[key]) + "ms"
    report.add("browser:internal:complete", "frontend", "PASS" if complete else "BLOCKED" if blocked else "FAIL",
               "Real Admin/Manufacturing PKCE, resource authorization, refresh, logout, same-origin tab isolation, "
               "token-origin confinement and read-only safety; Inspector, user-switch and origin-negative "
               "scenarios remain separate obligations" + diagnostic)


INSPECTOR_BROWSER_CHECKS = {
    "anonymous-proxy-denied", "anonymous-ui-gated", "internal-pkce-session", "opaque-secure-session",
    "no-browser-bearer-tokens", "custom-inspector-ui-connected", "dab-inspector-ui-connected",
    "custom-delegated-catalog", "dab-delegated-product-read", "manufacturing-role-escalation-denied",
    "arbitrary-target-denied", "stdio-disabled", "untrusted-origin-denied", "logout-invalidates-session",
    "no-business-mutations",
    "bounded-demo-client-timeout",
    "same-context-second-tab-authenticated", "second-tab-manufacturing-role-preserved",
    "independent-context-anonymous", "independent-admin-session", "admin-delegated-employee-read",
    "admin-login-does-not-elevate-manufacturing", "logout-invalidates-other-tab",
    "manufacturing-logout-preserves-admin", "admin-logout-invalidates-only-own-session",
    "owned-backend-session-established", "other-user-backend-session-denied", "other-target-backend-session-denied",
    "owner-backend-session-survives-replay", "owned-backend-session-cleanup",
}


def inspector_browser(report, deployment):
    policy = json.loads((Path(__file__).with_name("browser-policy.json")).read_text())
    helper = load_auth_helper()
    environment = dict(os.environ)
    for key in ["MCP_INSPECTOR_URL", "API_MCP_URL", "API_URL"]:
        environment[key] = https_url(deployment.required(key))
    email, password, *_ = helper.IDENTITIES["manufacturing"]
    environment["AUTH_BROWSER_MANUFACTURING_EMAIL"] = email
    environment["AUTH_BROWSER_MANUFACTURING_PASSWORD"] = password
    email, password, *_ = helper.IDENTITIES["admin"]
    environment["AUTH_BROWSER_ADMIN_EMAIL"] = email
    environment["AUTH_BROWSER_ADMIN_PASSWORD"] = password
    output = report.output / "inspector-browser.json"
    failure = None
    try:
        command(["node", "tests/scripts/test-inspector-browser-auth.mjs", "--output", str(output)],
                environment=environment, timeout=1200)
    except EvidenceError as error:
        failure = error
    if not output.is_file():
        raise failure or EvidenceError("Inspector browser runner returned no evidence")
    try:
        document = json.loads(output.read_text())
    except ValueError as error:
        raise EvidenceError("Inspector browser runner returned invalid JSON") from error
    checks = document.get("checks") if isinstance(document, dict) else None
    if (not isinstance(checks, list) or not checks or
            any(not isinstance(item, dict) or not isinstance(item.get("name"), str) or
                item.get("status") not in {"PASS", "FAIL", "BLOCKED"} for item in checks)):
        raise EvidenceError("Inspector browser runner returned invalid assertions")
    for index, item in enumerate(checks):
        report.add("browser:inspector:" + str(index), "frontend", item["status"], item["name"])
    startup = document.get("startupRead")
    valid_startup = (isinstance(startup, dict) and type(startup.get("status")) is int and
                     startup["status"] == 401 and type(startup.get("durationMs")) is int and
                     0 <= startup["durationMs"] <= policy["startupReadTimeoutMs"] and
                     type(startup.get("timeoutMs")) is int and startup["timeoutMs"] == policy["startupReadTimeoutMs"] and
                     type(startup.get("slow")) is bool and
                     startup["slow"] == (startup["durationMs"] >= policy["slowReadThresholdMs"]))
    if valid_startup:
        report.inventory["inspectorStartupRead"] = {key: startup[key] for key in ["status", "durationMs", "timeoutMs", "slow"]}
    complete = (failure is None and document.get("phase") == "complete" and
                document.get("policy") == policy and valid_startup and
                type(document.get("blockedMutations")) is int and document["blockedMutations"] == 0 and
                len(checks) == len(INSPECTOR_BROWSER_CHECKS) and
                {item["name"] for item in checks} == INSPECTOR_BROWSER_CHECKS and
                all(item["status"] == "PASS" for item in checks))
    blocked = any(item["status"] == "BLOCKED" for item in checks)
    report.add("browser:inspector:complete", "frontend", "PASS" if complete else "BLOCKED" if blocked else "FAIL",
               "Actual hosted Inspector internal PKCE, opaque session, both UI connections, delegated target "
               "authorization, role/origin/target denials, two-tab logout and independent manufacturing/admin "
               "role/session isolation; no business writes. Natural expiry and full role/tool matrices remain separate obligations")


def native_dab_mcp(report, deployment, dab_token, functions_token, role):
    url = origin(deployment.required("API_URL")) + "/mcp"
    headers = {"X-MS-API-ROLE": role}
    request_id = 0
    session_id = None
    opener = urllib.request.build_opener(
        NoRedirect(), urllib.request.HTTPCookieProcessor(cookiejar.CookieJar()))

    def rpc(method, params=None, *, bearer=dab_token, request_headers=None):
        nonlocal request_id
        request_id += 1
        data = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            data["params"] = params
        status, response_headers, body = http("POST", url, token=bearer,
                                              headers=headers if request_headers is None else request_headers,
                                              data=data, opener=opener)
        document = None
        if status == 200:
            document = mcp_document(body)
            if (document.get("jsonrpc") != "2.0" or document.get("id") != request_id or
                    ("result" in document) == ("error" in document)):
                raise EvidenceError("Native DAB MCP returned an invalid or mismatched JSON-RPC envelope")
            if "result" in document and not isinstance(document["result"], dict):
                raise EvidenceError("Native DAB MCP result is not an object")
        return status, response_headers, document

    def read(entity, field, *, bearer=dab_token, request_headers=None):
        status, _, document = rpc("tools/call", {
            "name": "read_records", "arguments": {"entity": entity, "select": field, "first": 1},
        }, bearer=bearer, request_headers=request_headers)
        if status != 200:
            return status, None, None
        result = document.get("result")
        if not isinstance(result, dict):
            raise EvidenceError("Native DAB MCP read has no tool result")
        content = result.get("content")
        if (not isinstance(content, list) or len(content) != 1 or
                not isinstance(content[0], dict) or content[0].get("type") != "text"):
            raise EvidenceError("Native DAB MCP read has an unsupported content shape")
        try:
            payload = json.loads(content[0]["text"])
        except (KeyError, TypeError, ValueError) as error:
            raise EvidenceError("Native DAB MCP read content is not a JSON object") from error
        if not isinstance(payload, dict):
            raise EvidenceError("Native DAB MCP read content is not a JSON object")
        if payload.get("status") == "success" and not isinstance(payload.get("result"), dict):
            raise EvidenceError("Native DAB MCP successful read result is not an object")
        return status, result.get("isError") is True, payload

    def permission_denied(status, is_error, payload):
        return (status in {401, 403} or status == 200 and is_error and
                payload.get("status") == "error" and
                isinstance(payload.get("error"), dict) and
                payload["error"].get("type") == "PermissionDenied")

    try:
        status, response_headers, document = rpc("initialize", {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "auth-assurance", "version": "1.0"},
        })
        session_id = response_headers.get("Mcp-Session-Id")
        result = document.get("result") if document else None
        valid = (status == 200 and isinstance(result, dict) and
                 result.get("protocolVersion") == "2025-03-26" and
                 isinstance(session_id, str) and bool(session_id))
        report.check("dab-mcp:initialize", "live-allows", valid,
                     f"Manufacturing DAB-audience token initializes a real protocol session; HTTP {status}")
        if not valid:
            return
        headers.update({"Mcp-Session-Id": session_id, "MCP-Protocol-Version": result["protocolVersion"]})
        status, _, _ = http("POST", url, token=dab_token, headers=headers,
                             data={"jsonrpc": "2.0", "method": "notifications/initialized"}, opener=opener)
        report.check("dab-mcp:initialized", "live-allows", status == 202,
                     f"Session accepts the protocol's initialized notification; HTTP {status}")
        if status != 202:
            return
        status, _, document = rpc("tools/list")
        tools = document.get("result", {}).get("tools", []) if document else []
        expected = {
            "aggregate_records": {"entity", "function"}, "create_record": {"entity", "data"},
            "delete_record": {"entity", "keys"}, "describe_entities": set(),
            "execute_entity": {"entity"}, "read_records": {"entity"},
            "update_record": {"entity", "keys", "fields"},
        }
        def reviewed_tool(tool):
            if not isinstance(tool, dict) or not isinstance(tool.get("name"), str) or tool["name"] not in expected:
                return False
            schema = tool.get("inputSchema")
            if not isinstance(schema, dict) or schema.get("type") != "object":
                return False
            required = schema.get("required", [])
            properties = schema.get("properties")
            return (isinstance(required, list) and all(isinstance(name, str) for name in required) and
                    len(required) == len(set(required)) and set(required) == expected[tool["name"]] and
                    isinstance(properties, dict) and expected[tool["name"]].issubset(properties))
        valid = (status == 200 and isinstance(tools, list) and len(tools) == len(expected) and
                 all(reviewed_tool(tool) for tool in tools) and
                 len({tool["name"] for tool in tools}) == len(expected))
        report.check("dab-mcp:tool-catalog", "live-allows", valid,
                     "Exactly seven reviewed native MCP tool names and required argument schemas")
        if not valid:
            return
        status, is_error, payload = read("Product", "ProductID")
        rows = payload.get("result", {}).get("value", []) if payload else []
        report.check("dab-mcp:catalog-read", "live-allows",
                     status == 200 and not is_error and payload.get("status") == "success" and
                     payload.get("entity") == "Product" and isinstance(rows, list) and len(rows) == 1 and
                     isinstance(rows[0], dict) and set(rows[0]) == {"ProductID"} and
                     isinstance(rows[0]["ProductID"], int),
                     "Native read returns one actual ProductID with no additional fields")
        status, is_error, payload = read("WorkOrder", "WorkOrderID")
        rows = payload.get("result", {}).get("value", []) if payload else []
        report.check("dab-mcp:manufacturing-read", "live-allows",
                     status == 200 and not is_error and payload.get("status") == "success" and
                     payload.get("entity") == "WorkOrder" and isinstance(rows, list) and len(rows) <= 1 and
                     all(isinstance(row, dict) and set(row) == {"WorkOrderID"} and
                         isinstance(row["WorkOrderID"], int) for row in rows),
                     "Manufacturing role can read at most one work-order identifier")
        status, is_error, payload = read("Employee", "BusinessEntityID")
        report.check("dab-mcp:private-role-denial", "live-denials",
                     permission_denied(status, is_error, payload),
                     "Manufacturing role cannot read Employee; HTTP success alone is not permission")
        anonymous_headers = {name: value for name, value in headers.items() if name != "X-MS-API-ROLE"}
        status, is_error, payload = read("WorkOrder", "WorkOrderID", bearer=None,
                                         request_headers=anonymous_headers)
        report.check("dab-mcp:session-is-not-authority", "live-denials",
                     permission_denied(status, is_error, payload),
                     "Reusing the session without a bearer token does not retain manufacturing permissions")
        for label, bearer, request_headers, expected_status in [
            ("forged", "invalid-auth-validation-token", headers, 401),
            ("wrong-audience", functions_token, headers, 401),
            ("role-escalation", dab_token, {**headers, "X-MS-API-ROLE": "executive-admin"}, 403),
            ("untrusted-origin", dab_token, {**headers, "Origin": "https://untrusted.example.invalid"}, 403),
            ("trusted-origin", dab_token, {**headers, "Origin": origin(url)}, 200),
        ]:
            status, _, document = rpc("tools/list", bearer=bearer, request_headers=request_headers)
            valid = status == expected_status
            if expected_status == 200:
                valid = valid and isinstance(document.get("result", {}).get("tools"), list)
            report.check("dab-mcp:" + label, "live-allows" if expected_status == 200 else "live-denials",
                         valid, f"Native MCP {label}: expected HTTP {expected_status}; received {status}")
    finally:
        if session_id:
            cleanup_headers = {**headers, "Mcp-Session-Id": session_id}
            status = None
            errors = []
            for attempt in range(2):
                try:
                    status, _, _ = http("DELETE", url, token=dab_token,
                                        headers=cleanup_headers, opener=opener)
                except EvidenceError as error:
                    errors.append(error)
                    if attempt == 0:
                        continue
                    break
                if status in {200, 202, 204, 404}:
                    break
                if status >= 500 and attempt == 0:
                    continue
                break
            confirmed = status in {200, 202, 204, 404}
            detail = ("Exact run-owned MCP session terminated or already absent."
                      if confirmed else "Exact run-owned MCP session termination remained unconfirmed.")
            if status is not None:
                detail += f" Final HTTP status {status}."
            if errors:
                detail += " A bounded retry followed a network failure."
            report.check("dab-mcp:session-cleanup", "cleanup", confirmed, detail)


def dab_read_role_matrix(report, deployment, admin_token, manufacturing_token, consumers):
    config = json.loads((ROOT / "api/dab-config.json").read_text())
    dab_inventory(config)
    entities = config["entities"]
    url = https_url(deployment.required("API_URL"))
    schema_query = """{ __schema { queryType { fields {
      name type { kind name ofType { kind name } }
    } } types { name fields { name } } } }"""
    status, _, raw = http("POST", url, token=admin_token,
                         headers={"X-MS-API-ROLE": "executive-admin"}, data={"query": schema_query})
    try:
        document = json.loads(raw)
        schema = document["data"]["__schema"]
        query_fields = schema["queryType"]["fields"]
        types = {item["name"]: {field["name"] for field in item["fields"] or []}
                 for item in schema["types"]}
    except (ValueError, KeyError, TypeError) as error:
        raise EvidenceError("DAB read-role schema discovery returned invalid metadata") from error
    if status != 200 or document.get("errors"):
        raise EvidenceError("DAB read-role schema discovery was not authorized")
    if not isinstance(query_fields, list):
        raise EvidenceError("DAB read-role schema has invalid query-field metadata")
    selectors = {}
    for field in query_fields:
        if not isinstance(field, dict) or not isinstance(field.get("type"), dict):
            raise EvidenceError("DAB read-role schema has invalid selector metadata")
        target = field["type"]
        if target.get("kind") == "NON_NULL":
            target = target.get("ofType")
        if not isinstance(target, dict):
            raise EvidenceError("DAB read-role schema has invalid selector type metadata")
        name = target.get("name")
        if target.get("kind") != "OBJECT" or not isinstance(name, str) or not name.endswith("Connection"):
            continue
        entity = name.removesuffix("Connection")
        if (entity not in entities or entity in selectors or not isinstance(field.get("name"), str) or
                not re.fullmatch(r"[_A-Za-z][_0-9A-Za-z]*", field["name"])):
            raise EvidenceError("DAB read-role schema has an unclassified or duplicate entity selector")
        selectors[entity] = field["name"]
    expected = {name for name, entity in entities.items() if entity.get("graphql", True) is True}
    if set(selectors) != expected:
        raise EvidenceError("DAB read-role schema does not close over the source GraphQL entities")
    callers = [("anonymous", None, "anonymous"), ("admin", admin_token, "executive-admin"),
               ("manufacturing", manufacturing_token, "manufacturing-engineer")]
    for consumer in consumers:
        token = consumer.token("dab", "customers.read orders.read products.read")
        callers.extend([(consumer.label, token, "consumer"),
                        ("authenticated-" + consumer.label, token, "authenticated")])
    evidence = []
    report.inventory["dabReadRoleMatrix"] = evidence
    for name in sorted(expected):
        entity = entities[name]
        column = entity["fields"][0]["name"]
        description = entity["fields"][0].get("description", "")
        selector = selectors[name]
        if (not isinstance(description, str) or not any(
                term in description.lower() for term in ["primary key", "composite key"]) or
                not re.fullmatch(r"[_A-Za-z][_0-9A-Za-z]*", column) or
                not re.fullmatch(r"[_A-Za-z][_0-9A-Za-z]*", selector) or column not in types.get(name, set())):
            raise EvidenceError("DAB read-role metadata lacks a valid source primary-column selector")
        for caller, token, role in callers:
            allowed = any(permission["role"] in {role, "anonymous"} and
                          ("read" in action_names(permission) or "*" in action_names(permission))
                          for permission in entity["permissions"])
            rest = entity.get("rest", True)
            if type(rest) is not bool:
                raise EvidenceError("DAB read-role REST configuration requires explicit classification")
            rest_url = origin(url) + "/api/" + name + "?" + urllib.parse.urlencode({
                "$select": column, "$first": 1,
            })
            for protocol in (["graphql", "rest"] if rest else ["graphql"]):
                check_id = f"dab:read-role:{'rest:' if protocol == 'rest' else ''}{name}:{caller}"
                group = "live-allows" if allowed else "live-denials"
                item = {"entity": name, "caller": caller, "role": role, "column": column,
                        "protocol": protocol, "expected": "allow" if allowed else "deny"}
                evidence.append(item)
                try:
                    status, _, raw = http(
                        "GET" if protocol == "rest" else "POST", rest_url if protocol == "rest" else url,
                        token=token, headers={"X-MS-API-ROLE": role},
                        data=None if protocol == "rest" else {
                            "query": f"{{ {selector}(first: 1) {{ items {{ {column} }} }} }}"})
                except EvidenceError as error:
                    item["status"] = "BLOCKED"
                    report.add(check_id, group, "BLOCKED", str(error))
                    continue
                try:
                    body = json.loads(raw) if raw else {}
                except ValueError:
                    item["status"] = "FAIL"
                    report.add(check_id, group, "FAIL", "Read-role response was not valid JSON; body withheld.")
                    continue
                data = body.get("data") if isinstance(body, dict) else None
                result = data.get(selector) if isinstance(data, dict) else None
                rows = (body.get("value") if isinstance(body, dict) else None) if protocol == "rest" else (
                    result.get("items") if isinstance(result, dict) else None)
                errors = body.get("errors") if isinstance(body, dict) else None
                if allowed:
                    valid = (status == 200 and not errors and isinstance(rows, list) and len(rows) <= 1 and
                             all(isinstance(row, dict) and set(row) == {column} and
                                 type(row[column]) in {int, str} for row in rows))
                else:
                    valid = status in {401, 403} and (rows is None or rows == [])
                    if protocol == "graphql":
                        valid = valid or (
                            status == 200 and isinstance(errors, list) and bool(errors) and
                            (rows is None or rows == []) and all(
                                isinstance(error, dict) and error.get("path") == [selector] and
                                error.get("message") == "The current user is not authorized to access this resource." and
                                isinstance(error.get("extensions"), dict) and
                                error["extensions"].get("code") ==
                                ("AUTH_NOT_AUTHENTICATED" if token is None else "AUTH_NOT_AUTHORIZED")
                                for error in errors))
                item["status"] = "PASS" if valid else "FAIL"
                report.check(check_id, group, valid,
                             f"Source role={role}, expected {protocol} read={'allow' if allowed else 'deny'}, "
                             f"HTTP {status}; one selected column, "
                             f"rows={len(rows) if isinstance(rows, list) else 'none'}. "
                             "Public anonymous reads are inherited. Values withheld; empty allowed results "
                             "do not prove ownership or total counts.")


def dab_role_header_denials(report, deployment, admin_token, manufacturing_token, consumers):
    config = json.loads((ROOT / "api/dab-config.json").read_text())
    dab_inventory(config)
    roles = {permission["role"] for entity in config["entities"].values()
             for permission in entity["permissions"]} - {"anonymous", "authenticated"}
    helper = load_auth_helper()
    callers = [("admin", admin_token), ("manufacturing", manufacturing_token)]
    callers.extend(("consumer-" + consumer.label, consumer.token("dab", "customers.read"))
                   for consumer in consumers)
    base = origin(deployment.required("API_URL"))
    decisions = []
    for label, token in callers:
        granted = helper.claims(token).get("roles")
        if isinstance(granted, str):
            granted = [granted]
        if (not isinstance(granted, list) or not granted or
                any(not isinstance(role, str) or role not in roles for role in granted)):
            raise EvidenceError("DAB role-header verification requires classified signed role claims")
        denied_roles = roles - set(granted)
        for role in sorted(denied_roles):
            for protocol in ["graphql", "rest"]:
                status, _, raw = http(
                    "POST" if protocol == "graphql" else "GET",
                    base + ("/graphql" if protocol == "graphql" else
                            "/api/Employee?$first=1&$select=BusinessEntityID"),
                    token=token, headers={"X-MS-API-ROLE": role},
                    **({"data": {"query": "{ employees(first: 1) { items { BusinessEntityID } } }"}}
                       if protocol == "graphql" else {}))
                try:
                    document = json.loads(raw) if raw else {}
                except ValueError:
                    document = None
                valid = (status == 403 and isinstance(document, dict) and
                         set(document) <= {"error", "errors"} and
                         (not document or bool(document.get("error") or document.get("errors"))))
                report.check(f"dab:role-header:{label}:{role}:{protocol}", "live-denials", valid,
                             f"Signed caller cannot select an ungranted source-declared role over {protocol}; "
                             f"HTTP {status}. No records or response values retained.")
                if not valid:
                    raise EvidenceError("DAB rejected-role boundary failed; response values withheld")
        decisions.append({"caller": label, "ungrantedRoles": sorted(denied_roles),
                          "protocolDecisions": len(denied_roles) * 2})
    report.inventory["dabRoleHeaderDecisions"] = decisions


def dab_private_employee_role_matrix(report, deployment, admin_token, manufacturing_token):
    url = https_url(deployment.required("API_URL"))
    query = {"query": "{ employees(first: 1) { items { BusinessEntityID } } }"}

    def request(label, token, role, allowed):
        status, _, raw = http("POST", url, token=token, headers={"X-MS-API-ROLE": role}, data=query)
        if status in {401, 403} and not raw:
            body = {}
        else:
            try:
                body = json.loads(raw)
            except ValueError as error:
                raise EvidenceError("DAB employee role query returned invalid JSON") from error
        data = body.get("data") if isinstance(body, dict) else None
        employees = data.get("employees") if isinstance(data, dict) else None
        rows = employees.get("items") if isinstance(employees, dict) else None
        errors = body.get("errors") if isinstance(body, dict) else None
        if allowed:
            valid = (status == 200 and not errors and isinstance(rows, list) and len(rows) == 1 and
                     isinstance(rows[0], dict) and set(rows[0]) == {"BusinessEntityID"} and
                     type(rows[0]["BusinessEntityID"]) is int and rows[0]["BusinessEntityID"] > 0)
        else:
            denied_response = (status in {401, 403} and (rows is None or rows == []) or
                               status == 200 and isinstance(errors, list) and bool(errors) and
                               (rows is None or isinstance(rows, list) and not rows))
            if status == 200:
                denied_response = (denied_response and all(
                    isinstance(error, dict) and
                    error.get("message") == "The current user is not authorized to access this resource." and
                    error.get("path") == ["employees"] and isinstance(error.get("extensions"), dict) and
                    error["extensions"].get("code") == "AUTH_NOT_AUTHORIZED"
                    for error in errors))
            valid = denied_response
        report.check("dab:employee:" + label, "live-allows" if allowed else "live-denials", valid,
                     ("Executive admin can read only the selected employee identifier." if allowed else
                      "Manufacturing credentials cannot read Employee, including with an executive role header.")
                     + f" HTTP {status}; rows={len(rows) if isinstance(rows, list) else 'invalid'}.")
        if not valid:
            raise EvidenceError("DAB Employee role decision was not established: " + label)

    request("executive-admin-allow", admin_token, "executive-admin", True)
    request("manufacturing-deny", manufacturing_token, "manufacturing-engineer", False)
    request("manufacturing-role-escalation-deny", manufacturing_token, "executive-admin", False)


def dab_credential_field_restrictions(report, deployment, admin_token, manufacturing_token, consumers):
    if len(consumers) != 2:
        raise EvidenceError("Credential-field verification requires two existing dedicated consumers")
    base = origin(deployment.required("API_URL"))
    for consumer in consumers:
        owner = consumer.business_id
        if type(owner) is not int or owner <= 0:
            raise EvidenceError("Credential-field verification requires a confirmed fixture owner")
        url = base + "/api/Password?" + urllib.parse.urlencode({
            "$filter": f"BusinessEntityID eq {owner}", "$first": 1,
        })
        consumer_token = consumer.token("dab", "customers.read")
        cases = [
            ("admin-metadata", admin_token, "executive-admin", True),
            ("manufacturing-deny", manufacturing_token, "manufacturing-engineer", False),
            ("consumer-own-deny", consumer_token, "consumer", False),
            ("manufacturing-role-spoof", manufacturing_token, "executive-admin", False),
            ("consumer-role-spoof", consumer_token, "executive-admin", False),
        ]
        for label, token, role, allowed in cases:
            status, _, raw = http("GET", url, token=token, headers={"X-MS-API-ROLE": role})
            try:
                body = json.loads(raw) if raw else {}
            except ValueError as error:
                raise EvidenceError("Credential-field verification returned invalid JSON; body withheld") from error
            rows = body.get("value") if isinstance(body, dict) else None
            if allowed:
                valid = (status == 200 and isinstance(rows, list) and len(rows) == 1 and
                         isinstance(rows[0], dict) and
                         set(rows[0]) == {"BusinessEntityID", "rowguid", "ModifiedDate"} and
                         type(rows[0]["BusinessEntityID"]) is int and rows[0]["BusinessEntityID"] == owner)
            else:
                valid = status in {401, 403} and (rows is None or rows == [])
            report.check(f"dab:password:{consumer.label}:{label}",
                         "live-allows" if allowed else "live-denials", valid,
                         "Dedicated fixture row returns only permitted metadata for admin; "
                         "consumer/manufacturing roles and forged executive headers cannot read it. "
                         f"HTTP {status}. No response values, hashes, salts or tokens are exported.")
            if not valid:
                raise EvidenceError("Credential-field verification stopped after a failed boundary; body withheld")


def dab_catalog_field_restrictions(report, deployment, admin_token, manufacturing_token, consumers):
    if len(consumers) != 2 or consumers[0].business_id == consumers[1].business_id:
        raise EvidenceError("Catalog field verification requires two distinct consumers")
    base = origin(deployment.required("API_URL"))
    graphql = https_url(deployment.required("API_URL"))
    entities = [
        ("Product", "products", ("ProductID",),
         ("StandardCost", "SafetyStockLevel", "ReorderPoint", "DaysToManufacture"),
         ("ProductID", "Name", "ListPrice"), True),
        ("ProductInventory", "productInventories", ("ProductID", "LocationID"),
         ("Shelf", "Bin"), ("ProductID", "LocationID", "Quantity"), True),
        ("ProductReview", "productReviews", ("ProductReviewID",),
         ("EmailAddress",), ("ProductReviewID", "ProductID", "ReviewerName", "Rating"), False),
    ]
    callers = [("anonymous", None, None)]
    probe_values = {
        "StandardCost": ("0", "0"), "SafetyStockLevel": ("0", "0"),
        "ReorderPoint": ("0", "0"), "DaysToManufacture": ("0", "0"),
        "Shelf": ("'auth-probe'", '"auth-probe"'), "Bin": ("0", "0"),
        "EmailAddress": ("'auth-probe@example.invalid'", '"auth-probe@example.invalid"'),
    }
    for consumer in consumers:
        token = consumer.token("dab", "products.read")
        callers.extend([(consumer.label + "-consumer", token, "consumer"),
                        (consumer.label + "-authenticated", token, "authenticated")])

    def document(raw):
        try:
            result = json.loads(raw)
        except ValueError as error:
            raise EvidenceError("Catalog verification returned invalid JSON; payload withheld") from error
        if not isinstance(result, dict):
            raise EvidenceError("Catalog verification returned invalid metadata; payload withheld")
        return result

    def contains_value(value, field):
        if isinstance(value, dict):
            return (field in value and value[field] is not None) or any(
                contains_value(nested, field) for nested in value.values())
        if isinstance(value, list):
            return any(contains_value(nested, field) for nested in value)
        return False

    for entity, selector, keys, restricted, public_fields, manufacturing_control in entities:
        endpoint = base + "/api/" + entity
        status, _, raw = http("GET", endpoint + "?" + urllib.parse.urlencode({"$first": 1}),
                              token=admin_token, headers={"X-MS-API-ROLE": "executive-admin"})
        rows = document(raw).get("value")
        if status == 200 and rows == []:
            report.add(f"dab:catalog:{entity}:control", "live-allows", "BLOCKED",
                       "No existing row is available for a nonempty field-authorization control.")
            raise EvidenceError("A nonempty catalog control is required")
        valid = (status == 200 and isinstance(rows, list) and len(rows) == 1 and
                 isinstance(rows[0], dict) and set(keys + restricted).issubset(rows[0]) and
                 all(type(rows[0][key]) is int and rows[0][key] > 0 for key in keys))
        report.check(f"dab:catalog:{entity}:control", "live-allows", valid,
                     f"Internal REST can read an existing record and the restricted fields; HTTP {status}. "
                     "Record values withheld.")
        if not valid:
            raise EvidenceError("Catalog field verification lacks an internal positive control")
        identifiers = {key: rows[0][key] for key in keys}
        rest_query = urllib.parse.urlencode({
            "$filter": " and ".join(f"{key} eq {identifiers[key]}" for key in keys), "$first": 1,
        })
        filter_clause = " ".join(f"{key}: {{ eq: {identifiers[key]} }}" for key in keys)

        def graphql_query(fields):
            return "{ " + selector + "(first: 1, filter: { " + filter_clause + \
                " }) { items { " + " ".join(fields) + " } } }"

        internal = [("admin", admin_token, "executive-admin")]
        if manufacturing_control:
            internal.append(("manufacturing", manufacturing_token, "manufacturing-engineer"))
        for label, token, role in internal:
            status, _, raw = http("POST", graphql, token=token, headers={"X-MS-API-ROLE": role},
                                  data={"query": graphql_query(keys + restricted)})
            body = document(raw)
            data = body.get("data")
            connection = data.get(selector) if isinstance(data, dict) else None
            result = connection.get("items") if isinstance(connection, dict) else None
            valid = (status == 200 and not body.get("errors") and isinstance(result, list) and
                     len(result) == 1 and isinstance(result[0], dict) and
                     set(keys + restricted).issubset(result[0]) and
                     all(result[0][key] == value for key, value in identifiers.items()))
            report.check(f"dab:catalog:{entity}:{label}:internal-graphql", "live-allows", valid,
                         f"Internal GraphQL retains required operational fields; HTTP {status}. Values withheld.")
            if not valid:
                raise EvidenceError("An internal catalog GraphQL control failed")

        for label, token, role in callers:
            headers = {"X-MS-API-ROLE": role} if role else {}
            status, _, raw = http("GET", endpoint + "?" + rest_query, token=token, headers=headers)
            rows = document(raw).get("value")
            valid = (status == 200 and isinstance(rows, list) and len(rows) == 1 and
                     isinstance(rows[0], dict) and not set(restricted).intersection(rows[0]) and
                     set(public_fields).issubset(rows[0]) and
                     all(rows[0][key] == value for key, value in identifiers.items()))
            report.check(f"dab:catalog:{entity}:{label}:rest-fields", "live-allows", valid,
                         f"Public REST returns a real storefront record without internal fields; HTTP {status}. "
                         "Values withheld.")
            if not valid:
                raise EvidenceError("Public catalog REST field boundary failed")

            status, _, raw = http("POST", graphql, token=token, headers=headers,
                                  data={"query": graphql_query(public_fields)})
            body = document(raw)
            data = body.get("data")
            connection = data.get(selector) if isinstance(data, dict) else None
            result = connection.get("items") if isinstance(connection, dict) else None
            valid = (status == 200 and not body.get("errors") and isinstance(result, list) and
                     len(result) == 1 and isinstance(result[0], dict) and
                     set(public_fields).issubset(result[0]) and
                     all(result[0][key] == value for key, value in identifiers.items()))
            report.check(f"dab:catalog:{entity}:{label}:graphql-fields", "live-allows", valid,
                         f"Public GraphQL retains the storefront fields on a real record; HTTP {status}. "
                         "Values withheld.")
            if not valid:
                raise EvidenceError("Public catalog GraphQL positive control failed")

            for field in restricted:
                status, _, raw = http("POST", graphql, token=token, headers=headers,
                                      data={"query": graphql_query(keys + (field,))})
                body = document(raw)
                data = body.get("data")
                errors = body.get("errors")
                expected_code = "AUTH_NOT_AUTHENTICATED" if role is None else "AUTH_NOT_AUTHORIZED"
                valid = (status == 200 and (data is None or isinstance(data, dict)) and
                         not contains_value(data, field) and isinstance(errors, list) and bool(errors) and
                         all(isinstance(error, dict) and isinstance(error.get("extensions"), dict) and
                             error["extensions"].get("code") == expected_code for error in errors))
                report.check(f"dab:catalog:{entity}:{label}:graphql-deny:{field}", "live-denials", valid,
                             f"Public GraphQL rejects the internal field with an authorization error; "
                             f"HTTP {status}. Values withheld.")
                if not valid:
                    raise EvidenceError("Public catalog GraphQL field boundary failed")

                rest_value, graphql_value = probe_values[field]
                for operation, query in [
                    ("select", {"$select": ",".join(keys + (field,)), "$first": 1}),
                    ("filter", {"$filter": f"{field} eq {rest_value}", "$select": ",".join(keys), "$first": 1}),
                    ("orderby", {"$orderby": field + " asc", "$select": ",".join(keys), "$first": 1}),
                ]:
                    status, _, raw = http("GET", endpoint + "?" + urllib.parse.urlencode(query),
                                          token=token, headers=headers)
                    body = document(raw)
                    valid = (status == 403 and set(body) <= {"error", "errors"} and
                             bool(body.get("error") or body.get("errors")))
                    report.check(f"dab:catalog:{entity}:{label}:rest-{operation}-deny:{field}",
                                 "live-denials", valid,
                                 f"Public REST cannot {operation} an internal field; HTTP {status}. "
                                 "Response withheld.")
                    if not valid:
                        raise EvidenceError("Public catalog REST field boundary failed")

                for operation, argument, message in [
                    ("filter", f"filter: {{ {field}: {{ eq: {graphql_value} }} }}",
                     "Access forbidden to a field referenced in the filter."),
                    ("orderby", f"orderBy: {{ {field}: ASC }}",
                     "Access forbidden to a field referenced in the orderBy argument."),
                ]:
                    query = "{ " + selector + "(first: 1, " + argument + ") { items { " + keys[0] + " } } }"
                    status, _, raw = http("POST", graphql, token=token, headers=headers, data={"query": query})
                    body = document(raw)
                    data = body.get("data")
                    errors = body.get("errors")
                    valid = (status == 200 and (data is None or
                             isinstance(data, dict) and data.get(selector) is None) and
                             isinstance(errors, list) and bool(errors) and
                             all(isinstance(error, dict) and error.get("message") == message for error in errors))
                    report.check(f"dab:catalog:{entity}:{label}:graphql-{operation}-deny:{field}",
                                 "live-denials", valid,
                                 f"Public GraphQL cannot {operation} an internal field; HTTP {status}. "
                                 "Response withheld.")
                    if not valid:
                        raise EvidenceError("Public catalog GraphQL field boundary failed")


def payment_method_reads(report, deployment, admin_functions_token, admin_dab_token, consumers):
    if len(consumers) != 2 or any(type(user.business_id) is not int or user.business_id <= 0 for user in consumers):
        raise EvidenceError("Payment verification requires two confirmed consumer person claims")
    callers = [(user.label, user.business_id, user.token("functions", "customers.read"),
                user.token("dab", "customers.read"), "consumer") for user in consumers]
    dab = origin(deployment.required("API_URL"))
    functions = https_url(deployment.required("API_FUNCTIONS_URL"))
    for label, token, expected in [("admin-unbound", admin_functions_token, 403),
                                    ("wrong-audience", admin_dab_token, 401)]:
        status, _, _ = http("GET", functions + "/api/payment-methods", token=token)
        report.check("functions:payments:" + label, "live-denials", status == expected,
                     f"Unbound staff/cross-audience payment read expected HTTP {expected}; received {status}.")
    nonempty = False
    for label, owner, functions_token, dab_token, role in callers:
        url = dab + "/api/PersonCreditCard?" + urllib.parse.urlencode({
            "$filter": f"BusinessEntityID eq {owner}", "$select": "BusinessEntityID,CreditCardID", "$first": 100,
        })
        expected = set()
        seen = set()
        for _ in range(20):
            if url in seen:
                raise EvidenceError("Payment link pagination repeated a cursor")
            seen.add(url)
            status, _, raw = http("GET", url, token=dab_token, headers={"X-MS-API-ROLE": role})
            try:
                document = json.loads(raw)
                rows = document["value"]
            except (ValueError, KeyError, TypeError) as error:
                raise EvidenceError("Payment link verification returned invalid metadata; values withheld") from error
            if status != 200 or not isinstance(rows, list) or not all(
                    isinstance(row, dict) and set(row) == {"BusinessEntityID", "CreditCardID"} and
                    type(row["BusinessEntityID"]) is int and row["BusinessEntityID"] == owner and
                    type(row["CreditCardID"]) is int for row in rows):
                raise EvidenceError("Payment link ownership was not established; values withheld")
            expected.update(row["CreditCardID"] for row in rows)
            link = document.get("nextLink")
            if link is None:
                break
            if not isinstance(link, str) or not rows:
                raise EvidenceError("Payment link pagination returned invalid continuation metadata")
            url = urllib.parse.urljoin(dab + "/", link)
            parsed = urllib.parse.urlsplit(url)
            if (f"{parsed.scheme}://{parsed.netloc}" != dab or
                    parsed.path != "/api/PersonCreditCard" or parsed.fragment):
                raise EvidenceError("Payment link cursor escaped the trusted DAB endpoint")
        else:
            raise EvidenceError("Payment link pagination exceeded the bounded verification window")
        foreign = next(candidate[1] for candidate in callers if candidate[1] != owner)
        for suffix, query in [("own", ""), ("foreign-query", f"?businessEntityId={foreign}")]:
            status, _, raw = http("GET", functions + "/api/payment-methods" + query, token=functions_token)
            try:
                cards = json.loads(raw)
            except ValueError as error:
                raise EvidenceError("Payment method verification returned invalid JSON; values withheld") from error
            valid = status == 200 and isinstance(cards, list) and all(
                isinstance(card, dict) and set(card) == {"id", "cardType", "last4", "expMonth", "expYear"} and
                type(card["id"]) is int and isinstance(card["cardType"], str) and
                isinstance(card["last4"], str) and len(card["last4"]) <= 4 and
                type(card["expMonth"]) is int and 1 <= card["expMonth"] <= 12 and
                type(card["expYear"]) is int and card["expYear"] > 0 for card in cards)
            valid = valid and len(cards) == len(expected) and {card["id"] for card in cards} == expected
            report.check(f"functions:payments:{label}:{suffix}", "live-allows", valid,
                         "Only signed-person card IDs match independently paginated owned links; "
                         f"HTTP {status}, cards={len(cards) if isinstance(cards, list) else 'invalid'}. "
                         "Card values and owner IDs withheld; empty results are not nonempty masking proof.")
            if not valid:
                raise EvidenceError("Payment method ownership/masking verification failed; values withheld")
            nonempty |= bool(cards)
    report.add("functions:payments:nonempty-masking", "live-allows", "PASS" if nonempty else "BLOCKED",
               "Actual linked card metadata was server-masked." if nonempty else
               "Available callers have no linked cards; no SQL fixture is created to manufacture masking proof.")


def receipt_reads(report, deployment, admin_functions_token, admin_dab_token, consumers):
    if len(consumers) != 2:
        raise EvidenceError("Receipt read verification requires two retained consumers")
    dab = origin(deployment.required("API_URL"))
    functions = https_url(deployment.required("API_FUNCTIONS_URL"))
    status, _, raw = http(
        "GET", dab + "/api/SalesOrderHeader?" + urllib.parse.urlencode({
            "$select": "SalesOrderID,CustomerID", "$first": 3,
        }), token=admin_dab_token, headers={"X-MS-API-ROLE": "executive-admin"})
    try:
        orders = json.loads(raw)["value"]
        valid = (status == 200 and isinstance(orders, list) and 0 < len(orders) <= 3 and
                 all(isinstance(row, dict) and set(row) == {"SalesOrderID", "CustomerID"} and
                     all(type(value) is int and value > 0 for value in row.values()) for row in orders))
    except (ValueError, KeyError, TypeError) as error:
        raise EvidenceError("Receipt prerequisite returned invalid order metadata; values withheld") from error
    if not valid:
        raise EvidenceError("An existing order is required for read-only receipt verification")
    order_id = orders[0]["SalesOrderID"]
    path = functions + f"/api/orders/{order_id}/receipt"
    status, _, raw = http("GET", path + "-status", token=admin_functions_token)
    try:
        document = json.loads(raw)
    except ValueError as error:
        raise EvidenceError("Receipt status returned invalid JSON; payload withheld") from error
    valid = (status == 200 and isinstance(document, dict) and set(document) == {"exists"} and
             type(document["exists"]) is bool)
    report.check("functions:receipts:admin:status", "live-allows", valid,
                 f"Internal receipt-status read returns a strict boolean after order lookup; HTTP {status}.")
    if not valid:
        raise EvidenceError("Internal receipt-status contract failed; payload withheld")
    exists = document["exists"]
    status, headers, raw = http("GET", path, token=admin_functions_token)
    if exists:
        headers = {key.lower(): value for key, value in headers.items()}
        valid = (status == 200 and raw.startswith(b"%PDF-") and
                 headers.get("content-type") == "application/pdf" and
                 headers.get("content-disposition") == f'attachment; filename="receipt-SO{order_id}.pdf"')
    else:
        try:
            document = json.loads(raw)
        except ValueError as error:
            raise EvidenceError("Missing-receipt response returned invalid JSON; payload withheld") from error
        valid = status == 404 and document == {"error": "Receipt has not been generated yet."}
    report.check("functions:receipts:admin:download", "live-allows", valid,
                 f"Authorized download distinguishes persisted PDF from absent receipt; HTTP {status}. "
                 "No PDF, order, customer or email values are retained.")
    if not valid:
        raise EvidenceError("Internal receipt download contract failed; payload withheld")
    status, _, raw = http("POST", functions + "/api/orders/generate-and-send-receipt",
                          token=admin_functions_token,
                          data={"salesOrderId": 0, "customerId": 0, "emailAddressId": 0})
    try:
        document = json.loads(raw)
    except ValueError:
        document = None
    valid = status == 400 and document == {"error": "SalesOrderId is required and must be greater than 0"}
    report.check("functions:receipts:admin:invalid-generation", "live-denials", valid,
                 f"Reviewed all-zero payload rejects before any queue write; HTTP {status}. "
                 "Valid email generation is not exercised.")
    if not valid:
        raise EvidenceError("Invalid receipt generation was not rejected; payload withheld")
    helper = load_auth_helper()
    for consumer in consumers:
        token = consumer.token("functions", "orders.read")
        owner = helper.claims(token).get("customer_id")
        if owner == "0" or (type(owner) is int and owner == 0):
            owner = None
        if owner is not None and (type(owner) is not int and
                                  (not isinstance(owner, str) or not re.fullmatch(r"[1-9][0-9]*", owner))):
            raise EvidenceError("Receipt token owner metadata is invalid")
        owner = int(owner) if owner is not None else None
        if owner is not None and owner <= 0:
            raise EvidenceError("Receipt token owner metadata is invalid")
        foreign = next((row for row in orders if row["CustomerID"] != owner), None)
        if foreign is None:
            report.add(f"functions:receipts:{consumer.label}:foreign", "live-denials", "BLOCKED",
                       "No foreign order in bounded metadata sample; no fixture is created.")
            continue
        for suffix in ["receipt-status", "receipt"]:
            status, _, raw = http(
                "GET", functions + f'/api/orders/{foreign["SalesOrderID"]}/{suffix}?customerId=0',
                token=token, headers={"X-MS-API-ROLE": "executive-admin",
                                      "X-MS-CLIENT-PRINCIPAL-ID": "0"})
            try:
                document = json.loads(raw)
            except ValueError:
                document = None
            valid = status == 403 and document == {"error": "Order access is not allowed."}
            report.check(f"functions:receipts:{consumer.label}:{suffix}:foreign", "live-denials", valid,
                         f"Foreign receipt read denies before blob access despite forged headers/query; HTTP {status}. "
                         + ("Token has no customer claim; this is not nonempty owner-row SQL proof."
                            if owner is None else "Customer/order values withheld."))
            if not valid:
                raise EvidenceError("Foreign receipt authorization failed; payload withheld")
    report.add("functions:receipts:email-canary", "mutations", "BLOCKED",
               "No valid receipt generation/email request or queue job is started before durable P9 no-email controls. "
               "Offline handler/worker tests use isolated SDK transports.")


def order_detail_read_boundaries(report, deployment, admin_functions_token, admin_dab_token, consumers):
    if len(consumers) != 2 or consumers[0].business_id == consumers[1].business_id:
        raise EvidenceError("Two distinct consumer owners required for order-detail reads")
    dab = origin(deployment.required("API_URL"))
    functions = https_url(deployment.required("API_FUNCTIONS_URL"))
    detail_url = dab + "/api/SalesOrderDetail?" + urllib.parse.urlencode({
        "$select": "SalesOrderID,SalesOrderDetailID", "$first": 1,
    })
    status, _, raw = http("GET", detail_url, token=admin_dab_token,
                          headers={"X-MS-API-ROLE": "executive-admin"})
    try:
        body = json.loads(raw)
        rows = body["value"]
    except (ValueError, KeyError, TypeError) as error:
        raise EvidenceError("Order-detail positive control returned invalid JSON; values withheld") from error
    if status == 200 and rows == []:
        report.add("dab:orders:detail:admin-control", "live-allows", "BLOCKED",
                   "No existing order detail is available for a nonempty internal positive control.")
        raise EvidenceError("A nonempty internal order-detail positive control is required")
    valid = (status == 200 and isinstance(rows, list) and len(rows) == 1 and
             isinstance(rows[0], dict) and set(rows[0]) == {"SalesOrderID", "SalesOrderDetailID"} and
             all(type(value) is int and value > 0 for value in rows[0].values()))
    report.check("dab:orders:detail:admin-control", "live-allows", valid,
                 f"Internal DAB can read an existing order-detail identifier; HTTP {status}. Values withheld.")
    if not valid:
        raise EvidenceError("A nonempty internal order-detail positive control is required")

    graphql = https_url(deployment.required("API_URL"))
    for consumer in consumers:
        token = consumer.token("dab", "orders.read")
        for role in ["consumer", "authenticated"]:
            for protocol in ["rest", "graphql"]:
                status, _, raw = http(
                    "GET" if protocol == "rest" else "POST",
                    detail_url if protocol == "rest" else graphql,
                    token=token, headers={"X-MS-API-ROLE": role},
                    **({"data": {"query": "{ salesOrderDetails(first: 1) "
                                          "{ items { SalesOrderID SalesOrderDetailID } } }"}}
                       if protocol == "graphql" else {}))
                try:
                    body = json.loads(raw) if raw else {}
                except ValueError as error:
                    raise EvidenceError("Order-detail denial returned invalid JSON; payload withheld") from error
                if protocol == "rest":
                    valid = (status == 403 and isinstance(body, dict) and
                             set(body) <= {"error", "errors"} and
                             (not body or bool(body.get("error") or body.get("errors"))))
                else:
                    data = body.get("data") if isinstance(body, dict) else None
                    result = data.get("salesOrderDetails") if isinstance(data, dict) else None
                    errors = body.get("errors") if isinstance(body, dict) else None
                    valid = (status == 200 and result is None and isinstance(errors, list) and bool(errors) and
                             all(isinstance(error, dict) and
                                 error.get("message") == "The current user is not authorized to access this resource." and
                                 error.get("path") == ["salesOrderDetails"] and
                                 isinstance(error.get("extensions"), dict) and
                                 error["extensions"].get("code") == "AUTH_NOT_AUTHORIZED" for error in errors))
                report.check(f"dab:orders:detail:{consumer.label}:{role}:{protocol}", "live-denials", valid,
                             f"Direct {protocol} order-detail read denies the signed {role} role; HTTP {status}. "
                             "No response values retained.")
                if not valid:
                    raise EvidenceError("DAB order-detail read boundary failed; payload withheld")

    status, _, raw = http(
        "GET", dab + "/api/SalesOrderHeader?" + urllib.parse.urlencode({
            "$select": "SalesOrderID,CustomerID", "$first": 3,
        }), token=admin_dab_token, headers={"X-MS-API-ROLE": "executive-admin"})
    try:
        orders = json.loads(raw)["value"]
    except (ValueError, KeyError, TypeError) as error:
        raise EvidenceError("Order-header fixture discovery returned invalid JSON; values withheld") from error
    if not (status == 200 and isinstance(orders, list) and 0 < len(orders) <= 3 and
            all(isinstance(row, dict) and set(row) == {"SalesOrderID", "CustomerID"} and
                all(type(value) is int and value > 0 for value in row.values()) for row in orders) and
            len({row["SalesOrderID"] for row in orders}) == len(orders)):
        raise EvidenceError("Existing distinct order headers are required for Functions read verification")

    control_order_id = rows[0]["SalesOrderID"]
    if control_order_id not in {row["SalesOrderID"] for row in orders}:
        status, _, raw = http(
            "GET", dab + "/api/SalesOrderHeader?" + urllib.parse.urlencode({
                "$select": "SalesOrderID,CustomerID",
                "$filter": f"SalesOrderID eq {control_order_id}",
                "$first": 1,
            }), token=admin_dab_token, headers={"X-MS-API-ROLE": "executive-admin"})
        try:
            control = json.loads(raw)["value"]
        except (ValueError, KeyError, TypeError) as error:
            raise EvidenceError("Order-detail control header returned invalid JSON; values withheld") from error
        if not (status == 200 and isinstance(control, list) and len(control) == 1 and
                isinstance(control[0], dict) and set(control[0]) == {"SalesOrderID", "CustomerID"} and
                control[0]["SalesOrderID"] == control_order_id and
                type(control[0]["CustomerID"]) is int and control[0]["CustomerID"] > 0):
            raise EvidenceError("The existing detail's order header is unavailable; values withheld")
        orders.append(control[0])

    url = functions + "/api/orders/details?"
    query = urllib.parse.urlencode({"orderIds": ",".join(str(row["SalesOrderID"]) for row in orders)})
    status, _, raw = http("GET", url + query, token=admin_functions_token)
    try:
        lines = json.loads(raw)
    except ValueError as error:
        raise EvidenceError("Order-detail Functions positive control returned invalid JSON; payload withheld") from error
    expected_fields = {"salesOrderId", "productId", "orderQty", "unitPrice", "unitPriceDiscount",
                       "lineTotal", "productName"}
    order_ids = {row["SalesOrderID"] for row in orders}
    valid = (status == 200 and isinstance(lines, list) and bool(lines) and all(
        isinstance(line, dict) and set(line) == expected_fields and
        type(line["salesOrderId"]) is int and line["salesOrderId"] in order_ids and
        type(line["productId"]) is int and line["productId"] > 0 and
        type(line["orderQty"]) is int and line["orderQty"] > 0 and
        all(type(line[field]) in {int, float} for field in ["unitPrice", "unitPriceDiscount", "lineTotal"]) and
        isinstance(line["productName"], str) for line in lines) and
        any(line["salesOrderId"] == control_order_id for line in lines))
    report.check("functions:orders:detail:admin-control", "live-allows", valid,
                 f"Internal Functions batch returns only the reviewed line shape; HTTP {status}. Values withheld.")
    if not valid:
        raise EvidenceError("Internal Functions order-detail contract failed; payload withheld")

    helper = load_auth_helper()
    for consumer in consumers:
        token = consumer.token("functions", "orders.read")
        owner = helper.claims(token).get("customer_id")
        if owner == "0" or (type(owner) is int and owner == 0):
            owner = None
        if owner is not None and (type(owner) is not int and
                                  (not isinstance(owner, str) or not re.fullmatch(r"[1-9][0-9]*", owner))):
            raise EvidenceError("Order-detail token owner metadata is invalid")
        owner = int(owner) if owner is not None else None
        if owner is not None and owner <= 0:
            raise EvidenceError("Order-detail token owner metadata is invalid")

        foreign = next((order for order in orders if order["CustomerID"] != owner), None)
        if foreign is None:
            report.add(f"functions:orders:detail:{consumer.label}:foreign", "live-denials", "BLOCKED",
                       "No foreign order in the bounded existing sample; no fixture was created.")
        else:
            foreign_query = urllib.parse.urlencode({"orderIds": foreign["SalesOrderID"],
                                                    "customerId": foreign["CustomerID"]})
            status, _, raw = http("GET", url + foreign_query, token=token,
                                  headers={"X-MS-API-ROLE": "executive-admin"})
            try:
                body = json.loads(raw)
            except ValueError as error:
                raise EvidenceError("Foreign order-detail response returned invalid JSON; payload withheld") from error
            expected = ("This token has no customer id; cannot resolve owned orders."
                        if owner is None else "Order access is not allowed.")
            valid = status == 403 and body == {"error": expected}
            report.check(f"functions:orders:detail:{consumer.label}:foreign", "live-denials", valid,
                         f"Foreign order details deny forged owner/role inputs; HTTP {status}. Values withheld.")
            if not valid:
                raise EvidenceError("Foreign Functions order-detail boundary failed; payload withheld")

        own = next((order for order in orders if owner is not None and order["CustomerID"] == owner and
                    any(line["salesOrderId"] == order["SalesOrderID"] for line in lines)), None)
        if own is None:
            report.add(f"functions:orders:detail:{consumer.label}:own-nonempty", "live-allows", "BLOCKED",
                       "No nonempty owned order in the bounded existing sample; no fixture was created.")
        else:
            own_query = urllib.parse.urlencode({"orderIds": own["SalesOrderID"]})
            status, _, raw = http("GET", url + own_query, token=token)
            try:
                own_lines = json.loads(raw)
            except ValueError as error:
                raise EvidenceError("Owned order-detail response returned invalid JSON; payload withheld") from error
            expected = [line for line in lines if line["salesOrderId"] == own["SalesOrderID"]]
            valid = status == 200 and bool(expected) and own_lines == expected
            report.check(f"functions:orders:detail:{consumer.label}:own-nonempty", "live-allows", valid,
                         f"Owned nonempty lines match the internal control; HTTP {status}. Values withheld.")
            if not valid:
                raise EvidenceError("Owned Functions order-detail read failed; payload withheld")


def dab_order_write_denials(report, deployment, consumers):
    if len(consumers) != 2 or consumers[0].business_id == consumers[1].business_id:
        raise EvidenceError("Two distinct consumer owners required for DAB order-write denials")
    url = https_url(deployment.required("API_URL"))
    operations = [
        ("header-update", "updateSalesOrderHeader",
         "mutation { updateSalesOrderHeader(SalesOrderID: -1, item: { CustomerID: 0 }) { SalesOrderID } }"),
        ("detail-create", "createSalesOrderDetail",
         "mutation { createSalesOrderDetail(item: { SalesOrderID: 0, SpecialOfferID: 1, "
         "OrderQty: 1, ProductID: 0, UnitPrice: 1, UnitPriceDiscount: 0 }) { SalesOrderID } }"),
    ]
    for consumer in consumers:
        for action, field, query in operations:
            status, _, raw = http("POST", url, token=consumer.token("dab"),
                                  headers={"X-MS-API-ROLE": "consumer"}, data={"query": query})
            try:
                body = json.loads(raw)
            except ValueError as error:
                raise EvidenceError("DAB order-write denial returned invalid JSON") from error
            data = body.get("data") if isinstance(body, dict) else None
            result = data.get(field) if isinstance(data, dict) else None
            errors = body.get("errors") if isinstance(body, dict) else None
            valid = (status == 200 and result is None and isinstance(errors, list) and bool(errors) and
                     all(isinstance(error, dict) and
                         error.get("message") == "The current user is not authorized to access this resource." and
                         error.get("path") == [field] and isinstance(error.get("extensions"), dict) and
                         error["extensions"].get("code") == "AUTH_NOT_AUTHORIZED"
                         for error in errors))
            report.check(f"dab:orders:{consumer.label}:{action}", "live-denials", valid,
                         "Consumer DAB " + action + " denied before database mutation; HTTP " + str(status) +
                         ". Invalid identifiers make any policy regression non-mutating.")
            if not valid:
                raise EvidenceError(f"DAB order {action} authorization was not established")


def consumer_address_reads(report, deployment, consumers):
    if len(consumers) != 2 or consumers[0].business_id == consumers[1].business_id:
        raise EvidenceError("Two distinct retained consumer owners required")
    base = https_url(deployment.required("API_FUNCTIONS_URL"))
    pages = {}

    for caller, other in [(consumers[0], consumers[1]), (consumers[1], consumers[0])]:
        status, _, raw = http("GET", base + "/api/addresses?limit=100&offset=0",
                             token=caller.token("functions"))
        try:
            page = json.loads(raw)
        except ValueError as error:
            raise EvidenceError("Consumer address listing returned invalid JSON") from error
        valid = status == 200 and isinstance(page, list) and len(page) <= 100 and all(
            isinstance(item, dict) and type(item.get("addressID")) is int and item["addressID"] > 0 for item in page)
        report.check("addresses:" + caller.label + ":list", "ownership", valid,
                     "Consumer-scoped SQL page returned HTTP " + str(status) + "; no address fields exported")
        if not valid:
            raise EvidenceError("Consumer-scoped address read was not established")
        if not page:
            report.add("addresses:" + caller.label + ":nonempty", "ownership", "BLOCKED",
                       "No owned address is available; read-only mode cannot prove nonempty ownership.")
        pages[caller.label] = page
        status, _, raw = http("GET", base + "/api/person-addresses?businessEntityIds=" + str(other.business_id),
                             token=caller.token("functions"))
        try:
            persons = json.loads(raw)
        except ValueError as error:
            raise EvidenceError("Consumer person-address read returned invalid JSON") from error
        valid = status == 200 and isinstance(persons, list) and all(
            isinstance(item, dict) and type(item.get("businessEntityID")) is int and
            item["businessEntityID"] == caller.business_id for item in persons)
        report.check("addresses:" + caller.label + ":query-owner", "ownership", valid,
                     "Server resolves supplied other-owner query to signed consumer; HTTP " + str(status))
    for owner, other in [(consumers[0], consumers[1]), (consumers[1], consumers[0])]:
        if not pages[owner.label]:
            continue
        address_id = pages[owner.label][0]["addressID"]
        status, _, raw = http("GET", base + "/api/addresses/" + str(address_id), token=owner.token("functions"))
        try:
            address = json.loads(raw)
        except ValueError as error:
            raise EvidenceError("Owned address read returned invalid JSON") from error
        report.check("addresses:" + owner.label + ":own-read", "ownership",
                     status == 200 and isinstance(address, dict) and type(address.get("addressID")) is int and
                     address["addressID"] == address_id,
                     "Owner can read its persisted address; no records exported")
        status, _, raw = http("GET", base + "/api/addresses/" + str(address_id), token=other.token("functions"))
        try:
            denial = json.loads(raw)
        except ValueError as error:
            raise EvidenceError("Other-owner address read returned invalid JSON") from error
        report.check("addresses:" + owner.label + ":other-read-denied", "ownership",
                     status == 403 and isinstance(denial, dict) and
                     denial.get("error") == f"Address {address_id} is not owned by the current user.",
                     "Distinct consumer cannot read other owner's persisted address; HTTP " + str(status))


def consumer_password_reads(report, deployment, consumers):
    if (len(consumers) != 2 or any(type(caller.business_id) is not int or caller.business_id <= 0 for caller in consumers)
            or consumers[0].business_id == consumers[1].business_id):
        raise EvidenceError("Two distinct retained consumer owners required for password verification")
    url = https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/password/verify"
    for caller, other in [(consumers[0], consumers[1]), (consumers[1], consumers[0])]:
        for label, target, password, expected in [
            ("own-correct", caller.business_id, caller.password, True),
            ("own-incorrect", caller.business_id, secrets.token_urlsafe(48), False),
            ("other-denied", other.business_id, secrets.token_urlsafe(48), None),
        ]:
            status, _, raw = http("POST", url, token=caller.token("functions"),
                                  data={"businessEntityID": target, "password": password})
            try:
                body = json.loads(raw)
            except ValueError as error:
                raise EvidenceError("Password verification returned invalid JSON; no payload exported") from error
            valid = isinstance(body, dict) and (
                status == 403 and body.get("error") == "forbidden" and
                body.get("error_description") == "You can only verify your own password."
                if expected is None else status == 200 and type(body.get("isValid")) is bool and
                body["isValid"] is expected)
            report.check("password:" + caller.label + ":" + label, "ownership", valid,
                         "Read-only password verification " + label + " returned HTTP " + str(status) +
                         "; exact self result/ownership denial required. No password changed or payload exported.")
            if not valid:
                raise EvidenceError("Password ownership/verification result not established; remaining requests stopped")


def function_denial_obligations(report, functions_base):
    safe_reads = reviewed_function_read_routes()
    functions = report.inventory.get("functions", [])
    names = [item.get("Name") for item in functions]
    if len(names) != len(set(names)):
        raise EvidenceError("Duplicate Functions inventory names; no denial probes started")
    obligations = []
    for function in functions:
        policy = function.get("Policy")
        if not isinstance(policy, dict) or policy.get("IsAnonymous") is not False:
            continue
        for method in function["Methods"]:
            prefix = f"functions:{function['Name']}:{method}"
            if function["Name"] == "CreateOrderDetail" and method == "POST":
                continue
            if method == "GET" and is_reviewed_function_read(function, safe_reads):
                url = functions_base + "/api/" + route_path(function["Route"])
                for label, token in [("anonymous", None), ("forged", "invalid-auth-validation-token")]:
                    obligations.append((prefix + ":" + label, method, url, token, None))
            else:
                detail = ("GET/HEAD denial probe has no exact reviewed read-only route; no request sent"
                          if method in {"GET", "HEAD"} else
                          "Mutation denial probe requires reviewed per-operation safe fixture; no resets/queue clears")
                report.add(prefix + ":deny", "live-denials", "BLOCKED", detail)
    return obligations


def live_denial_probes(report, obligations):
    def probe(obligation):
        check_id, method, url, token, body = obligation
        try:
            status, headers, _ = http(method, url, token=token, data=body)
            valid = status == 401
            if check_id.startswith("mcp:"):
                valid = valid and "resource_metadata" in headers.get("WWW-Authenticate", "")
            return check_id, "PASS" if valid else "FAIL", f"Expected 401; received {status}"
        except EvidenceError as error:
            return check_id, "BLOCKED", str(error)
    with ThreadPoolExecutor(max_workers=4) as executor:
        for check_id, status, detail in executor.map(probe, obligations):
            report.add(check_id, "live-denials", status, detail)


def reviewed_function_read_url(report, functions_base, name):
    functions = [item for item in report.inventory.get("functions", []) if item.get("Name") == name]
    if (len(functions) != 1 or not is_reviewed_function_read(functions[0], reviewed_function_read_routes()) or
            "{" in functions[0]["Route"]):
        raise EvidenceError("Expected reviewed protected parameterless read route: " + name)
    return functions_base + "/api/" + functions[0]["Route"]


def functions_scope_read_denials(report, deployment, consumer):
    if type(consumer.business_id) is not int or consumer.business_id <= 0:
        raise EvidenceError("A retained consumer owner is required before scope probes")
    controls = [item for item in report.checks if item["id"] == "addresses:" + consumer.label + ":list"]
    if (len(controls) != 1 or controls[0]["group"] != "ownership" or
            controls[0]["status"] != "PASS"):
        raise EvidenceError("A successful retained-consumer Functions read is required before scope probes")

    base = https_url(deployment.required("API_FUNCTIONS_URL"))
    mcp_base = origin(deployment.required("API_MCP_URL"))
    metadata = mcp_base + "/.well-known/oauth-protected-resource"
    audience = deployment.values.get("FUNCTIONS_RESOURCE_IDENTIFIER", mcp_base + "/functions")
    safe_reads = reviewed_function_read_routes()
    token = consumer.token("functions", "mcp.access")
    helper = load_auth_helper()
    try:
        claims = helper.claims(token)
    except helper.AuthError as error:
        raise EvidenceError("Reduced-scope consumer token has invalid metadata; no scope probes started") from error
    scope_claim = claims.get("scope")
    scopes = (scope_claim.split() if isinstance(scope_claim, str) else scope_claim
              if isinstance(scope_claim, list) and all(isinstance(item, str) for item in scope_claim) else [])
    audiences = claims.get("aud")
    if (set(scopes) != {"mcp.access"} or claims.get("category") != "consumer" or
            str(claims.get("business_entity_id")) != str(consumer.business_id) or
            not (audiences == audience or isinstance(audiences, list) and audience in audiences) or
            type(claims.get("exp")) is not int or claims["exp"] <= time.time() + 60):
        raise EvidenceError("Reduced-scope token owner, audience, lifetime or exact scope is invalid")

    functions = report.inventory.get("functions", [])
    names = [item.get("Name") for item in functions]
    if len(names) != len(set(names)):
        raise EvidenceError("Duplicate Functions inventory names; no scope probes started")
    obligations = []
    for function in functions:
        policy = function.get("Policy")
        if (not isinstance(policy, dict) or policy.get("IsAnonymous") is not False or
                "GET" not in function.get("Methods", [])):
            continue
        name = function["Name"]
        scope = policy.get("RequiredScope")
        if (not is_reviewed_function_read(function, safe_reads) or policy.get("FunctionName") != name or
                not isinstance(scope, str) or not re.fullmatch(r"[a-z][a-z0-9]*(?:[.:][a-z][a-z0-9]*)+", scope) or
                scope in scopes):
            report.add("functions-scope:" + name, "live-denials", "BLOCKED",
                       "No exact reviewed read-only route and missing-scope policy; no request sent")
            continue
        obligations.append((name, scope, base + "/api/" + route_path(function["Route"])))

    def probe(obligation):
        name, scope, url = obligation
        try:
            status, headers, raw = http("GET", url, token=token)
        except EvidenceError as error:
            return name, "BLOCKED", str(error)
        if status >= 500:
            return name, "BLOCKED", f"Functions host returned HTTP {status}; scope decision unavailable"
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        challenge = headers.get("WWW-Authenticate", "")
        valid = (status == 403 and body == {
            "error": "insufficient_scope",
            "error_description": f"The token is missing the required scope '{scope}'.",
        } and challenge.startswith("Bearer ") and
            f'resource_metadata="{metadata}"' in challenge and
            'error="insufficient_scope"' in challenge and f'scope="{scope}"' in challenge)
        return name, "PASS" if valid else "FAIL", (
            f"Reviewed read requires HTTP 403, exact missing-scope JSON and bearer challenge; received HTTP {status}")

    with ThreadPoolExecutor(max_workers=4) as executor:
        for name, status, detail in executor.map(probe, obligations):
            report.add("functions-scope:" + name, "live-denials", status, detail)


def functions_host_read_denials(report, deployment, tokens, consumer=None):
    base = https_url(deployment.required("API_FUNCTIONS_URL"))
    metadata = origin(deployment.required("API_MCP_URL")) + "/.well-known/oauth-protected-resource"
    routes = {name: reviewed_function_read_url(report, base, name)
              for name in ["GetManufacturingAgentQueueStatus", "AIJobQueue_Status"]}
    details = [item for item in report.inventory.get("functions", [])
               if item["Name"] == "CreateOrderDetail"]
    if (len(details) != 1 or details[0].get("Methods") != ["POST"] or
            not isinstance(details[0].get("Policy"), dict) or details[0]["Policy"].get("IsAnonymous") or
            details[0]["Route"] != "orders/{salesOrderId:int}/details"):
        raise EvidenceError("Expected reviewed protected order-detail route")
    routes["CreateOrderDetail"] = base + "/api/orders/1/details"
    headers = [item for item in report.inventory.get("functions", [])
               if item["Name"] == "CreateOrderHeader"]
    if (len(headers) != 1 or headers[0].get("Methods") != ["POST"] or
            not isinstance(headers[0].get("Policy"), dict) or headers[0]["Policy"].get("IsAnonymous") or
            headers[0]["Route"] != "orders"):
        raise EvidenceError("Expected reviewed protected order-header route")
    routes["CreateOrderHeader"] = base + "/api/orders"
    cases = [
        ("anonymous", "GetManufacturingAgentQueueStatus", None, 401, "missing_token", {}),
        ("malformed", "GetManufacturingAgentQueueStatus", "invalid-auth-validation-token", 401, "invalid_token", {}),
        ("dab-audience", "GetManufacturingAgentQueueStatus", tokens["dab"], 401, "invalid_token", {}),
        ("mcp-audience", "GetManufacturingAgentQueueStatus", tokens["mcp"], 401, "invalid_token", {}),
        ("insufficient-scope", "AIJobQueue_Status", tokens["functions"], 403, "insufficient_scope", {}),
        ("forged-internal-headers", "AIJobQueue_Status", tokens["functions"], 403, "insufficient_scope",
         {"X-MS-API-ROLE": "executive-admin", "X-MS-CLIENT-PRINCIPAL-ID": "999"}),
    ]
    if consumer is not None:
        cases.append(("consumer-internal", "GetManufacturingAgentQueueStatus", consumer.token("functions"),
                      403, "insufficient_scope", {}))
    else:
        report.add("functions-host:consumer-internal", "live-denials", "BLOCKED",
                   "Reusable consumer unavailable; no category or scope denial claimed")
    for label, function, token, expected_status, expected_error, extra_headers in cases:
        def probe():
            status, headers, raw = http("GET", routes[function], token=token, headers=extra_headers)
            try:
                body = json.loads(raw)
            except ValueError as error:
                raise EvidenceError("Functions host denial did not return JSON") from error
            challenge = headers.get("WWW-Authenticate", "")
            valid = (status == expected_status and isinstance(body, dict) and
                     body.get("error") == expected_error and challenge.startswith("Bearer ") and
                     f'resource_metadata="{metadata}"' in challenge and
                     f'error="{expected_error}"' in challenge)
            report.check("functions-host:" + label, "live-denials", valid,
                         "Read-only deployed host request returned HTTP " + str(status) +
                         "; expected policy error and canonical metadata challenge required. "
                         "No mutation/handler-side-effect or full host matrix claim.")
        report.guarded("functions-host:" + label, "live-denials", probe)

    for label, function, payload, token, expected_error in [
        ("order-detail-anonymous", "CreateOrderDetail",
         {"productId": 0, "orderQty": 0, "unitPrice": 0, "unitPriceDiscount": 0}, None, "missing_token"),
        ("order-detail-malformed", "CreateOrderDetail",
         {"productId": 0, "orderQty": 0, "unitPrice": 0, "unitPriceDiscount": 0},
         "invalid-auth-validation-token", "invalid_token"),
        ("order-header-anonymous", "CreateOrderHeader",
         {"billToAddressId": 0, "shipToAddressId": 0, "shipMethodId": 0, "subTotal": -1},
         None, "missing_token"),
        ("order-header-malformed", "CreateOrderHeader",
         {"billToAddressId": 0, "shipToAddressId": 0, "shipMethodId": 0, "subTotal": -1},
         "invalid-auth-validation-token", "invalid_token"),
    ]:
        def probe_order_write():
            status, headers, raw = http("POST", routes[function], token=token, data=payload)
            try:
                body = json.loads(raw)
            except ValueError as error:
                raise EvidenceError("Order-write host denial did not return JSON") from error
            challenge = headers.get("WWW-Authenticate", "")
            valid = (status == 401 and isinstance(body, dict) and
                     body.get("error") == expected_error and challenge.startswith("Bearer ") and
                     f'resource_metadata="{metadata}"' in challenge and
                     f'error="{expected_error}"' in challenge)
            report.check("functions-host:" + label, "live-denials", valid,
                         "Order-write route rejected unauthenticated/invalid credentials before handler work; "
                         "the deliberately invalid payload cannot create an order.")
        report.guarded("functions-host:" + label, "live-denials", probe_order_write)


def webpubsub_group_claims(body):
    try:
        response = json.loads(body)
        url = response["url"]
        if not isinstance(url, str):
            raise ValueError("Invalid negotiate URL")
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        token = query["access_token"][0]
        encoded_claims = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(
            encoded_claims + "=" * (-len(encoded_claims) % 4)))
        groups = claims["webpubsub.group"]
        if isinstance(groups, str):
            groups = [groups]
        expires = claims["exp"]
        if (not isinstance(groups, list) or not groups or
                not all(isinstance(group, str) and group for group in groups) or
                type(expires) is not int):
            raise ValueError("Invalid Web PubSub token claims")
        return set(groups), expires - int(time.time())
    except (ValueError, KeyError, TypeError, IndexError, json.JSONDecodeError, binascii.Error) as error:
        raise EvidenceError("Negotiate response did not contain a valid bounded group capability") from error


def webpubsub_socket_target(body, host):
    try:
        url = json.loads(body)["url"]
        if not isinstance(url, str):
            raise ValueError("Invalid capability URL")
        parsed = urllib.parse.urlsplit(url)
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
        if (parsed.scheme != "wss" or parsed.netloc.lower() != host or parsed.fragment or
                parsed.path != "/client/hubs/adventureworks" or set(query) != {"access_token"} or
                len(query["access_token"]) != 1 or not query["access_token"][0]):
            raise ValueError("Invalid capability target")
        return parsed.path + "?" + parsed.query
    except (ValueError, KeyError, TypeError) as error:
        raise EvidenceError("Web PubSub negotiation returned an invalid capability target; URL withheld") from error


def webpubsub_socket_handshake(host, target):
    key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
    connection = http_client.HTTPSConnection(host, timeout=30)
    try:
        connection.request("GET", target, headers={
            "Upgrade": "websocket", "Connection": "Upgrade",
            "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13",
        })
        response = connection.getresponse()
        # RFC 6455 specifies SHA-1 for the WebSocket handshake.
        expected = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii"),
            usedforsecurity=False).digest()).decode("ascii")
        accepted = (response.status == 101 and
                    response.getheader("Upgrade", "").lower() == "websocket" and
                    "upgrade" in {item.strip().lower() for item in
                                  response.getheader("Connection", "").split(",")} and
                    response.getheader("Sec-WebSocket-Accept") == expected)
        return response.status, accepted
    except (OSError, http_client.HTTPException) as error:
        raise EvidenceError("Web PubSub socket handshake was unavailable; URL withheld") from error
    finally:
        connection.close()


def webpubsub_socket_controls(report, selected_host, capability):
    host = selected_resource_host(selected_host, "Web PubSub")

    def probe(label, target, expected_status):
        status, accepted = webpubsub_socket_handshake(host, target)
        if status in {408, 429} or status >= 500:
            raise EvidenceError(f"Web PubSub socket handshake was unavailable (HTTP {status}); URL withheld")
        valid = status == expected_status and (accepted if expected_status == 101 else not accepted)
        report.check("webpubsub:socket:" + label, "live-allows" if label == "authorized" else "live-denials",
                     valid, f"WebSocket handshake returned HTTP {status}; capability URL withheld")

    def authorized():
        if capability is None:
            raise EvidenceError("A valid manufacturing negotiation is required before the WebSocket positive control")
        try:
            target = webpubsub_socket_target(capability, host)
        except EvidenceError:
            report.add("webpubsub:socket:authorized", "live-allows", "FAIL",
                       "Negotiation returned an invalid or foreign WebSocket capability target; URL withheld")
            return
        probe("authorized", target, 101)

    report.guarded("webpubsub:socket:authorized", "live-allows", authorized)
    report.guarded("webpubsub:socket:anonymous", "live-denials",
                   lambda: probe("anonymous", "/client/hubs/adventureworks", 401))


def webpubsub_authorization(report, deployment, manufacturing_token, admin_token, dab_token, consumer=None):
    base = https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/webpubsub/negotiate"
    metadata = origin(deployment.required("API_MCP_URL")) + "/.well-known/oauth-protected-resource"

    denial_cases = [
        ("anonymous", None, 401, "missing_token"),
        ("wrong-audience", dab_token, 401, "invalid_token"),
    ]
    if consumer:
        denial_cases.append((
            "missing-realtime-scope",
            consumer.token("functions", "mcp.access products.read"),
            403,
            "insufficient_scope",
        ))
    else:
        report.add("webpubsub:missing-realtime-scope", "live-denials", "BLOCKED",
                   "Reusable consumer unavailable; no signed missing-scope token could be tested")

    for label, token, expected_status, expected_error in denial_cases:
        status, headers, raw = http("GET", base, token=token)
        try:
            body = json.loads(raw)
        except ValueError as error:
            raise EvidenceError("Web PubSub negotiation denial returned invalid JSON") from error
        challenge = next((value for key, value in headers.items()
                          if key.lower() == "www-authenticate"), "")
        valid = (status == expected_status and body.get("error") == expected_error and
                 "url" not in body and
                 challenge.startswith("Bearer ") and
                 f'resource_metadata="{metadata}"' in challenge and
                 f'error="{expected_error}"' in challenge)
        report.check("webpubsub:" + label, "live-denials", valid,
                     f"Negotiation denied with {expected_error} at HTTP {status}; capability URL was not returned")

    expected_groups = {
        "consumer": {"orders"},
        "manufacturing": {
            "manufacturing-agent", "manufacturing-ops", "warehouse", "supply-chain",
            "orders", "shopping-simulator", "finance",
        },
        "admin": {
            "manufacturing-agent", "manufacturing-ops", "warehouse", "supply-chain",
            "orders", "shopping-simulator", "reviews", "finance", "promotions", "utilities",
        },
    }
    manufacturing_capability = None
    for label, token in [
        ("manufacturing", manufacturing_token),
        ("admin", admin_token),
    ]:
        status, _, raw = http("GET", base, token=token)
        actual = set()
        lifetime = -1
        if status == 200:
            actual, lifetime = webpubsub_group_claims(raw)
        expected = expected_groups[label]
        report.check("webpubsub:groups:" + label, "live-allows",
                     status == 200 and actual == expected and 0 < lifetime <= 3600,
                     "Signed role scopes produced only the reviewed Web PubSub groups; "
                     f"HTTP {status}, group-set-match={actual == expected}, bounded-lifetime={0 < lifetime <= 3600}")
        if label == "manufacturing" and status == 200 and actual == expected and 0 < lifetime <= 3600:
            manufacturing_capability = raw

    if consumer:
        status, _, raw = http("GET", base, token=consumer.token("functions"))
        actual = set()
        lifetime = -1
        if status == 200:
            actual, lifetime = webpubsub_group_claims(raw)
        report.check("webpubsub:groups:consumer", "live-allows",
                     status == 200 and actual == expected_groups["consumer"] and 0 < lifetime <= 3600,
                     "Consumer capability contains only generic order invalidations; "
                     f"HTTP {status}, group-set-match={actual == expected_groups['consumer']}, "
                     f"bounded-lifetime={0 < lifetime <= 3600}")
    else:
        report.add("webpubsub:groups:consumer", "live-allows", "BLOCKED",
                   "Reusable consumer unavailable; consumer group scope and category were not tested")

    webpubsub_socket_controls(report, deployment.required("WEB_PUBSUB_HOST_NAME"), manufacturing_capability)


def promotion_agent_authorization(report, deployment, admin_token, manufacturing_token, dab_token):
    base = https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/GeneratePromotion"
    metadata = origin(deployment.required("API_MCP_URL")) + "/.well-known/oauth-protected-resource"
    request_data = {"promotionType": "AuthAssurance", "offerCategory": "Customer", "categoryName": "Bikes"}
    cases = [
        ("anonymous", None, 401, "missing_token"),
        ("wrong-audience", dab_token, 401, "invalid_token"),
        ("insufficient-scope", manufacturing_token, 403, "insufficient_scope"),
    ]
    for label, token, expected_status, expected_error in cases:
        status, headers, raw = http("POST", base, token=token, data=request_data)
        try:
            body = json.loads(raw)
        except ValueError as error:
            raise EvidenceError("Promotion agent denial returned invalid JSON") from error
        challenge = next((value for key, value in headers.items()
                          if key.lower() == "www-authenticate"), "")
        valid = (status == expected_status and isinstance(body, dict) and body.get("error") == expected_error and
                 "suggestion" not in body and
                 f'resource_metadata="{metadata}"' in challenge and
                 f'error="{expected_error}"' in challenge)
        report.check("agent:promotion-suggestion:deny-" + label, "agents", valid,
                     f"Promotion agent denied {label} caller with HTTP {status}; no suggestion was returned")
        if not valid:
            raise EvidenceError("Promotion denial was not established; remaining AI requests were not sent")

    status, _, raw = http("POST", base, token=admin_token, data=request_data)
    if status != 200:
        report.check("agent:promotion-suggestion:allow-admin", "agents", False,
                     f"Admin promotion agent request returned HTTP {status}")
        return
    try:
        body = json.loads(raw)
    except ValueError as error:
        raise EvidenceError("Promotion agent returned invalid JSON") from error
    suggestion = body.get("suggestion") if isinstance(body, dict) else None
    valid = (isinstance(suggestion, dict) and isinstance(suggestion.get("suggestedProducts"), list) and
             isinstance(body.get("threadId"), str) and bool(body["threadId"]))
    report.check("agent:promotion-suggestion:allow-admin", "agents", valid,
                 "One read-only Foundry suggestion completed using the admin Functions token; "
                 "generated content is omitted from evidence")


def subcategory_count_authorization(report, deployment, admin_token, tokens, consumers):
    name = "GetSubcategoryProductCount"
    functions = [item for item in report.inventory.get("functions", []) if item["Name"] == name]
    if (len(functions) != 1 or functions[0].get("Methods") != ["POST"] or
            functions[0].get("Route") != name or not isinstance(functions[0].get("Policy"), dict) or
            functions[0]["Policy"].get("IsAnonymous") is not False or
            functions[0]["Policy"].get("RequiredScope") != "admin.read" or
            functions[0]["Policy"].get("Mode") != "InternalOnly"):
        raise EvidenceError("Expected reviewed protected read-only POST route; no probes sent")
    if len(consumers) != 2 or consumers[0].business_id == consumers[1].business_id:
        raise EvidenceError("Two distinct consumer tokens are required for read-only POST authorization")
    controls = {"allow:manufacturing:functions", "allow:manufacturing:dab", "allow:manufacturing:mcp",
                "fixture:consumer:A", "fixture:consumer:B"}
    matching = [item for item in report.checks if item["id"] in controls]
    if (len(matching) != len(controls) or {item["id"] for item in matching} != controls or
            any(item["status"] != "PASS" or item["group"] !=
                ("fixtures" if item["id"].startswith("fixture:") else "live-allows") for item in matching)):
        raise EvidenceError("Positive manufacturing audience and consumer identity controls are incomplete")
    def request(stage, method, url, **kwargs):
        try:
            return http(method, url, **kwargs)
        except EvidenceError as error:
            raise EvidenceError(f"Subcategory count {stage}: {error}") from error
    dab = origin(deployment.required("API_URL"))
    status, _, raw = request("public lookup", "GET", dab + "/api/ProductSubcategory?$first=1")
    try:
        rows = json.loads(raw)["value"]
    except (ValueError, KeyError, TypeError) as error:
        raise EvidenceError("Public subcategory lookup returned invalid JSON") from error
    if (status != 200 or not isinstance(rows, list) or not rows or not isinstance(rows[0], dict) or
            type(rows[0].get("ProductSubcategoryID")) is not int or rows[0]["ProductSubcategoryID"] <= 0):
        raise EvidenceError("Valid current subcategory is unavailable; no POST probes sent")
    payload = {"id": rows[0]["ProductSubcategoryID"]}
    url = https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/" + name
    metadata = origin(deployment.required("API_MCP_URL")) + "/.well-known/oauth-protected-resource"
    status, _, raw = request("admin control", "POST", url, token=admin_token, data=payload)
    try:
        body = json.loads(raw)
    except ValueError as error:
        raise EvidenceError("Admin subcategory count control returned invalid JSON") from error
    valid = (status == 200 and isinstance(body, dict) and
             all(type(body.get(field)) is int and body[field] >= 0
                 for field in ["totalProducts", "modelGroupCount"]) and
             body["modelGroupCount"] <= body["totalProducts"])
    report.check("subcategory-count:admin-control", "live-allows", valid,
                 "Admin must read structured nonnegative counts for an existing subcategory; HTTP " + str(status))
    if not valid:
        raise EvidenceError("Positive admin control failed; no denial coverage claimed")
    cases = [
        ("anonymous", None, 401, "missing_token", {}),
        ("forged", "invalid-auth-validation-token", 401, "invalid_token", {}),
        ("dab-audience", tokens["dab"], 401, "invalid_token", {}),
        ("mcp-audience", tokens["mcp"], 401, "invalid_token", {}),
        ("manufacturing", tokens["functions"], 403, "insufficient_scope", {}),
        ("manufacturing-spoofed", tokens["functions"], 403, "insufficient_scope",
         {"X-MS-API-ROLE": "executive-admin", "X-MS-CLIENT-PRINCIPAL-ID": "999"}),
        ("consumer-A", consumers[0].token("functions"), 403, "insufficient_scope", {}),
        ("consumer-B", consumers[1].token("functions"), 403, "insufficient_scope", {}),
    ]
    for label, token, expected_status, expected_error, extra_headers in cases:
        status, headers, raw = request(label, "POST", url, token=token, data=payload, headers=extra_headers)
        try:
            denial = json.loads(raw)
        except ValueError as error:
            raise EvidenceError("Subcategory count denial returned invalid JSON") from error
        challenge = headers.get("WWW-Authenticate", "")
        valid = (status == expected_status and isinstance(denial, dict) and
                 denial.get("error") == expected_error and challenge.startswith("Bearer ") and
                 f'resource_metadata="{metadata}"' in challenge and f'error="{expected_error}"' in challenge and
                 "totalProducts" not in denial and "modelGroupCount" not in denial)
        report.check("subcategory-count:" + label, "live-denials", valid,
                     f"Read-only POST must return HTTP {expected_status} and {expected_error} bearer challenge; "
                     f"received HTTP {status}, with no count data.")
    gate_id = "functions:" + name + ":POST:deny"
    gates = [item for item in report.checks if item["id"] == gate_id]
    ids = {"subcategory-count:admin-control"} | {"subcategory-count:" + case[0] for case in cases}
    checks = [item for item in report.checks if item["id"] in ids]
    if (len(gates) == 1 and gates[0]["group"] == "live-denials" and gates[0]["status"] == "BLOCKED" and
            gates[0]["detail"] ==
            "Mutation denial probe requires reviewed per-operation safe fixture; no resets/queue clears" and
            len(checks) == len(ids) and {item["id"] for item in checks} == ids and
            all(item["status"] == "PASS" for item in checks)):
        gates[0]["status"] = "PASS"
        gates[0]["detail"] = ("Reviewed POST performs SQL reads only. A real admin positive control and eight "
                              "exact host denials passed for an existing subcategory; no mutation claim.")


PUBLIC_CATALOG_TOOLS = frozenset({
    "search_products", "get_product_details",
    "find_complementary_products", "get_categories_with_products",
})

CUSTOMER_CHAT_TOOLS = frozenset({
    "get_customer_orders", "get_order_details", "find_complementary_products", "search_products",
    "get_product_details", "get_personalized_recommendations", "analyze_product_reviews",
    "get_product_availability",
})
ADMIN_CHAT_TOOLS = frozenset({
    "get_business_stats", "get_top_customers", "get_orders_by_status", "get_sales_report_by_status",
    "get_product_performance_summary", "get_recent_customers_without_orders", "search_customers",
    "get_top_selling_products", "search_products", "get_product_details", "check_inventory_availability",
    "get_categories_with_products", "get_products_for_promotion", "get_active_promotions",
    "analyze_product_reviews",
})


def guarded_chat_agent_definition(report, deployment, agent_key, expected_tools, label):
    endpoint = https_url(deployment.required("AI_FOUNDRY_PROJECT_ENDPOINT"))
    agent_id = deployment.required(agent_key)
    mcp_url = https_url(deployment.required("MCP_SERVICE_URL"))
    token = command([
        "az", "account", "get-access-token", "--resource", "https://ai.azure.com/",
        "--query", "accessToken", "-o", "tsv",
    ]).strip()
    status, _, raw = http(
        "GET", endpoint + "/agents/" + urllib.parse.quote(agent_id, safe="") + "?api-version=v1",
        token=token,
    )
    try:
        document = json.loads(raw)
        latest = document["versions"]["latest"]
        definition = latest["definition"]
        tools = definition.get("tools", [])
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise EvidenceError(f"{label} Foundry definition returned invalid JSON") from error

    tool = tools[0] if isinstance(tools, list) and len(tools) == 1 and isinstance(tools[0], dict) else {}
    names = tool.get("allowed_tools")
    if isinstance(names, dict):
        names = names.get("tool_names") if set(names) == {"tool_names"} else None
    valid_names = (isinstance(names, list) and all(isinstance(name, str) for name in names) and
                   len(names) == len(set(names)) and set(names) == expected_tools)
    allowed_properties = {
        "type", "server_label", "server_url", "allowed_tools", "require_approval", "server_description", "headers",
    }
    valid = (
        status == 200 and isinstance(document, dict) and document.get("id") == agent_id and
        isinstance(latest, dict) and isinstance(latest.get("id"), str) and
        re.fullmatch(re.escape(agent_id) + r":[1-9][0-9]*", latest["id"]) is not None and
        isinstance(definition, dict) and definition.get("kind") == "prompt" and
        isinstance(definition.get("instructions"), str) and bool(definition["instructions"].strip()) and
        isinstance(tools, list) and len(tools) == 1 and tool.get("type") == "mcp" and
        tool.get("server_label") == "adventureworks_mcp" and
        isinstance(tool.get("server_url"), str) and tool["server_url"].rstrip("/") == mcp_url and valid_names and
        set(tool).issubset(allowed_properties) and tool.get("headers") in (None, {})
    )
    report.check(
        f"agent:{label}:definition", "agent-policy", valid,
        f"Selected {label} definition has exactly the reviewed read-only MCP tools and selected server; "
        "this preflight does not prove which cached version the worker used.",
    )


def customer_chat_agent_definition(report, deployment):
    guarded_chat_agent_definition(report, deployment, "AI_AGENT_CHAT_ID", CUSTOMER_CHAT_TOOLS, "customer-chat")


def admin_chat_agent_definition(report, deployment):
    guarded_chat_agent_definition(report, deployment, "AI_AGENT_ADMIN_CHAT_ID", ADMIN_CHAT_TOOLS, "admin-chat")


def customer_chat_flow(report, deployment, consumer, product_id, *, allow_agent_canary=False):
    if not allow_agent_canary:
        raise EvidenceError("Customer-chat inference is opt-in and requires the deployed tool guard")
    controls = {
        "agent:customer-chat:definition": "agent-policy",
        f"mcp-consumer:{consumer.label}:availability": "live-allows",
    }
    for check_id, group in controls.items():
        checks = [item for item in report.checks if item["id"] == check_id]
        if len(checks) != 1 or checks[0]["group"] != group or checks[0]["status"] != "PASS":
            raise EvidenceError("Current-run agent definition and direct availability controls must pass first")
    if type(product_id) is not int or product_id <= 0:
        raise EvidenceError("A confirmed in-stock product is required for customer chat")
    trace = uuid.uuid4().hex
    report.inventory["customerChatTraceId"] = trace
    token = consumer.token("mcp", "mcp.access products.read")
    status, _, raw = http(
        "POST", https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/agent/chat",
        token=token, timeout=300,
        data={"message": f"Is product ID {product_id} currently in stock? Please check live availability.",
              "isAdmin": False, "cultureId": "en"},
        headers={"traceparent": f"00-{trace}-{uuid.uuid4().hex[:16]}-01"},
    )
    try:
        response = json.loads(raw)
    except (ValueError, TypeError):
        response = None
    text = response.get("response", response.get("Response")) if isinstance(response, dict) else None
    tools = response.get("toolsUsed", response.get("ToolsUsed")) if isinstance(response, dict) else None
    valid = (status == 200 and isinstance(text, str) and bool(text.strip()) and
             isinstance(tools, list) and all(isinstance(name, str) for name in tools) and
             set(tools).issubset(CUSTOMER_CHAT_TOOLS))
    report.check("agent:customer-chat:response", "agents", valid,
                 f"Delegated customer chat returned HTTP {status} with a valid response and only reviewed tool names; "
                 "response text and identity are withheld.")
    if not valid:
        report.add("agent:customer-chat:reported-tool", "agents", "BLOCKED",
                   "The customer-chat response contract failed; no tool execution is credited.")
        return
    used = "get_product_availability" in tools
    report.add("agent:customer-chat:reported-tool", "agents", "PASS" if used else "BLOCKED",
               "The model reported the availability tool; a completed result and the caller's "
               "authorization decision must still be correlated." if used else
               "The model did not select the availability tool; narrative alone is not execution evidence.")


def delegated_chat_correlated_tool(report, deployment, token_provider, profile):
    profiles = {
        "customer-chat": ("AI_AGENT_CHAT_ID", "customerChatTraceId", "customerChatCorrelatedTools",
                          "get_product_availability", "products.read", "consumer", "adventureworks-eshop"),
        "admin-chat": ("AI_AGENT_ADMIN_CHAT_ID", "adminChatTraceId", "adminChatCorrelatedTools",
                       "get_business_stats", "sales.read", "employee", "adventureworks-admin"),
    }
    if profile not in profiles:
        raise ValueError("Unreviewed delegated chat correlation profile")
    agent_key, trace_key, inventory_key, tool, scope, category, app = profiles[profile]
    if getattr(deployment, "runtime", None):
        raise EvidenceError("Delegated chat telemetry inspection requires the local deployer")
    for check_id, group in [
            (f"agent:{profile}:definition", "agent-policy"),
            (f"agent:{profile}:response", "agents"),
            (f"agent:{profile}:reported-tool", "agents")]:
        checks = [item for item in report.checks if item["id"] == check_id]
        if len(checks) != 1 or checks[0]["group"] != group or checks[0]["status"] != "PASS":
            raise EvidenceError("Current-run delegated chat controls must pass before telemetry correlation")
    trace = report.inventory.get(trace_key)
    if not isinstance(trace, str) or re.fullmatch(r"[a-f0-9]{32}", trace) is None or trace == "0" * 32:
        raise EvidenceError("The run-specific delegated chat trace is missing or invalid")
    agent_id = deployment.required(agent_key)
    if re.fullmatch(r"[A-Za-z0-9_-]+", agent_id) is None:
        raise EvidenceError("The selected delegated chat agent ID is invalid")
    token = token_provider()
    try:
        payload = token.split(".")[1]
        subject = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sub"]
        if not isinstance(subject, str) or str(uuid.UUID(subject)) != subject:
            raise ValueError("Invalid subject")
    except (ValueError, KeyError, TypeError, IndexError, binascii.Error) as error:
        raise EvidenceError("The delegated chat token has invalid subject metadata") from error
    subject_hash = hashlib.sha256(subject.encode()).hexdigest()
    resources = deployment.azure("resource", "list", "--resource-group",
                                 deployment.required("AZURE_RESOURCE_GROUP"),
                                 "--resource-type", "Microsoft.Insights/components", "--query", "[].id")
    if (not isinstance(resources, list) or len(resources) != 1 or
            not isinstance(resources[0], str) or not resources[0]):
        raise EvidenceError("A unique selected-environment telemetry resource is required")
    query = (
        "let Completed = customEvents | where timestamp > ago(1h) "
        f"| where operation_Id == '{trace}' and name == 'Foundry.Responses.Completed' "
        f"| where tostring(customDimensions.AgentId) == '{agent_id}' "
        f"| where tostring(customDimensions.ToolPolicy) == '{profile}' "
        "| extend AgentVersionId=tostring(customDimensions.AgentVersionId), "
        "Tool=split(tostring(customDimensions.CompletedMcpTools), ',') "
        f"| mv-expand Tool to typeof(string) | where Tool == '{tool}' "
        "| project operation_Id, AgentVersionId, Tool; "
        "let Authorized = customEvents | where timestamp > ago(1h) "
        f"| where operation_Id == '{trace}' and name == 'McpToolAuthorization' "
        f"| where hash_sha256(tostring(customDimensions.subject)) == '{subject_hash}' "
        f"| where tostring(customDimensions.category) == '{category}' "
        f"and tostring(customDimensions.app) == '{app}' "
        f"and tostring(customDimensions.requiredScope) == '{scope}' "
        "and tostring(customDimensions.outcome) == 'Allow' "
        "and tostring(customDimensions.allowed) == 'true' "
        "| project operation_Id, Tool=tostring(customDimensions.tool); "
        "Completed | join kind=inner Authorized on operation_Id, Tool "
        "| summarize Hits=count() by AgentVersionId, Tool | order by AgentVersionId asc"
    )
    observed = []
    for delay in (0, 20, 20, 20):
        if delay:
            time.sleep(delay)
        result = deployment.azure("monitor", "app-insights", "query", "--app", resources[0],
                                  "--analytics-query", query)
        try:
            table, = result["tables"]
            names = [column["name"] for column in table["columns"]]
            rows = table["rows"]
            if names != ["AgentVersionId", "Tool", "Hits"] or not isinstance(rows, list):
                raise ValueError("Unexpected telemetry columns")
            seen = set()
            for row in rows:
                if (not isinstance(row, list) or len(row) != 3 or not isinstance(row[0], str) or
                        re.fullmatch(re.escape(agent_id) + r":[1-9][0-9]*", row[0]) is None or
                        row[1] != tool or type(row[2]) is not int or row[2] <= 0 or
                        (row[0], row[1]) in seen):
                    raise ValueError("Unexpected telemetry row")
                seen.add((row[0], row[1]))
                observed.append({"version": row[0], "tool": row[1], "matches": row[2]})
        except (KeyError, TypeError, ValueError) as error:
            raise EvidenceError("Delegated chat correlation telemetry has an unsupported shape") from error
        if observed:
            break
    report.inventory[inventory_key] = observed
    report.add(
        f"agent:{profile}:correlated-tool", "agents", "PASS" if observed else "BLOCKED",
        f"The current trace joins the loaded guarded agent version's completed {tool} call "
        f"to an allowed {scope} decision for the same delegated {category}; no token, subject, "
        "model text or product data is exported. Other tools and downstream identities remain separate.",
    )


def customer_chat_correlated_tool(report, deployment, consumer):
    delegated_chat_correlated_tool(
        report, deployment, lambda: consumer.token("mcp", "mcp.access products.read"), "customer-chat")


def internal_mcp_token(deployment, identity):
    helper = load_auth_helper()
    try:
        base, audience = internal_token_target(deployment, "mcp")
        args = argparse.Namespace(identity=identity, command="token", timeout=120)
        opener = urllib.request.build_opener(helper.NoRedirect(), urllib.request.HTTPCookieProcessor())
        return helper.session(opener, args, base, audience)["access_token"]
    except (helper.AuthError, ValueError, OSError, KeyError) as error:
        raise EvidenceError(f"Could not authenticate the {identity} MCP control") from error


def admin_chat_direct_controls(report, deployment, admin_token, manufacturing_token):
    url = origin(deployment.required("API_MCP_URL")) + "/mcp"
    denied, text = consumer_mcp_tool_call(url, "get_business_stats", admin_token, {}, 1)
    report.check("agent:admin-chat:direct-allow", "live-allows",
                 not denied and text[0].startswith("=== AdventureWorks Business Dashboard ==="),
                 "The delegated admin can read the business dashboard; returned data is withheld.")
    denied, text = consumer_mcp_tool_call(url, "get_business_stats", manufacturing_token, {}, 2)
    report.check("agent:admin-chat:direct-denial", "live-denials",
                 denied and "sales.read" in text[0],
                 "A manufacturing user without sales.read is denied the same MCP tool.")


def admin_chat_flow(report, deployment, token, *, allow_agent_canary=False):
    if not allow_agent_canary:
        raise EvidenceError("Admin-chat inference is opt-in and requires the deployed tool guard")
    for check_id, group in [
            ("agent:admin-chat:definition", "agent-policy"),
            ("agent:admin-chat:direct-allow", "live-allows"),
            ("agent:admin-chat:direct-denial", "live-denials")]:
        checks = [item for item in report.checks if item["id"] == check_id]
        if len(checks) != 1 or checks[0]["group"] != group or checks[0]["status"] != "PASS":
            raise EvidenceError("Current-run admin definition and direct allow/deny controls must pass first")
    trace = uuid.uuid4().hex
    report.inventory["adminChatTraceId"] = trace
    status, _, raw = http(
        "POST", https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/agent/chat",
        token=token, timeout=300,
        data={"message": "Show a brief business dashboard using the get_business_stats tool.",
              "isAdmin": True, "cultureId": "en"},
        headers={"traceparent": f"00-{trace}-{uuid.uuid4().hex[:16]}-01"},
    )
    try:
        response = json.loads(raw)
    except (ValueError, TypeError):
        response = None
    text = response.get("response", response.get("Response")) if isinstance(response, dict) else None
    tools = response.get("toolsUsed", response.get("ToolsUsed")) if isinstance(response, dict) else None
    valid = (status == 200 and isinstance(text, str) and bool(text.strip()) and
             isinstance(tools, list) and all(isinstance(name, str) for name in tools) and
             set(tools).issubset(ADMIN_CHAT_TOOLS))
    report.check("agent:admin-chat:response", "agents", valid,
                 f"Delegated admin chat returned HTTP {status} with a valid response and only reviewed tool names; "
                 "response text and identity are withheld.")
    if not valid:
        report.add("agent:admin-chat:reported-tool", "agents", "BLOCKED",
                   "The admin-chat response contract failed; no tool execution is credited.")
        return
    used = "get_business_stats" in tools
    report.add("agent:admin-chat:reported-tool", "agents", "PASS" if used else "BLOCKED",
               "The model reported the business dashboard tool; a completed result and the caller's "
               "authorization decision must still be correlated." if used else
               "The model did not select the business dashboard tool; narrative alone is not execution evidence.")


def admin_chat_live(report, deployment, *, allow_agent_canary=False):
    if not allow_agent_canary:
        return
    report.add("scope:admin-chat", "scope", "PASS",
               "One opt-in paid admin chat inference and read-only MCP controls; "
               "no orders, email or simulator mutations.")
    report.guarded("agent:admin-chat:definition", "agent-policy",
                   lambda: admin_chat_agent_definition(report, deployment))
    definitions = [item for item in report.checks if item["id"] == "agent:admin-chat:definition"]
    if len(definitions) != 1 or definitions[0]["status"] != "PASS":
        report.add("agent:admin-chat:canary", "agents", "BLOCKED",
                   "The selected admin agent definition is not verified; no inference was sent.")
        return
    tokens = {}

    def authenticate():
        if getattr(deployment, "runtime", None):
            raise EvidenceError("Admin chat canary requires the local deployer and telemetry access")
        for identity in ("admin", "manufacturing"):
            tokens[identity] = internal_mcp_token(deployment, identity)

    report.guarded("agent:admin-chat:authentication", "agents", authenticate)
    if set(tokens) != {"admin", "manufacturing"}:
        report.add("agent:admin-chat:canary", "agents", "BLOCKED",
                   "Both internal controls are required; no inference was sent.")
        return
    report.guarded("agent:admin-chat:direct-controls", "agents", lambda: admin_chat_direct_controls(
        report, deployment, tokens["admin"], tokens["manufacturing"]))
    report.guarded("agent:admin-chat:canary", "agents", lambda: admin_chat_flow(
        report, deployment, tokens["admin"], allow_agent_canary=True))
    report.guarded("agent:admin-chat:correlation", "agents", lambda: delegated_chat_correlated_tool(
        report, deployment, lambda: tokens["admin"], "admin-chat"))


def customer_chat_live(report, deployment, consumers, available_products, *, allow_agent_canary=False):
    if not allow_agent_canary:
        report.add("agent:customer-chat:canary", "agents", "BLOCKED",
                   "Customer-chat inference is opt-in after deploying the matching MCP and Functions guards.")
        return
    report.guarded("agent:customer-chat:definition", "agent-policy",
                   lambda: customer_chat_agent_definition(report, deployment))
    if not consumers:
        report.add("agent:customer-chat:canary", "agents", "BLOCKED",
                   "A retained consumer is required; no inference was sent.")
        return
    consumer = consumers[0]
    report.guarded("agent:customer-chat:canary", "agents", lambda: customer_chat_flow(
        report, deployment, consumer, available_products.get(consumer.label), allow_agent_canary=True))
    report.guarded("agent:customer-chat:correlation", "agents",
                   lambda: customer_chat_correlated_tool(report, deployment, consumer))


def help_me_choose_agent_definition(report, deployment):
    endpoint = https_url(deployment.required("AI_FOUNDRY_PROJECT_ENDPOINT"))
    agent_id = deployment.required("AI_AGENT_HELP_ME_CHOOSE_ID")
    mcp_url = https_url(deployment.required("MCP_SERVICE_URL"))
    token = command([
        "az", "account", "get-access-token", "--resource", "https://ai.azure.com/",
        "--query", "accessToken", "-o", "tsv",
    ]).strip()
    status, _, raw = http(
        "GET",
        endpoint + "/agents/" + urllib.parse.quote(agent_id, safe="") + "?api-version=v1",
        token=token,
    )
    try:
        document = json.loads(raw)
        definition = (document.get("versions", {}).get("latest", {}).get("definition")
                      or document.get("definition", {}))
    except (ValueError, AttributeError) as error:
        raise EvidenceError("Help-Me-Choose Foundry definition returned invalid JSON") from error

    tools = definition.get("tools", []) if isinstance(definition, dict) else []
    if not isinstance(tools, list):
        tools = []
    mcp_tools = [tool for tool in tools if isinstance(tool, dict) and tool.get("type") == "mcp"]
    allowed = []
    for tool in mcp_tools:
        names = tool.get("allowed_tools", [])
        if isinstance(names, dict):
            names = names.get("tool_names", []) if set(names) == {"tool_names"} else []
        if (not isinstance(names, list) or not all(isinstance(name, str) for name in names) or
                len(names) != len(set(names))):
            names = []
        allowed.append((tool.get("server_label"), set(names)))
    inputs = definition.get("structured_inputs", {}) if isinstance(definition, dict) else {}
    allowed_properties = {
        "type", "server_label", "server_url", "allowed_tools", "require_approval", "server_description", "headers",
    }
    valid = (
        status == 200 and isinstance(document, dict) and isinstance(definition, dict) and
        document.get("id") == agent_id and isinstance(inputs, dict) and
        not definition.get("memory_stores") and set(inputs) == {"cultureId", "profileContext"} and
        len(tools) == 1 and len(allowed) == 1 and allowed[0] == ("adventureworks_mcp", PUBLIC_CATALOG_TOOLS) and
        mcp_tools[0].get("server_url") == mcp_url and
        set(mcp_tools[0]).issubset(allowed_properties) and
        mcp_tools[0].get("headers") in (None, {}) and not mcp_tools[0].get("project_connection_id")
    )
    report.check(
        "agent:helpme-choose:definition", "agent-policy", valid,
        "Selected Foundry agent has no memory or DAB MCP connection and only the four public catalog tools",
    )


def help_me_choose_public_flow(report, deployment, *, allow_agent_canary=False):
    if not allow_agent_canary:
        raise EvidenceError("AI canary is opt-in: first deploy the source-matched Functions catalog guard, "
                            "then explicitly enable this paid inference")
    controls = [item for item in report.checks if item["id"] == "agent:helpme-choose:definition"]
    if (len(controls) != 1 or controls[0]["group"] != "agent-policy" or
            controls[0]["status"] != "PASS"):
        raise EvidenceError("The exact deployed catalog-only agent definition must pass before AI requests")
    base = https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/helpme"
    traces = {}
    report.inventory["helpMeChooseTraceIds"] = traces

    def trace_headers(phase):
        trace = uuid.uuid4().hex
        traces[phase] = trace
        return {"traceparent": f"00-{trace}-{uuid.uuid4().hex[:16]}-01"}

    status, _, raw = http(
        "POST", base + "/questions",
        data={"context": "mountain bike", "cultureId": "en"}, timeout=300, headers=trace_headers("questions"),
    )
    try:
        questions = json.loads(raw)
    except ValueError as error:
        raise EvidenceError("Public Help-Me-Choose questions returned invalid JSON") from error
    questions = questions if isinstance(questions, dict) else {}
    question_items = questions.get("questions", questions.get("Questions", []))
    session_id = questions.get("sessionId", questions.get("SessionId"))
    private_response_keys = {
        "threadid", "responseid", "foundryresponseid", "previousresponseid", "previousthreadid",
    }
    valid_questions = (
        status == 200 and isinstance(question_items, list) and len(question_items) == 5 and
        all(isinstance(item, dict) and isinstance(item.get("options", item.get("Options")), list) and
            len(item.get("options", item.get("Options"))) == 4 for item in question_items) and
        isinstance(session_id, str) and re.fullmatch(r"[a-f0-9]{32}", session_id) is not None and
        not any(key.lower() in private_response_keys for key in questions)
    )
    report.check(
        "agent:helpme-choose:anonymous-questions", "agents", valid_questions,
        f"Anonymous questions returned HTTP {status}, five four-option questions, and no Foundry response ID",
    )
    if not valid_questions:
        report.add("agent:helpme-choose:anonymous-recommendations", "agents", "BLOCKED",
                   "Question response failed its safety contract; no recommendation request sent")
        return

    recommendation_payload = {
        "answers": [
            {"questionId": 1, "question": "Where will it be used?", "answer": "Mountain trails"},
            {"questionId": 2, "question": "Experience level?", "answer": "Beginner"},
            {"questionId": 3, "question": "Budget?", "answer": "Under $1,000"},
        ],
        "cultureId": "en",
        "customerId": 0,
        "previousThreadId": "resp_auth_validation_untrusted",
    }
    status, _, raw = http(
        "POST", base + "/recommend", data=recommendation_payload, timeout=300,
        headers=trace_headers("recommendations"),
    )
    try:
        recommendations = json.loads(raw)
    except ValueError as error:
        raise EvidenceError("Public Help-Me-Choose recommendations returned invalid JSON") from error
    recommendations = recommendations if isinstance(recommendations, dict) else {}
    products = recommendations.get("recommendations", recommendations.get("Recommendations", []))
    search_terms = recommendations.get("searchTermsUsed", recommendations.get("SearchTermsUsed", []))
    returned_keys = {key.lower() for key in recommendations}
    valid_recommendations = (
        status == 200 and isinstance(products, list) and 3 <= len(products) <= 5 and
        all(isinstance(item, dict) and type(item.get("productId", item.get("ProductId"))) is int
            for item in products) and isinstance(search_terms, list) and bool(search_terms) and
        not returned_keys.intersection(private_response_keys | {"customerid"})
    )
    report.check(
        "agent:helpme-choose:anonymous-recommendations", "agents", valid_recommendations,
        f"Anonymous recommendations returned HTTP {status}, live search terms, and no caller identity or Foundry ID",
    )


def help_me_choose_correlated_tools(report, deployment):
    if getattr(deployment, "runtime", None):
        raise EvidenceError("Agent telemetry inspection requires the local deployer, not the private runtime identity")
    checks = {item["id"]: item["status"] for item in report.checks}
    if checks.get("agent:helpme-choose:anonymous-recommendations") != "PASS":
        raise EvidenceError("A successful run-specific recommendation is required before telemetry correlation")
    traces = report.inventory.get("helpMeChooseTraceIds")
    if (not isinstance(traces, dict) or set(traces) != {"questions", "recommendations"} or
            any(not isinstance(value, str) or re.fullmatch(r"[a-f0-9]{32}", value) is None
                or value == "0" * 32 for value in traces.values()) or len(set(traces.values())) != 2):
        raise EvidenceError("Run-specific agent traces are missing or invalid")
    agent_id = deployment.required("AI_AGENT_HELP_ME_CHOOSE_ID")
    if re.fullmatch(r"[A-Za-z0-9_-]+", agent_id) is None:
        raise EvidenceError("The selected agent ID is not a supported telemetry identity")
    identity = deployment.azure("identity", "show", "-g", deployment.required("AZURE_RESOURCE_GROUP"),
                                "-n", deployment.required("USER_MANAGED_IDENTITY_NAME"))
    try:
        principal_id = str(uuid.UUID(identity["principalId"]))
    except (ValueError, KeyError, TypeError) as error:
        raise EvidenceError("The selected runtime managed-identity principal is unavailable") from error
    resources = deployment.azure("resource", "list", "--resource-group",
                                 deployment.required("AZURE_RESOURCE_GROUP"),
                                 "--resource-type", "Microsoft.Insights/components", "--query", "[].id")
    if (not isinstance(resources, list) or len(resources) != 1 or
            not isinstance(resources[0], str) or not resources[0]):
        raise EvidenceError("A unique selected-environment telemetry resource is required")
    trace_list = ", ".join("'" + value + "'" for value in traces.values())
    query = (
        "let Completed = customEvents | where timestamp > ago(1h) "
        f"| where operation_Id in ({trace_list}) and name == 'Foundry.Responses.Completed' "
        f"| where tostring(customDimensions.AgentId) == '{agent_id}' "
        "| where tostring(customDimensions.ToolPolicy) == 'public-catalog' "
        "| extend AgentVersionId=tostring(customDimensions.AgentVersionId), "
        "Tool=split(tostring(customDimensions.CompletedMcpTools), ',') "
        "| mv-expand Tool to typeof(string) | project operation_Id, AgentVersionId, Tool; "
        "let Authorized = customEvents | where timestamp > ago(1h) "
        f"| where operation_Id in ({trace_list}) and name == 'McpToolAuthorization' "
        f"| where tostring(customDimensions.subject) == 'service:{principal_id}' "
        "| where tostring(customDimensions.category) == 'service' "
        "and tostring(customDimensions.app) == 'adventureworks-agents' "
        "and tostring(customDimensions.requiredScope) == 'products.read' "
        "and tostring(customDimensions.outcome) == 'Allow' "
        "and tostring(customDimensions.allowed) == 'true' "
        "| project operation_Id, Tool=tostring(customDimensions.tool); "
        "Completed | join kind=inner Authorized on operation_Id, Tool "
        "| summarize Hits=count() by AgentVersionId, Tool | order by AgentVersionId asc, Tool asc"
    )
    observed = []
    for delay in (0, 20, 20, 20):
        if delay:
            time.sleep(delay)
        result = deployment.azure("monitor", "app-insights", "query", "--app", resources[0],
                                  "--analytics-query", query)
        try:
            table, = result["tables"]
            names = [column["name"] for column in table["columns"]]
            rows = table["rows"]
            if names != ["AgentVersionId", "Tool", "Hits"] or not isinstance(rows, list):
                raise ValueError("Unexpected telemetry columns")
            seen = set()
            for row in rows:
                if (not isinstance(row, list) or len(row) != 3 or
                        not isinstance(row[0], str) or
                        re.fullmatch(re.escape(agent_id) + r":[1-9][0-9]*", row[0]) is None or
                        row[1] not in PUBLIC_CATALOG_TOOLS or type(row[2]) is not int or row[2] <= 0 or
                        (row[0], row[1]) in seen):
                    raise ValueError("Unexpected telemetry row")
                seen.add((row[0], row[1]))
                observed.append({"version": row[0], "tool": row[1], "matches": row[2]})
        except (KeyError, TypeError, ValueError) as error:
            raise EvidenceError("Agent correlation telemetry has an unsupported shape") from error
        if observed:
            break
    report.inventory["helpMeChooseCorrelatedTools"] = observed
    report.add(
        "agent:helpme-choose:correlated-tools", "agents", "PASS" if observed else "BLOCKED",
        "Run-specific trace joins a completed catalog MCP result to an allowed products.read decision "
        "for the selected runtime principal and the version actually loaded by Functions. "
        "Only listed tools are observed; sampled or delayed telemetry, other tool paths and SQL "
        "effective permissions remain separate obligations.",
    )


def reconcile_correlated_agent_tool_paths(report, deployment, agent_id, allowed_tools,
                                          observations_key, evidence_detail, reconciliation_id):
    observations = report.inventory.get(observations_key)
    versions = report.inventory.get("deployedAgentVersions")
    edges = report.inventory.get("agentDependencyEdges")
    if not all(isinstance(value, list) and value and all(isinstance(item, dict) for item in value)
               for value in (observations, versions, edges)):
        raise EvidenceError("Current-run agent versions, tool edges and correlated observations are required")
    expected_origin = origin(deployment.required("MCP_SERVICE_URL"))
    seen = set()
    for observation in observations:
        version = observation.get("version")
        tool = observation.get("tool")
        if (not isinstance(version, str) or
                re.fullmatch(re.escape(agent_id) + r":[1-9][0-9]*", version) is None or
                not isinstance(tool, str) or tool not in allowed_tools or
                type(observation.get("matches")) is not int or observation["matches"] <= 0 or
                (version, tool) in seen):
            raise EvidenceError("The correlated agent-tool observations are invalid")
        seen.add((version, tool))
    unresolved = []
    for observation in observations:
        version, tool = observation["version"], observation["tool"]
        version_id = foundry_agent_version_id(agent_id, version.rsplit(":", 1)[1])
        surface = f"{version_id}:mcp-server:adventureworks_mcp:tool:{tool}"
        matching_versions = [item for item in versions if item.get("versionId") == version_id]
        matching_edges = [item for item in edges if item.get("id") == surface]
        matching_checks = [item for item in report.checks if item["id"] == "agent-tool-path:" + surface]
        matching_tools = [item for version_summary in matching_versions
                          if isinstance(version_summary.get("tools"), list)
                          for item in version_summary.get("tools", []) if isinstance(item, dict)
                          and item.get("type") == "mcp" and item.get("server") == "adventureworks_mcp"
                          and item.get("resource") == "custom-mcp" and item.get("targetOrigin") == expected_origin
                          and isinstance(item.get("surfaceIds"), list) and isinstance(item.get("allowedTools"), list)
                          and surface in item.get("surfaceIds", []) and tool in item.get("allowedTools", [])]
        if (len(matching_versions) != 1 or len(matching_edges) != 1 or
                len(matching_checks) != 1 or len(matching_tools) != 1 or
                matching_versions[0].get("name") != agent_id or
                matching_edges[0].get("kind") != "mcp-tool" or matching_edges[0].get("from") != version_id or
                matching_edges[0].get("tool") != tool or matching_edges[0].get("toOrigin") != expected_origin or
                matching_checks[0]["group"] != "agents" or matching_checks[0]["status"] != "BLOCKED" or
                matching_checks[0]["detail"] != AGENT_TOOL_RUNTIME_BLOCKED_DETAIL):
            unresolved.append(surface)
            continue
        matching_checks[0].update({
            "status": "PASS",
            "detail": evidence_detail,
        })
    report.add(
        reconciliation_id, "agents", "BLOCKED" if unresolved else "PASS",
        "Observed version/tool paths must match exactly one selected-MCP inventory edge and its original "
        "runtime obligation; only matched paths are credited." +
        (" Unmatched: " + ", ".join(unresolved) if unresolved else ""),
    )


def reconcile_help_me_choose_tool_paths(report, deployment):
    controls = {
        "agent:helpme-choose:definition": "agent-policy",
        "agent:helpme-choose:anonymous-recommendations": "agents",
        "agent:helpme-choose:correlated-tools": "agents",
    }
    for check_id, group in controls.items():
        checks = [item for item in report.checks if item["id"] == check_id]
        if len(checks) != 1 or checks[0]["group"] != group or checks[0]["status"] != "PASS":
            raise EvidenceError("Current-run definition, recommendation and correlation evidence are required")
    reconcile_correlated_agent_tool_paths(
        report, deployment, deployment.required("AI_AGENT_HELP_ME_CHOOSE_ID"), PUBLIC_CATALOG_TOOLS,
        "helpMeChooseCorrelatedTools",
        "This version's public-catalog call returned a completed MCP result and joined an "
        "allowed products.read decision for the selected runtime principal on the same trace. "
        "Other caller modes and downstream SQL/embedding identity remain separate obligations.",
        "agent:helpme-choose:inventory-reconciliation",
    )


def reconcile_customer_chat_tool_paths(report, deployment):
    controls = {
        "agent:customer-chat:definition": "agent-policy",
        "agent:customer-chat:response": "agents",
        "agent:customer-chat:reported-tool": "agents",
        "agent:customer-chat:correlated-tool": "agents",
    }
    for check_id, group in controls.items():
        checks = [item for item in report.checks if item["id"] == check_id]
        if len(checks) != 1 or checks[0]["group"] != group or checks[0]["status"] != "PASS":
            raise EvidenceError("Current-run customer-chat definition, response and correlation evidence are required")
    reconcile_correlated_agent_tool_paths(
        report, deployment, deployment.required("AI_AGENT_CHAT_ID"), {"get_product_availability"},
        "customerChatCorrelatedTools",
        "This version's customer availability call returned a completed MCP result and joined an "
        "allowed products.read decision for the delegated consumer on the same trace. "
        "Other caller modes and downstream SQL identity remain separate obligations.",
        "agent:customer-chat:inventory-reconciliation",
    )


def reconcile_admin_chat_tool_paths(report, deployment):
    controls = {
        "agent:admin-chat:definition": "agent-policy",
        "agent:admin-chat:direct-allow": "live-allows",
        "agent:admin-chat:direct-denial": "live-denials",
        "agent:admin-chat:response": "agents",
        "agent:admin-chat:reported-tool": "agents",
        "agent:admin-chat:correlated-tool": "agents",
    }
    for check_id, group in controls.items():
        checks = [item for item in report.checks if item["id"] == check_id]
        if len(checks) != 1 or checks[0]["group"] != group or checks[0]["status"] != "PASS":
            raise EvidenceError("Current-run admin chat definition, controls and correlation evidence are required")
    reconcile_correlated_agent_tool_paths(
        report, deployment, deployment.required("AI_AGENT_ADMIN_CHAT_ID"), {"get_business_stats"},
        "adminChatCorrelatedTools",
        "This version's business dashboard call returned a completed MCP result and joined an "
        "allowed sales.read decision for the delegated employee on the same trace. "
        "Other caller modes and downstream SQL identity remain separate obligations.",
        "agent:admin-chat:inventory-reconciliation",
    )


def reconcile_browser_auth_requirement(report):
    required_id = "required:browser-real-login-all-sites"
    required = [item for item in report.checks if item["id"] == required_id]
    if len(required) != 1:
        raise EvidenceError("The all-sites browser requirement must exist exactly once")
    evidence_ids = ["browser:internal:complete", "browser:inspector:complete", "browser:guest-cart:complete"]
    evidence = [[item for item in report.checks if item["id"] == check_id] for check_id in evidence_ids]
    if any(len(items) != 1 for items in evidence):
        return
    statuses = [items[0]["status"] for items in evidence]
    if "FAIL" in statuses:
        required[0].update({"status": "FAIL",
                            "detail": "At least one deployed site or Inspector browser authentication suite failed"})
    elif all(status == "PASS" for status in statuses):
        required[0].update({"status": "PASS",
                            "detail": "Storefront, Admin, Manufacturing and Inspector completed deployed login/session coverage"})


def reconcile_mcp_task_requirement(report):
    required = [item for item in report.checks if item["id"] == "required:mcp-task-ownership"]
    if len(required) != 1:
        raise EvidenceError("The MCP task ownership requirement must exist exactly once")
    expected = {"required:mcp-tool-http-dispatch", "required:mcp-task-ownership-offline",
                "mcp-task:scope-before-create"}
    for label in ["A", "B"]:
        expected.update(f"mcp-task:{label}:{step}" for step in ["created", "completed"])
        expected.update(f"mcp-task:{label}:{authority}:{method}"
                        for authority in ["other-owner", "missing-scope"]
                        for method in ["tasks/get", "tasks/update", "tasks/cancel"])
        expected.update(f"mcp-personalized:{label}:products-only:{task}" for task in [False, True])
    evidence = [[item for item in report.checks if item["id"] == check_id] for check_id in expected]
    failed = any(item["status"] == "FAIL" for items in evidence for item in items)
    complete = all(len(items) == 1 and items[0]["status"] == "PASS" for items in evidence)
    fixtures = report.inventory.get("mcpTaskFixtures", [])
    confirmed = (isinstance(fixtures, list) and len(fixtures) == 2 and
                 all(isinstance(item, dict) and item.get("status") == "completed" and
                     isinstance(item.get("taskId"), str) and
                     re.fullmatch(r"[a-f0-9]{32}", item["taskId"]) is not None for item in fixtures) and
                 {item.get("label") for item in fixtures} == {"A", "B"} and
                 len({item["taskId"] for item in fixtures}) == 2)
    required[0].update({
        "status": "FAIL" if failed else "PASS" if complete and confirmed else "BLOCKED",
        "detail": "Requires exact current-run dispatch/store gates and 21 deployed assertions: "
                  "two distinct completed owner-bound catalogue tasks, all foreign/reduced-scope controls, "
                  "scope denial before task creation and catalogue-only purchase-history denials. "
                  "Does not establish every agent execution path or order/mutation safety.",
    })


def live(report, deployment, *, allow_agent_canary=False, allow_customer_agent_canary=False,
         allow_admin_agent_canary=False):
    d = deployment
    functions_base = https_url(d.required("API_FUNCTIONS_URL"))
    mcp_base = origin(d.required("API_MCP_URL"))
    dab_base = origin(d.required("API_URL"))
    try:
        status, _, raw = http("GET", mcp_base + "/.well-known/openid-configuration", timeout=90)
    except EvidenceError as error:
        report.add("live:oauth-preflight", "live-allows", "BLOCKED",
                   "OAuth discovery is unreachable; live scenarios were not started. " + str(error))
        return
    if status >= 500:
        report.add("live:oauth-preflight", "live-allows", "BLOCKED",
                   f"OAuth discovery returned HTTP {status}; live scenarios were not started.")
        return
    try:
        metadata = json.loads(raw)
    except ValueError:
        metadata = None
    valid = status == 200 and isinstance(metadata, dict) and metadata.get("issuer") == mcp_base + "/"
    report.check("live:oauth-preflight", "live-allows", valid,
                 f"OAuth discovery returned HTTP {status} with the selected issuer; response values withheld.")
    if not valid:
        return
    report.guarded("browser:internal:cross-tab-local", "frontend", lambda: internal_session_browser(report))
    report.guarded("browser:internal:scenario", "frontend", lambda: internal_browser(report, d))
    report.guarded("browser:inspector:scenario", "frontend", lambda: inspector_browser(report, d))
    report.guarded("agent:helpme-choose:definition", "agent-policy",
                   lambda: help_me_choose_agent_definition(report, d))
    report.guarded("agent:helpme-choose:public-flow", "agents",
                   lambda: help_me_choose_public_flow(report, d, allow_agent_canary=allow_agent_canary))
    report.guarded("guest-cart:scenario", "ownership", lambda: guest_cart_live(report, d))
    consumers = []
    report.guarded("consumer-fixtures:setup", "fixtures",
                   lambda: consumers.extend(consumer_fixtures(report, d)))
    if len(consumers) == 2:
        report.guarded("consumer-cart:scenario", "ownership", lambda: consumer_cart_live(report, d, consumers))
        report.guarded("consumer-address:scenario", "ownership", lambda: consumer_address_reads(report, d, consumers))
        report.guarded("consumer-password:scenario", "ownership", lambda: consumer_password_reads(report, d, consumers))
        report.guarded("dab:order-write-denials:scenario", "live-denials",
                       lambda: dab_order_write_denials(report, d, consumers))
    else:
        report.add("consumer-cart:scenario", "ownership", "BLOCKED", "Two reusable consumer identities unavailable")
        report.add("consumer-password:scenario", "ownership", "BLOCKED", "Two reusable consumer identities unavailable")
        report.add("dab:order-write-denials:scenario", "live-denials", "BLOCKED",
                   "Two reusable consumer identities unavailable; DAB order writes were not probed")
        report.add("browser:consumer-cart:scenario", "frontend", "BLOCKED",
                   "Real consumer browser sign-in requires the reusable fixture")
    report.guarded("browser:guest-cart:scenario", "frontend",
                   lambda: guest_cart_browser(report, d, consumers[0] if consumers else None,
                                              consumers[1] if len(consumers) > 1 else None))
    available_products = {}
    obligations = function_denial_obligations(report, functions_base)
    obligations += [
        ("mcp:anonymous", "POST", mcp_base + "/mcp", None,
         {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        ("mcp:forged", "POST", mcp_base + "/mcp", "invalid-auth-validation-token",
         {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        ("chat:alternate-enforcement", "POST", functions_base + "/api/agent/chat", None,
         {"message": "Authentication validation; do not invoke tools."}),
        ("dab:forged", "POST", dab_base + "/graphql", "invalid-auth-validation-token",
         {"query": "{ products(first: 1) { items { ProductID } } }"}),
    ]
    live_denial_probes(report, obligations)
    if consumers:
        report.guarded("functions-scope:scenario", "live-denials",
                       lambda: functions_scope_read_denials(report, d, consumers[0]))
    else:
        report.add("functions-scope:scenario", "live-denials", "BLOCKED",
                   "A retained consumer is required for reduced-scope read probes")
    for method, path, body in [
            ("POST", "/api/ProductReview", {}),
            ("PATCH", "/api/ProductReview/ProductReviewID/0", {"HelpfulVotes": 1}),
            ("DELETE", "/api/ProductReview/ProductReviewID/0", None)]:
        def review_denial(method=method, path=path, body=body):
            if method == "POST":
                body = review_denial_body(dab_base)
            status, _, _ = http(method, dab_base + path, data=body)
            report.check("deny:reviews:anonymous:" + method, "live-denials",
                         status in {401, 403}, f"Anonymous review mutation denied with HTTP {status}")
        report.guarded("deny:reviews:anonymous:" + method, "live-denials", review_denial)
    def public_reviews():
        status, _, body = http("GET", dab_base + "/api/ProductReview?$first=1")
        try:
            result = json.loads(body)
        except ValueError as error:
            raise EvidenceError("Public review read returned invalid JSON") from error
        items = result.get("value", [])
        report.check("allow:reviews:anonymous-read", "live-allows",
                     status == 200 and isinstance(items, list) and bool(items) and
                     isinstance(items[0].get("ProductReviewID"), int),
                     "Anonymous users can still read persisted reviews")
    report.guarded("allow:reviews:anonymous-read", "live-allows", public_reviews)
    for path in ["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]:
        def discovery(path=path):
            status, _, body = http("GET", mcp_base + path)
            try:
                document = json.loads(body)
            except ValueError as error:
                raise EvidenceError("Discovery returned invalid JSON") from error
            report.check("discovery:" + path, "live-allows",
                         status == 200 and document.get("issuer") == mcp_base + "/" and
                         document.get("code_challenge_methods_supported") == ["S256"],
                         "Discovery advertises selected issuer and only PKCE S256")
        report.guarded("discovery:" + path, "live-allows", discovery)
    def authenticated():
        helper = load_auth_helper()
        read_urls = {name: reviewed_function_read_url(report, functions_base, name)
                     for name in ["ShoppingSimulator_Status", "GetManufacturingAgentQueueStatus",
                                  "ManufacturingGetScrapEvents"]}
        manufacturing_tokens = {}
        admin_functions_token = None
        admin_dab_token = None
        for identity in ["admin", "manufacturing"]:
            for resource in ["functions", "dab", "mcp"]:
                base, audience = internal_token_target(d, resource)
                args = argparse.Namespace(identity=identity, command="token", timeout=120)
                opener = urllib.request.build_opener(
                    helper.NoRedirect(), urllib.request.HTTPCookieProcessor())
                try:
                    session = helper.session(opener, args, base, audience)
                except (helper.AuthError, ValueError, OSError) as error:
                    raise EvidenceError(f"Authentication helper could not obtain {identity}/{resource} session") from error
                token = session["access_token"]
                if identity == "manufacturing":
                    manufacturing_tokens[resource] = token
                elif resource == "functions":
                    admin_functions_token = token
                elif resource == "dab":
                    admin_dab_token = token
                if resource == "functions":
                    name = "ShoppingSimulator_Status" if identity == "admin" else "GetManufacturingAgentQueueStatus"
                    status, _, body = http("GET", read_urls[name], token=token)
                    try:
                        result = json.loads(body)
                    except ValueError as error:
                        raise EvidenceError("Authenticated Functions read returned invalid JSON") from error
                    report.check(f"allow:{identity}:{resource}", "live-allows",
                                 status == 200 and isinstance(result, dict) and bool(result) and "error" not in result,
                                 f"Authenticated read returned HTTP {status} with structured data")
                    wrong_status, _, _ = http("POST", mcp_base + "/mcp", token=token,
                                              data={"jsonrpc": "2.0", "id": 20, "method": "tools/list"})
                    report.check(f"deny:{identity}:functions-token-at-mcp", "live-denials",
                                 wrong_status == 401, f"Cross-audience token rejected with HTTP {wrong_status}")
                elif resource == "dab":
                    status, _, body = http("POST", dab_base + "/graphql", token=token,
                                          headers={"X-MS-API-ROLE": helper.IDENTITIES[identity][4]},
                                          data={"query": "{ products(first: 1) { items { ProductID } } }"})
                    try:
                        result = json.loads(body)
                    except ValueError as error:
                        raise EvidenceError("DAB read returned invalid JSON") from error
                    items = result.get("data", {}).get("products", {}).get("items", [])
                    report.check(f"allow:{identity}:{resource}", "live-allows",
                                 status == 200 and not result.get("errors") and bool(items) and
                                 isinstance(items[0].get("ProductID"), int),
                                 "DAB returns an actual product without GraphQL errors")
                else:
                    wrong_status, _, _ = http("GET", read_urls["GetManufacturingAgentQueueStatus"], token=token)
                    report.check(f"deny:{identity}:mcp-token-at-functions", "live-denials",
                                 wrong_status == 401, f"Cross-audience token rejected with HTTP {wrong_status}")
                    status, _, body = http("POST", mcp_base + "/mcp", token=token,
                                          data={"jsonrpc": "2.0", "id": 10, "method": "tools/call",
                                                "params": {"name": "get_manufacturing_scrap_events", "arguments": {}}})
                    document = mcp_document(body)
                    result = document.get("result", {})
                    text = "\n".join(item.get("text", "") for item in result.get("content", []))
                    report.check(f"allow:{identity}:{resource}", "live-allows",
                                 status == 200 and not document.get("error") and not result.get("isError") and
                                 "## Scrap Events" in text and "Total events:" in text,
                                 "MCP dispatch returns manufacturing data through Functions service-token proxy")
                    if identity == "manufacturing":
                        status, _, body = http("POST", mcp_base + "/mcp", token=token,
                                              data={"jsonrpc": "2.0", "id": 11, "method": "tools/call",
                                                    "params": {"name": "get_business_stats", "arguments": {}}})
                        document = mcp_document(body)
                        result = document.get("result", {})
                        text = "\n".join(item.get("text", "") for item in result.get("content", []))
                        report.check("deny:manufacturing:sales-tool", "live-denials",
                                     status == 200 and result.get("isError") is True and "sales.read" in text,
                                     "MCP protocol-level denial enforces manufacturing versus sales scope")
        report.guarded("dab-mcp:scenario", "live-allows", lambda: native_dab_mcp(
            report, d, manufacturing_tokens["dab"], manufacturing_tokens["functions"],
            helper.IDENTITIES["manufacturing"][4]))
        report.guarded("dab:employee-role-matrix", "live-allows", lambda: dab_private_employee_role_matrix(
            report, d, admin_dab_token, manufacturing_tokens["dab"]))
        report.guarded("dab:role-header:matrix", "live-denials", lambda: dab_role_header_denials(
            report, d, admin_dab_token, manufacturing_tokens["dab"], consumers))
        if len(consumers) == 2:
            report.guarded("functions:receipts:scenario", "live-denials",
                           lambda: receipt_reads(report, d, admin_functions_token, admin_dab_token, consumers))
            report.guarded("functions:orders:detail:scenario", "live-denials",
                           lambda: order_detail_read_boundaries(
                               report, d, admin_functions_token, admin_dab_token, consumers))
            report.guarded("functions:payments:scenario", "live-allows", lambda: payment_method_reads(
                report, d, admin_functions_token, admin_dab_token, consumers))
            report.guarded("dab:password:field-restrictions", "live-denials",
                           lambda: dab_credential_field_restrictions(
                               report, d, admin_dab_token, manufacturing_tokens["dab"], consumers))
            report.guarded("dab:catalog:field-restrictions", "live-denials",
                           lambda: dab_catalog_field_restrictions(
                               report, d, admin_dab_token, manufacturing_tokens["dab"], consumers))
            report.guarded("dab:read-role:matrix", "live-denials",
                           lambda: dab_read_role_matrix(
                               report, d, admin_dab_token, manufacturing_tokens["dab"], consumers))
        report.guarded("functions-host:scenario", "live-denials", lambda: functions_host_read_denials(
            report, d, manufacturing_tokens, consumers[0] if consumers else None))
        if consumers:
            report.guarded("mcp-consumer:owner-denials", "live-denials",
                           lambda: available_products.update(consumer_mcp_owner_denials(report, d, consumers)))
            report.guarded("mcp-task:ownership", "live-denials",
                           lambda: mcp_task_ownership_live(report, d, consumers))
        report.guarded("mcp-task:scope-denial", "live-denials",
                       lambda: mcp_task_scope_denial(report, d, manufacturing_tokens["mcp"]))
        report.guarded("webpubsub:authorization", "live-denials", lambda: webpubsub_authorization(
            report, d, manufacturing_tokens["functions"], admin_functions_token,
            admin_dab_token, consumers[0] if consumers else None))
        report.guarded("agent:promotion-suggestion:scenario", "agents", lambda: promotion_agent_authorization(
            report, d, admin_functions_token, manufacturing_tokens["functions"], admin_dab_token))
        report.guarded("subcategory-count:scenario", "live-denials", lambda: subcategory_count_authorization(
            report, d, admin_functions_token, manufacturing_tokens, consumers))
    report.guarded("live:authenticated-paths", "live-allows", authenticated)
    customer_chat_live(report, d, consumers, available_products, allow_agent_canary=allow_customer_agent_canary)
    admin_chat_live(report, d, allow_agent_canary=allow_admin_agent_canary)
    report.guarded("agent:helpme-choose:correlated-tools", "agents",
                   lambda: help_me_choose_correlated_tools(report, d))
    if "agentDependencyEdges" in report.inventory:
        report.guarded("agent:helpme-choose:inventory-reconciliation", "agents",
                       lambda: reconcile_help_me_choose_tool_paths(report, d))
        if allow_customer_agent_canary:
            report.guarded("agent:customer-chat:inventory-reconciliation", "agents",
                           lambda: reconcile_customer_chat_tool_paths(report, d))
        if allow_admin_agent_canary:
            report.guarded("agent:admin-chat:inventory-reconciliation", "agents",
                           lambda: reconcile_admin_chat_tool_paths(report, d))
    report.add("live:simulator-budget", "mutations", "BLOCKED",
               "No simulator started: server-enforced 100-order/run, two-run, rolling 30/minute combined budget, "
               "60-minute expiry, retry-safe creation and no-email lineage remain unverified")
    report.add("live:browser", "browser", "BLOCKED",
               "Storefront, internal portals and hosted Inspector browser scenarios have individual evidence; "
               "natural guest-cart expiry and complete API role/action/tool matrices remain required")
    report.add("live:dab-native-mcp", "live-allows", "BLOCKED",
               "Native handshake/read/role/audience/origin checks have individual evidence; "
               "complete entity/action/field/owner policies and mutation tool dispatch remain required")
    reconcile_browser_auth_requirement(report)
    reconcile_mcp_task_requirement(report)


def browser_tests(report, deployment):
    report.add("scope:browsers", "scope", "PASS",
               "Targeted deployed Chromium scenarios only; no .NET tests, SQL fixtures, orders, AI or email. "
               "Storefront test performs bounded cart mutations with exact cleanup.")
    report.guarded("browser:internal:cross-tab-local", "frontend", lambda: internal_session_browser(report))
    report.guarded("browser:internal:scenario", "frontend", lambda: internal_browser(report, deployment))
    report.guarded("browser:inspector:scenario", "frontend", lambda: inspector_browser(report, deployment))
    consumers = []
    report.guarded("browser:consumer-fixtures", "fixtures",
                   lambda: consumers.extend(consumer_fixtures(report, deployment)))
    if len(consumers) != 2:
        report.add("browser:storefront:scenario", "frontend", "BLOCKED",
                   "Both retained consumers must authenticate before storefront sign-in/merge verification")
    else:
        report.guarded("browser:storefront:scenario", "frontend",
                       lambda: guest_cart_browser(report, deployment, consumers[0],
                                                  consumers[1] if len(consumers) > 1 else None))


def customer_chat_tests(report, deployment, *, allow_agent_canary=False, allow_admin_agent_canary=False):
    report.add("scope:customer-chat", "scope", "PASS",
               "Retained-consumer MCP reads only; no new accounts, orders or email. "
               "A single paid chat inference is opt-in and stores its normal Foundry response.")
    consumers = []
    report.guarded("consumer-fixtures:setup", "fixtures",
                   lambda: consumers.extend(retained_consumer_fixtures(report, deployment)))
    available_products = {}
    if consumers:
        report.guarded("mcp-consumer:owner-denials", "live-denials",
                       lambda: available_products.update(consumer_mcp_owner_denials(report, deployment, consumers)))
    customer_chat_live(report, deployment, consumers, available_products, allow_agent_canary=allow_agent_canary)
    admin_chat_live(report, deployment, allow_agent_canary=allow_admin_agent_canary)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    profile = parser.add_mutually_exclusive_group(required=True)
    for name in ["offline", "infra", "live", "all", "browsers", "chat"]:
        profile.add_argument("--" + name, action="store_true")
    parser.add_argument("--environment", help="azd environment; otherwise use current selection")
    parser.add_argument("--output", type=Path, help="New evidence directory; defaults to ignored .auth-results/<run-id>")
    parser.add_argument("--public-agent-canary", action="store_true",
                        help="After deploying the matching Functions catalog guard, explicitly allow bounded paid AI requests")
    parser.add_argument("--customer-agent-canary", action="store_true",
                        help="After deploying the matching MCP and Functions guards, allow one paid customer-chat inference")
    parser.add_argument("--admin-agent-canary", action="store_true",
                        help="After deploying the Functions admin-chat guard, allow one paid read-only admin-chat inference")
    parser.add_argument("--functions-host", action="store_true",
                        help="Also test the actual Functions worker in a loopback-only local namespace")
    args = parser.parse_args(argv)
    if args.public_agent_canary and not (args.live or args.all):
        parser.error("--public-agent-canary requires --live or --all")
    if args.customer_agent_canary and not (args.live or args.all or args.chat):
        parser.error("--customer-agent-canary requires --chat, --live or --all")
    if args.admin_agent_canary and not (args.live or args.all or args.chat):
        parser.error("--admin-agent-canary requires --chat, --live or --all")
    if args.functions_host and not (args.offline or args.all):
        parser.error("--functions-host requires --offline or --all")
    output = (args.output or ROOT / ".auth-results" / str(uuid.uuid4())).resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = Report(output)
    runtime = Deployment(args.environment) if os.environ.get("AUTH_ASSURANCE_MANIFEST_FILE") else None
    report.provenance["sourceRevision"] = (runtime.runtime["sourceRevision"] if runtime else
                                           command(["git", "rev-parse", "HEAD"]).strip())
    diff = "" if runtime else command(["git", "diff", "--no-ext-diff", "HEAD"])
    report.provenance["trackedDiffSha256"] = (runtime.runtime["sourceSha256"] if runtime else
                                             hashlib.sha256(diff.encode()).hexdigest())
    untracked = "" if runtime else command(["git", "ls-files", "--others", "--exclude-standard", "-z"])
    report.provenance["untrackedFileSha256"] = {
        name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        for name in untracked.split("\0") if name and (ROOT / name).is_file()
    }
    report.provenance["profile"] = next(name for name in ["offline", "infra", "live", "all", "browsers", "chat"]
                                      if getattr(args, name))
    if args.browsers or args.chat:
        deployment = runtime or Deployment(args.environment)
        report.provenance["azdEnvironment"] = deployment.values.get("AZURE_ENV_NAME")
        record_deployment_origin_inventory(report, deployment)
        if args.browsers:
            browser_tests(report, deployment)
        else:
            customer_chat_tests(report, deployment, allow_agent_canary=args.customer_agent_canary,
                                allow_admin_agent_canary=args.admin_agent_canary)
        return report.save()
    try:
        # All profiles build the same assemblies. Serialize across invocations to avoid
        # concurrent MSBuild/test processes corrupting the shared build outputs.
        lock_path = ROOT / ".auth-results" / "validation.lock"
        lock_path.parent.mkdir(exist_ok=True)
        lock = lock_path.open("a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            lock.close()
            raise EvidenceError("Another authentication validation run is active") from error
        export_inventory(report, args.offline or args.all)
        if args.offline or args.all:
            offline_tests(report)
        contracts(report)
        if args.functions_host:
            functions_host_tests(report)
        if args.infra or args.live or args.all:
            deployment = runtime or Deployment(args.environment)
            report.provenance["azdEnvironment"] = deployment.values.get("AZURE_ENV_NAME")
            record_deployment_origin_inventory(report, deployment)
            if (args.infra or args.all) and runtime:
                report.provenance["infrastructureInspection"] = "Separate local-deployer report; not runtime ARM access"
            elif args.infra or args.all:
                infra(report, deployment)
            if args.live or args.all:
                live(report, deployment, allow_agent_canary=args.public_agent_canary,
                     allow_customer_agent_canary=args.customer_agent_canary,
                     allow_admin_agent_canary=args.admin_agent_canary)
    except (EvidenceError, KeyError, ValueError) as error:
        # Only known, non-sensitive discovery/shape errors. Unexpected programming errors remain visible.
        detail = str(error) if isinstance(error, EvidenceError) else "Unsupported inventory/configuration shape"
        report.add("suite:preflight", "preflight", "BLOCKED", detail)
    finally:
        if "lock" in locals() and not lock.closed:
            lock.close()
    return report.save()


if __name__ == "__main__":
    sys.exit(main())
