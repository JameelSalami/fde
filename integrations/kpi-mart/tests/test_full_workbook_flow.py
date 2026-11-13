"""FDE full 16-sheet KPI mart Excel acceptance tests (no paid/model/vendor effects)."""
from __future__ import annotations
from pathlib import Path
from hashlib import sha256
import json,sys,unittest
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/"kpi-mart"))
import full_workbook_flow as full

class FullWorkbookQualification(unittest.TestCase):
    def test_01_eight_bounded_langgraph_steps(self):
        nodes=full.graph().get_graph().nodes
        for n in ("validate_accepted_mart","independent_Haskell_replay",
                  "offline_review_questions","read_only_SQL_export",
                  "stage_run_receipt","stage_approved_Windows_snapshot",
                  "render_full_16_sheet_workbook","independent_Windows_Excel_readback"):
            self.assertIn(n,nodes)

    def test_02_invalid_run_identity_refuses_before_effect(self):
        result=full.run("../../not-a-run",windows=False)
        self.assertEqual(result["status"],"refused")
        self.assertEqual(result["error"],"validate_accepted_mart-refused")

    def test_03_invalid_prior_action_identity_fails_closed(self):
        state={"windows":True,"run_id":"valid-run-id",
               "previous_run":"../../outside"}
        with self.assertRaises(ValueError):
            full.install_windows_stage(state)
        state["previous_run"]="valid-run-id"
        with self.assertRaises(ValueError):
            full.install_windows_stage(state)

    def test_04_exec_boundary_refuses_non_SSH_and_SCP(self):
        with self.assertRaises(ValueError):
            full.execute(["python","-c","print('unexpected')"])

    def test_05_graph_carries_previous_run_identity(self):
        probe=full._full_guard("probe",lambda state:{"status":state["previous_run"]})
        self.assertEqual(probe({"previous_run":"qa-manual-actions-prev"})["status"],
                         "qa-manual-actions-prev")

    def test_06_native_accepted_workbook_receipt_matches_current_bytes(self):
        out=full.ROOT/".local/kpi-mart/runs/fde-16sheet-final-preserved-20261112-v4"
        receipt=json.loads((out/"full-excel-validation.json").read_text())
        workbook=out/full.FILENAME
        self.assertTrue(workbook.is_file())
        self.assertEqual(receipt["xlsx_sha256"],sha256(workbook.read_bytes()).hexdigest())
        self.assertEqual(receipt["status"],"software-accepted-human-review-pending")
        self.assertEqual(receipt["previous_action_run"],"qa-manual-actions-prev")
        self.assertEqual(receipt["cloud_model_calls"],0)
        self.assertEqual(receipt["source_system_writes"],0)
        excel=receipt["native_excel"]
        self.assertEqual(excel["status"],"COM_VERIFIED")
        self.assertEqual(excel["sheetCount"],16)
        self.assertEqual(excel["latestDay"],"2026-11-12")
        self.assertEqual(excel["latestClosed"],"2026-10")
        self.assertEqual(excel["currentScenario"],0.8526)
        self.assertEqual(excel["currentQc"],0.8889)
        self.assertEqual(excel["nativeMesProduced"],0)
        self.assertEqual(excel["futurePmStatus"],"blank-not-due")
        self.assertEqual(excel["externalConnections"],0)

    def test_07_repeat_id_refuses_without_overwrite(self):
        path=full.ROOT/".local/kpi-mart/runs/fde-16sheet-final-preserved-20261112-v4"/full.FILENAME
        before=sha256(path.read_bytes()).hexdigest()
        result=full.run("fde-16sheet-final-preserved-20261112-v4",windows=False)
        self.assertEqual(result["status"],"refused")
        self.assertEqual(result["error"],"read_only_SQL_export-refused")
        self.assertEqual(sha256(path.read_bytes()).hexdigest(),before)

if __name__=="__main__":
    unittest.main()
