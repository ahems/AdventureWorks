#!/usr/bin/env python3
"""Rebuild local review HTML and dated fictional revision histories using live product lifecycle dates."""

import argparse
from datetime import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlencode
from urllib.request import urlopen
from urllib.error import URLError

spec = importlib.util.spec_from_file_location("drafts", Path(__file__).with_name("generate-manufacturing-drafts.py"))
drafts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drafts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    args = parser.parse_args()
    endpoint = os.environ.get("API_URL", "").rstrip("/")
    if not endpoint.startswith("https://"):
        parser.error("Set API_URL to the deployed HTTPS DAB service base URL.")
    manifest = json.loads((args.run / "manifest.json").read_text())
    current_date = datetime.now().astimezone().date()
    pending = []
    for model in manifest["models"]:
        directory = args.run / f'model-{model["modelId"]}'
        result = json.loads((directory / "response.json").read_text())
        product_id = result["grounding"]["representative"]["productId"]
        query = urlencode({"$filter": f"ProductID eq {product_id}",
                           "$select": "ProductID,Name,SellStartDate,SellEndDate,DiscontinuedDate,ModifiedDate", "$first": 2})
        with urlopen(f"{endpoint}/api/Product?{query}", timeout=120) as response:
            products = json.load(response)
        if len(products["value"]) != 1 or products.get("nextLink"):
            raise ValueError(f"Expected exactly one lifecycle record for product {product_id}.")
        history = drafts.create_change_history(result, products["value"][0], current_date)
        images = {}
        preview = directory / "instructions-diagrams.html"
        if preview.exists():
            import html
            import re
            for name in re.findall(r'<img src="([^"]+)"', preview.read_text()):
                path = Path(html.unescape(name))
                match = re.fullmatch(r"illustration-(\d+)\.svg", path.name)
                if path.is_absolute() or ".." in path.parts or not match or not (directory / path).is_file():
                    raise ValueError("The previous preview contains an invalid illustration asset path.")
                images[int(match.group(1))] = str(path)
        pending.append((directory, result, history, images))
    for directory, result, history, images in pending:
        drafts.write_atomic(directory / "change-history.json", drafts.json_text(history))
        drafts.write_atomic(directory / "instructions.html", drafts.render_preview(result, change_history=history))
        if images:
            drafts.write_atomic(directory / "instructions-diagrams.html", drafts.render_preview(result, images, history))
        print(f'{history["documentNumber"]}: {len(history["revisions"])} revisions, '
              f'{history["revisions"][0]["effectiveDate"]} to {history["revisions"][-1]["effectiveDate"]}')


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, URLError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
