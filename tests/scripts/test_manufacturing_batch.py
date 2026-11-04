import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("batch", ROOT / "scripts/data-management/populate-manufacturing-content.py")
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)


class FakeInventoryApi:
    def read(self, entity, select=None):
        return {
            "ProductModel": [{"ProductModelID": i, "Name": f"Model {i}", "Instructions": "<root/>" if i == 1 else None}
                             for i in range(1, 7)],
            "Product": [{"ProductID": i, "ProductModelID": i, "MakeFlag": i != 2} for i in range(1, 7)],
            "BillOfMaterials": [{"ProductAssemblyID": i, "ComponentID": 100, "StartDate": "2023-01-01", "EndDate": end}
                                for i, end in [(3, None), (4, None), (5, "2024-01-01")]],
            "ProductModelProductDescriptionCulture": [{"ProductModelID": i, "CultureID": "en ", "ProductDescriptionID": 10}
                                                     for i in (3, 5, 6)],
            "ProductDescription": [{"ProductDescriptionID": 10, "Description": "Actual English description."}],
            "Illustration": [],
            "ProductModelIllustration": [],
        }[entity]


class ManufacturingBatchTests(unittest.TestCase):
    def test_inventory_preserves_originals_and_reports_each_ineligible_reason(self):
        with patch.object(batch.verify, "instruction_hashes", return_value={"1": "hash"}):
            rows, products, before = batch.inventory(FakeInventoryApi(), "2026-11-04")
        self.assertEqual(len(products), 6)
        self.assertEqual(before, {"1": "hash"})
        self.assertEqual([r["modelId"] for r in rows if r["status"] == "eligible"], [3])
        self.assertEqual(rows[0]["status"], "existing-instructions")
        self.assertIn("No manufactured", rows[1]["reason"])
        self.assertIn("English", rows[3]["reason"])
        self.assertIn("effective bill", rows[4]["reason"])
        self.assertIn("effective bill", rows[5]["reason"])

    def test_supplements_are_opt_in_and_only_selected_for_manufactured_originals_without_diagrams(self):
        api = FakeInventoryApi()
        with patch.object(batch.verify, "instruction_hashes", return_value={"1": "hash"}):
            normal, _, _ = batch.inventory(api, "2026-11-04")
            supplements, _, _ = batch.inventory(api, "2026-11-04", supplement_originals=True)
        self.assertEqual(normal[0]["status"], "existing-instructions")
        self.assertEqual(supplements[0]["status"], "eligible-supplement")

    def test_existing_supplemental_mappings_prevent_another_generation_batch(self):
        api = FakeInventoryApi()
        original_read = api.read
        def read(entity, select=None):
            if entity == "Illustration":
                return [{"IllustrationID": 100011}]
            if entity == "ProductModelIllustration":
                return [{"ProductModelID": 1, "IllustrationID": 100011}]
            return original_read(entity, select)
        with patch.object(api, "read", side_effect=read), patch.object(batch.verify, "instruction_hashes", return_value={"1": "hash"}):
            rows, _, _ = batch.inventory(api, "2026-11-04", supplement_originals=True)
        self.assertEqual(rows[0]["status"], "existing-instructions")

    def test_resume_rejects_modified_saved_instruction_before_api_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root / "model-5-run"
            model = run / "model-5"
            model.mkdir(parents=True)
            (model / "response.json").write_text(json.dumps({"instructionsXml": "<changed/>"}))
            (run / "manifest.json").write_text(json.dumps({"models": [{"instructionsSha256": "wrong"}]}))
            with patch.object(batch.drafts, "validate_result"):
                with self.assertRaisesRegex(ValueError, "hash changed"):
                    batch.process_model(None, root, {"modelId": 5, "status": "eligible"}, {}, False)

    def test_offline_assets_validate_referential_integrity_even_before_full_coverage(self):
        validator = batch.load("assets", "validate-manufacturing-assets.py")
        report = validator.validate(require_full=False)
        self.assertEqual(report["manufacturedModels"], 61)
        self.assertGreaterEqual(report["generatedModels"], 3)
        self.assertGreaterEqual(report["generatedDiagrams"], 4)


if __name__ == "__main__":
    unittest.main()
