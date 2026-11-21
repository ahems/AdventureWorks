#!/usr/bin/env python3
"""Recreate a local azd environment for a demo deployed by the GitHub workflow.

The GitHub workflow runs `azd up` on a disposable runner, so its azd state is
discarded. This script reads the deployed resource group (read-only Azure
calls) and writes the values that `azd up` would have stored locally:

* non-secret outputs of the latest successful `infra/main.bicep` deployment;
* azd inputs recovered by inverting `infra/main.parameters.json`;
* hook-derived aliases (`VITE_API_URL`, `VITE_API_FUNCTIONS_URL`);
* Foundry agent IDs and the hosted-agent endpoint from Function App settings.

It never modifies Azure and refuses to overwrite an existing azd environment.
`FOUNDRY_AGENT_CONFIG_HASH` is deliberately not recovered, so the next local
`azd deploy` re-applies the checked-out agent definitions.
"""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PARAMETERS_FILE = ROOT / "infra" / "main.parameters.json"
ENV_NAME_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,64}$")
GUID_PATTERN = re.compile(r"^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")
PLACEHOLDER_PATTERN = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}$")
EXCLUDED_OUTPUTS = {"AZURE_STATIC_WEB_APP_DEPLOYMENT_TOKEN"}
SECRET_OUTPUT_TYPES = {"securestring", "secureobject"}
APP_SETTING_PATTERN = re.compile(r"^AI_AGENT_[A-Z0-9_]+_ID$")
APP_SETTING_NAMES = {"MANUFACTURING_AGENT_ENDPOINT"}
REQUIRED_AGENT_SETTINGS = (
    "AI_AGENT_CHAT_ID", "AI_AGENT_ORDER_ID", "AI_AGENT_PROMOTION_ID",
    "AI_AGENT_HELP_ME_CHOOSE_ID", "AI_AGENT_CART_RECOVERY_ID", "AI_AGENT_PRODUCT_CONTENT_ID",
)
REQUIRED_KEYS = (
    "AZURE_ENV_NAME", "AZURE_SUBSCRIPTION_ID", "AZURE_RESOURCE_GROUP", "AZURE_LOCATION",
    "API_URL", "API_FUNCTIONS_URL", "API_MCP_URL", "SERVICE_API_FUNCTIONS_NAME",
)
# Outputs that identify the root main.bicep deployment rather than a module.
ROOT_DEPLOYMENT_OUTPUTS = ("API_URL", "SERVICE_API_FUNCTIONS_NAME")


class RecoveryError(Exception):
    pass


def run(command):
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise RecoveryError(f"{' '.join(command[:3])} failed: {detail[-1] if detail else 'no output'}")
    return result.stdout


def run_json(command):
    output = run(command)
    try:
        return json.loads(output or "null")
    except json.JSONDecodeError as error:
        raise RecoveryError(f"{' '.join(command[:3])} returned invalid JSON") from error


def as_env_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"))
    return "" if value is None else str(value)


def parameter_env_map(path=PARAMETERS_FILE):
    """Map Bicep parameter names to the azd variables that populate them."""
    parameters = json.loads(path.read_text())["parameters"]
    mapping = {}
    for name, definition in parameters.items():
        value = definition.get("value")
        match = PLACEHOLDER_PATTERN.match(value) if isinstance(value, str) else None
        if match:
            mapping[name] = match.group(1)
    return mapping


def select_deployment(deployments, environment):
    candidates = []
    for deployment in deployments or []:
        properties = deployment.get("properties") or {}
        parameters = properties.get("parameters") or {}
        outputs = properties.get("outputs") or {}
        if properties.get("provisioningState") != "Succeeded":
            continue
        if (parameters.get("environmentName") or {}).get("value") != environment:
            continue
        output_keys = {key.casefold() for key in outputs}
        if not all(key.casefold() in output_keys for key in ROOT_DEPLOYMENT_OUTPUTS):
            continue
        candidates.append(deployment)
    if not candidates:
        raise RecoveryError(
            f"No successful main.bicep deployment for environment '{environment}' was found in the resource group."
        )
    return max(candidates, key=lambda item: item["properties"].get("timestamp") or "")


def output_name_map(template):
    outputs = template.get("outputs") if isinstance(template, dict) else None
    if not isinstance(outputs, dict):
        raise RecoveryError("The exported deployment template has no output definitions.")
    names = {}
    for name in outputs:
        normalized = name.casefold()
        if normalized in names:
            raise RecoveryError("The exported deployment template has ambiguous output names.")
        names[normalized] = name
    return names


def deployment_values(deployment, parameter_map, output_names):
    properties = deployment["properties"]
    values = {}
    sources = {}
    for name, parameter in (properties.get("parameters") or {}).items():
        key = parameter_map.get(name)
        if key and "value" in parameter:
            value = as_env_value(parameter["value"])
            if value != "":
                values[key], sources[key] = value, "parameter"
    seen = set()
    for raw_name, output in (properties.get("outputs") or {}).items():
        normalized = raw_name.casefold()
        if normalized in seen:
            raise RecoveryError("The deployment has ambiguous output names.")
        seen.add(normalized)
        name = output_names.get(normalized)
        if name is None:
            raise RecoveryError(f"Deployment output '{raw_name}' is absent from the exported template.")
        if name.upper() in EXCLUDED_OUTPUTS or str(output.get("type", "")).lower() in SECRET_OUTPUT_TYPES:
            continue
        values[name], sources[name] = as_env_value(output.get("value")), "output"
    return values, sources


