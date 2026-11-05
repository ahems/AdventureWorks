#!/usr/bin/env python3
"""Export draft-only manufacturing instructions from the protected Functions API."""

import argparse
import hashlib
import html
import json
import os
import re
import random
from pathlib import Path
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


NAMESPACE = "http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelManuInstructions"
REPO = Path(__file__).resolve().parents[2]
STYLE = """
body{font:16px/1.65 system-ui,sans-serif;max-width:1050px;margin:2rem auto;padding:0 1.5rem;color:#203040;background:#f8fafc;overflow-wrap:anywhere}
h1,h2,h3{line-height:1.25}section,aside{background:white;border:1px solid #d5dee7;border-radius:8px;padding:1.5rem;margin:1.5rem 0}
li{margin:.8rem 0}.notice{border-left:6px solid #b87500;background:#fff8e6}a{color:#17659c}
dt{font-weight:bold;display:inline}dd{display:inline;margin:0 1.5rem 0 .4rem}.tool{color:#17659c}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{border-bottom:1px solid #ddd;padding:.5rem;text-align:left}.table-scroll{overflow-x:auto}
code{overflow-wrap:anywhere}.diagram{border:2px dashed #9aa8b5;padding:1rem;margin:1rem 0;background:#f2f6fa}.callouts{list-style:none;padding-left:0}.diagram img{display:block;width:100%;height:auto;background:white}
@media print{body{background:white;margin:0;max-width:none}nav{display:none}section{break-inside:auto}}
.brand-header{display:flex;justify-content:space-between;align-items:center;gap:1.5rem;padding:1.5rem 0;border-bottom:3px solid #2563eb;margin-bottom:1.5rem}
.brand{display:flex;align-items:center;gap:.9rem}.brand svg{width:56px;height:56px;flex-shrink:0}.wordmark{font-size:1.5rem;font-weight:800;letter-spacing:-.04em}.wordmark span{color:#2563eb}
.brand-label,.document-date{font-size:.8rem;color:#52657a}.brand-label{letter-spacing:.12em;text-transform:uppercase}
.document-title{padding:1.5rem 0 .5rem}.document-title h1{font-size:2.4rem;margin:.5rem 0}.eyebrow{color:#2563eb;font-size:.8rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
section{box-shadow:0 3px 14px #19364d06}section h2{color:#173858}.diagram{border:1px solid #cbd9ea;border-top:4px solid #2563eb;background:#f6f9ff}
footer{border-top:1px solid #cbd9ea;padding:1.5rem 0;color:#52657a;font-size:.85rem}
.history-table{min-width:900px}.history-table th,.history-table td{overflow-wrap:normal;vertical-align:top}
.history-table th:not(:nth-child(4)),.history-table td:not(:nth-child(4)){white-space:nowrap}.history-table td:nth-child(4){min-width:22rem}
@media(max-width:600px){.brand-header{align-items:flex-start;flex-direction:column}.document-date{text-align:left}.document-title h1{font-size:2rem}}
@media print{.brand-header,.diagram{print-color-adjust:exact}section{box-shadow:none}}
"""

DISCLAIMER = "AI-generated fictional demo instructions. Not validated engineering or safety instructions."


def brand_header():
    # Match the manufacturing site's ManufacturingLogo gear mark.
    logo = """<svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="AdventureWorks Manufacturing">
<defs><linearGradient id="gear-gradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#1d4ed8"/></linearGradient></defs>
<rect width="100" height="100" rx="16" fill="url(#gear-gradient)"/>
<g transform="translate(50,50)" fill="white"><path d="M-5,-34 L5,-34 L6,-28 Q9,-27 12,-25 L17,-29 L24,-22 L20,-17 Q22,-14 23,-11 L29,-10 L29,0 L23,-1 Q22,2 20,5 L24,10 L17,17 L13,12 Q10,14 7,15 L6,22 L-6,22 L-7,15 Q-10,14 -13,12 L-17,17 L-24,10 L-20,5 Q-22,2 -23,-1 L-29,0 L-29,-10 L-23,-11 Q-22,-14 -20,-17 L-24,-22 L-17,-29 L-12,-25 Q-9,-27 -6,-28 Z"/><circle r="9" fill="#2563eb"/></g></svg>"""
    return (f'<header class="brand-header"><div class="brand">{logo}<div>'
            '<div class="wordmark">Adventure<span>Works</span></div>'
            '<div class="brand-label">Manufacturing Hub</div></div></div></header>')


