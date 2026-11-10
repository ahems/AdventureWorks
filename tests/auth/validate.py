#!/usr/bin/env python3
"""Authentication assurance. Never treats unavailable evidence as conformance."""

import argparse
import base64
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import fcntl
import fnmatch
import importlib.util
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


def json_command(args, **kwargs):
    try:
        return json.loads(command(args, **kwargs))
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


def route_path(route):
    def substitute(match):
        specification = match.group(1).lstrip("*").rstrip("?")
        if ":guid" in specification:
            return "11111111-1111-1111-1111-111111111111"
        return "1" if re.search(r":(?:int|long|decimal|double|float)", specification) else "auth-validation"
    return re.sub(r"\{([^{}]+)\}", substitute, route)


def http(method, url, *, token=None, data=None, form=None, headers=None, timeout=90):
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
    opener = urllib.request.build_opener(NoRedirect())
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
        "Microsoft.CognitiveServices/accounts/write",
        "Microsoft.CognitiveServices/accounts/listKeys/action",
        "Microsoft.CognitiveServices/accounts/regenerateKey/action",
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


def dab_inventory(config):
    entities = config.get("entities")
    if not isinstance(entities, dict) or not entities:
        raise EvidenceError("DAB entity discovery is empty")
    operations = []
    for name, entity in entities.items():
        permissions = entity.get("permissions")
        if not isinstance(permissions, list) or not permissions:
            raise EvidenceError(f"DAB entity {name} has no permissions")
        for permission in permissions:
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
                operations.append({"entity": name, "role": permission["role"], "action": action,
                                   "rest": entity.get("rest", True),
                                   "graphql": entity.get("graphql", True),
                                   "source": entity["source"], "permission": permission})
    return operations


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
        args += ["--logger", "trx", "--results-directory", str(report.output / "dotnet")]
        try:
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
        report.inventory[filename.removesuffix(".json")] = inventory


def offline_tests(report):
    commands = [
        ("python:auth", ["python3", "-B", "-m", "unittest", "discover", "-s", "tests/scripts",
                         "-p", "test_azure_auth.py"]),
        ("python:hosted", ["python3", "-B", "-m", "unittest", "discover", "-s", "tests/scripts",
                           "-p", "test_hosted_agent_mcp_trust.py"]),
        ("python:assurance", ["python3", "-B", "-m", "unittest", "discover", "-s", "tests/auth",
                              "-p", "test_*.py"]),
        ("python:seed-storage", ["python3", "-B", "-m", "unittest", "discover", "-s", "seed-job/tests",
                                 "-p", "test_seed*.py"]),
        ("node:auth", ["node", "--experimental-vm-modules", "--test",
                       "tests/scripts/test-route-auth.mjs", "tests/scripts/test-eshop-chat.mjs",
                       "tests/scripts/test-review-auth.mjs", "tests/scripts/test-guest-cart-auth.mjs",
                       "tests/scripts/test-cart-provider-auth.mjs", "tests/scripts/test-runtime-rbac.cjs"]),
    ]
    for name, args in commands:
        try:
            command(args, timeout=180)
            report.add(name, "offline", "PASS", "Configured test runner passed")
        except EvidenceError as error:
            report.add(name, "offline", "FAIL", str(error))


