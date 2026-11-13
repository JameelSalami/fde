#!/usr/bin/env python3
"""Check the shipped synthetic fixture without network, vendor apps or credentials."""
from collections import Counter
from datetime import date
from pathlib import Path
import hashlib,json,re,sys

ROOT=Path(__file__).resolve().parents[1]
P=ROOT/"demo/synthetic-native-reporting.json"
def main():
    if not P.is_file() or P.is_symlink() or P.stat().st_size>750_000:
        raise ValueError("fixture-source-custody")
    raw=P.read_bytes()
    data=json.loads(raw)
    expected={"shifts":314,"exposure":314,"ehs":29,"pm":149,
              "downtime":29,"calendar":438,"targets":60}
    if data.get("schema")!="fde.excel-native-refresh/v1" or data.get("run_id")!="FDEBF14-20261113":
        raise ValueError("source-identity")
    for group,count in expected.items():
        if len(data.get(group,[]))!=count:raise ValueError("fixture-cardinality-"+group)
    shifts=data["shifts"]
    dates=[x["date"] for x in shifts]
    if len(set(dates))!=314:raise ValueError("duplicate-shift-date")
    if date.fromisoformat(dates[0])!=date(2025,9,1) or date.fromisoformat(dates[-1])!=date(2026,11,12):
        raise ValueError("historical-horizon")
    erp={x["erp"] for x in shifts};mes={x["mes"] for x in shifts}
    if len(erp)!=314 or len(mes)!=314:raise ValueError("source-identity-collision")
    if any(int(x["quality_samples"])!=5 or int(x["quality_checks"])!=1 or
       not 0<=int(x["quality_sample_passed"])<=5 for x in shifts):
        raise ValueError("quality-sample-grain")
    if sum(int(x["plan"]) for x in shifts)!=5754:
        raise ValueError("native-plan-count")
    if any(int(x["plan"])!=sum(int(x[k]) for k in
              ("scenario_good","scenario_reject","scenario_unfinished")) for x in shifts):
        raise ValueError("scenario-unit-conservation")
    if any(int(x["mes_produced"])!=0 or x["data_class"]!="SYNTHETIC_SCENARIO" for x in shifts):
        raise ValueError("actual-scenario-contamination")
    if len(set(x["date"][:7] for x in shifts))!=15:raise ValueError("period-cardinality")
    cal={x["date"]:x for x in data["calendar"]}
    if len(cal)!=438 or any(not int(cal[d]["scheduled"]) for d in dates):
        raise ValueError("scheduled-calendar-coverage")
    if len({(x["period"],x["department"],x["metric"]) for x in data["targets"]})!=60:
        raise ValueError("target-identity-collision")
    if any(token in raw for token in (b"/srv/data/",b"192.168.",b"10.10.",
                                     b"scriptorium-main",b"BEGIN PRIVATE KEY")):
        raise ValueError("private-host-string")
    print(json.dumps({"status":"SYNTHETIC_FIXTURE_ACCEPTED",
        "shifts":314,"planned_units":5754,"native_mes_produced":0,
        "quality_samples":1570,"maintenance":149,"downtime":29,"ehs":29,
        "days":438,"targets":60,"months":15,
        "sha256":hashlib.sha256(raw).hexdigest()},sort_keys=True))
if __name__=="__main__":
    try:main()
    except Exception as error:
        print("FIXTURE_REFUSED:"+str(error),file=sys.stderr)
        raise SystemExit(2)