def presentation_notes(text):
    sentences = re.split(r"(?<=[.!?])\s+", text)
    return " ".join(sentence for sentence in sentences if not any(
        phrase in sentence.lower() for phrase in (
            "fictional", "not engineering advice", "not a certified",
            "actual assembly and release require",
        )
    ))


def escape(value):
    return html.escape(str(value), quote=True)


def write_atomic(path, text):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(text)
            file.flush()
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def json_text(value):
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def create_change_history(result, product, current_date):
    representative = result["grounding"]["representative"]
    model_id = result["grounding"]["model"]["productModelId"]
    if product["ProductID"] != representative["productId"]:
        raise ValueError("Lifecycle dates do not belong to the representative product.")
    start = date.fromisoformat(product["SellStartDate"][:10])
    if start >= current_date:
        raise ValueError("A document history requires a product launch before the current revision date.")
    rng = random.Random(model_id)
    count = min(rng.choice([0, 2, 4, 6]), (current_date - start).days - 1)
    dates = sorted(rng.sample(range(1, (current_date - start).days), count))
    components = sorted({c["name"] for c in result["grounding"]["components"]
                         if c["parentProductId"] == representative["productId"]})
    if not components:
        raise ValueError("Document changes require actual direct BOM components.")
    first, last = components[0], components[-1]
    changes = [
        f"Reordered the {first} receiving check ahead of kit staging; added a missing-part hold point.",
        "Standardized work-center hand-off notes and separated preparation time from hands-on labor.",
        f"Clarified identification of {last}; retained the source part number in the point-of-use checklist.",
        "Moved variant-selection notes ahead of the first operation to reduce wrong-kit changeovers.",
        "Aligned component count checks with the bill of materials and removed a duplicate sign-off box.",
        "Reformatted shop-floor copies for clearer numbered steps and consolidated inspection comments.",
    ]
    rng.shuffle(changes)
    owners = ["M. Chen", "R. Alvarez", "J. Patel", "S. Brooks"]
    rng.shuffle(owners)
    entries = [(start, "Initial controlled issue for product introduction; established the component list and work-center sequence.")]
    entries.extend((start + timedelta(days=offset), changes[i]) for i, offset in enumerate(dates))
    titles = "; ".join(d["title"] for d in result["draft"]["diagrams"])
    entries.append((current_date,
                    f"Released the illustrated workstation edition: {titles}. Matched numbered component legends "
                    "to the operating steps and adopted the Manufacturing Hub document layout."))
    revisions = [{
        "revision": f"{i + 1}.0", "effectiveDate": when.isoformat(),
        "changeRequest": f"ECN-{when.year}-{model_id:03d}-{i + 1:02d}", "description": text,
        "preparedBy": owners[i % len(owners)], "approvedBy": owners[(i + 1) % len(owners)],
    } for i, (when, text) in enumerate(entries)]
    return {"documentNumber": f"AW-MFG-WI-{model_id:04d}", "contentKind": "fabricated-demo-change-history",
            "dateBasis": "Initial issue uses the representative product SellStartDate; intervening changes are invented.",
            "lifecycleSource": product, "revisions": revisions}


