#!/usr/bin/env python3
"""Generate, validate and optionally publish all eligible missing manufacturing documents."""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
from http.cookiejar import CookieJar
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import build_opener, HTTPCookieProcessor, HTTPRedirectHandler, Request, urlopen


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


drafts = load("drafts", "generate-manufacturing-drafts.py")
diagrams = load("diagrams", "generate-manufacturing-diagrams.py")
export = load("export", "export-manufacturing-content.py")
verify = load("verify", "verify-manufacturing-content.py")
REPO = Path(__file__).resolve().parents[2]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class OAuth:
    """Keep resource-specific short-lived credentials in memory, never in batch files."""

    def __init__(self, base, username, password):
        self.base, self.username, self.password = base, username, password
        self.tokens = {}
        self.lock = threading.Lock()

    def token(self, resource, force=False):
        with self.lock:
            cached = self.tokens.get(resource)
            if cached and cached[1] > time.time() + 60 and not force:
                return cached[0]
            opener = build_opener(HTTPCookieProcessor(CookieJar()), NoRedirect())

            def post(path, values):
                request = Request(self.base + path, urlencode(values).encode(),
                                  {"Content-Type": "application/x-www-form-urlencoded"})
                try:
                    return opener.open(request, timeout=120)
                except HTTPError as error:
                    if error.code in (302, 303):
                        return error
                    raise RuntimeError(f"OAuth {path} failed with HTTP {error.code}.") from error

            with post("/login", {"username": self.username, "password": self.password, "returnUrl": "/"}) as response:
                if response.status not in (302, 303):
                    raise RuntimeError("OAuth login did not accept the employee credentials.")
            verifier, state = secrets.token_urlsafe(48), secrets.token_urlsafe(24)
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
            redirect = "http://localhost:6274/oauth/callback"
            with post("/authorize", {"client_id": "mcp-inspector", "response_type": "code", "redirect_uri": redirect,
                      "scope": "manufacturing.read manufacturing.write", "resource": self.base + "/" + resource,
                      "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
                      "decision": "allow"}) as response:
                query = parse_qs(urlparse(response.headers.get("Location", "")).query)
            if query.get("state") != [state] or not query.get("code"):
                raise RuntimeError("OAuth authorization failed or returned mismatched state.")
            with post("/token", {"grant_type": "authorization_code", "code": query["code"][0],
                      "client_id": "mcp-inspector", "redirect_uri": redirect, "code_verifier": verifier,
                      "resource": self.base + "/" + resource}) as response:
                result = json.load(response)
            token = result.get("access_token")
            if not token:
                raise RuntimeError("OAuth token endpoint returned no access token.")
            self.tokens[resource] = (token, time.time() + result["expires_in"])
            return token


class Api:
    def __init__(self, endpoint, functions, oauth, attempts=3):
        self.endpoint, self.functions, self.oauth, self.attempts = endpoint, functions, oauth, attempts

    def request(self, url, resource, body=None):
        for attempt in range(self.attempts):
            token = self.oauth.token(resource)
            headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
            if resource == "dab":
                headers["X-MS-API-ROLE"] = "manufacturing-engineer"
            request = Request(url, json.dumps(body).encode() if body is not None else None, headers)
            try:
                with urlopen(request, timeout=225) as response:
                    return json.load(response)
            except HTTPError as error:
                message = error.read().decode()[:2500]
                if error.code == 401 and attempt + 1 < self.attempts:
                    self.oauth.token(resource, force=True)
                elif error.code not in (429, 500, 502, 503, 504) or attempt + 1 == self.attempts:
                    raise RuntimeError(f"HTTP {error.code}: {message}") from error
                print(f"Retrying {resource} HTTP {error.code} ({attempt + 1}/{self.attempts}).", flush=True)
            except (TimeoutError, URLError) as error:
                if attempt + 1 == self.attempts:
                    raise RuntimeError(f"{resource} transport failed: {error}") from error
                print(f"Retrying {resource} transport failure ({attempt + 1}/{self.attempts}).", flush=True)
            time.sleep(min(5 * 2 ** attempt, 30))
        raise RuntimeError("Request retry bound exhausted.")

    def read(self, entity, select=None):
        query = {"$first": 100}
        if select:
            query["$select"] = select
        url = f"{self.endpoint}/api/{entity}?{urlencode(query)}"
        result, seen = [], set()
        while url:
            if urlparse(url).scheme != "https" or urlparse(url).netloc != urlparse(self.endpoint).netloc or url in seen:
                raise ValueError("Invalid DAB pagination URL.")
            seen.add(url)
            page = self.request(url, "dab")
            result.extend(page["value"])
            url = page.get("nextLink")
        return result

    def generate(self, stage, body):
        return self.request(self.functions + f"/api/manufacturing/content/{stage}/generate", "functions", body)


