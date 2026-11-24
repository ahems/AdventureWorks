#!/usr/bin/env python3
"""Export AI-generated seed data from the deployed DAB REST API to seed-job CSVs.

Reads the selected azd environment's DAB endpoint with an admin token from
scripts/utilities/azure-auth.py (DAB audience, X-MS-API-ROLE executive-admin) and
follows DAB next links, so it works against the private-SQL deployment without
direct database access. Review the resulting git diff before committing.

Targets (default: all):
  translations           ProductModelProductDescriptionCulture-ai.csv (AI cultures)
  descriptions           ProductDescription-ai-translations.csv (AI-only descriptions)
  description-embeddings ProductDescription-ai-embeddings.csv.gz
  review-embeddings      ProductReview-ai.csv.gz (reviews with CommentsEmbedding)

Usage:
  python3 scripts/data-management/export-ai-seed-data.py [target ...]
      [--environment NAME] [--output-dir seed-job/sql]
"""
import argparse
import gzip
import json
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AUTH = REPO_ROOT / "scripts" / "utilities" / "azure-auth.py"
ROLE = "executive-admin"
PAGE_SIZE = 1000
BASE_CULTURES = {"ar", "en", "es", "fr", "he", "th", "zh-cht"}
TARGETS = ("translations", "descriptions", "description-embeddings", "review-embeddings")


class DabClient:
    def __init__(self, environment):
        env_args = ["--environment", environment] if environment else []
        api_url = subprocess.run(
            ["azd", "env", "get-value", "API_URL", "--no-prompt", *env_args],
            check=True, stdout=subprocess.PIPE, text=True).stdout.strip()
        if not api_url.startswith("https://"):
            raise SystemExit("API_URL is not an https URL in the selected azd environment.")
        self.base = api_url.rstrip("/").removesuffix("/graphql") + "/api"
        self.token = subprocess.run(
            [sys.executable, str(AUTH), "token", "--identity", "admin", "--resource", "dab", *env_args],
            check=True, stdout=subprocess.PIPE, text=True).stdout.strip()

    def rows(self, entity, select):
        query = urllib.parse.urlencode({"$first": PAGE_SIZE, "$select": ",".join(select)}, safe="$,")
        url = f"{self.base}/{entity}?{query}"
        while url:
            if urllib.parse.urlsplit(url).netloc != urllib.parse.urlsplit(self.base).netloc:
                raise SystemExit(f"Refusing to follow a next link to another host for {entity}.")
            request = urllib.request.Request(url, headers={
                "Authorization": "Bearer " + self.token,
                "X-MS-API-ROLE": ROLE,
                "Accept": "application/json",
            })
            with urllib.request.urlopen(request, timeout=180) as response:
                document = json.load(response)
            yield from document.get("value", [])
            url = document.get("nextLink")


def parse_timestamp(value):
    """Parse a DAB ISO timestamp, allowing any fractional-second precision."""
    stamp, _, fraction = value.rstrip("Z").partition(".")
    parsed = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S")
    return parsed.replace(microsecond=int((fraction + "000000")[:6]))


def sql_datetime(value):
    """DAB ISO timestamp -> SQL style 121 ('YYYY-MM-DD hh:mm:ss.mmm')."""
    parsed = parse_timestamp(value)
    return parsed.strftime("%Y-%m-%d %H:%M:%S.%f")[:23]


def iso_datetime(value):
    """DAB ISO timestamp -> 'YYYY-MM-DDThh:mm:ss.mmmZ' as used by ProductReview-ai.csv."""
    parsed = parse_timestamp(value)
    return parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:23] + "Z"


def vector(value):
    return json.dumps(value, separators=(",", ":")) if isinstance(value, list) else str(value)


def single_line(text):
    return (text or "").replace("\t", " ").replace("\r", "").replace("\n", " ")


def write(path, lines):
    data = "".join(line + "\n" for line in lines).encode("utf-8")
    if path.suffix == ".gz":
        # Deterministic gzip (no name, mtime 0) so unchanged data produces no diff.
        with open(path, "wb") as raw, gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=raw, mtime=0) as gz:
            gz.write(data)
    else:
        path.write_bytes(data)
    print(f"  wrote {len(lines)} rows to {path.relative_to(REPO_ROOT) if path.is_relative_to(REPO_ROOT) else path}")


