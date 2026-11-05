#!/usr/bin/env python3
"""Generate, validate and optionally publish part sheets for manufactured parts without a ProductModel."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import sys
from urllib.error import URLError
from urllib.parse import urlparse
import uuid
import xml.etree.ElementTree as ET


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


drafts = load("drafts", "generate-manufacturing-drafts.py")
populate = load("populate", "populate-manufacturing-content.py")
export = load("export", "export-manufacturing-content.py")
REPO = Path(__file__).resolve().parents[2]
FOLDER = "/900000/"
FOLDER_TITLE = "Generated Part Sheets"
FOLDER_DATE = "2026-01-01T00:00:00"
DOCUMENT_OWNER, FOLDER_OWNER = "219", "217"
SVG = "{http://www.w3.org/2000/svg}"


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def reservation_id(product_id, slot):
    return 2000000 + product_id * 10 + slot


def document_title(product):
    title = f'{product["name"]} part sheet'
    return title if len(title) <= 50 else f'{product["productNumber"]} part sheet'[:50]


def inventory(api, today):
    products = api.read("Product", "ProductID,ProductModelID,MakeFlag,Name,ProductNumber,SellStartDate")
    bom = api.read("BillOfMaterials", "ProductAssemblyID,ComponentID,StartDate,EndDate")
    effective = {b["ProductAssemblyID"] for b in bom if b["ProductAssemblyID"] and b["StartDate"][:10] <= today and
                 (not b["EndDate"] or b["EndDate"][:10] > today)}
    rows = []
    for product in sorted(products, key=lambda p: p["ProductID"]):
        if not product["MakeFlag"] or product["ProductModelID"] is not None:
            continue
        identifier = product["ProductID"]
        status, reason = (("eligible", "Manufactured part without a model; effective BOM children available.")
                          if identifier in effective else
                          ("ineligible", "No effective bill of materials children to ground the part sheet."))
        rows.append({"productId": identifier, "name": product["Name"], "productNumber": product["ProductNumber"],
                     "status": status, "reason": reason})
    return rows


def validate_result(result, product_id):
    grounding = result["grounding"]
    if result["status"] != "draft-awaiting-instruction-review" or grounding["product"]["productId"] != product_id:
        raise ValueError("The API returned an unexpected part or draft status.")
    if result["documentNode"] != f"{FOLDER}{product_id}/":
        raise ValueError("The API returned an unexpected document node.")
    if (grounding["routingBasis"] not in ("historical", "demo-assumption") or
            any(d["documentNode"].startswith(FOLDER) for d in grounding["existingDocuments"])):
        raise ValueError("Part sheet grounding has an unsupported routing basis or an existing generated sheet.")
    if "<!DOCTYPE" in result["instructionsXml"].upper() or "<!ENTITY" in result["instructionsXml"].upper():
        raise ValueError("Document type declarations are not supported.")
    root = ET.fromstring(result["instructionsXml"])
    if root.tag != f"{{{drafts.NAMESPACE}}}root":
        raise ValueError("Unexpected instruction XML namespace.")
    reservations = result["diagramReservations"]
    for reservation in reservations:
        identifier = reservation_id(product_id, reservation["slot"])
        if (reservation["slot"] not in (1, 2, 3) or reservation["illustrationId"] != identifier or
                reservation["fileName"] != f"illustration-{identifier}.svg"):
            raise ValueError("Invalid part diagram reservation.")
    if not reservations or len({r["slot"] for r in reservations}) != len(reservations):
        raise ValueError("No unique diagram reservations were returned.")
    if sorted(r["slot"] for r in reservations) != sorted(d["slot"] for d in result["draft"]["diagrams"]):
        raise ValueError("Diagram briefs and reservations do not match.")
    refs = {int(d.text) for d in root.iter(f"{{{drafts.NAMESPACE}}}diag")}
    if refs != {r["illustrationId"] for r in reservations}:
        raise ValueError("Instruction references do not match reserved illustrations.")
    for text in (result["instructionsXml"], result["draft"]["summary"]):
        if "+|" in text or "&|" in text:
            raise ValueError("Generated text collides with the seed overlay delimiters.")
    return root


def validate_diagram(drawing, approved, slot):
    product_id = approved["grounding"]["product"]["productId"]
    reservation = next(r for r in approved["diagramReservations"] if r["slot"] == slot)
    if (drawing["status"] != "draft-awaiting-diagram-review" or drawing["productId"] != product_id or
            drawing["slot"] != slot or drawing["illustrationId"] != reservation["illustrationId"] or
            drawing["fileName"] != reservation["fileName"] or
            drawing["sourceFingerprint"] != approved["sourceFingerprint"] or
            drawing["instructionsSha256"] != digest(approved["instructionsXml"])):
        raise ValueError("Diagram response is not bound to the approved part, instructions and reservation.")
    if any(token in drawing["svg"].upper() or token in drawing["xaml"].upper() for token in ("<!DOCTYPE", "<!ENTITY")):
        raise ValueError("Document type declarations are not supported.")
    if "+|" in drawing["xaml"] or "&|" in drawing["xaml"]:
        raise ValueError("Diagram XAML collides with the seed overlay delimiters.")
    svg = ET.fromstring(drawing["svg"])
    if svg.tag != SVG + "svg":
        raise ValueError("The diagram response is not SVG.")
    if any(node.tag not in (SVG + tag for tag in ("svg", "path", "g")) or
           any(a.split("}")[-1].lower().startswith("on") or a.endswith("href") for a in node.attrib)
           for node in svg.iter()):
        raise ValueError("Unexpected SVG element or external reference.")
    expected = next(d for d in approved["draft"]["diagrams"] if d["slot"] == slot)
    if sorted(c["number"] for c in drawing["callouts"]) != sorted(c["number"] for c in expected["callouts"]):
        raise ValueError("Diagram callout mapping does not match the approved brief.")


def create_change_history(result, current_date):
    product = result["grounding"]["product"]
    product_id = product["productId"]
    start = date.fromisoformat(product["sellStartDate"][:10])
    if start >= current_date:
        raise ValueError("A part sheet history requires a product launch before the current revision date.")
    rng = random.Random(1_000_000 + product_id)
    count = min(rng.choice([0, 1, 3, 5]), (current_date - start).days - 1)
    dates = sorted(rng.sample(range(1, (current_date - start).days), count))
    components = sorted({c["name"] for c in result["grounding"]["components"] if c["parentProductId"] == product_id})
    if not components:
        raise ValueError("Part sheet changes require actual direct BOM components.")
    parents = result["grounding"]["whereUsedCount"]
    changes = [
        f"Added a stock-identification check for {components[0]} before the first cut or fit-up.",
        "Separated first-article inspection from routine in-process checks; clarified the hold point for nonconforming parts.",
        f"Recorded that the part supplies {parents} parent assemblies; added a kitting note to prevent mixed lots.",
        "Consolidated deburr and handling notes and removed a duplicate operator sign-off.",
        "Reformatted the point-of-use copy with numbered steps and larger callout references.",
    ]
    rng.shuffle(changes)
    owners = ["K. Novak", "D. Okafor", "L. Moreau", "T. Haddad"]
    rng.shuffle(owners)
    routed = result["grounding"]["routingBasis"] == "historical"
    entries = [(start, "Initial controlled issue for part release; established the stock list and work-center hand-off.")]
    entries.extend((start + timedelta(days=offset), changes[i]) for i, offset in enumerate(dates))
    titles = "; ".join(d["title"] for d in result["draft"]["diagrams"])
    routing = ("Confirmed the operation sequence against historical work-order routing."
               if routed else "Assigned demonstration work centres pending a routing study; marked them as demo assumptions.")
    entries.append((current_date, f"Released the illustrated part sheet edition: {titles}. {routing}"))
    revisions = [{
        "revision": f"{i + 1}.0", "effectiveDate": when.isoformat(),
        "changeRequest": f"ECN-{when.year}-P{product_id:03d}-{i + 1:02d}", "description": text,
        "preparedBy": owners[i % len(owners)], "approvedBy": owners[(i + 1) % len(owners)],
    } for i, (when, text) in enumerate(entries)]
    return {"documentNumber": f"AW-MFG-PS-{product_id:04d}", "contentKind": "fabricated-demo-change-history",
            "dateBasis": "Initial issue uses the part SellStartDate; intervening changes are invented.",
            "lifecycleSource": {"ProductID": product_id, "SellStartDate": product["sellStartDate"]},
            "revisions": revisions}


def process_part(api, root, row):
    product_id = row["productId"]
    directory = root / f"part-{product_id}"
    response_path = directory / "response.json"
    if response_path.exists():
        result = json.loads(response_path.read_text())
    else:
        print(f"Part sheet: product {product_id} {row['name']}", flush=True)
        result = api.generate("parts/instructions", {"productId": product_id})
        validate_result(result, product_id)
        directory.mkdir(parents=True, exist_ok=True)
        for name, value in [("grounding.json", drafts.json_text(result["grounding"])),
                            ("instructions.xml", result["instructionsXml"] + "\n"),
                            ("response.json", drafts.json_text(result))]:
            drafts.write_atomic(directory / name, value)
    validate_result(result, product_id)
    history_path = directory / "change-history.json"
    if history_path.exists():
        history = json.loads(history_path.read_text())
    else:
        history = create_change_history(result, datetime.now().astimezone().date())
        drafts.write_atomic(history_path, drafts.json_text(history))
    output = directory / "diagrams"
    output.mkdir(exist_ok=True)
    images = {}
    for reservation in result["diagramReservations"]:
        identifier, slot = reservation["illustrationId"], reservation["slot"]
        drawing_path = output / f"illustration-{identifier}.json"
        if drawing_path.exists():
            drawing = json.loads(drawing_path.read_text())
        else:
            print(f"Diagram: product {product_id}, illustration {identifier}", flush=True)
            drawing = api.generate("parts/diagrams", {"approvedDraft": result, "slot": slot})
            validate_diagram(drawing, result, slot)
            drafts.write_atomic(drawing_path, drafts.json_text(drawing))
        validate_diagram(drawing, result, slot)
        for suffix in ("xaml", "svg"):
            path = output / f"illustration-{identifier}.{suffix}"
            if path.exists() and path.read_text() != drawing[suffix]:
                raise ValueError(f"Saved illustration {identifier} changed; refusing to resume.")
            drafts.write_atomic(path, drawing[suffix])
        images[identifier] = f"diagrams/{reservation['fileName']}"
    drafts.write_atomic(directory / "part-sheet.html", drafts.render_preview(result, images, history))
    grounding = result["grounding"]
    return {"productId": product_id, "name": row["name"], "status": "validated",
            "routingBasis": grounding["routingBasis"], "whereUsedCount": grounding["whereUsedCount"],
            "locations": [int(l.attrib["LocationID"]) for l in ET.fromstring(result["instructionsXml"])],
            "diagramIds": [r["illustrationId"] for r in result["diagramReservations"]],
            "instructionsSha256": digest(result["instructionsXml"]), "preview": str(directory / "part-sheet.html")}


def merge_documents(path, additions):
    merged = {}
    for row in export.records(path, "+|", "&|", 13) + additions:
        if any("+|" in value or "&|" in value for value in row):
            raise ValueError(f"Unescaped delimiter in {path.name}.")
        if row[0] in merged and merged[row[0]] != row:
            if row[0] == FOLDER:
                continue
            raise ValueError(f"Conflicting approved document {row[0]} in {path.name}.")
        merged.setdefault(row[0], row)
    return "".join("+|".join(merged[key]) + "&|\n" for key in sorted(merged, key=lambda k: (len(k), k)))


def merge_links(path, additions):
    merged = {}
    for row in export.records(path, "\t", "\n", 3) + additions:
        if row[0] in merged and merged[row[0]] != row:
            raise ValueError(f"Conflicting approved product document link {row[0]} in {path.name}.")
        merged[row[0]] = row
    return "".join("\t".join(merged[key]) + "\n" for key in sorted(merged, key=int))


def publish(run, product_ids, repo=REPO):
    documents = [[FOLDER, FOLDER_TITLE, FOLDER_OWNER, "1", FOLDER_TITLE, "", "0", "0", "2",
                  "AI-generated fictional demo part sheets for manufactured parts without a product model.", "",
                  str(uuid.uuid5(uuid.NAMESPACE_URL, "adventureworks:part-sheet-folder")), FOLDER_DATE]]
    links, illustrations, pending, published = [], [], {}, []
    original_ids = {int(row[0]) for row in export.records(repo / "seed-job/sql/Illustration.csv", "+|", "&|", 3)}
    for product_id in sorted(set(product_ids)):
        directory = run / f"part-{product_id}"
        result = json.loads((directory / "response.json").read_text())
        root = validate_result(result, product_id)
        history = json.loads((directory / "change-history.json").read_text())
        if history["lifecycleSource"]["ProductID"] != product_id:
            raise ValueError("Revision history belongs to another product.")
        grounding, product = result["grounding"], result["grounding"]["product"]
        current = history["revisions"][-1]
        when = current["effectiveDate"] + "T00:00:00"
        components = {c["productId"]: c for c in grounding["components"]}
        components[product_id] = product
        figures = {}
        for reservation in result["diagramReservations"]:
            identifier = reservation["illustrationId"]
            if identifier in original_ids:
                raise ValueError("An approved diagram collides with an original illustration.")
            drawing = json.loads((directory / f"diagrams/illustration-{identifier}.json").read_text())
            validate_diagram(drawing, result, reservation["slot"])
            illustrations.append([str(identifier), drawing["xaml"], when])
            pending[repo / "app-manufacturing/public/illustrations" / reservation["fileName"]] = drawing["svg"] + "\n"
            brief = next(b for b in result["draft"]["diagrams"] if b["slot"] == reservation["slot"])
            figures[str(identifier)] = {
                "title": brief["title"], "guidance": drafts.operation_guidance(root, brief, components, identifier),
                "callouts": [{"number": c["number"], "name": components[c["productId"]]["name"],
                              "productNumber": components[c["productId"]]["productNumber"]} for c in brief["callouts"]]}
        node = result["documentNode"]
        documents.append([node, document_title(product), DOCUMENT_OWNER, "0", f"AW-MFG-PS-{product_id:04d}.xml", ".xml",
                          current["revision"], str(len(history["revisions"]) - 1), "2",
                          " ".join(result["draft"]["summary"].split()), result["instructionsXml"],
                          str(uuid.uuid5(uuid.NAMESPACE_URL, f"adventureworks:part-sheet:{product_id}")), when])
        links.append([str(product_id), node, when])
        notes = [note for text in result["draft"]["assumptions"] if (note := drafts.presentation_notes(text))]
        metadata = {"productId": product_id, "name": product["name"], "productNumber": product["productNumber"],
                    "documentNode": node, "title": document_title(product), "sourceInstructions": result["instructionsXml"],
                    "routingBasis": grounding["routingBasis"], "processNotes": notes,
                    "variantNotes": result["draft"]["variantNotes"], "history": history, "figures": figures,
                    "whereUsed": [{"productId": w["parentProductId"], "name": w["name"], "productNumber": w["productNumber"],
                                   "productModelId": w["productModelId"], "productModelName": w["productModelName"],
                                   "quantity": w["quantity"], "unit": w["unit"]} for w in grounding["whereUsed"]],
                    "whereUsedCount": grounding["whereUsedCount"]}
        pending[repo / f"app-manufacturing/src/data/manufacturing/part-{product_id}.json"] = drafts.json_text(metadata)
        published.append({"productId": product_id, "sourceFingerprint": result["sourceFingerprint"],
                          "instructionsSha256": digest(result["instructionsXml"]),
                          "diagramIds": [r["illustrationId"] for r in result["diagramReservations"]]})
    sql = repo / "seed-job/sql"
    pending[sql / "Document-ai.csv"] = merge_documents(sql / "Document-ai.csv", documents)
    pending[sql / "ProductDocument-ai.csv"] = merge_links(sql / "ProductDocument-ai.csv", links)
    pending[sql / "Illustration-ai.csv"] = export.merge_rows(sql / "Illustration-ai.csv", illustrations, "+|", "&|", 3, (0,))
    for path, content in pending.items():
        if path.exists() and path.read_text() != content and path.suffix in (".svg", ".json"):
            raise ValueError(f"Refusing to overwrite a different published asset: {path}.")
    for path, content in pending.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        drafts.write_atomic(path, content)
    receipt = {"status": "exported-approved-part-sheets", "exportedAtUtc": datetime.now(timezone.utc).isoformat(),
               "run": str(run), "parts": published}
    drafts.write_atomic(run / "seed-export.json", drafts.json_text(receipt))
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True, help="Persistent batch directory; reuse to resume.")
    parser.add_argument("--workers", type=int, default=2, choices=(1, 2, 3))
    parser.add_argument("--parts", nargs="+", type=int, help="Optional explicit eligible product subset.")
    parser.add_argument("--inventory-only", action="store_true")
    parser.add_argument("--publish", nargs="+", type=int, metavar="PRODUCT_ID",
                        help="Publish these already-validated, explicitly approved parts from --run (no generation).")
    args = parser.parse_args()
    args.run.mkdir(parents=True, exist_ok=True)
    if args.publish:
        receipt = publish(args.run, args.publish)
        print(f'Exported {len(receipt["parts"])} approved part sheet(s); no SQL changes were made.')
        return
    environment = {name: os.environ.get(name, "") for name in
                   ("API_URL", "API_FUNCTIONS_URL", "MCP_SERVICE_URL", "MANUFACTURING_USERNAME", "MANUFACTURING_PASSWORD")}
    if any(not value for value in environment.values()):
        parser.error("Set API_URL, API_FUNCTIONS_URL, MCP_SERVICE_URL, MANUFACTURING_USERNAME and MANUFACTURING_PASSWORD.")
    if any(not environment[key].startswith("https://") for key in ("API_URL", "API_FUNCTIONS_URL", "MCP_SERVICE_URL")):
        parser.error("All service endpoints must use HTTPS.")
    origin = urlparse(environment["MCP_SERVICE_URL"])
    oauth = populate.OAuth(f"{origin.scheme}://{origin.netloc}", environment["MANUFACTURING_USERNAME"],
                           environment["MANUFACTURING_PASSWORD"])
    api = populate.Api(environment["API_URL"].rstrip("/"), environment["API_FUNCTIONS_URL"].rstrip("/"), oauth)
    rows = inventory(api, datetime.now(timezone.utc).date().isoformat())
    report = {"capturedAtUtc": datetime.now(timezone.utc).isoformat(), "parts": rows, "results": [], "failures": []}
    report_path = args.run / "coverage.json"
    drafts.write_atomic(report_path, drafts.json_text(report))
    selected = [r for r in rows if r["status"] == "eligible" and (not args.parts or r["productId"] in args.parts)]
    print(f"Inventory: {len(rows)} manufactured parts without a model; "
          f"{sum(r['status'] == 'eligible' for r in rows)} eligible; selecting {len(selected)}.", flush=True)
    if args.inventory_only:
        return
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        tasks = {executor.submit(process_part, api, args.run, row): row for row in selected}
        for future in as_completed(tasks):
            row = tasks[future]
            try:
                report["results"].append(future.result())
                print(f"Complete: product {row['productId']}.", flush=True)
            except (RuntimeError, ValueError, KeyError, TypeError, OSError, StopIteration, ET.ParseError) as error:
                report["failures"].append({"productId": row["productId"], "name": row["name"], "error": str(error)})
                print(f"FAILED product {row['productId']}: {error}", flush=True)
            report["results"].sort(key=lambda result: result["productId"])
            drafts.write_atomic(report_path, drafts.json_text(report))
    print(f"Batch complete: {len(report['results'])} validated, {len(report['failures'])} failed. "
          "Review part-*/part-sheet.html, then publish approved IDs with --publish.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, OSError, URLError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