def render_change_history(history):
    if history is None:
        return ""
    rows = "".join(
        f'<tr><td>{escape(r["revision"])}</td><td><time datetime="{escape(r["effectiveDate"])}">'
        f'{escape(r["effectiveDate"])}</time></td><td>{escape(r["changeRequest"])}</td>'
        f'<td>{escape(r["description"])}</td><td>{escape(r["preparedBy"])}</td>'
        f'<td>{escape(r["approvedBy"])}</td></tr>' for r in history["revisions"]
    )
    return (f'<section id="change-history"><h2>Document change management history</h2>'
            f'<p><strong>Document:</strong> {escape(history["documentNumber"])} · '
            f'<strong>Current revision:</strong> {escape(history["revisions"][-1]["revision"])} · '
            '<strong>Owner:</strong> Manufacturing Engineering</p>'
            '<div class="table-scroll"><table class="history-table"><thead><tr><th>Revision</th><th>Effective date</th>'
            '<th>Change request</th><th>Description of change</th><th>Prepared by</th><th>Approved by</th>'
            f'</tr></thead><tbody>{rows}</tbody></table></div></section>')


def operation_guidance(root, brief, components, identifier):
    names = {components[c["productId"]]["name"] for c in brief["callouts"]}
    paragraphs = []
    for location in root:
        if not any(d.text == str(identifier) for d in location.iter(f"{{{NAMESPACE}}}diag")):
            continue
        for step in location:
            materials = list(step.iter(f"{{{NAMESPACE}}}material"))
            if not any(any(m.text and m.text.startswith(name + " (") for name in names) for m in materials) and not any(
                d.text == str(identifier) for d in step.iter(f"{{{NAMESPACE}}}diag")
            ):
                continue
            text = "".join(step.itertext())
            text = re.sub(r"\s*(?:See|Refer to)\s+(?:(?:the\s+)?(?:illustration|schematic|diagram|figure)\s+)?\d+\.?", "", text).strip()
            if text and text not in paragraphs:
                paragraphs.append(text)
    if not paragraphs:
        raise ValueError(f"Illustration {identifier} has no associated operation explanation.")
    return paragraphs


