#!/usr/bin/env python3
"""Publish explicitly approved local manufacturing drafts as seed overlays and bundled assets."""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location("drafts", Path(__file__).with_name("generate-manufacturing-drafts.py"))
drafts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drafts)
spec = importlib.util.spec_from_file_location("verification", Path(__file__).with_name("verify-manufacturing-content.py"))
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)
REPO = Path(__file__).resolve().parents[2]


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def records(path, delimiter, terminator, columns):
    if not path.exists():
        return []
    result = []
    for row in path.read_text(encoding="utf-8").split(terminator):
        if not row.strip():
            continue
        fields = row.strip().split(delimiter)
        if len(fields) != columns:
            raise ValueError(f"Invalid record in {path.name}.")
        result.append(fields)
    return result


def merge_rows(path, additions, delimiter, terminator, columns, key_columns):
    merged = {}
    for row in records(path, delimiter, terminator, columns) + additions:
        if any(delimiter in value or terminator in value for value in row):
            raise ValueError(f"Unescaped delimiter in {path.name}.")
        key = tuple(int(row[index]) for index in key_columns)
        if key in merged and merged[key] != row:
            raise ValueError(f"Conflicting approved record {key} in {path.name}.")
        merged[key] = row
    return "".join(delimiter.join(merged[key]) + terminator for key in sorted(merged))


