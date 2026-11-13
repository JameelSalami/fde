"""Independent orchestration tests: accepted SQL mart -> Haskell -> Excel gate."""
from __future__ import annotations
import sys,unittest,uuid
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import mart_excel_flow as flow

class MartExcelGraph(unittest.TestCase):
    def test_01_accepted_mart_is_pinned(self):
        x=flow.validate_mart({"run_id":"valid-audit-id"})
        self.assertEqual(x["status"],"accepted-mart-validated")
        self.assertEqual(x["mart"]["rows"],2961)
        self.assertEqual(x["mart"]["as_of"],"2026-11-12")
        self.assertEqual(x["mart"]["run_id"],"fde-mart-20261113-v1")

    def test_02_haskell_replays_15_months(self):
        seed=flow.validate_mart({"run_id":"valid-haskell-check"})
        x=flow.compare_haskell(seed)
        self.assertEqual(x["status"],"persisted-KPI-reverified-by-Haskell")
        self.assertEqual(len(x["report"]["periods"]),15)
        self.assertEqual(x["report"]["periods"][-1]["periodId"],"2026-11")
        self.assertEqual(x["report"]["periods"][-1]["attainmentPercent"],"85.26")
        self.assertFalse(x["report"]["sourceWriteAllowed"])

    def test_03_review_questions_do_not_call_model(self):
        seed=flow.validate_mart({"run_id":"valid-inference-check"})
        report=flow.compare_haskell(seed)
        x=flow.questions(report)
        self.assertEqual(x["draft"]["origin"],"deterministic-human-checklist")
        self.assertEqual(x["status"],"offline-investigation-questions")
        self.assertEqual(x["draft"]["authority"],"review-only")

    def test_04_graph_finite_steps_and_refusal(self):
        graph=flow.graph().get_graph()
        for name in ("validate_accepted_mart","independently_replay_Haskell",
                     "export_postgres_views","Windows_Excel_render","refuse"):
            self.assertIn(name,graph.nodes)
        self.assertEqual(flow.route({"error":"invalid"}),"refuse")
        self.assertEqual(flow.route({"status":"fine"}),"continue")

    def test_05_invalid_identity_fails_closed(self):
        result=flow.run("../../invalid",windows=False)
        self.assertEqual(result["status"],"refused")
        self.assertIn("validate_accepted_mart",result["error"])

    def test_06_fail_closed_on_source_kernel_drift(self):
        original=flow.load.KERNEL
        try:
            flow.load.KERNEL=Path("/tmp/no-such-fde-kernel")
            with self.assertRaises(FileNotFoundError):
                flow.validate_mart({"run_id":"valid-invalid-kernel"})
        finally:
            flow.load.KERNEL=original

if __name__=="__main__":unittest.main()