def culture_rows(client):
    return list(client.rows("ProductModelProductDescriptionCulture",
                            ["ProductModelID", "ProductDescriptionID", "CultureID", "ModifiedDate"]))


def export_translations(client, out, cultures):
    rows = sorted((r for r in cultures if r["CultureID"].strip() not in BASE_CULTURES),
                  key=lambda r: (r["ProductModelID"], r["CultureID"].strip()))
    write(out / "ProductModelProductDescriptionCulture-ai.csv", [
        f'{r["ProductModelID"]}|{r["ProductDescriptionID"]}|{r["CultureID"].strip().ljust(6)}|{sql_datetime(r["ModifiedDate"])}'
        for r in rows])


def export_descriptions(client, out, cultures):
    base = {r["ProductDescriptionID"] for r in cultures if r["CultureID"].strip() in BASE_CULTURES}
    ai = {r["ProductDescriptionID"] for r in cultures if r["CultureID"].strip() not in BASE_CULTURES} - base
    rows = sorted((r for r in client.rows("ProductDescription", ["ProductDescriptionID", "Description", "ModifiedDate"])
                   if r["ProductDescriptionID"] in ai), key=lambda r: r["ProductDescriptionID"])
    write(out / "ProductDescription-ai-translations.csv", [
        f'{r["ProductDescriptionID"]}|{single_line(r["Description"])}|{sql_datetime(r["ModifiedDate"])}'
        for r in rows])


def export_description_embeddings(client, out):
    rows = sorted((r for r in client.rows("ProductDescription",
                                          ["ProductDescriptionID", "DescriptionEmbedding", "ModifiedDate"])
                   if r.get("DescriptionEmbedding") is not None and r.get("ProductDescriptionID")),
                  key=lambda r: r["ProductDescriptionID"])
    write(out / "ProductDescription-ai-embeddings.csv.gz",
          ["ProductDescriptionID\tDescriptionEmbedding\tModifiedDate"] + [
              f'{r["ProductDescriptionID"]}\t{vector(r["DescriptionEmbedding"])}\t{r.get("ModifiedDate") or ""}'
              for r in rows])


def export_review_embeddings(client, out):
    fields = ["ProductReviewID", "ProductID", "ReviewerName", "ReviewDate", "EmailAddress",
              "Rating", "Comments", "ModifiedDate", "CommentsEmbedding"]
    rows = sorted((r for r in client.rows("ProductReview", fields) if r.get("CommentsEmbedding") is not None),
                  key=lambda r: r["ProductReviewID"])
    lines = []
    for r in rows:
        comments = single_line(r["Comments"]).replace('"', '""')
        lines.append("\t".join([
            str(r["ProductReviewID"]), str(r["ProductID"]), r["ReviewerName"], iso_datetime(r["ReviewDate"]),
            r["EmailAddress"], str(r["Rating"]), f'"{comments}"', iso_datetime(r["ModifiedDate"]),
            vector(r["CommentsEmbedding"])]))
    write(out / "ProductReview-ai.csv.gz", lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("targets", nargs="*", metavar="target", help=" | ".join(TARGETS))
    parser.add_argument("--environment", help="azd environment; default is the selected environment")
    parser.add_argument("--output-dir", type=Path, default=REPO_ROOT / "seed-job" / "sql")
    args = parser.parse_args()
    args.targets = args.targets or list(TARGETS)
    unknown = sorted(set(args.targets) - set(TARGETS))
    if unknown:
        parser.error(f"unknown target(s): {', '.join(unknown)}")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    client = DabClient(args.environment)
    print(f"Exporting {', '.join(args.targets)} from {client.base}")
    cultures = culture_rows(client) if {"translations", "descriptions"} & set(args.targets) else []
    if "translations" in args.targets:
        export_translations(client, args.output_dir, cultures)
    if "descriptions" in args.targets:
        export_descriptions(client, args.output_dir, cultures)
    if "description-embeddings" in args.targets:
        export_description_embeddings(client, args.output_dir)
    if "review-embeddings" in args.targets:
        export_review_embeddings(client, args.output_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