def review_contract(report, config):
    permissions = {item["role"]: item for item in config["entities"]["ProductReview"]["permissions"]}
    report.check("dab:reviews:anonymous-read-only", "contracts",
                 permissions.get("anonymous", {}).get("actions") == ["read"],
                 "Anonymous users may read reviews but never create, like or delete them")
    for role in ["authenticated", "consumer"]:
        actions = {item if isinstance(item, str) else item["action"]:
                   {} if isinstance(item, str) else item
                   for item in permissions.get(role, {}).get("actions", [])}
        create = actions.get("create", {})
        update = actions.get("update", {})
        report.check("dab:reviews:owner-bound-create:" + role, "contracts",
                     create.get("policy", {}).get("database") == "@item.UserID eq @claims.business_entity_id" and
                     set(create.get("fields", {}).get("include", [])) ==
                     {"ProductID", "ReviewerName", "ReviewDate", "EmailAddress", "Rating", "Comments", "UserID"},
                     "Review creation binds authorship to identity and excludes moderation/vote fields")
        report.check("dab:reviews:vote-fields-owner:" + role, "contracts",
                     update.get("fields", {}).get("include") == ["HelpfulVotes"] and
                     not update.get("policy"),
                     "Authenticated review updates are vote-only; DAB policy columns must not broaden writable fields")


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
    public = {item["Name"] for item in functions if item["Policy"] and item["Policy"]["IsAnonymous"]}
    report.check("inventory:public-functions", "contracts",
                 public == set(contract["publicFunctions"]),
                 "Anonymous/alternate-enforcement registry must exactly match reviewed contract")
    for name in sorted(public):
        classification = contract["publicFunctions"].get(name)
        report.add("exception:function:" + name, "exceptions",
                   "ACCEPTED_EXCEPTION" if classification else "FAIL",
                   classification or "Unreviewed anonymous function")
    config = json.loads((ROOT / "api/dab-config.json").read_text())
    operations = dab_inventory(config)
    review_contract(report, config)
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
    report.add("inventory:caller-trust-edge-closure", "agents", "BLOCKED",
               "Provisioners are discovered; complete source/deployment caller and dependency-edge reconciliation remains required")
    for name in agents:
        report.add("agent-path:" + name, "agents", "BLOCKED",
                   "Actual deployed identity, tool calls and dependency authorization require correlated runtime evidence")
    for obligation in ["functions-middleware-host-denials", "all-ownership-handlers-two-owners",
                       "browser-real-login-all-sites", "dab-all-role-operation-decisions",
                       "mcp-task-ownership", "entra-assertion-real-signature-negatives"]:
        report.add("required:" + obligation, "required", "BLOCKED",
                   "Required coverage obligation is not established by registry or helper tests")


