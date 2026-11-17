#!/usr/bin/env python3
"""Read-only, azd-discovered DAB/SQL pressure and index-advisor evidence; no API warm-up."""

import argparse
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import math
import os
from pathlib import Path
import uuid

SPEC = importlib.util.spec_from_file_location("auth_validation", Path(__file__).parents[1] / "auth/validate.py")
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)

DAB_METRICS = ["CpuPercentage", "MemoryPercentage"]
SQL_METRICS = ["cpu_percent", "physical_data_read_percent", "log_write_percent",
               "workers_percent", "sessions_percent", "app_cpu_percent"]


def summarize(document, expected):
    summaries = {}
    for metric in document["value"]:
        name = metric["name"]["value"]
        if name not in expected or name in summaries:
            raise auth.EvidenceError("Unexpected or duplicate capacity metric")
        values, longest = [], 0
        for series in metric["timeseries"]:
            previous, consecutive = None, 0
            for point in sorted(series["data"], key=lambda item: item["timeStamp"]):
                value = point.get("maximum")
                if value is None:
                    previous, consecutive = None, 0
                    continue
                if type(value) not in {int, float} or not math.isfinite(value) or value < 0:
                    raise auth.EvidenceError("Invalid capacity metric value")
                when = datetime.fromisoformat(point["timeStamp"].replace("Z", "+00:00"))
                if when.tzinfo is None:
                    raise auth.EvidenceError("Capacity timestamp has no timezone")
                consecutive = (consecutive + 1 if previous is not None and
                               when - previous == timedelta(minutes=1) else 1) if value >= 80 else 0
                previous = when
                longest = max(longest, consecutive)
                values.append(value)
        summaries[name] = {
            "samples": len(values), "series": len(metric["timeseries"]),
            "peak": max(values) if values else None,
            "longestHighPressureMinutes": longest,
            "status": "BLOCKED" if not values else "REVIEW" if longest >= 5 or
                name == "RestartCount" and max(values) > 0 else "OBSERVED",
        }
    if set(summaries) != set(expected):
        raise auth.EvidenceError("Required capacity metrics missing")
    return summaries


