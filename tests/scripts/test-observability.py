#!/usr/bin/env python3
"""Read-only verification of selected Azure Monitor trace metadata."""

import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
TRACE_ID = re.compile(r"[a-f0-9]{32}")
SPAN_ID = re.compile(r"[a-f0-9]{16}")
MAX_TRACES = 20


def trace_query(trace_ids):
    if not 1 <= len(trace_ids) <= MAX_TRACES or any(
            not TRACE_ID.fullmatch(value) or value == "0" * 32 for value in trace_ids):
        raise ValueError("Provide between 1 and 20 nonzero lowercase W3C trace IDs.")
    selected = ",".join(f"'{value}'" for value in dict.fromkeys(trace_ids))
    return f"""union
    (AppRequests | extend Signal='request'),
    (AppDependencies | extend Signal='dependency')
| where TimeGenerated > ago(1h) and OperationId in ({selected})
| project OperationId, Id, ParentId, AppRoleName, Signal, Success,
    GenAiOperation=tostring(Properties['gen_ai.operation.name'])
| take 2000"""


def query_rows(document):
    if isinstance(document, list) and all(isinstance(row, dict) for row in document):
        return document
    if isinstance(document, dict) and isinstance(document.get("tables"), list):
        rows = []
        for table in document["tables"]:
            if not isinstance(table, dict):
                raise ValueError("Invalid Azure Monitor table.")
            columns = table.get("columns", [])
            values = table.get("rows", [])
            if (not isinstance(columns, list) or not isinstance(values, list) or
                    any(not isinstance(column, dict) or not isinstance(column.get("name"), str)
                        for column in columns)):
                raise ValueError("Invalid Azure Monitor columns.")
            names = [column["name"] for column in columns]
            for value in values:
                if not isinstance(value, list) or len(value) != len(names):
                    raise ValueError("Invalid Azure Monitor row.")
                rows.append(dict(zip(names, value)))
        return rows
    raise ValueError("Azure Monitor returned an unsupported result shape.")


def verify_trace_metadata(rows, trace_ids, expected_roles=(), require_gen_ai=False):
    reports = []
    for trace_id in trace_ids:
        selected = [row for row in rows if row.get("OperationId") == trace_id]
        ids = [row.get("Id") for row in selected]
        valid_ids = [value for value in ids
                     if isinstance(value, str) and SPAN_ID.fullmatch(value) and value != "0" * 16]
        valid_id_set = set(valid_ids)
        roles = sorted({row["AppRoleName"] for row in selected
                        if isinstance(row.get("AppRoleName"), str) and row["AppRoleName"]})
        linked = sum(1 for row in selected
                     if row.get("ParentId") in valid_id_set and row.get("ParentId") != row.get("Id"))
        missing_roles = sorted(set(expected_roles) - set(roles))
        gen_ai = any(isinstance(row.get("GenAiOperation"), str) and row["GenAiOperation"]
                     for row in selected)
        checks = {
            "dataObserved": bool(selected),
            "validSpanIds": bool(selected) and len(valid_ids) == len(selected),
            "noDuplicateSpanIds": len(set(valid_ids)) == len(valid_ids),
            "parentLinkObserved": linked > 0,
            "requestedRolesObserved": not missing_roles,
            "genAiObserved": gen_ai if require_gen_ai else None,
            "completeQuery": len(rows) < 2000,
        }
        reports.append({
            "traceId": trace_id,
            "status": "PASS" if all(value is not False for value in checks.values()) else "FAIL",
            "checks": checks,
            "spanCount": len(selected),
            "linkedSpanCount": linked,
            "roles": roles,
            "missingRoles": missing_roles,
        })
    return reports


def workspace_id(environment):
    spec = importlib.util.spec_from_file_location(
        "observability_auth", ROOT / "scripts/utilities/azure-auth.py")
    auth = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(auth)
    try:
        return auth.azd_value("MONITORING_WORKSPACE_ID", environment)
    except auth.AuthError as error:
        raise RuntimeError(str(error)) from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", help="Selected deployed azd environment")
    parser.add_argument("--workspace-id", help="Log Analytics workspace customer ID (GUID)")
    parser.add_argument("--trace-id", action="append", required=True,
                        help="Known W3C trace ID; repeat up to 20 times")
    parser.add_argument("--expected-role", action="append", default=[],
                        help="Role that must occur in each selected trace")
    parser.add_argument("--require-gen-ai", action="store_true")
    parser.add_argument("--output", type=Path, required=True,
                        help="Metadata-only verification report; parent directory must exist")
    args = parser.parse_args()
    query = trace_query(args.trace_id)
    workspace = args.workspace_id or workspace_id(args.environment)
    if not re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", workspace):
        raise ValueError("Workspace customer ID must be a GUID.")
    result = subprocess.run(
        ["az", "monitor", "log-analytics", "query", "--workspace", workspace,
         "--analytics-query", query, "--timespan", "PT1H", "--output", "json"],
        capture_output=True, text=True, timeout=60, check=False)
    if result.returncode:
        report = {"schemaVersion": 1, "status": "BLOCKED",
                  "reason": "Azure Monitor query failed; verify operator RBAC and workspace access.",
                  "traces": []}
        exit_code = 2
    else:
        reports = verify_trace_metadata(query_rows(json.loads(result.stdout)),
                                        args.trace_id, args.expected_role, args.require_gen_ai)
        report = {"schemaVersion": 1,
                  "status": "PASS" if all(item["status"] == "PASS" for item in reports) else "FAIL",
                  "traces": reports,
                  "limitations": [
                      "Only the selected request/dependency metadata is inspected.",
                      "One parent link does not prove complete instrumentation or secret redaction.",
                      "SQL change-tracking and other causal boundaries can use separate trace IDs.",
                  ]}
        exit_code = 0 if report["status"] == "PASS" else 1
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Observability metadata verification: {report['status']}")
    return exit_code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"observability: {error}", file=sys.stderr)
        sys.exit(1)
