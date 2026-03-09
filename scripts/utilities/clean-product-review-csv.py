#!/usr/bin/env python3
"""
Clean ProductReview.csv for seed-job import:
- Parse multi-line rows (Comments contain newlines)
- Normalize Comments: replace newlines with space, strip
- Encode Comments as UTF-16 LE hex (matches seed-job HexColumns=@('Comments'))
- Output tab-delimited, one row per record
"""
import re
import sys
from pathlib import Path

def parse_records(content: str) -> list[dict]:
    # Split into record blocks: each record starts with newline + digits + tab + digits + tab
    blocks = re.split(r"\n(?=\d+\t\d+\t)", content.strip())
    records = []
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        lines = block.split("\n")
        first_parts = lines[0].split("\t")
        if len(first_parts) < 6:
            continue
        product_review_id = first_parts[0]
        product_id = first_parts[1]
        reviewer_name = first_parts[2]
        review_date = first_parts[3]
        email_address = first_parts[4]
        rating = first_parts[5]
        # Comment runs from 7th field of first line to the last tab+date in the block
        # Find last occurrence of tab followed by date (YYYY-MM-DD ...)
        date_match = list(re.finditer(r"\t(\d{4}-\d{2}-\d{2}\s[\d.:]+)", block))
        if not date_match:
            continue
        mod_date = date_match[-1].group(1).strip()
        # Comment: from after 6th tab on first line to start of that last tab+date
        comment_end_match = date_match[-1]
        comment_start = len("\t".join(first_parts[:6])) + 1  # +1 for the tab after 6th field
        comment_end = comment_end_match.start()
        comment_text = block[comment_start:comment_end]
        # Normalize: newlines and multiple spaces -> single space, strip
        comment_text = " ".join(comment_text.split()).strip()
        records.append({
            "ProductReviewID": product_review_id,
            "ProductID": product_id,
            "ReviewerName": reviewer_name,
            "ReviewDate": review_date,
            "EmailAddress": email_address,
            "Rating": rating,
            "Comments": comment_text,
            "ModifiedDate": mod_date,
        })
    return records


def text_to_utf16_hex(s: str) -> str:
    """Encode string as UTF-16 LE hex (no BOM), matching seed-job HexColumns expectation."""
    data = s.encode("utf-16-le")
    return data.hex().upper()


def main():
    repo_root = Path(__file__).resolve().parents[2]
    csv_path = repo_root / "seed-job" / "sql" / "ProductReview.csv"
    if not csv_path.exists():
        print(f"Error: {csv_path} not found", file=sys.stderr)
        sys.exit(1)
    content = csv_path.read_text(encoding="utf-8")
    records = parse_records(content)
    if not records:
        print("Error: no records parsed", file=sys.stderr)
        sys.exit(1)
    # Build output: tab-delimited, Comments as hex, trailing two empty columns to match original
    out_lines = []
    for r in records:
        comments_hex = text_to_utf16_hex(r["Comments"])
        row = [
            r["ProductReviewID"],
            r["ProductID"],
            r["ReviewerName"],
            r["ReviewDate"],
            r["EmailAddress"],
            r["Rating"],
            comments_hex,
            r["ModifiedDate"],
            "",
            "",
        ]
        out_lines.append("\t".join(row))
    out_text = "\n".join(out_lines) + "\n"
    csv_path.write_text(out_text, encoding="utf-8")
    print(f"Cleaned {len(records)} records; Comments encoded as UTF-16 LE hex, newlines removed.")
    print(f"Written to {csv_path}")


if __name__ == "__main__":
    main()
