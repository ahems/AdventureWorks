#!/usr/bin/env python3
"""Resolve the deployed hosted identity and merge it into existing MCP trust.

Only performs Azure reads. The root postdeploy hook owns the Container App update.
"""

import argparse
import json
import re
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID


SETTING = "MCP_TRUSTED_SERVICE_PRINCIPAL_IDS"


def azure_json(arguments):
    result = subprocess.run(
        ["az", *arguments, "--only-show-errors", "--output", "json"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        # Do not echo arbitrary CLI output, deployment settings, or credentials.
        raise ValueError(f"Azure read failed ({arguments[0]}). Check deployment identity read permissions.")
    try:
        return json.loads(result.stdout)
    except ValueError as error:
        raise ValueError("Azure read returned invalid JSON.") from error


def principal_id(value):
    if not isinstance(value, str):
        raise ValueError("Hosted agent/MCP trust principal ID must be a UUID.")
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise ValueError("Hosted agent/MCP trust principal ID must be a UUID.") from error
    if str(parsed) != value.lower() or parsed.int == 0:
        raise ValueError("Hosted agent/MCP trust principal ID must be a nonzero canonical UUID.")
    return str(parsed)


def agent_url(endpoint):
    url = urlsplit(endpoint)
    if (url.scheme != "https" or not url.hostname or
            not url.hostname.endswith(".services.ai.azure.com") or
            url.username or url.password or url.port not in (None, 443) or url.fragment):
        raise ValueError("Expected an Azure Foundry HTTPS hosted-agent Responses endpoint.")
    match = re.fullmatch(
        r"(/api/projects/[A-Za-z0-9_-]+/agents/manufacturing-agent)/endpoint/protocols/openai/responses",
        url.path,
    )
    if not match:
        raise ValueError("Expected the manufacturing-agent deployment Responses endpoint.")
    return urlunsplit((url.scheme, url.netloc, match[1], "api-version=2025-11-15-preview", ""))


def resolve_trust(endpoint, resource_group, app_name):
    agent = azure_json(["rest", "--method", "get", "--resource", "https://ai.azure.com",
                        "--url", agent_url(endpoint)])
    if not isinstance(agent, dict) or agent.get("name") != "manufacturing-agent":
        raise ValueError("Foundry did not return the expected manufacturing agent.")
    versions = agent.get("versions")
    latest = versions.get("latest") if isinstance(versions, dict) else None
    if not isinstance(latest, dict):
        raise ValueError("The manufacturing agent has no deployed latest version.")
    definition = latest.get("definition")
    if not isinstance(definition, dict) or definition.get("kind") != "hosted":
        raise ValueError("The manufacturing agent is not a hosted agent; refusing to change MCP trust.")
    identity = latest.get("instance_identity")
    if not isinstance(identity, dict):
        raise ValueError("Hosted agent instance identity is not published; rerun deploy after identity creation.")
    # Never substitute blueprint principal, client ID, or project identity for the
    # instance principal: api-mcp validates the assertion's oid claim.
    hosted_principal = principal_id(identity.get("principal_id"))

    settings = azure_json([
        "containerapp", "show", "--resource-group", resource_group, "--name", app_name,
        "--query", "properties.template.containers[0].env[?name=='MCP_TRUSTED_SERVICE_PRINCIPAL_IDS' || name=='MCP_ENTRA_TENANT_ID']",
    ])
    if not isinstance(settings, list) or any(not isinstance(item, dict) for item in settings):
        raise ValueError("MCP Container App settings have an unexpected shape.")
    values = {item.get("name"): item.get("value") for item in settings}
    principal_id(values.get("MCP_ENTRA_TENANT_ID"))
    existing = values.get(SETTING)
    if not isinstance(existing, str) or not existing.strip():
        raise ValueError("Existing shared-identity MCP trust is missing; refusing to replace it.")
    trusted = list(dict.fromkeys(principal_id(value) for value in re.split(r"[,;\s]+", existing.strip())))
    if hosted_principal not in trusted:
        trusted.append(hosted_principal)
    return ",".join(trusted)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--resource-group", required=True)
    parser.add_argument("--app-name", required=True)
    args = parser.parse_args()
    try:
        print(resolve_trust(args.endpoint, args.resource_group, args.app_name))
    except (ValueError, OSError) as error:
        print(f"Hosted agent MCP trust resolution failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