class Deployment:
    def __init__(self, environment):
        self.environment = environment
        args = ["azd", "env", "get-values", "--output", "json", "--no-prompt"]
        if environment:
            args += ["--environment", environment]
        self.values = json_command(args)
        if not isinstance(self.values, dict):
            raise EvidenceError("azd returned no environment object")
        self.subscription = self.required("AZURE_SUBSCRIPTION_ID")
        self.group = self.required("AZURE_RESOURCE_GROUP")

    def required(self, key):
        value = self.values.get(key)
        if not isinstance(value, str) or not value.strip():
            raise EvidenceError(f"azd value {key} is missing")
        return value.strip()

    def azure(self, *args):
        return json_command(["az", *args, "--subscription", self.subscription,
                             "--only-show-errors", "--output", "json"])

    def resource(self, provider_path):
        return (f"https://management.azure.com/subscriptions/{self.subscription}"
                f"/resourceGroups/{self.group}/providers/{provider_path}")

    def arm(self, provider_path, version):
        return self.azure("rest", "--method", "get", "--url",
                          self.resource(provider_path) + "?api-version=" + version)


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
        report.check("infra:functions-sql-passwordless", "infra",
                     passwordless_sql(settings.get("SQL_CONNECTION_STRING")),
                     "Functions SQL configuration uses Entra authentication without embedded credentials")
    report.guarded("infra:function-settings", "infra", functions)
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
    report.guarded("infra:runtime-roles", "infra", roles)
    def agents():
        deployed = fetch_agents(d)
        expected = set(report.inventory.get("agentProvisioners", [])) | {"manufacturing-agent"}
        unexpected = set(deployed) - expected
        # Workflow provisioners also create intent sub-agents; follow those declarations.
        summaries = []
        references = set()
        custom_origin = origin(d.required("API_MCP_URL"))
        dab_origin = origin(d.required("API_URL"))
        for name, agent in sorted(deployed.items()):
            latest = agent["versions"]["latest"]
            definition = latest["definition"]
            tools = []
            refs = []
            if definition.get("kind") == "workflow":
                workflow = definition.get("workflow", "")
                if not isinstance(workflow, str):
                    raise EvidenceError("Unsupported workflow definition shape")
                refs = re.findall(r"\bagent:\s*\n\s+name:\s*([A-Za-z0-9_-]+)", workflow)
                report.check("agent:workflow-shape:" + name, "agents",
                             len(refs) == len(re.findall(r"kind:\s*InvokeAzureAgent\b", workflow)),
                             "Every workflow agent invocation must have a resolved static reference")
                references.update(refs)
            for tool in definition.get("tools", []):
                summary = {"type": tool.get("type")}
                if tool.get("type") == "mcp":
                    target = tool.get("server_url")
                    tool_origin = origin(target) if isinstance(target, str) else None
                    summary.update({"server": tool.get("server_label"),
                                    "resource": "custom-mcp" if tool_origin == custom_origin else
                                    "dab-mcp" if tool_origin == dab_origin else "unclassified",
                                    "hasStoredAuthorization": any(key.lower() == "authorization"
                                                                  for key in tool.get("headers", {}))})
                    report.check(f"agent:tool-origin:{name}:{len(tools)}", "agents",
                                 summary["resource"] != "unclassified",
                                 "Deployed MCP origin must match selected custom MCP or DAB")
                    report.check(f"agent:no-stored-token:{name}:{len(tools)}", "agents",
                                 not summary["hasStoredAuthorization"],
                                 "Deployed agent definition must not store a bearer token")
                tools.append(summary)
            summaries.append({"name": name, "version": latest.get("version"),
                              "kind": definition.get("kind"), "tools": tools,
                              "agentReferences": refs,
                              "hasInstanceIdentity": bool(latest.get("instance_identity", {}).get("principal_id"))})
        report.inventory["deployedAgents"] = summaries
        known_obligations = {check["id"] for check in report.checks}
        for item in summaries:
            check_id = "agent-path:" + item["name"]
            if check_id not in known_obligations:
                report.add(check_id, "agents", "BLOCKED",
                           "Discovered hosted/sub-agent requires actual runtime identity and dependency evidence")
        report.check("agent:workflow-reference-closure", "agents", references <= set(deployed),
                     "All deployed workflow sub-agent references resolve")
        report.check("agent:unexpected-deployed", "agents", not (unexpected - references),
                     "Deployed agents must be explained by provisioners, hosted service or workflow references")
        report.check("agent:missing-deployed", "agents", expected <= set(deployed),
                     "Every agent provisioner/hosted service must have a deployed agent")
        report.provenance["agentVersions"] = {item["name"]: item["version"] for item in summaries}
    report.guarded("infra:deployed-agents", "agents", agents)
    def revisions():
        services = {}
        identity = d.azure("identity", "show", "-g", d.group,
                           "-n", d.required("USER_MANAGED_IDENTITY_NAME"))
        for key in ["SERVICE_API_NAME", "SERVICE_API_MCP_NAME",
                    "SERVICE_APP_ADMIN_NAME", "SERVICE_APP_MANUFACTURING_NAME"]:
            app = d.azure("containerapp", "show", "-g", d.group, "-n", d.required(key))
            properties = app["properties"]
            services[key] = {"latestRevision": properties.get("latestRevisionName"),
                             "readyRevision": properties.get("latestReadyRevisionName")}
            report.check("revision:" + key, "infra",
                         bool(properties.get("latestReadyRevisionName")) and
                         properties.get("latestRevisionName") == properties.get("latestReadyRevisionName"),
                         "Latest deployed Container App revision is ready")
            if key in {"SERVICE_API_NAME", "SERVICE_API_MCP_NAME"}:
                configured = {item["name"]: item.get("value", "") for item in
                              properties["template"]["containers"][0].get("env", [])}
                attached = app.get("identity", {}).get("userAssignedIdentities", {})
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
        report.provenance["containerRevisions"] = services
    report.guarded("infra:revisions", "infra", revisions)
    for check_id, detail in [
            ("effective-sql-grants", "Verify contained users and SQL grants from approved private-network runtime"),
            ("workload-data-plane", "Developer role discovery is not proof of actual workload data-plane access"),
            ("all-principal-edges", "Hosted/project/seed identities and assignment conditions need edge-by-edge verification"),
            ("local-auth-exceptions", "Mount/logging/deployment credentials need exact scoped exception verification")]:
        report.add("infra:" + check_id, "infra", "BLOCKED", detail)