def app_setting_values(settings):
    values = {}
    for setting in settings or []:
        name, value = setting.get("name", ""), setting.get("value")
        if value and (name in APP_SETTING_NAMES or APP_SETTING_PATTERN.match(name)):
            values[name] = value
    return values


def existing_environments():
    environments = run_json(["azd", "env", "list", "--output", "json", "--no-prompt"]) or []
    return {item.get("Name") or item.get("name") for item in environments}


def collect(args):
    subscription = args.subscription or run(
        ["az", "account", "show", "--query", "id", "--output", "tsv"]).strip()
    if not GUID_PATTERN.match(subscription):
        raise RecoveryError("Could not determine a valid subscription ID; pass --subscription.")
    resource_group = args.resource_group or f"rg-{args.environment}"
    scope = ["--subscription", subscription, "--output", "json"]

    tenant = run(["az", "account", "show", "--subscription", subscription,
                  "--query", "tenantId", "--output", "tsv"]).strip()
    group = run_json(["az", "group", "show", "--name", resource_group, *scope])
    tagged_env = (group.get("tags") or {}).get("azd-env-name")
    if tagged_env and tagged_env != args.environment:
        raise RecoveryError(
            f"Resource group {resource_group} belongs to azd environment '{tagged_env}', not '{args.environment}'."
        )

    deployments = run_json(["az", "deployment", "group", "list", "--resource-group", resource_group, *scope])
    deployment = select_deployment(deployments, args.environment)
    template = run_json([
        "az", "deployment", "group", "export", "--name", deployment["name"],
        "--resource-group", resource_group, *scope,
    ])
    values, sources = deployment_values(deployment, parameter_env_map(), output_name_map(template))

    base = {
        "AZURE_ENV_NAME": args.environment,
        "AZURE_SUBSCRIPTION_ID": subscription,
        "AZURE_RESOURCE_GROUP": resource_group,
        "AZURE_LOCATION": group.get("location", ""),
        "TENANT_ID": tenant,
    }
    for key, value in base.items():
        values[key], sources[key] = value, "resource group"
    for alias, source in (("VITE_API_URL", "API_URL"), ("VITE_API_FUNCTIONS_URL", "API_FUNCTIONS_URL")):
        if values.get(source):
            values[alias], sources[alias] = values[source], "derived"

    if not args.skip_app_settings and values.get("SERVICE_API_FUNCTIONS_NAME"):
        settings = run_json([
            "az", "functionapp", "config", "appsettings", "list",
            "--name", values["SERVICE_API_FUNCTIONS_NAME"], "--resource-group", resource_group, *scope,
        ])
        agent_settings = app_setting_values(settings)
        missing_agents = [key for key in REQUIRED_AGENT_SETTINGS if not agent_settings.get(key)]
        if missing_agents:
            raise RecoveryError(
                "Function App is missing required agent settings: " + ", ".join(missing_agents) +
                ". The deployment may not have completed; use --skip-app-settings only for partial recovery."
            )
        for key, value in agent_settings.items():
            values[key], sources[key] = value, "function app setting"

    missing = [key for key in REQUIRED_KEYS if not values.get(key)]
    if missing:
        raise RecoveryError("Deployment is missing required values: " + ", ".join(missing))
    return values, sources, deployment.get("name", "")


def write_environment(environment, values):
    run(["azd", "env", "new", environment, "--subscription", values["AZURE_SUBSCRIPTION_ID"],
         "--location", values["AZURE_LOCATION"], "--no-prompt"])
    try:
        for key in sorted(values):
            run(["azd", "env", "set", key, values[key], "--environment", environment, "--no-prompt"])
    except RecoveryError as error:
        raise RecoveryError(
            f"{error}. The local azd environment is incomplete; delete .azure/{environment} and rerun."
        ) from error


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--environment", required=True,
                        help="azd environment name used by the GitHub run, for example adventureworks042")
    parser.add_argument("--subscription", help="subscription ID; default is the current Azure CLI subscription")
    parser.add_argument("--resource-group", help="resource group; default is rg-<environment>")
    parser.add_argument("--skip-app-settings", action="store_true",
                        help="do not read Foundry agent IDs from the Function App settings")
    parser.add_argument("--dry-run", action="store_true", help="list the keys that would be written")
    args = parser.parse_args(argv)
    if not ENV_NAME_PATTERN.match(args.environment):
        parser.error("--environment may contain only letters, numbers and hyphens (max 64).")
    if args.subscription and not GUID_PATTERN.match(args.subscription):
        parser.error("--subscription must be a subscription ID (GUID).")
    return args


def main(argv=None):
    args = parse_args(argv)
    try:
        if args.environment in existing_environments():
            raise RecoveryError(
                f"azd environment '{args.environment}' already exists locally; refusing to overwrite it."
            )
        values, sources, deployment_name = collect(args)
        print(f"Recovered {len(values)} values from deployment '{deployment_name}':")
        for key in sorted(values):
            print(f"  {key} ({sources[key]})")
        if args.dry_run:
            print("Dry run: no azd environment was created.")
            return 0
        write_environment(args.environment, values)
    except RecoveryError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"Created and selected azd environment '{args.environment}'.")
    print("Not recovered: FOUNDRY_AGENT_CONFIG_HASH and AI_AGENT_*_MEMORY_STORE; "
          "the next 'azd deploy' re-applies agent definitions and restores them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
