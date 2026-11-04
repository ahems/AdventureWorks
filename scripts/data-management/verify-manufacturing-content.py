#!/usr/bin/env python3
"""Verify deployed approved overlays and preservation of existing instructions through DAB."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlencode, urlparse
from urllib.request import urlopen
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[2]


def canonical(xml):
    root = ET.fromstring(xml)
    def value(node):
        attributes = dict(node.attrib)
        for key in ("LocationID", "SetupHours", "LaborHours", "MachineHours", "LotSize"):
            if key in attributes:
                attributes[key] = str(Decimal(attributes[key]).normalize())
        return [node.tag, sorted(attributes.items()), " ".join((node.text or "").split()),
                [[value(child), " ".join((child.tail or "").split())] for child in node]]
    return json.dumps(value(root), separators=(",", ":"), ensure_ascii=False)


def read_all(endpoint, entity, select=None):
    query = {"$first": 100}
    if select:
        query["$select"] = select
    url = f"{endpoint}/api/{entity}?{urlencode(query)}"
    records, seen = [], set()
    while url:
        if urlparse(url).scheme != "https" or urlparse(url).netloc != urlparse(endpoint).netloc or url in seen:
            raise ValueError("Invalid or looping API pagination.")
        seen.add(url)
        with urlopen(url, timeout=180) as response:
            page = json.load(response)
        records.extend(page["value"])
        url = page.get("nextLink")
    return records


def instruction_hashes(models):
    return {str(model["ProductModelID"]): hashlib.sha256(canonical(model["Instructions"]).encode()).hexdigest()
            for model in models if model["Instructions"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--capture-baseline", action="store_true")
    parser.add_argument("--list-candidates", action="store_true", help="List manufactured models without instructions; generation still verifies BOM and English descriptions.")
    parser.add_argument("--limit", type=int, default=3, help="Candidate bound, 1-100 (default three).")
    parser.add_argument("--require-full-coverage", action="store_true", help="Require every live manufactured model to have instructions and at least one illustration.")
    parser.add_argument("--site-url", help="Also verify every bundled SVG matches the deployed manufacturing site's bytes.")
    args = parser.parse_args()
    endpoint = os.environ.get("API_URL", "").rstrip("/")
    if not endpoint.startswith("https://"):
        parser.error("Set API_URL to the deployed HTTPS DAB endpoint.")
    if not 1 <= args.limit <= 100:
        parser.error("--limit must be 1-100.")
    if not args.list_candidates and not args.baseline:
        parser.error("Choose --list-candidates or provide --baseline.")
    models = read_all(endpoint, "ProductModel")
    if args.list_candidates:
        products = read_all(endpoint, "Product", "ProductModelID,MakeFlag")
        manufactured = {p["ProductModelID"] for p in products if p["MakeFlag"]}
        candidates = sorted((m for m in models if m["ProductModelID"] in manufactured and not m["Instructions"]),
                            key=lambda m: m["ProductModelID"])[:args.limit]
        print(json.dumps([{"modelId": m["ProductModelID"], "name": m["Name"]} for m in candidates], indent=2))
        return
    hashes = instruction_hashes(models)
    if args.capture_baseline:
        if args.baseline.exists():
            raise ValueError("Refusing to overwrite an existing preservation baseline.")
        args.baseline.write_text(json.dumps(hashes, indent=2) + "\n")
        print(f"Captured hashes of {len(hashes)} existing instructed models across {len(models)} models.")
        return
    before = json.loads(args.baseline.read_text())
    for model_id, fingerprint in before.items():
        if hashes.get(model_id) != fingerprint:
            raise ValueError(f"Existing instructions for model {model_id} were changed or lost.")
    for row in (REPO / "seed-job/sql/ProductModelInstructions-ai.csv").read_text().split("&|"):
        if not row.strip():
            continue
        model_id, xml = row.strip().split("+|")
        if hashes.get(model_id) != hashlib.sha256(canonical(xml).encode()).hexdigest():
            raise ValueError(f"Model {model_id} does not match the approved instructions.")
    illustrations = {str(row["IllustrationID"]): row["Diagram"] for row in read_all(endpoint, "Illustration")}
    mappings = {(row["ProductModelID"], row["IllustrationID"]) for row in read_all(endpoint, "ProductModelIllustration")}
    diagram_count = 0
    for row in (REPO / "seed-job/sql/Illustration-ai.csv").read_text().split("&|"):
        if not row.strip():
            continue
        identifier, xaml, _ = row.strip().split("+|")
        if identifier not in illustrations or canonical(illustrations[identifier]) != canonical(xaml):
            raise ValueError(f"Illustration {identifier} does not match approved XAML.")
        diagram_count += 1
    for row in (REPO / "seed-job/sql/ProductModelIllustration-ai.csv").read_text().splitlines():
        model_id, identifier, _ = row.split("\t")
        if (int(model_id), int(identifier)) not in mappings:
            raise ValueError(f"Model/illustration mapping {model_id}/{identifier} is missing.")
    if args.require_full_coverage:
        products = read_all(endpoint, "Product", "ProductModelID,MakeFlag")
        manufactured = {p["ProductModelID"] for p in products if p["MakeFlag"] and p["ProductModelID"] is not None}
        by_id = {m["ProductModelID"]: m for m in models}
        for model_id in sorted(manufactured):
            model = by_id[model_id]
            if not model["Instructions"]:
                raise ValueError(f"Manufactured model {model_id} has no instructions.")
            referenced = {int(node.text) for node in ET.fromstring(model["Instructions"]).iter()
                          if node.tag.endswith("}diag")}
            referenced.update(identifier for mapped_model, identifier in mappings if mapped_model == model_id)
            if not referenced or any(str(identifier) not in illustrations for identifier in referenced):
                raise ValueError(f"Manufactured model {model_id} has no complete diagram coverage.")
        print(f"Full coverage verified: all {len(manufactured)} manufactured product models have instructions and illustrations.")
    if args.site_url:
        if not args.site_url.startswith("https://"):
            parser.error("--site-url must use HTTPS.")
        files = sorted((REPO / "app-manufacturing/public/illustrations").glob("illustration-*.svg"))
        def verify_asset(path):
            with urlopen(f"{args.site_url.rstrip('/')}/illustrations/{path.name}", timeout=120) as response:
                deployed = response.read()
            if hashlib.sha256(deployed).digest() != hashlib.sha256(path.read_bytes()).digest():
                raise ValueError(f"Deployed SVG does not match the bundled asset: {path.name}.")
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(verify_asset, files))
        print(f"Verified {len(files)} deployed SVG assets against bundled SHA-256 hashes.")
    print(f"Verified approved instruction overlays, {diagram_count} diagrams and all mappings; "
          f"{len(before)} existing instructed models unchanged. {len(hashes)} models now have instructions.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, ET.ParseError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
