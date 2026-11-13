"""Compile-valid mutation of the exact OOXML relationship/template guard (copy only)."""
from __future__ import annotations
from pathlib import Path
from zipfile import ZipFile
import json
import subprocess
import tempfile
from engine import Refused, admitted_rows, write_xlsx, reopen_and_verify

ROOT=Path(__file__).resolve().parents[2]
SOURCE=Path(__file__).resolve().parent/"engine.py"
OLD="if z.read(part)!=expected_zip.read(part):"
NEW="if False:"

def main():
    source=SOURCE.read_text()
    if source.count(OLD)!=1:
        print(json.dumps({"mutant":"WBR-OOXML-01","result":"BLOCKED","reason":"exact-target-missing"}))
        return 3
    ns={"__name__":"fde_ooxml_mutant","__file__":str(SOURCE)}
    try:
        exec(compile(source.replace(OLD,NEW), str(SOURCE), "exec"),ns)
    except Exception:
        print(json.dumps({"mutant":"WBR-OOXML-01","result":"BLOCKED","reason":"compile-failed"}))
        return 3
    with tempfile.TemporaryDirectory(prefix="fde-ooxml-mutant-") as tmp:
        raw=subprocess.run(["node",str(ROOT/"demo"/"workbook-fixture.mjs")],cwd=ROOT,capture_output=True,text=True,timeout=20,check=True)
        case=Path(tmp)/"case.json"
        case.write_text(raw.stdout)
        admitted=subprocess.run(["node",str(ROOT/"bin"/"fde-workbook-source.mjs"),str(case)],cwd=ROOT,capture_output=True,text=True,timeout=20,check=True)
        rows=admitted_rows(json.loads(admitted.stdout))
        file=Path(tmp)/"tampered-relationship.xlsx"
        write_xlsx(rows,file)
        with ZipFile(file,"r") as z:
            parts={name:z.read(name) for name in z.namelist()}
        target="xl/_rels/workbook.xml.rels"
        if b"worksheets/sheet1.xml" not in parts[target]:
            print(json.dumps({"mutant":"WBR-OOXML-01","result":"BLOCKED","reason":"test-target-missing"}))
            return 3
        parts[target]=parts[target].replace(b"worksheets/sheet1.xml",b"worksheets/sheet7.xml",1)
        with ZipFile(file,"w") as z:
            for name,bytes_ in parts.items():z.writestr(name,bytes_)
        try:
            reopen_and_verify(file,rows)
        except Refused as err:
            if "xlsx-template-part-mismatch" not in str(err):
                print(json.dumps({"mutant":"WBR-OOXML-01","result":"BLOCKED","reason":"original-wrong-refusal"}))
                return 3
        else:
            print(json.dumps({"mutant":"WBR-OOXML-01","result":"BLOCKED","reason":"original-guard-not-working"}))
            return 3
        try:
            ns["reopen_and_verify"](file,rows)
        except Refused:
            print(json.dumps({"mutant":"WBR-OOXML-01","result":"SURVIVED","assertion":"forged-relationship-must-refuse"}))
            return 2
        print(json.dumps({"mutant":"WBR-OOXML-01","result":"KILLED",
                          "assertion":"forged-relationship-must-refuse","blocked":False}))
        return 0

if __name__=="__main__":
    raise SystemExit(main())
