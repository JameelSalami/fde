"""FDE accepted KPI mart → LangGraph → local Windows Excel presentation.

This workflow reads an already accepted mart refresh, recomputes every monthly
production law using the FDE compiled Haskell kernel, and asks Windows Excel
to render a user-review workbook. It neither modifies ERP/MES nor invokes Azure
AI/SQL. Source data are synthetic and a human must approve the result.
"""
from __future__ import annotations
from collections import defaultdict
from hashlib import sha256
from pathlib import Path
from typing import Any, TypedDict
from datetime import datetime,timezone
from decimal import Decimal
import json,os,re,subprocess,sys

from langgraph.graph import START,END,StateGraph
from psycopg.rows import dict_row

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"integrations"/"operations-excel"))
from azure_model import offline_draft
from native_workbook_flow import windows as windows_render
import load
import export_snapshot

OUT=ROOT/".local"/"kpi-mart"/"runs"
RUN_RE=re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{2,58}\Z")
MART_RUN="fde-mart-20261113-v1"

class State(TypedDict,total=False):
    run_id:str
    windows:bool
    mart:dict[str,Any]
    report:dict[str,Any]
    draft:dict[str,Any]
    export_dir:str
    output_dir:str
    workbook:str
    error:str
    status:str

def _guard(name,action):
    def wrapped(state:State)->State:
        try:return action(state)
        except Exception:
            return {"status":"refused","error":name+"-refused"}
    return wrapped

def validate_mart(s:State)->State:
    if not RUN_RE.fullmatch(s["run_id"]):raise ValueError("run-id")
    with export_snapshot.get_reader() as conn:
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        state=conn.execute("""SELECT run_id,source_sha256,kernel_sha256,as_of_date,state
                            FROM mart.v_latest_refresh""").fetchone()
        if (not state or state[0]!=MART_RUN or state[4]!="accepted" or
           state[3].isoformat()!="2026-11-12"):
            raise ValueError("wrong-accepted-mart")
        if state[2]!=sha256(load.KERNEL.read_bytes()).hexdigest():
            raise ValueError("stale-kernel-mart")
        if state[1]!=sha256(load.SOURCE.read_bytes()).hexdigest():
            raise ValueError("mart-source-changed")
        rows=conn.execute("SELECT count(*) FROM mart.v_kpi_history").fetchone()[0]
        if rows!=2961:raise ValueError("mart-KPI-history-population")
        return {"mart":{"run_id":state[0],"source_sha256":state[1],
                        "kernel_sha256":state[2],"rows":rows,
                        "as_of":state[3].isoformat()},"status":"accepted-mart-validated"}

def compare_haskell(s:State)->State:
    with export_snapshot.get_reader() as conn:
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        grouped=conn.execute("""
          SELECT period_key, sum(planned_units),sum(scenario_good_units),
                 sum(scenario_reject_units),sum(scenario_unfinished_units),
                 sum(mes_produced_units)
          FROM mart.v_source_shifts GROUP BY period_key ORDER BY period_key
        """).fetchall()
        metrics={r[0]:r for r in conn.execute("""
          SELECT period_key,metric_id,numerator,denominator,metric_value
          FROM mart.v_kpi_history
          WHERE grain='month' AND metric_id='SCENARIO_ATTAINMENT'
        """).fetchall()}
        # Reconstruct monthly Haskell result from the persisted population; no
        # spreadsheet or LLM is entrusted to compute a new attainment.
        results=[]
        if len(grouped)!=15:raise ValueError("period-cardinality")
        for period,plan,good,reject,unfinished,native_produced in grouped:
            if native_produced!=0 or plan!=good+reject+unfinished:
                raise ValueError("mart-scenario-vs-native-meaning")
            request={
              "schema":"fde.production-kpi-request/v1",
              "sourceClass":"synthetic-worksheet","periodId":period,
              "lineId":"CNDEMO-LINE-1",
              "plannedUnits":str(int(plan)),"goodUnits":str(int(good)),
              "losses":[{"id":"scenario-rejected","units":str(int(reject))},
                        {"id":"scenario-unfinished","units":str(int(unfinished))}]
            }
            p=subprocess.run([str(load.KERNEL)],input=json.dumps(request),
                   cwd=ROOT,text=True,capture_output=True,timeout=15,check=False)
            if p.returncode or len(p.stdout)>250000:raise ValueError("Haskell-runtime-refused")
            envelope=json.loads(p.stdout)
            if envelope.get("ok") is not True:raise ValueError("Haskell-request-refused")
            result=envelope["result"]
            if (result.get("schema")!="fde.production-kpi-result/v1" or
               result.get("authority")!="non-authoritative-diagnostic" or
               result.get("periodId")!=period or result.get("sourceWriteAllowed") is not False):
                raise ValueError("Haskell-result-invalid")
            persisted=metrics.get(period)
            if (persisted is None or persisted[2]!=good or persisted[3]!=plan or
                Decimal(persisted[4])!=Decimal(result["attainmentPercent"])):
                raise ValueError("Haskell-vs-mart-mismatch")
            results.append(result)
    return {
      "report":{"schema":"fde.performance-report/v1",
                "sourceClass":"synthetic-worksheet",
                "sourceWriteAllowed":False,
                "sourceMeaning":"KPI mart accepted numeric facts; Haskell-owned calculations; native MES produced=0",
                "periods":results},
      "status":"persisted-KPI-reverified-by-Haskell"}

