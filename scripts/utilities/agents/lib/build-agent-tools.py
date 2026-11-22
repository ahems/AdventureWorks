#!/usr/bin/env python3
"""Build a fail-closed Foundry MCP tool configuration for an agent."""

import json
import sys
from urllib.parse import urlsplit


def parse_allowlist(raw, label):
    try:
        names = json.loads(raw)
    except ValueError as error:
        raise ValueError(f"{label} allow-list is not valid JSON") from error
    if (not isinstance(names, list) or
            any(not isinstance(name, str) or not name or name != name.strip() or
                any(char.isspace() for char in name) for name in names) or
            len(names) != len(set(names))):
        raise ValueError(f"{label} allow-list must contain unique non-empty tool names")
    return names


def require_https_url(value, label):
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or
            parsed.query or parsed.fragment):
        raise ValueError(f"{label} MCP URL must be an absolute HTTPS URL")
    return value


def build_tools(mcp_url, dab_url, allowed_mcp, include_dab, allowed_dab):
    if not isinstance(include_dab, bool):
        raise ValueError("DAB MCP toggle must be a boolean")
    mcp_names = parse_allowlist(allowed_mcp, "api-mcp")
    dab_names = parse_allowlist(allowed_dab, "DAB MCP")
    tools = []

    if mcp_names:
        tools.append({
            "type": "mcp",
            "server_label": "adventureworks_mcp",
            "server_url": require_https_url(mcp_url, "api-mcp"),
            "require_approval": "never",
            "allowed_tools": mcp_names,
        })

    if include_dab:
        if not dab_names:
            raise ValueError("DAB MCP requires an explicit non-empty tool allow-list")
        tools.append({
            "type": "mcp",
            "server_label": "dabmcp",
            "server_url": require_https_url(dab_url, "DAB"),
            "require_approval": "never",
            "allowed_tools": dab_names,
        })

    return tools


def main(argv):
    if len(argv) != 6:
        raise ValueError("Expected MCP URL, DAB URL, two allow-lists and DAB toggle")
    mcp_url, dab_url, allowed_mcp, include_dab, allowed_dab = argv[1:]
    if include_dab not in {"true", "false"}:
        raise ValueError("DAB MCP toggle must be true or false")
    print(json.dumps(build_tools(
        mcp_url, dab_url, allowed_mcp, include_dab == "true", allowed_dab
    )))


if __name__ == "__main__":
    try:
        main(sys.argv)
    except ValueError as error:
        print(f"Invalid agent tool configuration: {error}", file=sys.stderr)
        sys.exit(2)
