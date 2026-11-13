#!/usr/bin/env python3
"""Disposable, negative semantic-mutant checks for FDE review bridge.
Never touches the tracked source or an owner-private database/corpus.
"""
from __future__ import annotations
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

SOURCE=Path(__file__).resolve().parents[1]/"integrations"/"engineer-qa"
TEST_SOURCE=SOURCE/"tests"
SPECS=[
 ("B01-asof-pin","bridge.py",
  'snapshot.require(approval.as_of_date == expected.asOf, "review-asof-mismatch")',
  'snapshot.require(True, "review-asof-mismatch")',
  "test_wrong_asof_refuses_before_any_io_or_payload_inspection"),
 ("B02-candidate-only","bridge.py",
  'boundary: str = field(default="candidate-only", init=False)',
  'boundary: str = field(default="verified", init=False)',
  "test_exact_metric_and_three_candidate_passages"),
 ("B03-empty-retrieval","bridge.py",
  'if any(p.text.strip() for p in self.context.passages):',
  'if self.context.passages:',
  "test_empty_or_whitespace_passage_is_no_usable_evidence"),
]
with tempfile.TemporaryDirectory(prefix="fde-bridge-mutants-") as t:
    work=Path(t)
    os.chmod(t,0o700)
    (work/"tests").mkdir(mode=0o700)
    for name in ["bridge.py","snapshot.py","context.py","answer.py"]:
        shutil.copyfile(SOURCE/name,work/name)
    for name in ["test_bridge.py","test_offline_qa.py","test_context.py"]:
        shutil.copyfile(TEST_SOURCE/name,work/"tests"/name)
    env={"PATH":os.environ.get("PATH","/usr/bin:/bin"),
         "PYTHONPATH":str(work),"PYTHONDONTWRITEBYTECODE":"1",
         "PYTHONNOUSERSITE":"1"}
    for mutant_id,file,original,substitute,test in SPECS:
        path=work/file
        saved=path.read_text()
        if saved.count(original)!=1:
            raise SystemExit("MUTATION_NOT_UNIQUE:"+mutant_id)
        cmd=[sys.executable,"-m","unittest","discover","-s",str(work/"tests"),
             "-p","test_bridge.py","-k",test,"-q"]
        def run():
            return subprocess.run(cmd,cwd=work,env=env,text=True,
                                  capture_output=True,timeout=12)
        control=run()
        if control.returncode!=0 or "OK" not in control.stderr:
            raise SystemExit("CONTROL_FAILED:"+mutant_id)
        try:
            path.write_text(saved.replace(original,substitute))
            mutant=run()
            observed=mutant.stdout+mutant.stderr
            if mutant.returncode==0 or "FAILED" not in observed or test not in observed:
                raise SystemExit("MUTANT_NOT_KILLED:"+mutant_id)
            print("MUTATION_KILLED",mutant_id,"test="+test,
                  "control=PASS mutant=FAIL",flush=True)
        finally:
            path.write_text(saved)
print("MUTATION_BATTERY",len(SPECS),"of",len(SPECS),"killed")