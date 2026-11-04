#!/usr/bin/env python3
"""Generate diagram drafts for an explicitly approved local instruction review bundle."""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location("instruction_drafts", Path(__file__).with_name("generate-manufacturing-drafts.py"))
drafts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drafts)


def validate_diagram(result, approved, slot):
    model_id = approved["grounding"]["model"]["productModelId"]
    reservation = next(r for r in approved["diagramReservations"] if r["slot"] == slot)
    if (result["status"] != "draft-awaiting-diagram-review" or result["productModelId"] != model_id or
            result["slot"] != slot or result["illustrationId"] != reservation["illustrationId"] or
            result["fileName"] != reservation["fileName"] or
            result["sourceFingerprint"] != approved["sourceFingerprint"] or
            result["instructionsSha256"] != hashlib.sha256(approved["instructionsXml"].encode()).hexdigest()):
        raise ValueError("Diagram response is not bound to the approved model, instructions and reservation.")
    if any(token in result["svg"].upper() or token in result["xaml"].upper() for token in ("<!DOCTYPE", "<!ENTITY")):
        raise ValueError("Document type declarations are not supported.")
    svg = ET.fromstring(result["svg"])
    if svg.tag != "{http://www.w3.org/2000/svg}svg":
        raise ValueError("The diagram response is not SVG.")
    if any(node.tag not in ("{http://www.w3.org/2000/svg}" + tag for tag in ("svg", "path", "g")) or
           any(attribute.split("}")[-1].lower().startswith("on") or attribute.endswith("href") for attribute in node.attrib)
           for node in svg.iter()):
        raise ValueError("Unexpected SVG element or external reference.")
    expected = next(d for d in approved["draft"]["diagrams"] if d["slot"] == slot)
    if sorted(c["number"] for c in result["callouts"]) != sorted(c["number"] for c in expected["callouts"]):
        raise ValueError("Diagram callout mapping does not match the approved brief.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True, help="Existing instruction review run directory.")
    parser.add_argument("--approved-instructions", action="store_true", help="Confirm explicit review approval; never implied.")
    parser.add_argument("--models", nargs="+", type=int, required=True, help="1-3 reviewed models from this run.")
    args = parser.parse_args()
    if not args.approved_instructions:
        parser.error("Review instructions first, then pass --approved-instructions.")
    if len(args.models) not in (1, 2, 3) or len(set(args.models)) != len(args.models):
        parser.error("Choose 1-3 unique reviewed models.")
    endpoint = os.environ.get("API_FUNCTIONS_URL", "").rstrip("/")
    token = os.environ.get("FUNCTIONS_ACCESS_TOKEN", "")
    if not endpoint.startswith("https://") or not token:
        parser.error("Set API_FUNCTIONS_URL (HTTPS) and FUNCTIONS_ACCESS_TOKEN (manufacturing.write).")
    manifest = json.loads((args.run / "manifest.json").read_text())
    if manifest["status"] != "awaiting-instruction-review":
        raise ValueError("Select a complete instruction review run.")
    models = {m["modelId"]: m for m in manifest["models"]}
    approved_models = {}
    for model_id in args.models:
        if model_id not in models:
            raise ValueError(f"Model {model_id} is not in this reviewed run.")
        approved = json.loads((args.run / f"model-{model_id}/response.json").read_text())
        drafts.validate_result(approved, model_id)
        if hashlib.sha256(approved["instructionsXml"].encode()).hexdigest() != models[model_id]["instructionsSha256"]:
            raise ValueError("Instruction content changed since the review manifest was saved.")
        approved_models[model_id] = approved
    attempt = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    record_dir = args.run / "diagram-attempts" / attempt
    record_dir.mkdir(parents=True)
    progress = {"status": "generating-diagram-drafts", "approvedInstructionRun": args.run.name,
                "requestedModels": args.models, "diagrams": []}

    def save_progress():
        drafts.write_atomic(record_dir / "manifest.json", drafts.json_text(progress))

    save_progress()
    previews = {}
    try:
        for model_id, approved in approved_models.items():
            images = {}
            model_dir = args.run / f"model-{model_id}"
            output = model_dir / "diagram-attempts" / attempt
            output.mkdir(parents=True)
            for reservation in approved["diagramReservations"]:
                slot = reservation["slot"]
                identifier = reservation["illustrationId"]
                print(f"Drawing model {model_id}, illustration {identifier}...", flush=True)
                request = Request(endpoint + "/api/manufacturing/content/diagrams/generate",
                                  data=json.dumps({"approvedDraft": approved, "slot": slot}).encode(),
                                  headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
                try:
                    with urlopen(request, timeout=220) as response:
                        result = json.load(response)
                except HTTPError as error:
                    raise RuntimeError(f"Illustration {identifier}: HTTP {error.code}: {error.read().decode()[:2000]}") from error
                validate_diagram(result, approved, slot)
                for suffix, content in [("xaml", result["xaml"]), ("svg", result["svg"]), ("json", drafts.json_text(result))]:
                    drafts.write_atomic(output / f"illustration-{identifier}.{suffix}", content)
                images[identifier] = f"diagram-attempts/{attempt}/{reservation['fileName']}"
                history_path = model_dir / "change-history.json"
                history = json.loads(history_path.read_text()) if history_path.exists() else None
                previews[model_id] = drafts.render_preview(approved, images, history)
                progress["diagrams"].append({"modelId": model_id, "illustrationId": identifier, "slot": slot,
                                             "responseId": result["responseId"], "sourceFingerprint": result["sourceFingerprint"],
                                             "svgSha256": hashlib.sha256(result["svg"].encode()).hexdigest(),
                                             "file": str((output / reservation["fileName"]).relative_to(args.run))})
                save_progress()
                print(f"Saved {output / reservation['fileName']}", flush=True)
    except (RuntimeError, ValueError, KeyError, TypeError, OSError, URLError, ET.ParseError) as error:
        progress["status"] = "failed"
        progress["error"] = str(error)
        save_progress()
        raise
    progress["status"] = "awaiting-diagram-review"
    save_progress()
    for model_id, preview in previews.items():
        drafts.write_atomic(args.run / f"model-{model_id}/instructions-diagrams.html", preview)
    links = "".join(f'<li><a href="model-{model_id}/instructions-diagrams.html">'
                    f'{drafts.escape(approved["grounding"]["model"]["name"])}</a></li>'
                    for model_id, approved in approved_models.items())
    drafts.write_atomic(args.run / "diagrams.html",
                        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                        f'<title>Manufacturing diagram review</title><style>{drafts.STYLE}</style>'
                        '<h1>Manufacturing diagram drafts</h1><p>AI-generated fictional schematics, not engineering drawings. '
                        'Review before publishing or seed integration.</p>'
                        f'<ul>{links}</ul><a href="index.html">Original approved instruction drafts</a></html>')
    print(f"Review index: {args.run / 'diagrams.html'}")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, TypeError, OSError, URLError, ET.ParseError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
