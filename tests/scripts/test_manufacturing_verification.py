import importlib.util
from io import BytesIO
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("verify", ROOT / "scripts/data-management/verify-manufacturing-content.py")
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class ManufacturingVerificationTests(unittest.TestCase):
    def test_instruction_comparison_accepts_typed_xml_serialization_but_not_changed_text(self):
        source = '<root xmlns="urn:instructions"><Location LaborHours="0.50" LocationID="50">Stage <step>Inspect component.</step></Location></root>'
        typed = '<i:root xmlns:i="urn:instructions">\n<i:Location LocationID="50" LaborHours=".5">Stage <i:step>Inspect component.</i:step></i:Location></i:root>'
        self.assertEqual(verify.canonical(source), verify.canonical(typed))
        self.assertNotEqual(verify.canonical(source), verify.canonical(typed.replace('Inspect', 'Discard')))

    def test_all_pages_are_read(self):
        pages = [BytesIO(json.dumps(page).encode()) for page in [
            {"value": [{"ProductModelID": 1}], "nextLink": "https://example.invalid/api/ProductModel?$after=cursor"},
            {"value": [{"ProductModelID": 101}]},
        ]]
        with patch.object(verify, "urlopen", side_effect=pages):
            self.assertEqual([r["ProductModelID"] for r in verify.read_all("https://example.invalid", "ProductModel")], [1, 101])

    def test_rejects_foreign_or_repeated_pagination_urls(self):
        for next_link in ("https://unexpected.invalid/api/ProductModel", "http://example.invalid/api/ProductModel",
                          "https://example.invalid/api/ProductModel?%24first=100"):
            page = BytesIO(json.dumps({"value": [], "nextLink": next_link}).encode())
            with patch.object(verify, "urlopen", return_value=page):
                with self.assertRaisesRegex(ValueError, "pagination"):
                    verify.read_all("https://example.invalid", "ProductModel")


if __name__ == "__main__":
    unittest.main()