def render_preview(result, illustrations=None, change_history=None):
    grounding = result["grounding"]
    sheet = grounding.get("product")
    model = grounding["model"] if sheet is None else {"name": f'{sheet["name"]} part sheet', "productModelId": None}
    representative = grounding["representative"] if sheet is None else sheet
    draft = result["draft"]
    xml = result["instructionsXml"]
    if "<!DOCTYPE" in xml.upper() or "<!ENTITY" in xml.upper():
        raise ValueError("Document type declarations are not supported.")
    root = ET.fromstring(xml)
    if root.tag != f"{{{NAMESPACE}}}root":
        raise ValueError("Unexpected instruction XML namespace.")
    reservations = {r["slot"]: r for r in result["diagramReservations"]}
    briefs = {reservations[d["slot"]]["illustrationId"]: d for d in draft["diagrams"]}
    components = {c["productId"]: c for c in grounding["components"]}
    if sheet is not None:
        components[sheet["productId"]] = sheet
    centers = {c["locationId"]: c["name"] for c in grounding["workCenters"]}

    def operation_explanation(identifier):
        paragraphs = operation_guidance(root, briefs[identifier], components, identifier)
        return "".join(f"<p>{escape(text)}</p>" for text in paragraphs)

    def figure(identifier):
        brief = briefs[identifier]
        drawing = (illustrations or {}).get(identifier)
        visual = (
            f'<a href="{escape(drawing)}"><img src="{escape(drawing)}" alt="{escape(brief["title"])}"></a>'
            '<p>Open the illustration at full size by selecting it.</p>'
            if drawing else '<p><strong>Diagram not generated yet — awaiting instruction review.</strong></p>'
        )
        callouts = "".join(
            f'<li>{escape(c["number"])}: {escape(components[c["productId"]]["name"])} '
            f'({escape(components[c["productId"]]["productNumber"])})</li>'
            for c in brief["callouts"]
        )
        return (
            f'<aside class="diagram"><h3>Illustration {identifier}: {escape(brief["title"])}</h3>'
            f'{visual}'
            f'<div class="operation-guidance"><h4>Operation guidance</h4>{operation_explanation(identifier)}</div>'
            f'<ul class="callouts">{callouts}</ul></aside>'
        )

    sections = []
    for location in root:
        if location.tag != f"{{{NAMESPACE}}}Location":
            raise ValueError("Unsupported instruction section.")
        location_id = int(location.attrib["LocationID"])
        metrics = "".join(
            f"<dt>{escape(label)}:</dt><dd>{escape(location.attrib[key])}{suffix}</dd>"
            for key, label, suffix in [
                ("SetupHours", "Setup", " h"), ("LaborHours", "Labor", " h"),
                ("MachineHours", "Machine", " h"), ("LotSize", "Lot size", ""),
            ] if key in location.attrib
        )
        steps = []
        for index, step in enumerate(location):
            if step.tag != f"{{{NAMESPACE}}}step":
                raise ValueError("Unsupported instruction step.")
            parts = [escape(step.text or "")]
            diagrams = []
            for part in step:
                kind = part.tag.removeprefix(f"{{{NAMESPACE}}}")
                text = "".join(part.itertext())
                if kind in ("material", "tool", "specs", "blueprint"):
                    parts.append(f'<strong class="{kind}">{escape(text)}</strong>')
                elif kind == "diag":
                    identifier = int(text)
                    if identifier not in briefs:
                        raise ValueError("Unresolved diagram reference.")
                    anchor = f"figure-{location_id}-{index}-{identifier}"
                    parts.append(f'<a href="#{anchor}">{identifier}</a>')
                    if identifier not in diagrams:
                        diagrams.append(identifier)
                else:
                    raise ValueError("Unsupported instruction inline element.")
                parts.append(escape(part.tail or ""))
            figures = "".join(
                f'<div id="figure-{location_id}-{index}-{identifier}">{figure(identifier)}</div>'
                for identifier in diagrams
            )
            steps.append("<li><p>" + "".join(parts) + "</p>" + figures + "</li>")
        sections.append(
            f'<section id="work-center-{location_id}"><h2>Work Center {location_id} — {escape(centers[location_id])}</h2>'
            f'<dl>{metrics}</dl><p>{escape((location.text or "").replace("Estimates are fictional demo assumptions. ", ""))}</p><ol>{"".join(steps)}</ol></section>'
        )
    assumptions = "".join(f"<li>{escape(note)}</li>" for text in draft["assumptions"] if (note := presentation_notes(text)))
    variants = "".join(f"<li>{escape(text)}</li>" for text in draft["variantNotes"])
    direct = [c for c in grounding["components"] if c["parentProductId"] == representative["productId"]]
    bom = "".join(
        f'<tr><td>{c["productId"]}</td><td>{escape(c["productNumber"])}</td><td>{escape(c["name"])}</td>'
        f'<td>{escape(c["quantity"])}</td><td>{escape(c["unit"])}</td></tr>' for c in direct
    )
    overview = (root.text or "").removeprefix(DISCLAIMER).strip()
    overview = overview.replace("Fictional assembly demonstration", "Assembly instructions")
    overview = overview.replace("Fictional workshop demonstration", "Workshop instructions")
    overview = overview.replace("Demo draft for model", "Instructions for model")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{escape(model["name"])} — instruction draft</title><style>{STYLE}</style></head>
