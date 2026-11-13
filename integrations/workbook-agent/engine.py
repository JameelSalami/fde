"""Local XLSX projection of already-authorized, Haskell-assessed FDE evidence.

No domain computations, model calls, vendor operations, or workbook formula execution.
Only Python stdlib OOXML/ZIP and an independently reopened readback are used.
"""
from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO
from hashlib import sha256
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET
from zipfile import ZipFile, ZIP_DEFLATED, BadZipFile
import json
import os
import re

M = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P = "http://schemas.openxmlformats.org/package/2006/relationships"
C = "http://schemas.openxmlformats.org/package/2006/content-types"
ET.register_namespace("", M)
ET.register_namespace("r", R)
SHEETS = ("Case", "ERP Evidence", "MES Evidence", "FDE Findings", "Exceptions", "Review", "Provenance")
FORBIDDEN_SOURCE_KEYS = ("privateWorkerNotes", "privateNote")
FORMULA_PREFIXES = ("=", "+", "-", "@")
MAX_CELL = 4500
MAX_ROWS = 110
MAX_BYTES = 3 * 1024 * 1024

class Refused(ValueError):
    """Explicitly refused incomplete/unsafe evidence or output."""

def _safe_text(x: Any) -> str:
    if x is None:
        return "UNKNOWN / NOT COVERED"
    if isinstance(x, (dict, list)):
        x = json.dumps(x, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    s = str(x)
    def xml_ok(c: str) -> bool:
        k=ord(c)
        return k in (9,10,13) or 0x20<=k<=0xD7FF or 0xE000<=k<=0xFFFD or 0x10000<=k<=0x10FFFF
    if any(not xml_ok(c) for c in s):
        raise Refused("invalid-xml-character-refused")
    if len(s) > MAX_CELL:
        raise Refused("cell-budget-refused")
    if s.lstrip().startswith(FORMULA_PREFIXES):
        # Even when written as inlineStr, protect copy/paste into another workbook.
        s = "'" + s
    return s

def _require(v: Any, key: str, expected: Any) -> None:
    if not isinstance(v, dict) or v.get(key) != expected:
        raise Refused("source-contract-refused:" + key)

def _hex64(s: Any) -> bool:
    return isinstance(s, str) and re.fullmatch(r"[a-f0-9]{64}", s) is not None

def admitted_rows(source: dict[str, Any]) -> dict[str, list[list[str]]]:
    """Only project FDE's authenticated evidence and existing compiled diagnostic."""
    _require(source, "schema", "fde.workbook-evidence/v1")
    _require(source, "authority", "none")
    _require(source, "sourceWriteAllowed", False)
    _require(source, "sourceCurrentness", "not-verified")
    _require(source, "physicalProductionCertified", False)
    if not all(_hex64(source.get(k)) for k in ("inputSha256", "kernelSha256")):
        raise Refused("source-digest-refused")
    pair = source.get("nativePair")
    _require(pair, "schema", "fde.native-evidence-pair/v1")
    _require(pair, "status", "complete-pair")
    _require(pair, "sourceWriteAllowed", False)
    _require(pair, "canCompareReportedQuantities", True)
    _require(pair, "distributedAtomicSnapshot", False)
    _require(pair, "physicalProductionCertified", False)
    _require(pair, "stockReceiptCovered", False)
    _require(pair, "inventoryLedgerCovered", False)
    if pair.get("missingRoles") or pair.get("observationId") != source.get("observationId"):
        raise Refused("missing-or-foreign-role-refused")
    sources = pair.get("sources", {})
    diagnostic = source.get("diagnostic")
    _require(diagnostic, "schema", "fde.compiled-diagnostic/v1")
    _require(diagnostic, "authority", "none")
    _require(diagnostic, "sourceClass", source.get("dataClass"))
    if diagnostic.get("physicalProductionCertified") is not False or diagnostic.get("postingPermitted") is not False:
        raise Refused("qualified-physical-or-posting-refused")
    ids = []
    for role, vendor in (("erp", "erpnext"), ("mes", "openmes")):
        slot = sources.get(role)
        _require(slot, "role", role)
        _require(slot, "vendor", vendor)
        _require(slot, "presence", "present")
        witness = slot.get("evidence")
        if not isinstance(witness, dict):
            raise Refused("missing-witness-refused")
        for key in ("id", "instance", "nativeId", "revision", "observedAt",
                    "sourceQuerySha256", "sourceDigest", "passageDigest", "planned", "reported", "unit"):
            if not isinstance(witness.get(key), str) or not witness[key]:
                raise Refused("witness-field-refused:" + key)
        if witness.get("unit") != ("Nos" if role == "erp" else "pcs"):
            raise Refused("witness-unit-refused")
        cover = witness.get("coverage")
        if not isinstance(cover, dict) or any(cover.get(k) != "not-covered" for k in ("receipt", "ledger", "physical")):
            raise Refused("coverage-upgrade-refused")
        ids.append(witness["id"])
    if len(set(ids)) != 2 or source.get("modelContextSourceIds") != ids:
        raise Refused("cross-source-identity-refused")
    if source.get("dataClass") not in ("isolated-synthetic-native", "handwritten-fixture"):
        raise Refused("unsupported-data-grade")
    if any(key in json.dumps(source) for key in FORBIDDEN_SOURCE_KEYS):
        raise Refused("private-notes-refused")

    def table(pairs: list[tuple[str, Any]]) -> list[list[str]]:
        if len(pairs) + 1 > MAX_ROWS:
            raise Refused("row-budget-refused")
        return [["Field", "Value"]] + [[_safe_text(k), _safe_text(v)] for k, v in pairs]

    source_rows = {}
    for role, title in (("erp", "ERP Evidence"), ("mes", "MES Evidence")):
        w = sources[role]["evidence"]
        source_rows[title] = table([
            ("Role", role), ("Vendor", sources[role]["vendor"]),
            ("Native instance", w["instance"]), ("Native ID", w["nativeId"]),
            ("Business ID", w.get("businessId", "")), ("Source revision", w["revision"]),
            ("Capture time (UTC)", w["observedAt"]), ("Query SHA-256", w["sourceQuerySha256"]),
            ("Evidence ID", w["id"]), ("Source digest", w["sourceDigest"]),
            ("Passage digest", w["passageDigest"]), ("Source path", w.get("sourcePath", "")),
            ("Native plan", w["planned"] + " " + w["unit"]),
            ("Native reported", w["reported"] + " " + w["unit"]),
            ("Receipt coverage", w["coverage"]["receipt"]),
            ("Ledger coverage", w["coverage"]["ledger"]),
            ("Physical coverage", w["coverage"]["physical"]),
            ("Currentness", "not-verified"), ("Disclosure", "explicit authenticated local source snapshot")
        ])
    source_rows["Case"] = table([
        ("Case identity", source["caseId"]), ("Observation identity", source["observationId"]),
        ("Question", source.get("question", "")),
        ("Data grade", source["dataClass"]), ("Source currentness", "not-verified"),
        ("Native pair status", pair["status"]),
        ("Recorded source read pattern", source["observationScope"].get("readPattern", "")),
        ("Atomic snapshot established", False), ("Physical output certified", False),
        ("Source effects allowed", False), ("Authority", "none — diagnostic/review only")
    ])
    finding_keys = (
        ("Classification", "classification"), ("Planned delta (Haskell)", "plannedDelta"),
        ("Reported delta (Haskell)", "reportedDelta"), ("Binding grade", "bindingGrade"),
        ("Admission status", "admissionStatus"), ("Human review required", "humanReviewRequired"),
        ("Physical coverage", "physicalCoverage"), ("Receipt coverage", "receiptCoverage"),
        ("Ledger coverage", "ledgerCoverage"), ("Posting permitted", "postingPermitted"),
        ("Semantic source class", "sourceClass")
    )
    source_rows["FDE Findings"] = table([(label, diagnostic.get(key)) for label, key in finding_keys] +
        [("Semantic kernel SHA-256", source["kernelSha256"]),
         ("Assessment authority", "non-authoritative compiled diagnostic")])
    source_rows["Exceptions"] = table([
        ("Compiled classification", diagnostic.get("classification")),
        ("Reported source difference (Haskell)", diagnostic.get("reportedDelta")),
        ("Receipt and physical proof", "not-covered"),
        ("Required action", "human review — do not claim physical production"),
        ("Source evidence", "ERP and MES are separately captured; not a distributed atomic snapshot")
    ])
    why = source.get("why") or []
    if not isinstance(why, list) or len(why) > 16:
        raise Refused("review-card-budget-refused")
    source_rows["Review"] = table([
        ("Review state", "PENDING — no approval recorded"),
        ("Review owner", "NOT ASSIGNED"),
        ("Authority", "human reviewer; workbook cannot approve vendor effects"),
    ] + [(str(q.get("id", "question")), q.get("claim", "")) for q in why if isinstance(q, dict)] +
    [("Next possible check", "Confirm reporting time and declared synthetic unit mapping"),
     ("Missing evidence", "Physical/receipt/ledger claims remain unverified")])
    source_rows["Provenance"] = table([
        ("Source input SHA-256", source["inputSha256"]),
        ("Semantic kernel SHA-256", source["kernelSha256"]),
        ("Case ID", source["caseId"]), ("Observation ID", source["observationId"]),
        ("ERP evidence ID", ids[0]), ("MES evidence ID", ids[1]),
        ("Native role-pair", "complete for captured observations only"),
        ("Source currentness", "not-verified"),
        ("Limitations", " | ".join(str(x) for x in source.get("limitations", [])[:6])),
        ("Export scope", "bounded XLSX projection — not the full review history"),
        ("Cloud calls", "none"), ("Source/vendor writes", "none")
    ])
    if set(source_rows) != set(SHEETS):
        raise Refused("sheet-contract-refused")
    return {s:source_rows[s] for s in SHEETS}

def _xml(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)

def _column(i: int) -> str:
    ans = ""
    i += 1
    while i:
        i, r = divmod(i-1, 26)
        ans = chr(65+r)+ans
    return ans

def _sheet_xml(rows: list[list[str]]) -> bytes:
    root = ET.Element(f"{{{M}}}worksheet")
    views = ET.SubElement(root, f"{{{M}}}sheetViews")
    view = ET.SubElement(views, f"{{{M}}}sheetView", {"workbookViewId":"0"})
    ET.SubElement(view, f"{{{M}}}pane", {"ySplit":"1","topLeftCell":"A2","activePane":"bottomLeft","state":"frozen"})
    cols = ET.SubElement(root, f"{{{M}}}cols")
    for idx, width in enumerate((31, 76), 1):
        ET.SubElement(cols, f"{{{M}}}col", {"min":str(idx),"max":str(idx),"width":str(width),"customWidth":"1"})
    data = ET.SubElement(root, f"{{{M}}}sheetData")
    for ri, row in enumerate(rows, 1):
        longest=max((len(v) for v in row),default=0)
        height="27" if ri==1 else str(min(150,max(21,((longest+84)//85)*19)))
        r = ET.SubElement(data, f"{{{M}}}row", {"r":str(ri),"ht":height,"customHeight":"1"})
        for ci, value in enumerate(row):
            cell = ET.SubElement(r, f"{{{M}}}c", {"r":f"{_column(ci)}{ri}","t":"inlineStr","s":("1" if ri==1 else "2")})
            inner=ET.SubElement(cell, f"{{{M}}}is")
            txt = ET.SubElement(inner, f"{{{M}}}t")
            txt.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            txt.text=value
    ET.SubElement(root, f"{{{M}}}autoFilter", {"ref":f"A1:B{len(rows)}"})
    return _xml(root)

def _styles() -> bytes:
    root=ET.Element(f"{{{M}}}styleSheet")
    fonts=ET.SubElement(root,f"{{{M}}}fonts",{"count":"2"})
    f0=ET.SubElement(fonts,f"{{{M}}}font");ET.SubElement(f0,f"{{{M}}}sz",{"val":"11"});ET.SubElement(f0,f"{{{M}}}name",{"val":"Aptos"})
    f1=ET.SubElement(fonts,f"{{{M}}}font");ET.SubElement(f1,f"{{{M}}}b");ET.SubElement(f1,f"{{{M}}}color",{"rgb":"FFFFFFFF"});ET.SubElement(f1,f"{{{M}}}sz",{"val":"11"})
    fills=ET.SubElement(root,f"{{{M}}}fills",{"count":"3"})
    ET.SubElement(ET.SubElement(fills,f"{{{M}}}fill"),f"{{{M}}}patternFill",{"patternType":"none"})
    ET.SubElement(ET.SubElement(fills,f"{{{M}}}fill"),f"{{{M}}}patternFill",{"patternType":"gray125"})
    colorfill=ET.SubElement(ET.SubElement(fills,f"{{{M}}}fill"),f"{{{M}}}patternFill",{"patternType":"solid"})
    ET.SubElement(colorfill,f"{{{M}}}fgColor",{"rgb":"FF17365D"})
    ET.SubElement(colorfill,f"{{{M}}}bgColor",{"indexed":"64"})
    borders=ET.SubElement(root,f"{{{M}}}borders",{"count":"1"})
    border=ET.SubElement(borders,f"{{{M}}}border")
    for k in ("left","right","top","bottom","diagonal"):ET.SubElement(border,f"{{{M}}}{k}")
    cs=ET.SubElement(root,f"{{{M}}}cellStyleXfs",{"count":"1"})
    ET.SubElement(cs,f"{{{M}}}xf",{"numFmtId":"0","fontId":"0","fillId":"0","borderId":"0"})
    xs=ET.SubElement(root,f"{{{M}}}cellXfs",{"count":"3"})
    ET.SubElement(xs,f"{{{M}}}xf",{"numFmtId":"0","fontId":"0","fillId":"0","borderId":"0","xfId":"0"})
    for font,fill in (("1","2"),("0","0")):
        xf=ET.SubElement(xs,f"{{{M}}}xf",{"numFmtId":"0","fontId":font,"fillId":fill,"borderId":"0","xfId":"0","applyAlignment":"1"})
        ET.SubElement(xf,f"{{{M}}}alignment",{"vertical":"center","wrapText":"1"})
    return _xml(root)

def write_xlsx(rows: dict[str,list[list[str]]], filename: Path) -> None:
    if set(rows)!=set(SHEETS):raise Refused("sheet-contract-refused")
    book=ET.Element(f"{{{M}}}workbook")
    tabs=ET.SubElement(book,f"{{{M}}}sheets")
    for n,name in enumerate(SHEETS,1):
        ET.SubElement(tabs,f"{{{M}}}sheet",{"name":name,"sheetId":str(n),f"{{{R}}}id":f"rId{n}"})
    relroot=ET.Element(f"{{{P}}}Relationships")
    for n in range(1,len(SHEETS)+1):
        ET.SubElement(relroot,f"{{{P}}}Relationship",{"Id":f"rId{n}","Type":R+"/worksheet","Target":f"worksheets/sheet{n}.xml"})
    ET.SubElement(relroot,f"{{{P}}}Relationship",{"Id":f"rId{len(SHEETS)+1}","Type":R+"/styles","Target":"styles.xml"})
    rootrels=ET.Element(f"{{{P}}}Relationships")
    ET.SubElement(rootrels,f"{{{P}}}Relationship",{"Id":"rId1","Type":R+"/officeDocument","Target":"xl/workbook.xml"})
    types=ET.Element(f"{{{C}}}Types")
    ET.SubElement(types,f"{{{C}}}Default",{"Extension":"rels","ContentType":"application/vnd.openxmlformats-package.relationships+xml"})
    ET.SubElement(types,f"{{{C}}}Default",{"Extension":"xml","ContentType":"application/xml"})
    ET.SubElement(types,f"{{{C}}}Override",{"PartName":"/xl/workbook.xml","ContentType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"})
    ET.SubElement(types,f"{{{C}}}Override",{"PartName":"/xl/styles.xml","ContentType":"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"})
    for n in range(1,len(SHEETS)+1):
        ET.SubElement(types,f"{{{C}}}Override",{"PartName":f"/xl/worksheets/sheet{n}.xml","ContentType":"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"})
    with ZipFile(filename,"w",compression=ZIP_DEFLATED,compresslevel=7) as zipf:
        zipf.writestr("[Content_Types].xml",_xml(types))
        zipf.writestr("_rels/.rels",_xml(rootrels))
        zipf.writestr("xl/workbook.xml",_xml(book))
        zipf.writestr("xl/_rels/workbook.xml.rels",_xml(relroot))
        zipf.writestr("xl/styles.xml",_styles())
        for n,name in enumerate(SHEETS,1):
            zipf.writestr(f"xl/worksheets/sheet{n}.xml",_sheet_xml(rows[name]))

def reopen_and_verify(filename: Path, rows: dict[str,list[list[str]]]) -> dict[str,Any]:
    if not filename.is_file() or filename.stat().st_size>MAX_BYTES:raise Refused("xlsx-budget-refused")
    try:
        with ZipFile(filename,"r") as z:
            entries=z.infolist()
            names_list=[member.filename for member in entries]
            if len(entries)>20 or len(names_list)!=len(set(names_list)):
                raise Refused("xlsx-duplicate-or-extra-parts")
            if any(member.file_size>MAX_BYTES for member in entries) or sum(m.file_size for m in entries)>MAX_BYTES:
                raise Refused("xlsx-uncompressed-budget")
            names=set(names_list)
            if z.testzip() is not None:raise Refused("xlsx-corrupt")
            mandatory={"[Content_Types].xml","_rels/.rels","xl/workbook.xml",
                       "xl/_rels/workbook.xml.rels","xl/styles.xml"}
            mandatory.update(f"xl/worksheets/sheet{n}.xml" for n in range(1,len(SHEETS)+1))
            if names!=mandatory:raise Refused("xlsx-unexpected-parts")
            if sum(x.file_size for x in z.infolist())>MAX_BYTES:raise Refused("xlsx-uncompressed-budget")
            workbook=ET.fromstring(z.read("xl/workbook.xml"))
            actual_names=[x.get("name") for x in workbook.findall(f".//{{{M}}}sheet")]
            if actual_names!=list(SHEETS):raise Refused("xlsx-sheet-order-refused")
            checks={}
            for n,name in enumerate(SHEETS,1):
                tree=ET.fromstring(z.read(f"xl/worksheets/sheet{n}.xml"))
                if tree.findall(f".//{{{M}}}f"):raise Refused("xlsx-executable-formula-refused")
                actual=[]
                for row in tree.findall(f".//{{{M}}}sheetData/{{{M}}}row"):
                    values=[]
                    for cell in row.findall(f"{{{M}}}c"):
                        if cell.get("t")!="inlineStr":raise Refused("xlsx-cell-type-refused")
                        t=cell.find(f"./{{{M}}}is/{{{M}}}t")
                        values.append(t.text or "" if t is not None else "")
                    actual.append(values)
                if actual!=rows[name]:raise Refused("xlsx-independent-readback-mismatch:"+name)
                checks[name]=len(actual)
            # Verify the entire expected package semantic bytes, not just display
            # text order. This refuses forged relationship targets, cell addresses,
            # hidden sheets, styles, external targets and unrecognized XML features.
            expected_bytes=BytesIO()
            write_xlsx(rows,expected_bytes)
            with ZipFile(expected_bytes,"r") as expected_zip:
                for part in mandatory:
                    if z.read(part)!=expected_zip.read(part):
                        raise Refused("xlsx-template-part-mismatch:"+part)
    except (BadZipFile,ET.ParseError,KeyError,OSError) as e:
        raise Refused("xlsx-reopen-refused") from e
    return {"sheetRows":checks,"byteSha256":sha256(filename.read_bytes()).hexdigest(),"readback":"exact-local-xml"}

def make_manifest(source:dict[str,Any],verified:dict[str,Any],run_id:str) -> dict[str,Any]:
    return {
        "schema":"fde.workbook-handoff/v1","authority":"none","humanReview":"pending",
        "sourceWriteAllowed":False,"vendorReadPerformed":False,"cloudCallPerformed":False,
        "sourceCurrentness":"not-verified",
        "caseId":source["caseId"],"observationId":source["observationId"],
        "sourceInputSha256":source["inputSha256"],"kernelSha256":source["kernelSha256"],
        "classificationFromHaskell":source["diagnostic"]["classification"],
        "runId":run_id,"createdAt":datetime.now(timezone.utc).isoformat(),
        "workbookSha256":verified["byteSha256"],"workbookSheets":list(SHEETS),
        "readback":verified["readback"],"sheetRows":verified["sheetRows"],
        "limits":["synthetic/captured FDE evidence only","not current source truth","no verified receipt/ledger/physical output",
                  "workbook is not the complete FDE review history","human decision and any provider write require separate authority"]
    }
