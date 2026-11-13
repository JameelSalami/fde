"""Independent Excel-first FDE workflow tests; no cloud/model/vendor calls."""
from __future__ import annotations
import csv
import json
from pathlib import Path
import tempfile
import shutil
import unittest
import uuid
from types import SimpleNamespace
from azure_model import AzureRefused,call_azure,endpoint_and_deployment,offline_draft,validate_model_reply,context_approval_digest
from budget import initialize
from kpi import Refused,intake,assess
from workflow import ROOT,run,graph

S=ROOT/"demo"/"production-shift-summary.csv"
L=ROOT/"demo"/"production-shift-losses.csv"
OUTPUT=ROOT/".local"/"operations-excel"/"outputs"

class TestPipeline(unittest.TestCase):
    def setUp(self):
        self.id="test-"+uuid.uuid4().hex[:12]
        self.addCleanup(self.cleanup)

    def cleanup(self):
        d=OUTPUT/self.id
        if d.is_dir() and not d.is_symlink():shutil.rmtree(d)

    def test_three_shift_reports_from_fde_haskell_not_python(self):
        prepared=intake(str(S),str(L),"handwritten-fixture")
        self.assertEqual(len(prepared["periods"]),3)
        report=assess(prepared)
        self.assertEqual(report["schema"],"fde.performance-report/v1")
        self.assertEqual([p["shortfallUnits"] for p in report["periods"]],["105","108","75"])
        self.assertEqual([p["attainmentPercent"] for p in report["periods"]],["88.59","88.00","91.48"])
        self.assertEqual([p["lossStatus"] for p in report["periods"]],["reconciled"]*3)
        self.assertEqual(report["periods"][-1]["pareto"][0]["id"],"changeover")

    def test_langgraph_end_to_end_prepares_excel_and_human_review(self):
        result=run(str(S),str(L),self.id,"handwritten-fixture","offline")
        self.assertEqual(result["status"],"excel-render-ready")
        self.assertEqual(result["model_status"],"not-requested")
        p=Path(result["outputs"]["performance.json"])
        manifest=json.loads(Path(result["outputs"]["manifest.json"]).read_text())
        self.assertTrue(p.exists())
        self.assertTrue(Path(result["outputs"]["loss_pareto.csv"]).exists())
        self.assertEqual(manifest["schema"],"fde.excel-automation-handoff/v1")
        self.assertFalse(manifest["cloudResourcesCreated"])
        self.assertFalse(manifest["vendorWritePerformed"])
        self.assertEqual(manifest["status"],"excel-render-ready")
        self.assertEqual(manifest["sha256"]["performance.json"],
                         __import__("hashlib").sha256(p.read_bytes()).hexdigest())
        self.assertIn("calculate_with_fde_haskell",graph().get_graph().nodes)

    def test_output_run_cannot_be_reused(self):
        self.assertEqual(run(str(S),str(L),self.id)["status"],"excel-render-ready")
        self.assertEqual(run(str(S),str(L),self.id)["status"],"refused")

    def test_invalid_run_id_refuses(self):
        self.assertEqual(run(str(S),str(L),"../go")["status"],"refused")

    def test_duplicate_shift_input_refuses(self):
        with tempfile.TemporaryDirectory() as t:
            target=Path(t)/"summary.csv"
            original=S.read_text()
            target.write_text(original+original.splitlines()[1]+"\n")
            with self.assertRaisesRegex(Refused,"duplicate-period-line"):
                intake(str(target),str(L),"handwritten-fixture")

    def test_duplicate_loss_reason_refuses(self):
        with tempfile.TemporaryDirectory() as t:
            target=Path(t)/"loss.csv"
            original=L.read_text()
            target.write_text(original+original.splitlines()[1]+"\n")
            with self.assertRaisesRegex(Refused,"duplicate-loss-category"):
                intake(str(S),str(target),"handwritten-fixture")

    def test_wrong_source_class_refuses(self):
        with self.assertRaises(Refused):
            intake(str(S),str(L),"live-certified-plant")

    def test_non_numeric_export_refuses(self):
        with tempfile.TemporaryDirectory() as t:
            target=Path(t)/"summary.csv"
            target.write_text(S.read_text().replace(",920,815",",=HYPERLINK(1),815"))
            with self.assertRaisesRegex(Refused,"invalid-nonnegative-count"):
                intake(str(target),str(L),"handwritten-fixture")

    def test_model_disabled_and_unconfigured_produces_no_live_call(self):
        report=assess(intake(str(S),str(L),"handwritten-fixture"))
        with self.assertRaisesRegex(AzureRefused,"explicit-enabled-flag"):
            call_azure(report,env={})
        with self.assertRaisesRegex(AzureRefused,"not-configured"):
            call_azure(report,env={"FDE_AZURE_MODEL_CALL_APPROVED":"1"})

    def test_model_endpoint_must_be_real_azure_https(self):
        for bad in ("http://fake.openai.azure.com",
                    "https://evil.example.com",
                    "https://fake.openai.azure.com/evil",
                    "https://fake.openai.azure.com@other.com"):
            with self.assertRaises(AzureRefused):
                endpoint_and_deployment({"AZURE_OPENAI_ENDPOINT":bad,
                                        "AZURE_OPENAI_DEPLOYMENT":"test-model"})

    def test_fake_azure_responses_api_is_validated(self):
        report=assess(intake(str(S),str(L),"synthetic-worksheet"))
        class Fake:
            def __init__(self):
                self.responses=self
            def create(self,**kw):
                self.kw=kw
                return SimpleNamespace(output_text=json.dumps({
                    "focusPeriod":"2026-11-12-S1",
                    "questionIds":["inspect-highest-loss-category","verify-shift-boundary"],
                    "rationale":"Investigate the leading categorized loss before proposing a trial."}))
        fake=Fake()
        with tempfile.TemporaryDirectory(prefix="fde-azure-budget-test-") as t:
            env={
                "FDE_AZURE_MODEL_CALL_APPROVED":"1",
                "FDE_AZURE_MODEL_ID":"gpt-4.1-mini",
                "FDE_AZURE_BUDGET_DB":str(Path(t)/"azure-budget.sqlite"),
                "AZURE_OPENAI_ENDPOINT":"https://fixture.openai.azure.com",
                "AZURE_OPENAI_DEPLOYMENT":"test-model",
                "FDE_AZURE_APPROVED_CONTEXT_SHA256":context_approval_digest(report)}
            initialize(env,test_mode=True)
            result=call_azure(report,env=env,client_factory=lambda **kw:fake)
        self.assertEqual(result["origin"],"azure-openai-model-draft")
        self.assertEqual(result["focusPeriod"],"2026-11-12-S1")
        self.assertEqual(fake.kw["model"],"test-model")
        self.assertEqual(fake.kw["max_output_tokens"],320)
        self.assertFalse(fake.kw["store"])

    def test_azure_refuses_non_synthetic_export(self):
        manual=assess(intake(str(S),str(L),"manual-export"))
        with self.assertRaisesRegex(AzureRefused,"non-synthetic"):
            call_azure(manual,env={
              "FDE_AZURE_MODEL_CALL_APPROVED":"1",
              "AZURE_OPENAI_ENDPOINT":"https://fixture.openai.azure.com",
              "AZURE_OPENAI_DEPLOYMENT":"test-model"})

    def test_fake_model_must_choose_admitted_questions(self):
        for bad in (
            {"focusPeriod":"unrelated","questionIds":["verify-shift-boundary"],"rationale":"This is a cautious question."},
            {"focusPeriod":"2026-11-12-S1","questionIds":["execute-erp-posting"],"rationale":"This is a cautious question."},
            {"focusPeriod":"2026-11-12-S1","questionIds":["verify-shift-boundary"],"rationale":"Guaranteed savings of 50 units."}
        ):
            with self.assertRaises(AzureRefused):
                validate_model_reply(bad,{"2026-11-12-S1"})

if __name__=="__main__":unittest.main()