def inventory(api, today, supplement_originals=False):
    models = api.read("ProductModel")
    products = api.read("Product", "ProductID,ProductModelID,MakeFlag,Name,SellStartDate,SellEndDate,DiscontinuedDate,ModifiedDate")
    bom = api.read("BillOfMaterials", "ProductAssemblyID,ComponentID,StartDate,EndDate")
    cultures = api.read("ProductModelProductDescriptionCulture")
    descriptions = {d["ProductDescriptionID"] for d in api.read("ProductDescription") if d["Description"].strip()}
    supplemented = set()
    if supplement_originals:
        illustration_ids = {d["IllustrationID"] for d in api.read("Illustration", "IllustrationID")}
        supplemented = {m["ProductModelID"] for m in api.read("ProductModelIllustration")
                        if m["IllustrationID"] in illustration_ids and
                        1 <= m["IllustrationID"] - 100000 - m["ProductModelID"] * 10 <= 3}
    effective = {b["ProductAssemblyID"] for b in bom if b["StartDate"][:10] <= today and
                 (not b["EndDate"] or b["EndDate"][:10] > today)}
    english = {c["ProductModelID"] for c in cultures if c["CultureID"].strip() == "en" and c["ProductDescriptionID"] in descriptions}
    rows = []
    for model in sorted(models, key=lambda m: m["ProductModelID"]):
        identifier = model["ProductModelID"]
        variants = [p for p in products if p["ProductModelID"] == identifier and p["MakeFlag"]]
        if model["Instructions"]:
            status, reason = "existing-instructions", "Preserve the current document."
            if (supplement_originals and variants and identifier not in supplemented and
                    not list(drafts.ET.fromstring(model["Instructions"]).iter(f"{{{drafts.NAMESPACE}}}diag"))):
                status, reason = "eligible-supplement", "Preserve original instructions and generate their missing supplemental diagrams."
        elif not variants:
            status, reason = "ineligible", "No manufactured variants."
        elif identifier not in english:
            status, reason = "ineligible", "No nonempty English description."
        elif not any(p["ProductID"] in effective for p in variants):
            status, reason = "ineligible", "No manufactured variant has an effective bill of materials."
        else:
            status, reason = "eligible", "Manufactured variant, English description and effective BOM available."
        rows.append({"modelId": identifier, "name": model["Name"], "status": status, "reason": reason,
                     "manufacturedVariants": len(variants)})
    return rows, {p["ProductID"]: p for p in products}, verify.instruction_hashes(models)