def publish(run, models, diagram_manifest, repo=REPO, supplement_originals=False):
    manifest_path = diagram_manifest.resolve().relative_to(run.resolve())
    source = json.loads((run / "manifest.json").read_text())
    diagrams = json.loads(diagram_manifest.read_text())
    if source["status"] != "awaiting-instruction-review" or diagrams["status"] != "awaiting-diagram-review":
        raise ValueError("Only complete instruction and diagram review runs can be published.")
    if diagrams["approvedInstructionRun"] != run.name:
        raise ValueError("The diagram run belongs to another instruction review.")
    if len(models) != len(set(models)) or not 1 <= len(models) <= 100:
        raise ValueError("Choose 1-100 unique explicitly approved model IDs.")
    instructions, illustrations, mappings, pending = [], [], [], {}
    published = []
    ns = {"i": drafts.NAMESPACE}
    original_models = {int(row[0]): row for row in records(repo / "seed-job/sql/ProductModel.csv", "+|", "&|", 6)}
    original_ids = {int(row[0]) for row in records(repo / "seed-job/sql/Illustration.csv", "+|", "&|", 3)}
    for model_id in sorted(models):
        model = next((m for m in source["models"] if m["modelId"] == model_id), None)
        original = original_models.get(model_id, ["", "", "", ""])[3].strip()
        if model is None or model_id not in original_models or (original and not supplement_originals):
            raise ValueError(f"Model {model_id} is absent or has original instructions; originals cannot be replaced.")
        directory = run / f"model-{model_id}"
        result = json.loads((directory / "response.json").read_text())
        drafts.validate_result(result, model_id, allow_existing=supplement_originals)
        if supplement_originals:
            if not original or not result["grounding"]["model"].get("instructions"):
                raise ValueError("Supplemental figures require existing original instructions.")
            if verification.canonical(original) != verification.canonical(result["grounding"]["model"]["instructions"]):
                raise ValueError("Supplemental source differs from the original seed instructions.")
            if list(ET.fromstring(original).iter(f"{{{drafts.NAMESPACE}}}diag")):
                raise ValueError("Original instructions already contain diagrams.")
        if digest(result["instructionsXml"]) != model["instructionsSha256"]:
            raise ValueError(f"Model {model_id} instructions changed after review.")
        history = json.loads((directory / "change-history.json").read_text())
        if history["lifecycleSource"]["ProductID"] != result["grounding"]["representative"]["productId"]:
            raise ValueError("Revision history belongs to another product.")
        root = ET.fromstring(result["instructionsXml"])
        refs = {int(d.text) for d in root.findall(".//i:diag", ns)}
        if refs != {r["illustrationId"] for r in result["diagramReservations"]}:
            raise ValueError("Instruction references do not match reserved illustrations.")
        figures = {}
        for reservation in result["diagramReservations"]:
            identifier = reservation["illustrationId"]
            if identifier in original_ids:
                raise ValueError("An approved diagram collides with an original illustration.")
            entry = next((d for d in diagrams["diagrams"] if d["modelId"] == model_id and d["illustrationId"] == identifier), None)
            if entry is None:
                raise ValueError(f"Illustration {identifier} is missing from the approved drawing run.")
            relative = Path(entry["file"])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Invalid drawing path.")
            response = json.loads((run / relative.with_suffix(".json")).read_text())
            svg = (run / relative).read_text()
            xaml = (run / relative.with_suffix(".xaml")).read_text()
            if (digest(svg) != entry["svgSha256"] or response["svg"] != svg or response["xaml"] != xaml or
                    response["sourceFingerprint"] != result["sourceFingerprint"] or
                    response["instructionsSha256"] != model["instructionsSha256"] or
                    response["illustrationId"] != identifier or response["productModelId"] != model_id or
                    response["slot"] != reservation["slot"]):
                raise ValueError(f"Illustration {identifier} does not match the reviewed source.")
            illustrations.append([str(identifier), xaml, history["revisions"][-1]["effectiveDate"] + "T00:00:00"])
            mappings.append([str(model_id), str(identifier), history["revisions"][-1]["effectiveDate"] + "T00:00:00"])
            pending[repo / "app-manufacturing/public/illustrations" / reservation["fileName"]] = svg + "\n"
            brief = next(b for b in result["draft"]["diagrams"] if b["slot"] == reservation["slot"])
            components = {c["productId"]: c for c in result["grounding"]["components"]}
            guidance = drafts.operation_guidance(root, brief, components, identifier)
            figures[str(identifier)] = {"title": brief["title"], "guidance": guidance,
                                       "callouts": [{"number": c["number"], "name": components[c["productId"]]["name"],
                                                     "productNumber": components[c["productId"]]["productNumber"]} for c in brief["callouts"]]}
        if not supplement_originals:
            instructions.append([str(model_id), result["instructionsXml"]])
        notes = [note for text in result["draft"]["assumptions"] if (note := drafts.presentation_notes(text))]
        metadata = {"modelId": model_id, "sourceInstructions": result["grounding"]["model"]["instructions"] if supplement_originals else result["instructionsXml"], "processNotes": notes,
                    "variantNotes": result["draft"]["variantNotes"], "history": history, "figures": figures}
        if supplement_originals:
            metadata["supplementalFigures"] = True
        pending[repo / f"app-manufacturing/src/data/manufacturing/model-{model_id}.json"] = drafts.json_text(metadata)
        published.append({"modelId": model_id, "sourceFingerprint": result["sourceFingerprint"],
                          "instructionsSha256": model["instructionsSha256"], "diagramIds": sorted(refs)})
    for name, additions, delimiter, terminator, columns, keys in [
        ("ProductModelInstructions-ai.csv", instructions, "+|", "&|", 2, (0,)),
        ("Illustration-ai.csv", illustrations, "+|", "&|", 3, (0,)),
        ("ProductModelIllustration-ai.csv", mappings, "\t", "\n", 3, (0, 1)),
    ]:
        path = repo / "seed-job/sql" / name
        pending[path] = merge_rows(path, additions, delimiter, terminator, columns, keys)
    for path, content in pending.items():
        if path.exists() and path.read_text() != content and path.suffix in (".svg", ".json"):
            raise ValueError(f"Refusing to overwrite a different published asset: {path}.")
    for path, content in pending.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        drafts.write_atomic(path, content)
    receipt = {"status": "exported-approved-manufacturing-content", "exportedAtUtc": datetime.now(timezone.utc).isoformat(),
               "instructionRun": run.name, "diagramManifest": str(manifest_path), "models": published}
    drafts.write_atomic(run / "seed-export.json", drafts.json_text(receipt))
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--diagram-manifest", type=Path, required=True)
    parser.add_argument("--models", nargs="+", type=int, required=True)
    parser.add_argument("--approved", action="store_true")
    parser.add_argument("--supplement-originals", action="store_true", help="Publish figures for existing originals without replacing their instruction XML.")
    args = parser.parse_args()
    if not args.approved:
        parser.error("Explicit instruction, diagram and presentation approval is required (--approved).")
    receipt = publish(args.run, args.models, args.diagram_manifest, supplement_originals=args.supplement_originals)
    print(f'Exported {len(receipt["models"])} approved model(s); no SQL changes were made.')


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, StopIteration, ET.ParseError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