def questions(s:State)->State:
    draft=offline_draft(s["report"])
    if draft["origin"]!="deterministic-human-checklist":
        raise ValueError("unexpected-model-use")
    return {"draft":draft,"status":"offline-investigation-questions"}

def export(s:State)->State:
    x=export_snapshot.export(s["run_id"])
    if x["status"]!="accepted-local-export" or x["source_run_id"]!=s["mart"]["run_id"]:
        raise ValueError("export-manifest-invalid")
    return {"export_dir":x["export_dir"],"status":"source-pinned-excel-snapshot-exported"}

def stage(s:State)->State:
    OUT.mkdir(parents=True,mode=0o700,exist_ok=True)
    if OUT.is_symlink() or OUT.stat().st_mode & 0o077:
        raise ValueError("output-root-unsafe")
    out=OUT/s["run_id"]
    out.mkdir(mode=0o700)
    for name,body in [("performance.json",s["report"]),
                      ("investigation.json",s["draft"])]:
        f=out/name
        with f.open("x",encoding="utf-8") as stream:
            os.fchmod(stream.fileno(),0o600)
            json.dump(body,stream,indent=2,sort_keys=True)
            stream.write("\n")
    receipt={
       "schema":"fde.mart-LangGraph-Excel/v1","run_id":s["run_id"],
       "mart_run":s["mart"]["run_id"],"source_sha256":s["mart"]["source_sha256"],
       "kernel_sha256":s["mart"]["kernel_sha256"],
       "snapshot_export":s["export_dir"],"scope":"15 synthetic reporting months",
       "as_of_date":s["mart"]["as_of"],"modelCalls":0,"vendorWrites":0,
       "review":"pending","status":"staged-for-native-Windows-Excel",
       "atUtc":datetime.now(timezone.utc).isoformat()}
    with (out/"receipt.json").open("x",encoding="utf8") as f:
        os.fchmod(f.fileno(),0o600)
        json.dump(receipt,f,sort_keys=True,indent=2);f.write("\n")
    return {"output_dir":str(out),"status":"staged-for-native-Windows-Excel"}

def desktop_excel(s:State)->State:
    if not s.get("windows"):
        return {"status":"staged-for-native-Windows-Excel"}
    result=windows_render({"windows":True,"run_id":s["run_id"],
                           "output_dir":s["output_dir"]})
    if result.get("status")!="windows-excel-produced-review-pending":
        raise ValueError("Windows-Excel-candidate-refused")
    workbook=Path(result["workbook"])
    receipt_path=Path(s["output_dir"])/"receipt.json"
    receipt=json.loads(receipt_path.read_text())
    receipt["status"]="Excel-candidate-produced"
    receipt["workbook_sha256"]=sha256(workbook.read_bytes()).hexdigest()
    receipt["excel_opened_verification"]="pending-independent-COM-readback"
    with (Path(s["output_dir"])/"workbook-validation.json").open("x",encoding="utf8") as f:
        os.fchmod(f.fileno(),0o600)
        json.dump(receipt,f,sort_keys=True,indent=2);f.write("\n")
    return {"status":"Excel-candidate-produced","workbook":str(workbook)}

def route(s:State):
    return "refuse" if s.get("error") else "continue"

def graph():
    g=StateGraph(State)
    steps=[
      ("validate_accepted_mart",validate_mart),
      ("independently_replay_Haskell",compare_haskell),
      ("prepare_human_questions",questions),
      ("export_postgres_views",export),
      ("stage_review_candidate",stage),
      ("Windows_Excel_render",desktop_excel)
    ]
    for name,action in steps:g.add_node(name,_guard(name,action))
    g.add_node("refuse",lambda s:{"status":"refused"})
    g.add_edge(START,steps[0][0])
    for (name,_),(nextname,_) in zip(steps,steps[1:]):
        g.add_conditional_edges(name,route,{"continue":nextname,"refuse":"refuse"})
    g.add_edge(steps[-1][0],END)
    g.add_edge("refuse",END)
    return g.compile()

def run(run_id:str,windows:bool=False):
    result=graph().invoke({"run_id":run_id,"windows":windows},
                           config={"recursion_limit":18})
    return {key:result[key] for key in (
      "status","error","output_dir","export_dir","workbook") if key in result}

if __name__=="__main__":
    import argparse
    p=argparse.ArgumentParser()
    p.add_argument("--run-id",required=True)
    p.add_argument("--windows-render",action="store_true")
    a=p.parse_args()
    result=run(a.run_id,a.windows_render)
    print(json.dumps(result,sort_keys=True))
    sys.exit(0 if result.get("status") in ("staged-for-native-Windows-Excel","Excel-candidate-produced") else 2)
