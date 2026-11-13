"""Independent FDE workbook contract tests; all inputs synthetic and disposable."""
from __future__ import annotations
from pathlib import Path
from zipfile import ZipFile
import copy
import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

from engine import Refused, _safe_text, admitted_rows, write_xlsx, reopen_and_verify
from workflow import run, make_graph
import workflow as wf

ROOT = Path(__file__).resolve().parents[3]
BRIDGE = ROOT/"bin"/"fde-workbook-source.mjs"
DEMO = ROOT/"demo"/"workbook-fixture.mjs"

class WorkbookContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="fde-new-workbook-test-")
        cls.path = Path(cls.temp.name)/"admitted-fixture.json"
        made = subprocess.run(["node", str(DEMO)], cwd=ROOT, capture_output=True, text=True, timeout=25)
        if made.returncode:
            raise RuntimeError("first-party FDE source fixture did not admit")
        cls.path.write_text(made.stdout)
        cls.connected = json.loads(made.stdout)
        bridge = subprocess.run(["node", str(BRIDGE), str(cls.path)], cwd=ROOT,capture_output=True,text=True,timeout=25)
        if bridge.returncode:
            raise RuntimeError("first-party FDE workbook source bridge refused valid fixture")
        cls.admitted = json.loads(bridge.stdout)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.run_id="contract-"+uuid.uuid4().hex[:16]

    def clean(self):
        folder=ROOT/".local"/"workbook-agent"/"outputs"/self.run_id
        if folder.is_dir() and not folder.is_symlink():
            shutil.rmtree(folder)

    def _tampered_case(self, change):
        payload=copy.deepcopy(self.connected)
        change(payload)
        filename=Path(self.temp.name)/(uuid.uuid4().hex+".json")
        filename.write_text(json.dumps(payload))
        self.addCleanup(lambda:filename.unlink(missing_ok=True))
        return filename

    def test_positive_graph_generates_independently_reopened_xlsx(self):
        try:
            result=run(str(self.path),self.run_id)
            self.assertEqual(result["status"],"pending-human-review")
            workbook=Path(result["workbook"])
            manifest=json.loads(Path(result["manifest"]).read_text())
            rows=admitted_rows(self.admitted)
            verified=reopen_and_verify(workbook,rows)
            self.assertEqual(verified["byteSha256"],manifest["workbookSha256"])
            self.assertEqual(manifest["sourceInputSha256"],hashlib.sha256(self.path.read_bytes()).hexdigest())
            self.assertEqual(manifest["humanReview"],"pending")
            self.assertFalse(manifest["cloudCallPerformed"])
            self.assertFalse(manifest["vendorReadPerformed"])
            self.assertFalse(manifest["sourceWriteAllowed"])
            self.assertIn("ERP Evidence",manifest["workbookSheets"])
            self.assertEqual(rows["FDE Findings"][2][1],self.admitted["diagnostic"]["plannedDelta"])
            self.assertEqual(rows["FDE Findings"][3][1],self.admitted["diagnostic"]["reportedDelta"])
            self.assertEqual(rows["FDE Findings"][3][1],"1.75")
            self.assertIn("not-covered",str(rows["ERP Evidence"]))
        finally:self.clean()

    def test_graph_has_explicit_review_and_refusal_nodes(self):
        graph=make_graph().get_graph()
        self.assertIn("human_handoff",graph.nodes)
        self.assertIn("refuse",graph.nodes)
        self.assertIn("independent_readback",graph.nodes)

    def test_node_rejects_tampered_saved_compiled_diagnostic(self):
        filename=self._tampered_case(lambda x:x["diagnostic"].__setitem__("reportedDelta","999999.0"))
        p=subprocess.run(["node",str(BRIDGE),str(filename)],cwd=ROOT,capture_output=True,timeout=25)
        self.assertEqual(p.returncode,2)
        self.assertFalse(p.stdout)

    def test_node_refuses_missing_mes_witness(self):
        filename=self._tampered_case(lambda x:x["sources"].pop("mes"))
        self.assertEqual(run(str(filename),self.run_id)["status"],"refused")
        self.assertFalse((ROOT/".local"/"workbook-agent"/"outputs"/self.run_id).exists())

    def test_node_refuses_forged_physical_coverage(self):
        filename=self._tampered_case(lambda x:x["sources"]["erp"]["coverage"].__setitem__("physical","proved"))
        p=subprocess.run(["node",str(BRIDGE),str(filename)],cwd=ROOT,capture_output=True,timeout=25)
        self.assertEqual(p.returncode,2)

    def test_node_refuses_wrong_binding(self):
        filename=self._tampered_case(lambda x:x["binding"]["mes"].__setitem__("nativeId","foreign-mes"))
        self.assertEqual(run(str(filename),self.run_id)["status"],"refused")

    def test_source_gate_does_not_accept_fake_second_source_id(self):
        bad=copy.deepcopy(self.admitted)
        bad["modelContextSourceIds"][1]=bad["modelContextSourceIds"][0]
        with self.assertRaisesRegex(Refused,"cross-source-identity-refused"):
            admitted_rows(bad)

    def test_missing_source_role_refused_in_renderer(self):
        bad=copy.deepcopy(self.admitted)
        bad["nativePair"]["sources"]["mes"]["presence"]="missing"
        with self.assertRaises(Refused):admitted_rows(bad)

    def test_formula_copy_paste_injection_is_escaped(self):
        for value in ("=HYPERLINK(1)"," +SUM(1,2)","-2+2","@SUM(1)"):
            escaped=_safe_text(value)
            self.assertEqual(escaped[0],"'")
        clean=_safe_text("ordinary analyst note")
        self.assertEqual(clean,"ordinary analyst note")

    def test_workbook_contains_no_formulas_or_external_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/"probe.xlsx"
            rows=admitted_rows(self.admitted)
            write_xlsx(rows,file)
            with ZipFile(file) as z:
                self.assertFalse(any("externalLink" in n or "vbaProject" in n for n in z.namelist()))
                self.assertFalse(any(b"<f>" in z.read(x) for x in z.namelist() if x.startswith("xl/worksheets/")))
            self.assertEqual(reopen_and_verify(file,rows)["readback"],"exact-local-xml")

    def test_wrong_expected_cells_refused_by_independent_readback(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/"probe.xlsx"
            correct=admitted_rows(self.admitted)
            write_xlsx(correct,file)
            wrong=copy.deepcopy(correct)
            wrong["FDE Findings"][3][1]="777777.0"
            with self.assertRaisesRegex(Refused,"xlsx-independent-readback-mismatch"):
                reopen_and_verify(file,wrong)

    def test_corrupt_xlsx_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/"broken.xlsx"
            file.write_bytes(b"not a spreadsheet")
            with self.assertRaises(Refused):
                reopen_and_verify(file,admitted_rows(self.admitted))

    def test_existing_run_never_overwritten(self):
        try:
            first=run(str(self.path),self.run_id)
            self.assertEqual(first["status"],"pending-human-review")
            previous=hashlib.sha256(Path(first["workbook"]).read_bytes()).hexdigest()
            second=run(str(self.path),self.run_id)
            self.assertEqual(second["status"],"refused")
            self.assertEqual(previous,hashlib.sha256(Path(first["workbook"]).read_bytes()).hexdigest())
        finally:self.clean()

    def test_unsafe_output_run_name_refused(self):
        for runid in ("../escape","/abs/path","ab/cd","-starts-bad"):
            self.assertEqual(run(str(self.path),runid)["status"],"refused")

    def test_saved_case_cannot_be_symbolic_link(self):
        with tempfile.TemporaryDirectory() as tmp:
            alias=Path(tmp)/"alias.json"
            alias.symlink_to(self.path)
            self.assertEqual(run(str(alias),self.run_id)["status"],"refused")

    def test_source_is_captured_snapshot_not_live_production(self):
        rows=admitted_rows(self.admitted)
        self.assertIn(["Source currentness","not-verified"],rows["Case"])
        self.assertIn(["Physical output certified","False"],rows["Case"])
        self.assertIn(["Receipt coverage","not-covered"],rows["MES Evidence"])

    def test_altered_relationship_is_refused_even_with_correct_cells(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/"danger.xlsx"
            rows=admitted_rows(self.admitted)
            write_xlsx(rows,file)
            with ZipFile(file) as z:
                chunks={name:z.read(name) for name in z.namelist()}
            path="xl/_rels/workbook.xml.rels"
            self.assertIn(b"worksheets/sheet1.xml",chunks[path])
            chunks[path]=chunks[path].replace(b"worksheets/sheet1.xml",b"worksheets/sheet7.xml",1)
            with ZipFile(file,"w") as z:
                for name,content in chunks.items():z.writestr(name,content)
            with self.assertRaisesRegex(Refused,"xlsx-template-part-mismatch"):
                reopen_and_verify(file,rows)

    def test_altered_cell_address_refused_even_with_same_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/"danger.xlsx"
            rows=admitted_rows(self.admitted)
            write_xlsx(rows,file)
            with ZipFile(file) as z:chunks={name:z.read(name) for name in z.namelist()}
            path="xl/worksheets/sheet4.xml"
            self.assertIn(b'r="B4"',chunks[path])
            chunks[path]=chunks[path].replace(b'r="B4"',b'r="B5"',1)
            with ZipFile(file,"w") as z:
                for name,content in chunks.items():z.writestr(name,content)
            with self.assertRaisesRegex(Refused,"xlsx-template-part-mismatch"):
                reopen_and_verify(file,rows)

    def test_duplicate_zip_member_rejected_predecompression(self):
        import warnings
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/"duplicate.xlsx"
            rows=admitted_rows(self.admitted)
            write_xlsx(rows,file)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore",UserWarning)
                with ZipFile(file,"a") as z:
                    z.writestr("xl/workbook.xml",z.read("xl/workbook.xml"))
            with self.assertRaisesRegex(Refused,"xlsx-duplicate-or-extra-parts"):
                reopen_and_verify(file,rows)

    def test_invalid_xml_unicode_fails_early(self):
        for x in ("bad"+chr(0xD800),"bad"+chr(0xFFFE)):
            with self.assertRaisesRegex(Refused,"invalid-xml-character-refused"):
                _safe_text(x)

    def test_manifest_failure_never_publishes_final_named_files(self):
        try:
            folder=wf.safe_dir(self.run_id)
            rows=admitted_rows(self.admitted)
            temporary=folder/"unverified.xlsx"
            write_xlsx(rows,temporary)
            state={"run_dir":str(folder),"temporary_workbook":str(temporary),
                   "rows":rows,"source":self.admitted,"run_id":self.run_id}
            with patch("workflow.make_manifest",side_effect=Refused("fixture-manifest-failure")):
                outcome=wf.verify_and_seal(state)
            self.assertEqual(outcome["status"],"refused")
            self.assertFalse((folder/"FDE_Investigation.xlsx").exists())
            self.assertFalse((folder/"handoff-manifest.json").exists())
        finally:
            self.clean()

if __name__=="__main__":
    unittest.main()
