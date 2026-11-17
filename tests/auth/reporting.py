"""Render portable, self-contained assurance reports from structured assertions."""

from collections import Counter
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

STATUSES = {"PASS", "FAIL", "BLOCKED", "ACCEPTED_EXCEPTION", "NOT_APPLICABLE"}


def combine(documents, provenance):
    checks = []
    for phase, document in documents:
        for check in document["checks"]:
            if check["status"] not in STATUSES:
                raise ValueError("Invalid assertion status")
            checks.append({**check, "id": phase + ":" + check["id"]})
    if not checks or len({check["id"] for check in checks}) != len(checks):
        raise ValueError("Empty or duplicate report assertions")
    counts = dict(Counter(check["status"] for check in checks))
    return {
        "schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
        "outcome": "FAIL" if counts.get("FAIL") else "BLOCKED" if counts.get("BLOCKED") else "PASS",
        "scope": "Partial assurance; unexecuted obligations remain explicit",
        "provenance": provenance, "counts": counts, "checks": checks,
    }


def render(document, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "report.json").write_text(json.dumps(document, indent=2) + "\n")
    esc = lambda value: html.escape(str(value), quote=True)
    rows = "".join("<tr><td>" + "</td><td>".join(esc(check.get(key, "")) for key in
                   ["id", "group", "status", "detail"]) + "</td></tr>" for check in document["checks"])
    content = """<!doctype html><html lang="en"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>AdventureWorks authentication assurance</title>
<style>body{font:12px sans-serif;color:#17212b}h1{font-size:22px}
table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{border:1px solid #bbb;
padding:5px;text-align:left;overflow-wrap:anywhere}thead{display:table-header-group}
tr{break-inside:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere}
@page{size:A4 landscape;margin:12mm}</style><h1>Authentication assurance</h1>"""
    content += "<p>Outcome: <b>" + esc(document["outcome"]) + "</b></p>"
    content += "<p>" + esc(document["scope"]) + "</p><pre>"
    content += esc(json.dumps({key: value for key, value in document.items() if key != "checks"}, indent=2))
    content += "</pre><table><thead><tr><th>Assertion</th><th>Group</th><th>Status</th><th>Evidence</th>"
    content += "</tr></thead><tbody>" + rows + "</tbody></table></html>"
    (directory / "report.html").write_text(content)
    suite = ET.Element("testsuite", name="authentication-assurance", tests=str(len(document["checks"])),
                       failures=str(document["counts"].get("FAIL", 0)),
                       errors=str(document["counts"].get("BLOCKED", 0)))
    for check in document["checks"]:
        case = ET.SubElement(suite, "testcase", name=check["id"], classname=check["group"])
        if check["status"] in {"FAIL", "BLOCKED"}:
            ET.SubElement(case, "failure" if check["status"] == "FAIL" else "error", message=check["detail"])
        elif check["status"] != "PASS":
            ET.SubElement(case, "skipped", message=check["status"])
    ET.ElementTree(suite).write(directory / "junit.xml", encoding="utf-8", xml_declaration=True)


def pdf(directory):
    result = subprocess.run(["node", str(Path(__file__).with_name("report-pdf.mjs")), str(directory)],
                            capture_output=True, timeout=180, check=False)
    if result.returncode:
        raise RuntimeError("PDF generation failed; renderer output withheld")
    path = Path(directory) / "report.pdf"
    if not path.is_file() or not path.read_bytes().startswith(b"%PDF-"):
        raise RuntimeError("PDF renderer did not produce a valid PDF")


def artifact_manifest(directory):
    result = {}
    for name in ["report.pdf", "report.html", "report.json", "junit.xml"]:
        path = Path(directory) / name
        if path.is_file():
            data = path.read_bytes()
            result[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    return result
