#!/usr/bin/env python3
"""Check seed-to-frontend manufacturing coverage offline before provisioning or deployment."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

DIRECTORY = Path(__file__).parent
spec = importlib.util.spec_from_file_location("export", DIRECTORY / "export-manufacturing-content.py")
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)
spec = importlib.util.spec_from_file_location("verify", DIRECTORY / "verify-manufacturing-content.py")
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
REPO = Path(__file__).resolve().parents[2]


def validate(repo=REPO, require_full=True):
    sql = repo / "seed-job/sql"
    products = {}
    for filename in ("Product.csv", "Product-ai.csv"):
        for line in (sql / filename).read_text().splitlines():
            fields = line.split("\t")
            if len(fields) != 25:
                raise ValueError(f"{filename}: expected 25 Product columns.")
            products[int(fields[0])] = fields
    manufactured = {int(p[19]) for p in products.values() if p[3] == "1" and p[19].strip()}
    models = {int(row[0]): row for row in export.records(sql / "ProductModel.csv", "+|", "&|", 6)}
    overlay = export.records(sql / "ProductModelInstructions-ai.csv", "+|", "&|", 2)
    if len({int(row[0]) for row in overlay}) != len(overlay):
        raise ValueError("Duplicate instruction overlay IDs.")
    instructions = {identifier: row[3] for identifier, row in models.items() if row[3].strip()}
    original_ids = set(instructions)
    for row in overlay:
        identifier = int(row[0])
        if identifier not in models or identifier in original_ids:
            raise ValueError(f"Overlay model {identifier} is absent or would replace original instructions.")
        if identifier not in manufactured:
            raise ValueError(f"Overlay model {identifier} has no manufactured product.")
        instructions[identifier] = row[1]
    illustrations = {}
    generated_ids = set()
    for filename in ("Illustration.csv", "Illustration-ai.csv"):
        for row in export.records(sql / filename, "+|", "&|", 3):
            identifier = int(row[0])
            if identifier in illustrations:
                raise ValueError(f"Conflicting or duplicate illustration {identifier}.")
            illustrations[identifier] = row[1]
            if filename.endswith("-ai.csv"):
                generated_ids.add(identifier)
    mapping_rows = export.records(sql / "ProductModelIllustration-ai.csv", "\t", "\n", 3)
    mappings = {(int(row[0]), int(row[1])) for row in mapping_rows}
    if len(mapping_rows) != len(mappings):
        raise ValueError("Duplicate AI model/illustration mappings.")
    used_generated = set()
    expected_mappings = set()
    supplemented = []
    for identifier, xml in instructions.items():
        root = ET.fromstring(xml)
        refs = {int(node.text) for node in root.iter(f"{{{export.drafts.NAMESPACE}}}diag")}
        supplemental = identifier in original_ids and not refs
        metadata_path = repo / f"app-manufacturing/src/data/manufacturing/model-{identifier}.json"
        metadata = None
        if supplemental and metadata_path.exists():
            metadata = json.loads(metadata_path.read_text())
            if not metadata.get("supplementalFigures"):
                raise ValueError(f"Model {identifier} supplemental figures are not marked as such.")
            refs = {int(key) for key in metadata["figures"]}
            supplemented.append(identifier)
        if not refs:
            if require_full and identifier in manufactured:
                raise ValueError(f"Model {identifier} has no instruction diagram or supplemental illustrations.")
            continue
        for illustration in refs:
            if illustration not in illustrations:
                raise ValueError(f"Model {identifier} references missing illustration {illustration}.")
            path = repo / f"app-manufacturing/public/illustrations/illustration-{illustration}.svg"
            svg = ET.fromstring(path.read_text())
            if svg.tag != "{http://www.w3.org/2000/svg}svg":
                raise ValueError(f"Illustration {illustration} is not SVG.")
            if illustration in generated_ids:
                if (identifier, illustration) not in mappings:
                    raise ValueError(f"Missing AI model/illustration mapping {identifier}/{illustration}.")
                if any(node.tag not in ("{http://www.w3.org/2000/svg}" + tag for tag in ("svg", "path", "g")) or
                       any(key.lower().startswith("on") or key.endswith("href") for key in node.attrib) for node in svg.iter()):
                    raise ValueError(f"Unsafe generated SVG {illustration}.")
                used_generated.add(illustration)
        if identifier not in original_ids or supplemental:
            metadata = metadata or json.loads(metadata_path.read_text())
            expected_mappings.update((identifier, reference) for reference in refs)
            if metadata["modelId"] != identifier or verify.canonical(metadata["sourceInstructions"]) != verify.canonical(xml):
                raise ValueError(f"Model {identifier} metadata is not bound to the seeded instructions.")
            if {int(key) for key in metadata["figures"]} != refs or not metadata["history"]["revisions"]:
                raise ValueError(f"Model {identifier} figure metadata/history is incomplete.")
            for figure in metadata["figures"].values():
                if not figure["guidance"] or not figure["callouts"]:
                    raise ValueError(f"Model {identifier} figure lacks operational guidance or component callouts.")
    if used_generated != generated_ids:
        raise ValueError("Generated illustrations include unreferenced records.")
    if mappings != expected_mappings:
        raise ValueError("AI mappings do not exactly match the published instruction references.")
    missing = manufactured - instructions.keys()
    if missing and require_full:
        raise ValueError(f"Manufactured models without instructions/diagrams: {sorted(missing)}. Run the full-coverage generator before deployment.")
    hashes = {}
    for filename in ("ProductModelInstructions-ai.csv", "Illustration-ai.csv", "ProductModelIllustration-ai.csv"):
        hashes[filename] = hashlib.sha256((sql / filename).read_bytes()).hexdigest()
    return {"manufacturedModels": len(manufactured), "originalModels": len(original_ids),
            "generatedModels": len(overlay), "generatedDiagrams": len(generated_ids),
            "supplementedOriginalModels": supplemented,
            "manufacturedModelIds": sorted(manufactured),
            "generatedModelIds": sorted(int(row[0]) for row in overlay),
            "nonManufacturedModelIds": sorted(models.keys() - manufactured),
            "missingManufacturedModels": sorted(missing), "artifactSha256": hashes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-partial", action="store_true", help="Diagnostic only: report missing models without failing.")
    parser.add_argument("--write-manifest", action="store_true", help="Persist a complete validated seed/asset coverage manifest.")
    args = parser.parse_args()
    if args.allow_partial and args.write_manifest:
        parser.error("A published coverage manifest requires full validation.")
    report = validate(require_full=not args.allow_partial)
    if args.write_manifest:
        export.drafts.write_atomic(REPO / "seed-job/manufacturing-content-coverage.json", export.drafts.json_text(report))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, ET.ParseError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
