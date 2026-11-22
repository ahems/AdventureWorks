#!/usr/bin/env python3
"""Report legacy runtime grants that current Bicep no longer creates (report-only).

The conditioned azd deployer may delete only the roles in
infra/azd-role-assignment-allowlist.json, which excludes these legacy roles. Demo
environments that still carry them are recreated, not repaired in place.
"""

import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
CONTRIBUTOR = "b24988ac-6180-42a0-ab88-20f7382dd24c"
IDENTITY_OPERATOR = "f1a07417-d97a-45cb-824c-7a7467783830"
ACR_PULL = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
COMMUNICATION_EMAIL_OWNER = "09976791-48a7-449e-bb21-39d1a415f350"
LEGACY_ACTIONS = {
    "microsoft.storage/storageaccounts/*", "microsoft.containerinstance/containergroups/*",
    "microsoft.resources/deployments/*", "microsoft.resources/deploymentscripts/*",
}


class ReconciliationError(Exception):
    pass


def command(args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=180, check=False)
    if result.returncode:
        raise ReconciliationError("CLI operation failed: " + " ".join(args[:3]) +
                                  "; raw output withheld to avoid exposing configuration")
    try:
        return json.loads(result.stdout) if result.stdout.strip() else None
    except ValueError as error:
        raise ReconciliationError("CLI returned invalid JSON") from error


def exact_permissions(definition, actions):
    permissions = definition.get("permissions")
    return (isinstance(permissions, list) and len(permissions) == 1 and isinstance(permissions[0], dict) and
            isinstance(permissions[0].get("actions"), list) and
            all(isinstance(action, str) for action in permissions[0]["actions"]) and
            {action.lower() for action in permissions[0].get("actions", [])} == actions and
            not permissions[0].get("notActions") and not permissions[0].get("dataActions") and
            not permissions[0].get("notDataActions"))


def retirement_plan(assignments, definitions, principal, group, acr, communication):
    normalized = {key: value.lower() for key, value in {
        "principal": principal, "group": group, "acr": acr, "communication": communication}.items()}
    own = [item for item in assignments if item.get("principalId", "").lower() == normalized["principal"]]
    by_id = {definition["name"].lower(): definition for definition in definitions}

    def role_id(item):
        return item.get("roleDefinitionId", "").rsplit("/", 1)[-1].lower()

    if not any(role_id(item) == ACR_PULL and item.get("scope", "").lower() == normalized["acr"] and
               not item.get("condition") for item in own):
        raise ReconciliationError("Exact unconditional runtime AcrPull replacement is missing")
    email = [item for item in own if role_id(item) == COMMUNICATION_EMAIL_OWNER and
             item.get("scope", "").lower() == normalized["communication"] and
             not item.get("condition") and not item.get("conditionVersion")]
    if len(email) != 1:
        raise ReconciliationError("One unconditional resource-scoped Communication and Email Service Owner is required")
    targets = []
    for item in own:
        scope, identifier = item.get("scope", "").lower(), role_id(item)
        if ((identifier == CONTRIBUTOR and scope in {normalized["acr"], normalized["communication"]}) or
                (identifier == IDENTITY_OPERATOR and scope == normalized["group"])):
            targets.append(item)
        elif scope == normalized["group"]:
            definition = by_id.get(identifier, {})
            if definition.get("roleName", "").startswith("av-deployment-script-role-"):
                if (not exact_permissions(definition, LEGACY_ACTIONS) or
                        {value.lower() for value in definition.get("assignableScopes", [])} != {normalized["group"]}):
                    raise ReconciliationError("Legacy custom role differs from the reviewed definition; refusing deletion")
                targets.append(item)
    if len(targets) > 4:
        raise ReconciliationError("More than four legacy runtime bindings discovered; refusing bulk cleanup")
    return targets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment")
    args = parser.parse_args()
    env_args = ["azd", "env", "get-values", "--output", "json", "--no-prompt"]
    if args.environment:
        env_args += ["--environment", args.environment]
    values = command(env_args)

    def required(key):
        value = values.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ReconciliationError("Missing selected azd value: " + key)
        return value.strip()

    subscription, group_name = required("AZURE_SUBSCRIPTION_ID"), required("AZURE_RESOURCE_GROUP")
    group = f"/subscriptions/{subscription}/resourceGroups/{group_name}"

    def az(*arguments):
        return command(["az", *arguments, "--subscription", subscription, "--only-show-errors", "--output", "json"])

    identity = az("identity", "show", "-g", group_name, "-n", required("USER_MANAGED_IDENTITY_NAME"))
    registry = az("acr", "show", "-g", group_name,
                  "-n", required("AZURE_CONTAINER_REGISTRY_ENDPOINT").split(".")[0])
    communication = group + "/providers/Microsoft.Communication/communicationServices/" + required("COMMUNICATION_SERVICE_NAME")
    assignments = az("role", "assignment", "list", "--all")
    definitions = az("role", "definition", "list")
    targets = retirement_plan(assignments, definitions, identity["principalId"], group, registry["id"], communication)
    if not targets:
        print("Runtime RBAC matches source: no legacy runtime role bindings found.")
        return 0
    print(f"WARNING: {len(targets)} legacy runtime role binding(s) that current Bicep no longer grants:")
    for item in targets:
        print(f"  - {item.get('roleDefinitionName') or item.get('roleDefinitionId', '')} at {item.get('scope', '')}")
    print("This environment predates the current RBAC model. Recreate the demo environment "
          "rather than removing these bindings in place.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ReconciliationError, OSError, subprocess.TimeoutExpired) as error:
        raise SystemExit("ERROR: " + str(error))
