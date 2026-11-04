import hashlib
import importlib.util
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import test_manufacturing_drafts as fixtures

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("diagrams", ROOT / "scripts/data-management/generate-manufacturing-diagrams.py")
diagrams = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagrams)


class ManufacturingDiagramExportTests(unittest.TestCase):
    def approved(self):
        return fixtures.ManufacturingDraftPreviewTests().result()

    def response(self, approved):
        return {"status": "draft-awaiting-diagram-review", "productModelId": 59, "slot": 1,
                "illustrationId": 100591, "fileName": "illustration-100591.svg",
                "sourceFingerprint": approved["sourceFingerprint"],
                "instructionsSha256": hashlib.sha256(approved["instructionsXml"].encode()).hexdigest(),
                "responseId": "response-diagram",
                "svg": '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0,0 L 10,10"/></svg>',
                "xaml": '<Viewbox xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"/>',
                "callouts": [{"number": 1, "x": 60, "y": 60}]}

    def test_accepts_matching_diagram_and_escapes_preview_image_attributes(self):
        approved = self.approved()
        diagrams.validate_diagram(self.response(approved), approved, 1)
        preview = diagrams.drafts.render_preview(approved, {100591: 'diagram-attempts/test/illustration-100591.svg'})
        self.assertIn('<img src="diagram-attempts/test/illustration-100591.svg"', preview)
        self.assertNotIn("<script>", preview)
        self.assertIn("Adventure<span>Works</span>", preview)

    def test_rejects_mismatched_response_bindings(self):
        approved = self.approved()
        for field in ("status", "productModelId", "slot", "illustrationId", "fileName", "sourceFingerprint", "instructionsSha256"):
            result = self.response(approved)
            result[field] = "wrong"
            with self.assertRaises(ValueError):
                diagrams.validate_diagram(result, approved, 1)

    def test_rejects_unsafe_svg_and_wrong_callouts(self):
        approved = self.approved()
        for svg in ('<!DOCTYPE svg><svg/>', '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
                    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
                    '<svg xmlns="http://www.w3.org/2000/svg"><g href="https://example.invalid"/></svg>'):
            result = self.response(approved)
            result["svg"] = svg
            with self.assertRaises(ValueError):
                diagrams.validate_diagram(result, approved, 1)
        result = self.response(approved)
        result["callouts"] = []
        with self.assertRaises(ValueError):
            diagrams.validate_diagram(result, approved, 1)

    def run_cli(self, directory, failure=False):
        run = Path(directory)
        approved = self.approved()
        model = diagrams.drafts.save_result(run, approved, 59)
        diagrams.drafts.write_index(run, {"status": "awaiting-instruction-review", "models": [model]})
        original = (run / "model-59/instructions.html").read_bytes()
        response = self.response(approved)
        mock = {"side_effect": diagrams.HTTPError("url", 503, "Unavailable", {}, BytesIO(b"Unavailable"))} if failure else {
            "return_value": BytesIO(json.dumps(response).encode())}
        with patch.dict(diagrams.os.environ, {"API_FUNCTIONS_URL": "https://example.invalid", "FUNCTIONS_ACCESS_TOKEN": "test"}), \
             patch("sys.argv", ["diagrams", "--run", str(run), "--approved-instructions", "--models", "59"]), \
             patch.object(diagrams, "urlopen", **mock):
            if failure:
                with self.assertRaises(RuntimeError):
                    diagrams.main()
            else:
                diagrams.main()
        self.assertEqual((run / "model-59/instructions.html").read_bytes(), original)
        return json.loads(next(run.glob("diagram-attempts/*/manifest.json")).read_text())

    def test_exports_xaml_svg_and_review_page_without_changing_originals(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self.run_cli(directory)
            self.assertEqual(manifest["status"], "awaiting-diagram-review")
            run = Path(directory)
            self.assertEqual(len(list(run.glob("model-59/diagram-attempts/*/*"))), 3)
            self.assertTrue((run / "diagrams.html").exists())
            self.assertIn("<img", (run / "model-59/instructions-diagrams.html").read_text())

    def test_failed_attempt_is_recorded_without_publishing_a_review_index(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self.run_cli(directory, failure=True)
            self.assertEqual(manifest["status"], "failed")
            self.assertIn("HTTP 503", manifest["error"])
            self.assertFalse((Path(directory) / "diagrams.html").exists())


if __name__ == "__main__":
    unittest.main()