<body><nav><a href="../{"diagrams.html" if illustrations else "index.html"}">All sample drafts</a> · <a href="instructions.xml">Source XML</a> · <a href="grounding.json">Grounding</a></nav>
{brand_header()}
<div class="document-title"><div class="eyebrow">Manufacturing work instructions</div><h1>{escape(model["name"])}</h1>
<p>{f'Model {model["productModelId"]} · Representative product {representative["productId"]}: {escape(representative["name"])}' if sheet is None else f'Product {sheet["productId"]} · {escape(sheet["productNumber"])} · Routing basis: {escape(grounding["routingBasis"])}'}</p>
</div>
<section><h2>Overview</h2><p>{escape(overview)}</p></section>
<section><h2>Process notes and estimates</h2><ul>{assumptions}</ul><h2>Variant notes</h2><ul>{variants}</ul></section>
<nav>{" · ".join(f'<a href="#work-center-{int(c.attrib["LocationID"])}">Work Center {int(c.attrib["LocationID"])}</a>' for c in root)}</nav>
{"".join(sections)}
<section><h2>Grounded direct components</h2><p>Quantities per representative assembly, from the effective live BOM.</p>
<div class="table-scroll"><table><thead><tr><th>Product ID</th><th>Number</th><th>Component</th><th>Quantity</th><th>Unit</th></tr></thead><tbody>{bom}</tbody></table></div></section>
{render_change_history(change_history)}
<footer>AdventureWorks · Manufacturing Engineering · {escape(model["name"])} · {f'Model {model["productModelId"]}' if sheet is None else f'Product {sheet["productId"]}'}</footer>
</body></html>"""


def validate_result(result, model_id, allow_existing=False):
    if result["status"] != "draft-awaiting-instruction-review" or result["grounding"]["model"]["productModelId"] != model_id:
        raise ValueError("The API returned an unexpected model or draft status.")
    if (result["grounding"]["model"].get("instructions") or "").strip() and not allow_existing:
        raise ValueError("The API attempted to replace existing instructions.")
    used = set()
    for reservation in result["diagramReservations"]:
        identifier = reservation["illustrationId"]
        slot = reservation["slot"]
        if slot not in (1, 2, 3) or identifier != 100000 + model_id * 10 + slot or identifier in used:
            raise ValueError("Invalid diagram reservation.")
        if reservation["fileName"] != f"illustration-{identifier}.svg":
            raise ValueError("Invalid illustration filename.")
        used.add(identifier)
    if not used:
        raise ValueError("No diagram briefs were returned.")
    if sorted(r["slot"] for r in result["diagramReservations"]) != sorted(d["slot"] for d in result["draft"]["diagrams"]):
        raise ValueError("Diagram briefs and reservations do not match.")


def load_reservation_owners(output):
    owners = {}
    for path in output.glob("*/manifest.json"):
        manifest = json.loads(path.read_text(encoding="utf-8"))
        for model in manifest["models"]:
            for reservation in model["diagramReservations"]:
                identifier = reservation["illustrationId"]
                if identifier in owners and owners[identifier] != model["modelId"]:
                    raise ValueError(f"Local manifests assign illustration {identifier} to multiple models.")
                owners[identifier] = model["modelId"]
    return owners


def save_result(run, result, model_id, allow_existing=False):
    validate_result(result, model_id, allow_existing)
    preview = render_preview(result)
    directory = run / f"model-{model_id}"
    directory.mkdir()
    for name, value in [
        ("grounding.json", json_text(result["grounding"])),
        ("instructions.xml", result["instructionsXml"] + "\n"),
        ("instructions.html", preview),
        ("diagram-briefs.json", json_text({"briefs": result["draft"]["diagrams"], "reservations": result["diagramReservations"]})),
        ("metadata.json", json_text({key: value for key, value in result.items() if key not in ("grounding", "instructionsXml")})),
        ("response.json", json_text(result)),
    ]:
        write_atomic(directory / name, value)
    return {"modelId": model_id, "name": result["grounding"]["model"]["name"],
            "status": result["status"], "sourceFingerprint": result["sourceFingerprint"],
            "instructionsSha256": hashlib.sha256(result["instructionsXml"].encode()).hexdigest(),
            "diagramReservations": result["diagramReservations"]}


def write_index(run, manifest):
    rows = "".join(
        f'<li><a href="model-{m["modelId"]}/instructions.html">{escape(m["name"])} (model {m["modelId"]})</a></li>'
        for m in manifest["models"]
    )
    write_atomic(run / "manifest.json", json_text(manifest))
    write_atomic(run / "index.html", f'<!doctype html><html lang="en"><meta charset="utf-8">'
                 f'<title>Manufacturing instruction review</title><style>{STYLE}</style>'
                 '<h1>Manufacturing instruction drafts</h1><p>AI-generated fictional demo content. '
                 'Review instructions and diagram briefs before generating any drawings.</p>'
                 f'<ul>{rows}</ul></html>')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", nargs="+", type=int, help="Explicit model IDs (maximum three per invocation).")
    parser.add_argument("--output", type=Path, default=REPO / "review-output/manufacturing-content")
    parser.add_argument("--resume", type=Path, help="Resume a partial review run without regenerating saved models.")
    args = parser.parse_args()
    if args.resume:
        args.output = args.resume.parent
        manifest = json.loads((args.resume / "manifest.json").read_text())
        if args.models and args.models != manifest["requestedModels"]:
            parser.error("--models must match the resumed run.")
        args.models = manifest["requestedModels"]
    if not args.models:
        parser.error("Choose --models or --resume.")
    if not 1 <= len(args.models) <= 3 or len(set(args.models)) != len(args.models) or any(m < 1 or m > 1000000 for m in args.models):
        parser.error("Choose 1-3 unique model IDs between 1 and 1000000.")
    endpoint = os.environ.get("API_FUNCTIONS_URL", "").rstrip("/")
    token = os.environ.get("FUNCTIONS_ACCESS_TOKEN", "")
    if not endpoint.startswith("https://") or not token:
        parser.error("Set API_FUNCTIONS_URL (HTTPS) and FUNCTIONS_ACCESS_TOKEN (manufacturing.write).")
    args.output.mkdir(parents=True, exist_ok=True)
    owners = load_reservation_owners(args.output)
    if args.resume:
        run = args.resume
        for saved in manifest["models"]:
            result = json.loads((run / f'model-{saved["modelId"]}' / "response.json").read_text())
            validate_result(result, saved["modelId"])
            if hashlib.sha256(result["instructionsXml"].encode()).hexdigest() != saved["instructionsSha256"]:
                raise ValueError("A saved instruction changed; refusing to resume.")
        manifest.pop("error", None)
        manifest["status"] = "generating-instruction-drafts"
    else:
        run = args.output / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        run.mkdir()
        manifest = {"status": "generating-instruction-drafts", "requestedModels": args.models, "models": []}
    write_index(run, manifest)
    try:
        for model_id in args.models:
            if any(saved["modelId"] == model_id for saved in manifest["models"]):
                print(f"Keeping saved model {model_id}.", flush=True)
                continue
            request = Request(endpoint + "/api/manufacturing/content/instructions/generate",
                              data=json.dumps({"productModelId": model_id}).encode(),
                              headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
            print(f"Generating model {model_id}...", flush=True)
            try:
                with urlopen(request, timeout=220) as response:
                    result = json.load(response)
            except HTTPError as error:
                raise RuntimeError(f"Model {model_id}: HTTP {error.code}: {error.read().decode()[:2000]}") from error
            validate_result(result, model_id)
            for reservation in result["diagramReservations"]:
                identifier = reservation["illustrationId"]
                if identifier in owners and owners[identifier] != model_id:
                    raise ValueError(f"Illustration {identifier} is assigned to another model in a local manifest.")
                owners[identifier] = model_id
            manifest["models"].append(save_result(run, result, model_id))
            write_index(run, manifest)
            print(f"Saved {run / f'model-{model_id}/instructions.html'}", flush=True)
    except (RuntimeError, ValueError, KeyError, TypeError, OSError, URLError) as error:
        manifest["status"] = "failed"
        manifest["error"] = str(error)
        write_index(run, manifest)
        raise
    manifest["status"] = "awaiting-instruction-review"
    write_index(run, manifest)
    print(f"Review index: {run / 'index.html'}")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, TypeError, OSError, URLError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