def process_model(api, root, row, products, publish):
    model_id = row["modelId"]
    supplement = row["status"] == "eligible-supplement"
    run = root / f"model-{model_id}-run"
    run.mkdir(exist_ok=True)
    model_dir = run / f"model-{model_id}"
    response_path = model_dir / "response.json"
    if response_path.exists():
        result = json.loads(response_path.read_text())
        drafts.validate_result(result, model_id, allow_existing=supplement)
        manifest = json.loads((run / "manifest.json").read_text())
        if export.digest(result["instructionsXml"]) != manifest["models"][0]["instructionsSha256"]:
            raise ValueError("Saved instruction hash changed; refusing to resume.")
    else:
        print(f"Instructions: model {model_id} {row['name']}", flush=True)
        result = api.generate("instructions", {"productModelId": model_id, "supplementExistingInstructions": supplement})
        saved = drafts.save_result(run, result, model_id, allow_existing=supplement)
        drafts.write_index(run, {"status": "awaiting-instruction-review", "requestedModels": [model_id], "models": [saved],
                                "authorization": "User-authorized full-coverage batch with automated validation."})
    representative = result["grounding"]["representative"]["productId"]
    history_path = model_dir / "change-history.json"
    if history_path.exists():
        history = json.loads(history_path.read_text())
    else:
        history = drafts.create_change_history(result, products[representative], datetime.now().astimezone().date())
        drafts.write_atomic(history_path, drafts.json_text(history))
    diagram_manifest = run / "diagram-attempts/batch/manifest.json"
    diagram_manifest.parent.mkdir(parents=True, exist_ok=True)
    progress = {"status": "generating-diagram-drafts", "approvedInstructionRun": run.name,
                "requestedModels": [model_id], "diagrams": [], "authorization": "User-authorized full-coverage batch."}
    images = {}
    output = model_dir / "diagram-attempts/batch"
    output.mkdir(parents=True, exist_ok=True)
    for reservation in result["diagramReservations"]:
        identifier, slot = reservation["illustrationId"], reservation["slot"]
        response_path = output / f"illustration-{identifier}.json"
        if response_path.exists():
            drawing = json.loads(response_path.read_text())
        else:
            print(f"Diagram: model {model_id}, illustration {identifier}", flush=True)
            drawing = api.generate("diagrams", {"approvedDraft": result, "slot": slot})
            diagrams.validate_diagram(drawing, result, slot)
            drafts.write_atomic(response_path, drafts.json_text(drawing))
        diagrams.validate_diagram(drawing, result, slot)
        for suffix in ("xaml", "svg"):
            path = output / f"illustration-{identifier}.{suffix}"
            if path.exists() and path.read_text() != drawing[suffix]:
                raise ValueError(f"Saved illustration {identifier} changed; refusing to resume.")
            drafts.write_atomic(path, drawing[suffix])
        images[identifier] = f"diagram-attempts/batch/{reservation['fileName']}"
        progress["diagrams"].append({"modelId": model_id, "illustrationId": identifier, "slot": slot,
                                    "svgSha256": export.digest(drawing["svg"]),
                                    "file": str((output / reservation["fileName"]).relative_to(run))})
        drafts.write_atomic(diagram_manifest, drafts.json_text(progress))
    progress["status"] = "awaiting-diagram-review"
    drafts.write_atomic(diagram_manifest, drafts.json_text(progress))
    drafts.write_atomic(model_dir / "instructions.html", drafts.render_preview(result, change_history=history))
    drafts.write_atomic(model_dir / "instructions-diagrams.html", drafts.render_preview(result, images, history))
    return {"modelId": model_id, "status": "validated", "run": str(run), "diagramManifest": str(diagram_manifest),
            "diagramIds": [r["illustrationId"] for r in result["diagramReservations"]], "publishRequested": publish,
            "supplementalFigures": supplement}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True, help="Persistent batch directory; reuse to resume.")
    parser.add_argument("--limit", type=int, default=100, help="Maximum eligible models selected, 1-100.")
    parser.add_argument("--workers", type=int, default=2, choices=(1, 2, 3))
    parser.add_argument("--models", nargs="+", type=int, help="Optional explicit eligible model subset.")
    parser.add_argument("--inventory-only", action="store_true")
    parser.add_argument("--publish", action="store_true", help="Authorize automated validation and publication of this full-coverage batch.")
    parser.add_argument("--supplement-originals", action="store_true", help="Include originals missing diagrams without replacing their instruction XML.")
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error("--limit must be 1-100.")
    environment = {name: os.environ.get(name, "") for name in
                   ("API_URL", "API_FUNCTIONS_URL", "MCP_SERVICE_URL", "MANUFACTURING_USERNAME", "MANUFACTURING_PASSWORD")}
    if any(not value for value in environment.values()):
        parser.error("Set API_URL, API_FUNCTIONS_URL, MCP_SERVICE_URL, MANUFACTURING_USERNAME and MANUFACTURING_PASSWORD.")
    origin = urlparse(environment["MCP_SERVICE_URL"])
    if any(not environment[key].startswith("https://") for key in ("API_URL", "API_FUNCTIONS_URL", "MCP_SERVICE_URL")):
        parser.error("All service endpoints must use HTTPS.")
    oauth = OAuth(f"{origin.scheme}://{origin.netloc}", environment["MANUFACTURING_USERNAME"], environment["MANUFACTURING_PASSWORD"])
    api = Api(environment["API_URL"].rstrip("/"), environment["API_FUNCTIONS_URL"].rstrip("/"), oauth)
    args.run.mkdir(parents=True, exist_ok=True)
    rows, products, baseline = inventory(api, datetime.now(timezone.utc).date().isoformat(), args.supplement_originals)
    report = {"capturedAtUtc": datetime.now(timezone.utc).isoformat(), "models": rows, "results": [], "failures": []}
    baseline_path = args.run / "original-instructions.json"
    if not baseline_path.exists():
        drafts.write_atomic(baseline_path, drafts.json_text(baseline))
    report_path = args.run / "coverage.json"
    drafts.write_atomic(report_path, drafts.json_text(report))
    selected = [r for r in rows if r["status"] in ("eligible", "eligible-supplement") and (not args.models or r["modelId"] in args.models)][:args.limit]
    print(f"Inventory: {len(rows)} models; {sum(r['status']=='existing-instructions' for r in rows)} already instructed; "
          f"{sum(r['status']=='eligible' for r in rows)} eligible missing; selecting {len(selected)}.", flush=True)
    if args.inventory_only:
        return
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        tasks = {executor.submit(process_model, api, args.run, row, products, args.publish): row for row in selected}
        for future in as_completed(tasks):
            row = tasks[future]
            try:
                result = future.result()
                if args.publish:
                    export.publish(Path(result["run"]), [row["modelId"]], Path(result["diagramManifest"]),
                                   supplement_originals=result["supplementalFigures"])
                    result["status"] = "published"
                report["results"].append(result)
                print(f"Complete: model {row['modelId']} ({len(result['diagramIds'])} diagrams).", flush=True)
            except (RuntimeError, ValueError, KeyError, TypeError, OSError, StopIteration, drafts.ET.ParseError) as error:
                report["failures"].append({"modelId": row["modelId"], "name": row["name"], "error": str(error)})
                print(f"FAILED model {row['modelId']}: {error}", flush=True)
            report["results"].sort(key=lambda result: result["modelId"])
            drafts.write_atomic(report_path, drafts.json_text(report))
    if report["failures"]:
        raise RuntimeError(f"{len(report['failures'])} models failed; validated successes are saved. Resume the same --run to retry.")
    print(f"Batch complete: {len(report['results'])} models. No SQL changes were made.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, OSError, URLError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