def collect(deployment, hours):
    d = deployment
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    result = {
        "startedAt": start.isoformat(), "finishedAt": end.isoformat(), "sections": {},
        "limitations": [
            "Observed one-minute Azure Monitor samples, not a performance or authentication certification.",
            "REVIEW means at least five consecutive minute maxima at 80% or higher in one series; investigate before resizing.",
            "Any observed container restart also requires REVIEW; no automatic size or index changes are made.",
            "No samples is BLOCKED, never zero utilization. Peaks can miss shorter bursts and query-specific regressions.",
            "DAB CPU/memory is split by replica; series samples are not a count of distinct elapsed minutes.",
            "Empty CreateIndex recommendations do not prove all queries have suitable indexes; private Query Store/plan review remains separate.",
            "DAB SQL dependency telemetry can be sampled; missing samples is BLOCKED. Failed or 30-second SQL calls require REVIEW.",
            "This command does not query SQL directly, change tuning settings, resize, prevent auto-pause or warm any API.",
        ],
    }

    def section(name, operation):
        try:
            result["sections"][name] = {"status": "OBSERVED", "evidence": operation()}
        except (auth.EvidenceError, KeyError, TypeError, ValueError) as error:
            result["sections"][name] = {
                "status": "BLOCKED",
                "detail": str(error) if isinstance(error, auth.EvidenceError) else
                    "Invalid diagnostic response shape; raw details withheld",
            }

    api_id = (f"/subscriptions/{d.subscription}/resourceGroups/{d.group}/providers/"
              f"Microsoft.App/containerApps/{d.required('SERVICE_API_NAME')}")
    sql_id = (f"/subscriptions/{d.subscription}/resourceGroups/{d.group}/providers/"
              f"Microsoft.Sql/servers/{d.required('SQL_SERVER_NAME')}/databases/{d.required('SQL_DATABASE_NAME')}")
    section("dab-sizing", lambda: d.azure(
        "containerapp", "show", "--ids", api_id, "--query",
        "{minReplicas:properties.template.scale.minReplicas,maxReplicas:properties.template.scale.maxReplicas,"
        "containers:properties.template.containers[].{cpu:resources.cpu,memory:resources.memory}}"))
    section("sql-sizing", lambda: d.azure(
        "sql", "db", "show", "--ids", sql_id, "--query",
        "{sku:sku.name,maxVcores:sku.capacity,minVcores:minCapacity,autoPauseDelayMinutes:autoPauseDelay,status:status}"))

    def metrics(resource, names, per_replica=False):
        args = ["monitor", "metrics", "list", "--resource", resource, "--metric", *names,
                "--start-time", start.isoformat(), "--end-time", end.isoformat(),
                "--interval", "PT1M", "--aggregation", "Average", "Maximum"]
        if per_replica:
            args += ["--filter", "podName eq '*'", "--top", "100"]
        document = d.azure(*args)
        if per_replica and any(len(metric["timeseries"]) >= 100 for metric in document["value"]):
            raise auth.EvidenceError("Replica series may be truncated; use a shorter diagnostic window")
        return summarize(document, names)

    section("dab-pressure", lambda: metrics(api_id, DAB_METRICS, True))
    section("dab-lifecycle", lambda: metrics(api_id, ["Replicas", "RestartCount"]))
    section("sql-pressure", lambda: metrics(sql_id, SQL_METRICS))

    def indexes():
        response = d.azure("rest", "--method", "get", "--url",
                           sql_id + "/advisors/CreateIndex/recommendedActions?api-version=2023-08-01")
        actions = response if isinstance(response, list) else response["value"]
        if not isinstance(actions, list):
            raise auth.EvidenceError("Invalid SQL advisor collection")
        if isinstance(response, dict) and response.get("nextLink"):
            raise auth.EvidenceError("SQL advisor collection incomplete; pagination required")
        states = {}
        for action in actions:
            state = action["properties"]["state"]["currentValue"]
            if state not in {"Active", "Pending", "Executing", "Verifying", "Success", "Error",
                             "RevertCancelled", "Reverting", "Reverted", "Ignored", "Expired",
                             "Monitoring", "Resolved", "PendingRevert", "PendingStateChange"}:
                raise auth.EvidenceError("Unrecognized SQL advisor state; raw details withheld")
            states[state] = states.get(state, 0) + 1
        return {"recommendations": len(actions), "states": states,
                "status": "REVIEW" if any(state not in {"Success", "Resolved", "Expired", "Ignored", "Reverted"}
                                        for state in states) else "OBSERVED"}

    section("sql-index-advisor", indexes)

    def dependencies():
        apps = d.azure("resource", "list", "--resource-group", d.group,
                       "--resource-type", "Microsoft.Insights/components", "--query", "[].name")
        if not isinstance(apps, list) or len(apps) != 1 or not isinstance(apps[0], str):
            raise auth.EvidenceError("Expected one selected-environment Application Insights resource")
        query = (f"dependencies | where timestamp between (datetime({start.isoformat()}) .. "
                 f"datetime({end.isoformat()})) | where type contains 'SQL' "
                 "| where cloud_RoleName == 'DataApiBuilder' "
                 "| summarize samples=count(), failed=countif(success == false), "
                 "maxDurationMs=max(duration), p95DurationMs=percentile(duration,95)")
        document = d.azure("monitor", "app-insights", "query", "--app", apps[0], "--resource-group", d.group,
                           "--analytics-query", query)
        table, = document["tables"]
        row, = table["rows"]
        names = [column["name"] for column in table["columns"]]
        if names != ["samples", "failed", "maxDurationMs", "p95DurationMs"] or len(row) != 4:
            raise auth.EvidenceError("Invalid SQL dependency aggregate")
        evidence = dict(zip(names, row))
        if any(type(evidence[name]) is not int or evidence[name] < 0 for name in ["samples", "failed"]):
            raise auth.EvidenceError("Invalid SQL dependency counts")
        if evidence["failed"] > evidence["samples"]:
            raise auth.EvidenceError("Inconsistent SQL dependency counts")
        if not evidence["samples"]:
            return {"status": "BLOCKED", "detail": "No sampled DAB SQL dependency calls in this window"}
        if any(type(evidence[name]) not in {int, float} or not math.isfinite(evidence[name]) or
               evidence[name] < 0 for name in ["maxDurationMs", "p95DurationMs"]):
            raise auth.EvidenceError("Invalid SQL dependency durations")
        evidence["status"] = "REVIEW" if evidence["failed"] or evidence["maxDurationMs"] >= 30000 else "OBSERVED"
        return evidence

    section("dab-sql-dependencies", dependencies)
    statuses = [item["status"] for item in result["sections"].values()]
    for item in result["sections"].values():
        evidence = item.get("evidence")
        if isinstance(evidence, dict):
            statuses.extend(value["status"] for value in evidence.values()
                            if isinstance(value, dict) and "status" in value)
            if "status" in evidence:
                statuses.append(evidence["status"])
    result["outcome"] = "REVIEW" if "REVIEW" in statuses else "BLOCKED" if "BLOCKED" in statuses else "OBSERVED"
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment")
    parser.add_argument("--hours", type=int, choices=range(1, 25), default=6)
    args = parser.parse_args(argv)
    try:
        result = collect(auth.Deployment(args.environment), args.hours)
    except auth.EvidenceError as error:
        print("Capacity diagnostics BLOCKED: " + str(error))
        return 2
    directory = auth.ROOT / ".auth-results" / ("dab-capacity-" +
                datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + str(uuid.uuid4()))
    directory.mkdir(mode=0o700, parents=True)
    path = directory / "report.json"
    with open(path, "x", opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        stream.write(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    print("Capacity diagnostics: " + str(path))
    return 1 if result["outcome"] == "REVIEW" else 2 if result["outcome"] == "BLOCKED" else 0


if __name__ == "__main__":
    raise SystemExit(main())
