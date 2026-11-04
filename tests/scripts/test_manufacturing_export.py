import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("export", ROOT / "scripts/data-management/export-manufacturing-content.py")
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


class ManufacturingExportTests(unittest.TestCase):
    def test_merge_is_sorted_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "overlay.csv"
            path.write_text("19+|<root/> &|")
            value = export.merge_rows(path, [["5", "<root/>"], ["19", "<root/>"]], "+|", "&|", 2, (0,))
            self.assertEqual(value, "5+|<root/>&|19+|<root/>&|")
            path.write_text(value)
            self.assertEqual(export.merge_rows(path, [["19", "<root/>"]], "+|", "&|", 2, (0,)), value)

    def test_merge_rejects_conflict_and_delimiter_injection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "overlay.csv"
            path.write_text("19+|original&|")
            for row in [["19", "changed"], ["5", "bad+|field"], ["5", "bad&|row"]]:
                with self.assertRaises(ValueError):
                    export.merge_rows(path, [row], "+|", "&|", 2, (0,))

    def test_approved_export_is_bound_to_source_and_resumable(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(export.drafts, "validate_result"):
            base = Path(directory)
            repo = base / "repo"
            sql = repo / "seed-job/sql"
            sql.mkdir(parents=True)
            (sql / "ProductModel.csv").write_text("5+|Model+|+|+|uuid+|date&|")
            (sql / "Illustration.csv").write_text("3+|original+|date&|")
            run = base / "run"
            model = run / "model-5"
            model.mkdir(parents=True)
            xml = f'<root xmlns="{export.drafts.NAMESPACE}">Instructions<Location LocationID="50"><step>Check <diag>100051</diag>.</step></Location></root>'
            result = {
                "instructionsXml": xml, "sourceFingerprint": "grounding-hash",
                "grounding": {"representative": {"productId": 739}, "components": []},
                "diagramReservations": [{"illustrationId": 100051, "slot": 1, "fileName": "illustration-100051.svg"}],
                "draft": {"diagrams": [{"slot": 1, "title": "Inventory", "callouts": []}],
                          "locations": [], "assumptions": [], "variantNotes": []},
            }
            (model / "response.json").write_text(json.dumps(result))
            (model / "change-history.json").write_text(json.dumps({
                "lifecycleSource": {"ProductID": 739}, "revisions": [{"effectiveDate": "2026-11-04"}],
            }))
            manifest = {"status": "awaiting-instruction-review", "models": [{"modelId": 5, "instructionsSha256": export.digest(xml)}]}
            (run / "manifest.json").write_text(json.dumps(manifest))
            svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
            xaml = "<Viewbox/>"
            (model / "illustration-100051.svg").write_text(svg)
            (model / "illustration-100051.xaml").write_text(xaml)
            response = {"svg": svg, "xaml": xaml, "sourceFingerprint": "grounding-hash", "instructionsSha256": export.digest(xml),
                        "illustrationId": 100051, "productModelId": 5, "slot": 1}
            (model / "illustration-100051.json").write_text(json.dumps(response))
            diagram_manifest = run / "drawings.json"
            diagram_manifest.write_text(json.dumps({"status": "awaiting-diagram-review", "approvedInstructionRun": "run",
                "diagrams": [{"modelId": 5, "illustrationId": 100051, "file": "model-5/illustration-100051.svg", "svgSha256": export.digest(svg)}]}))
            export.publish(run, [5], diagram_manifest, repo)
            original = (sql / "ProductModelInstructions-ai.csv").read_bytes()
            export.publish(run, [5], diagram_manifest, repo)
            self.assertEqual(original, (sql / "ProductModelInstructions-ai.csv").read_bytes())
            (model / "illustration-100051.svg").write_text(svg + "<script/>")
            with self.assertRaisesRegex(ValueError, "reviewed source"):
                export.publish(run, [5], diagram_manifest, repo)
            self.assertEqual(original, (sql / "ProductModelInstructions-ai.csv").read_bytes())


if __name__ == "__main__":
    unittest.main()
