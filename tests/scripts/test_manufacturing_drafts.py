import importlib.util
from io import BytesIO
import json
from datetime import date
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("drafts", ROOT / "scripts/data-management/generate-manufacturing-drafts.py")
drafts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drafts)


class ManufacturingDraftPreviewTests(unittest.TestCase):
    def result(self):
        return {
            "status": "draft-awaiting-instruction-review",
            "grounding": {"model": {"productModelId": 59, "name": "<script>Headset</script>", "instructions": None},
                          "representative": {"productId": 805, "name": "Headset"},
                          "components": [{"parentProductId": 805, "productId": 4, "name": "Bearings",
                                          "productNumber": "BE-1", "quantity": 8, "unit": "EA"}],
                          "workCenters": [{"locationId": 50, "name": "Subassembly"}], "asOfUtc": "2026-11-04"},
            "draft": {"assumptions": ["demo"], "variantNotes": ["one variant"],
                      "diagrams": [{"slot": 1, "title": "<script>alert(1)</script>", "purpose": "Purpose",
                                    "composition": "Composition", "callouts": [{"number": 1, "productId": 4}]}]},
            "diagramReservations": [{"slot": 1, "illustrationId": 100591, "fileName": "illustration-100591.svg"}],
            "instructionsXml": f'<root xmlns="{drafts.NAMESPACE}">Overview<Location LocationID="50">'
                               'Center<step>Stage <material>Bearings</material>. See <diag>100591</diag>.</step>'
                               '</Location></root>', "sourceFingerprint": "test", "agentId": "test",
        }

    def test_reads_all_original_documents_with_matching_step_counts(self):
        source = (ROOT / "seed-job/sql/ProductModel.csv").read_text()
        count = 0
        for record in source.split("&|"):
            if not record.strip():
                continue
            fields = record.strip().split("+|")
            if not fields[3].strip():
                continue
            root = drafts.ET.fromstring(fields[3])
            refs = sorted({int(d.text) for d in root.iter(f"{{{drafts.NAMESPACE}}}diag")})
            result = {
                "grounding": {"model": {"name": fields[1], "productModelId": int(fields[0])},
                              "representative": {"productId": 1, "name": fields[1]}, "components": [],
                              "workCenters": [{"locationId": int(c.attrib["LocationID"]), "name": "Actual center"} for c in root],
                              "asOfUtc": "2026-11-04"},
                "draft": {"assumptions": ["demo"], "variantNotes": ["variants"],
                          "diagrams": [{"slot": i + 1, "title": f"Figure {r}", "purpose": "Purpose",
                                        "composition": "Composition", "callouts": []} for i, r in enumerate(refs)]},
                "diagramReservations": [{"slot": i + 1, "illustrationId": r} for i, r in enumerate(refs)],
                "instructionsXml": fields[3], "sourceFingerprint": "test", "agentId": "test",
            }
            preview = drafts.render_preview(result)
            self.assertEqual(preview.count("<li><p>"), len(list(root.iter(f"{{{drafts.NAMESPACE}}}step"))))
            if refs:
                self.assertIn("Diagram not generated yet", preview)
            count += 1
        self.assertEqual(count, 9)

    def test_atomic_output_and_html_escaping(self):
        self.assertEqual(drafts.escape('<script>"&'), "&lt;script&gt;&quot;&amp;")
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "preview.html"
            drafts.write_atomic(target, "example")
            self.assertEqual(target.read_text(), "example")
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_disallows_wrong_model_response(self):
        with self.assertRaises(ValueError):
            drafts.validate_result({"status": "draft-awaiting-instruction-review", "grounding": {"model": {"productModelId": 5}}}, 19)

    def test_accepts_null_original_instructions_and_escapes_generated_content(self):
        result = self.result()
        drafts.validate_result(result, 59)
        rendered = drafts.render_preview(result)
        self.assertNotIn("<script>", rendered)
        self.assertIn("&lt;script&gt;", rendered)
        self.assertIn('href="#figure-50-0-100591"', rendered)

    def test_existing_instructions_require_explicit_supplemental_validation(self):
        result = self.result()
        original = f'<root xmlns="{drafts.NAMESPACE}">Original operations.</root>'
        result["grounding"]["model"]["instructions"] = original
        with self.assertRaisesRegex(ValueError, "replace existing"):
            drafts.validate_result(result, 59)
        drafts.validate_result(result, 59, allow_existing=True)
        self.assertEqual(result["grounding"]["model"]["instructions"], original)

    def test_brands_documents_and_omits_disclaimers_and_standalone_creation_date(self):
        result = self.result()
        result["grounding"]["asOfUtc"] = "2026-11-04T15:08:49.9127303Z"
        result["instructionsXml"] = result["instructionsXml"].replace("Overview", drafts.DISCLAIMER + " Overview")
        result["draft"]["assumptions"] = [
            "This is a fictional demonstration, not engineering advice.",
            "Routing is inferred. All times are fictional demo estimates.",
            "The source does not specify the component mating order.",
        ]
        preview = drafts.render_preview(result, {100591: "illustration-100591.svg"})
        self.assertIn("Adventure<span>Works</span>", preview)
        self.assertIn("Manufacturing Hub", preview)
        self.assertNotIn("fictional", preview)
        self.assertNotIn("Not validated engineering", preview)
        self.assertIn("Routing is inferred.", preview)
        self.assertIn("The source does not specify the component mating order.", preview)
        self.assertEqual(preview.count("<img "), 1)
        self.assertNotIn("Created", preview.split("</header>")[0])
        self.assertNotIn("Created", preview)
        self.assertNotIn("<h2>Provenance</h2>", preview)
        self.assertNotIn("Source fingerprint:", preview)

    def test_revision_history_is_varied_grounded_and_ends_on_current_date(self):
        counts = []
        for model_id in (19, 5, 59):
            result = self.result()
            result["grounding"]["model"]["productModelId"] = model_id
            lifecycle = {"ProductID": 805, "SellStartDate": "2023-06-10T00:00:00",
                         "SellEndDate": "2024-06-08T00:00:00", "ModifiedDate": "2026-02-18T10:01:36.827"}
            history = drafts.create_change_history(result, lifecycle, date(2026, 11, 4))
            self.assertEqual(history, drafts.create_change_history(result, lifecycle, date(2026, 11, 4)))
            revisions = history["revisions"]
            counts.append(len(revisions))
            dates = [r["effectiveDate"] for r in revisions]
            self.assertEqual(dates, sorted(set(dates)))
            self.assertEqual(dates[0], "2023-06-10")
            self.assertEqual(dates[-1], "2026-11-04")
            self.assertEqual(history["lifecycleSource"], lifecycle)
            preview = drafts.render_preview(result, change_history=history)
            self.assertIn("Document change management history", preview)
            self.assertIn("2026-11-04", preview)
            self.assertNotIn("Created", preview)
            self.assertLess(preview.index('id="change-history"'), preview.index("<footer>"))
        self.assertEqual(counts, [2, 6, 4])

    def test_history_rejects_mismatched_or_future_lifecycle_data(self):
        for product in ({"ProductID": 999, "SellStartDate": "2023-01-01"},
                        {"ProductID": 805, "SellStartDate": "2027-01-01"}):
            with self.assertRaises(ValueError):
                drafts.create_change_history(self.result(), product, date(2026, 11, 4))

    def test_figures_show_operations_not_image_generation_prompts(self):
        result = self.result()
        result["draft"]["diagrams"][0]["purpose"] = "Explain how the bearings are staged."
        result["draft"]["diagrams"][0]["composition"] = "Draw eight spheres on a white background."
        preview = drafts.render_preview(result, {100591: "illustration-100591.svg"})
        self.assertNotIn("Explain how", preview)
        self.assertNotIn("Draw eight spheres", preview)
        self.assertIn("<h4>Operation guidance</h4><p>Stage Bearings.</p>", preview)
        self.assertIn("1: Bearings (BE-1)", preview)

    def test_rejects_mismatched_reservations_and_existing_instructions(self):
        for field in ("fileName", "illustrationId"):
            result = self.result()
            result["diagramReservations"][0][field] = "invalid"
            with self.assertRaises(ValueError):
                drafts.validate_result(result, 59)
        result = self.result()
        result["grounding"]["model"]["instructions"] = "<root/>"
        with self.assertRaises(ValueError):
            drafts.validate_result(result, 59)

    def test_rejects_unsafe_xml_and_missing_diagram_reference(self):
        for xml in ('<!DOCTYPE root><root/>', '<root/>',
                    self.result()["instructionsXml"].replace("100591", "999")):
            result = self.result()
            result["instructionsXml"] = xml
            with self.assertRaises(ValueError):
                drafts.render_preview(result)

    def test_saves_complete_review_bundle_and_detects_manifest_collisions(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            run = output / "first"
            run.mkdir()
            saved = drafts.save_result(run, self.result(), 59)
            drafts.write_index(run, {"status": "awaiting-instruction-review", "models": [saved]})
            self.assertEqual(len(list((run / "model-59").iterdir())), 6)
            self.assertEqual(drafts.load_reservation_owners(output), {100591: 59})
            (output / "second").mkdir()
            saved["modelId"] = 5
            (output / "second/manifest.json").write_text(json.dumps({"models": [saved]}))
            with self.assertRaises(ValueError):
                drafts.load_reservation_owners(output)

    def test_http_failure_preserves_a_failed_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(drafts.os.environ, {"API_FUNCTIONS_URL": "https://example.invalid", "FUNCTIONS_ACCESS_TOKEN": "test"}), \
                 patch("sys.argv", ["drafts", "--models", "59", "--output", directory]), \
                 patch.object(drafts, "urlopen", side_effect=drafts.HTTPError("url", 503, "Unavailable", {}, BytesIO(b"Unavailable"))):
                with self.assertRaises(RuntimeError):
                    drafts.main()
            manifest = json.loads(next(Path(directory).glob("*/manifest.json")).read_text())
            self.assertEqual(manifest["status"], "failed")
            self.assertIn("HTTP 503", manifest["error"])
            self.assertEqual(manifest["models"], [])

    def test_resume_keeps_existing_reviewed_model_without_another_model_call(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            run = output / "run"
            run.mkdir()
            saved = drafts.save_result(run, self.result(), 59)
            drafts.write_index(run, {"status": "failed", "requestedModels": [59], "models": [saved]})
            original = (run / "model-59/response.json").read_bytes()
            with patch.dict(drafts.os.environ, {"API_FUNCTIONS_URL": "https://example.invalid", "FUNCTIONS_ACCESS_TOKEN": "test"}), \
                 patch("sys.argv", ["drafts", "--resume", str(run), "--output", str(output)]), \
                 patch.object(drafts, "urlopen") as request:
                drafts.main()
                request.assert_not_called()
            self.assertEqual(original, (run / "model-59/response.json").read_bytes())
            self.assertEqual(json.loads((run / "manifest.json").read_text())["status"], "awaiting-instruction-review")


if __name__ == "__main__":
    unittest.main()
