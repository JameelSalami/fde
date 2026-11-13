"""FDE engineering reporting: manually exported shift data -> Haskell KPIs.

This module does not fetch ERP/MES data. It consumes prepared, explicit shift
records, checks their shape, and delegates *all quantitative interpretation*
to the FDE compiled Haskell kernel.
"""
from __future__ import annotations
import csv
from hashlib import sha256
import io
import json
from pathlib import Path
import re
import subprocess
from typing import Any

ROOT=Path(__file__).resolve().parents[2]
KERNEL=ROOT/"kernel"/"bin"/"fde-semantic"
SUMMARY=("period_id","line_id","planned_units","good_units")
LOSS=("period_id","line_id","loss_category","lost_units")
ID=re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\Z")
INTEGER=re.compile(r"(0|[1-9][0-9]{0,15})\Z")
MAX_ROWS=256
MAX_FILE=65_536
MAX_COUNT=9007199254740991

class Refused(ValueError):
    pass

def _file(path:str) -> tuple[bytes, list[dict[str,str]]]:
    p=Path(path)
    if not p.is_absolute() or not p.is_file() or p.is_symlink() or p.stat().st_size>MAX_FILE:
        raise Refused("source-path-or-budget-refused")
    raw=p.read_bytes()
    try:
        text=raw.decode("utf-8-sig")
        reader=csv.DictReader(io.StringIO(text), strict=True)
        if reader.fieldnames is None:raise Refused("empty-csv")
        if any(not row for row in reader.fieldnames):raise Refused("empty-header")
        records=list(reader)
    except (UnicodeError,csv.Error):
        raise Refused("invalid-csv")
    if not records or len(records)>MAX_ROWS or any(None in x for x in records):
        raise Refused("source-row-budget-or-shape-refused")
    return raw,records

def _check_id(v:str) -> str:
    if not isinstance(v,str) or not ID.fullmatch(v):raise Refused("invalid-identifier")
    return v

def _count(v:str) -> str:
    if not isinstance(v,str) or not INTEGER.fullmatch(v) or int(v)>MAX_COUNT:
        raise Refused("invalid-nonnegative-count")
    return v

def intake(summary_csv:str,loss_csv:str,source_class:str) -> dict[str,Any]:
    if source_class not in ("handwritten-fixture","synthetic-worksheet","manual-export"):
        raise Refused("unknown-source-class")
    sraw,srows=_file(summary_csv)
    lraw,lrows=_file(loss_csv)
    if list(srows[0])!=list(SUMMARY) or list(lrows[0])!=list(LOSS):
        raise Refused("csv-columns-not-agreed")
    groups:dict[tuple[str,str],dict[str,Any]]={}
    for row in srows:
        period=_check_id(row["period_id"])
        line=_check_id(row["line_id"])
        key=(period,line)
        if key in groups:raise Refused("duplicate-period-line")
        groups[key]={"periodId":period,"lineId":line,
                     "plannedUnits":_count(row["planned_units"]),
                     "goodUnits":_count(row["good_units"]),"losses":[]}
    if len(groups)>40:raise Refused("too-many-reporting-periods")
    for row in lrows:
        period=_check_id(row["period_id"]);line=_check_id(row["line_id"])
        key=(period,line)
        if key not in groups:raise Refused("loss-without-reporting-period")
        loss_id=_check_id(row["loss_category"])
        if loss_id in [loss["id"] for loss in groups[key]["losses"]]:
            raise Refused("duplicate-loss-category")
        groups[key]["losses"].append({"id":loss_id,"units":_count(row["lost_units"])})
        if len(groups[key]["losses"])>32:raise Refused("too-many-losses")
    return {"sourceClass":source_class,
            "summaryFileSha256":sha256(sraw).hexdigest(),
            "lossFileSha256":sha256(lraw).hexdigest(),
            "periods":[groups[k] for k in sorted(groups)]}

def assess(intake_result:dict[str,Any]) -> dict[str,Any]:
    if not KERNEL.is_file():raise Refused("fde-haskell-kernel-unavailable")
    metrics=[]
    for row in intake_result["periods"]:
        request={"schema":"fde.production-kpi-request/v1",
                 "sourceClass":intake_result["sourceClass"],**row}
        completed=subprocess.run([str(KERNEL)],input=json.dumps(request),
                                 capture_output=True,text=True,timeout=12,
                                 check=False,env={"PATH":"/usr/bin:/bin"})
        if completed.returncode!=0 or len(completed.stdout)>250_000:
            raise Refused("fde-haskell-execution-refused")
        try:reply=json.loads(completed.stdout)
        except ValueError:raise Refused("fde-haskell-response-invalid")
        if reply.get("ok") is not True or not isinstance(reply.get("result"),dict):
            raise Refused("fde-haskell-kpi-refused")
        result=reply["result"]
        if (result.get("schema")!="fde.production-kpi-result/v1" or
            result.get("authority")!="non-authoritative-diagnostic" or
            result.get("sourceWriteAllowed") is not False or
            result.get("periodId")!=row["periodId"] or
            result.get("lineId")!=row["lineId"] or
            result.get("sourceClass")!=intake_result["sourceClass"]):
            raise Refused("fde-haskell-reply-identity-refused")
        metrics.append(result)
    return {
        "schema":"fde.performance-report/v1",
        "sourceClass":intake_result["sourceClass"],
        "sourceDigests":{
            "summary":intake_result["summaryFileSha256"],
            "losses":intake_result["lossFileSha256"]},
        "kernelSha256":sha256(KERNEL.read_bytes()).hexdigest(),
        "authority":"reporting-preparation-only",
        "plannedSourceTransactions":0,
        "sourceWriteAllowed":False,
        "periods":metrics,
        "scope":"human-prepared shift/line exports — no automatic ERP/MES joins",
    }

def baseline_questions(report:dict[str,Any]) -> list[str]:
    # The prompts are generic checklists; no causal story is inferred.
    return [
        "Confirm shift/line boundaries and that the recorded plan is the intended reporting baseline.",
        "Check whether the declared loss categories are mutually exclusive and measured in the same unit-equivalent basis.",
        "Review the first Pareto category with the process owner; record evidence before choosing a cause.",
        "Set a measurement plan and revisit the report after an approved local improvement trial."
    ]