def load_auth_helper():
    spec = importlib.util.spec_from_file_location("azure_auth", ROOT / "scripts/utilities/azure-auth.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def persist_fixture_values(deployment, values):
    entries = json_command(["azd", "env", "list", "--output", "json"])
    selected = [entry for entry in entries if
                entry.get("Name") == deployment.environment] if deployment.environment else [
                    entry for entry in entries if entry.get("IsDefault")]
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
    scopes = "mcp.access products.read customers.read customers.write orders.read orders.write"

    def __init__(self, deployment, label, email, password, business_id=None):
        self.deployment, self.label = deployment, label
        self.email, self.password, self.business_id = email, password, business_id
        self.tokens = {}

    def exchange(self, resource, scopes=None):
        base = origin(self.deployment.required("API_MCP_URL"))
        audience = self.deployment.values.get(resource.upper() + "_RESOURCE_IDENTIFIER", base + "/" + resource)
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
            valid = (isinstance(token, str) and claims.get("category") == "consumer" and
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
        status, _, body = http(method, url, token=token, headers=headers, data=data)
        try:
            return status, json.loads(body)
        except ValueError as error:
            raise EvidenceError("Consumer cart endpoint returned invalid JSON") from error

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
            status, _, _ = http(method, dab + path, data=data)
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


def guest_cart_browser(report, deployment, consumer=None):
    app = deployment.azure("staticwebapp", "show", "--name", deployment.required("SERVICE_APP_NAME"),
                           "--resource-group", deployment.required("AZURE_RESOURCE_GROUP"))
    hostname = app.get("defaultHostname")
    if not isinstance(hostname, str) or not hostname:
        raise EvidenceError("Cannot discover deployed storefront hostname")
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith("AUTH_BROWSER_CONSUMER_")}
    environment["AUTH_BROWSER_SITE_URL"] = https_url("https://" + hostname)
    environment["API_FUNCTIONS_URL"] = https_url(deployment.required("API_FUNCTIONS_URL"))
    if consumer is not None:
        consumer.tokens.pop(("functions", None), None)
        environment.update({
            "AUTH_BROWSER_CONSUMER_EMAIL": consumer.email,
            "AUTH_BROWSER_CONSUMER_PASSWORD": consumer.password,
            "AUTH_BROWSER_CONSUMER_ID": str(consumer.business_id),
            "AUTH_BROWSER_CONSUMER_TOKEN": consumer.token("functions"),
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
    expected = {"guest-add-persists", "guest-cart-survives-reload", "checkout-requires-signin",
                "no-non-cart-function-mutations", "exact-browser-fixture-retired"}
    if consumer is not None:
        expected.update({"consumer-auto-merge", "merged-guest-proof-denied", "consumer-cart-reload",
                         "exact-consumer-fixture-removed"})
    if any(check.get("status") == "BLOCKED" for check in checks):
        report.add("browser:guest-cart:complete", "frontend", "BLOCKED",
                   "Browser prerequisites are unavailable; no browser conformance claimed")
    else:
        report.check("browser:guest-cart:complete", "frontend",
                     failure is None and len(checks) == len(expected) and
                     {check.get("name") for check in checks} == expected,
                     "Actual deployed browser bootstrap, persistence, checkout guard, required sign-in/merge "
                     "and exact cleanup all completed")


def live(report, deployment, environment):
    d = deployment
    functions_base = https_url(d.required("API_FUNCTIONS_URL"))
    mcp_base = origin(d.required("API_MCP_URL"))
    dab_base = origin(d.required("API_URL"))
    report.guarded("guest-cart:scenario", "ownership", lambda: guest_cart_live(report, d))
    consumers = []
    report.guarded("consumer-fixtures:setup", "fixtures",
                   lambda: consumers.extend(consumer_fixtures(report, d)))
    if len(consumers) == 2:
        report.guarded("consumer-cart:scenario", "ownership", lambda: consumer_cart_live(report, d, consumers))
    else:
        report.add("consumer-cart:scenario", "ownership", "BLOCKED", "Two reusable consumer identities unavailable")
        report.add("browser:consumer-cart:scenario", "frontend", "BLOCKED",
                   "Real consumer browser sign-in requires the reusable fixture")
    report.guarded("browser:guest-cart:scenario", "frontend",
                   lambda: guest_cart_browser(report, d, consumers[0] if consumers else None))
    obligations = []
    for function in report.inventory.get("functions", []):
        policy = function["Policy"]
        if policy is None or policy["IsAnonymous"]:
            continue
        for method in function["Methods"]:
            prefix = f"functions:{function['Name']}:{method}"
            if method not in {"GET", "HEAD"} and not (function["Name"] == "MergeGuestCart" and method == "POST"):
                report.add(prefix + ":deny", "live-denials", "BLOCKED",
                           "Mutation denial probe requires reviewed per-operation safe fixture; no resets/queue clears")
            else:
                url = functions_base + "/api/" + route_path(function["Route"])
                for label, token in [("anonymous", None), ("forged", "invalid-auth-validation-token")]:
                    obligations.append((prefix + ":" + label, method, url, token, None))
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
        for identity in ["admin", "manufacturing"]:
            for resource in ["functions", "dab", "mcp"]:
                base, audience = helper.deployment(environment, resource)
                args = argparse.Namespace(identity=identity, command="token", timeout=120)
                opener = urllib.request.build_opener(
                    helper.NoRedirect(), urllib.request.HTTPCookieProcessor())
                try:
                    session = helper.session(opener, args, base, audience)
                except (helper.AuthError, ValueError, OSError) as error:
                    raise EvidenceError(f"Authentication helper could not obtain {identity}/{resource} session") from error
                token = session["access_token"]
                if resource == "functions":
                    path = "/api/shopping-simulator/status" if identity == "admin" else "/api/manufacturing/status"
                    status, _, body = http("GET", functions_base + path, token=token)
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
                    wrong_status, _, _ = http("GET", functions_base + "/api/manufacturing/status", token=token)
                    report.check(f"deny:{identity}:mcp-token-at-functions", "live-denials",
                                 wrong_status == 401, f"Cross-audience token rejected with HTTP {wrong_status}")
                    status, _, body = http("POST", mcp_base + "/mcp", token=token,
                                          data={"jsonrpc": "2.0", "id": 10, "method": "tools/call",
                                                "params": {"name": "get_manufacturing_status", "arguments": {}}})
                    document = mcp_document(body)
                    result = document.get("result", {})
                    text = "\n".join(item.get("text", "") for item in result.get("content", []))
                    report.check(f"allow:{identity}:{resource}", "live-allows",
                                 status == 200 and not document.get("error") and not result.get("isError") and
                                 "## Manufacturing Simulation Status" in text and "Queue Depth:" in text,
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
    report.guarded("live:authenticated-paths", "live-allows", authenticated)
    report.add("live:simulator-budget", "mutations", "BLOCKED",
               "No simulator started: atomic three-order budget, retry-safe creation and indirect email suppression are unverified")
    report.add("live:browser", "browser", "BLOCKED",
               "Storefront consumer cart sign-in is covered; admin/manufacturing/Inspector UI and broader "
               "logout/token-origin/session scenarios remain required")
    report.add("live:dab-native-mcp", "live-allows", "BLOCKED",
               "Native DAB MCP handshake and role-specific tools require dedicated protocol tests")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    profile = parser.add_mutually_exclusive_group(required=True)
    for name in ["offline", "infra", "live", "all"]:
        profile.add_argument("--" + name, action="store_true")
    parser.add_argument("--environment", help="azd environment; otherwise use current selection")
    parser.add_argument("--output", type=Path, help="New evidence directory; defaults to ignored .auth-results/<run-id>")
    args = parser.parse_args(argv)
    output = (args.output or ROOT / ".auth-results" / str(uuid.uuid4())).resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = Report(output)
    report.provenance["sourceRevision"] = command(["git", "rev-parse", "HEAD"]).strip()
    diff = command(["git", "diff", "--no-ext-diff", "HEAD"])
    report.provenance["trackedDiffSha256"] = hashlib.sha256(diff.encode()).hexdigest()
    untracked = command(["git", "ls-files", "--others", "--exclude-standard", "-z"])
    report.provenance["untrackedFileSha256"] = {
        name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        for name in untracked.split("\0") if name and (ROOT / name).is_file()
    }
    report.provenance["profile"] = next(name for name in ["offline", "infra", "live", "all"]
                                      if getattr(args, name))
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
        if args.infra or args.live or args.all:
            deployment = Deployment(args.environment)
            report.provenance["azdEnvironment"] = deployment.values.get("AZURE_ENV_NAME")
            if args.infra or args.all:
                infra(report, deployment)
            if args.live or args.all:
                live(report, deployment, args.environment)
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
