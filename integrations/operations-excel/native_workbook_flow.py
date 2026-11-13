"""FDE native-readback -> Haskell monthly KPI -> LangGraph -> Windows Excel.

Uses the verified, immutable read-only native ERPNext/OpenMES extract snapshot.
The model is OFF and no ERP/MES/Google/Azure writes are allowed. The worker
uses a dedicated Windows desktop Excel process to render an actual workbook.
"""
from __future__ import annotations
from collections import defaultdict
from hashlib import sha256
from pathlib import Path
from typing import TypedDict, Any
import json,os,re,subprocess,sys
from langgraph.graph import START,END,StateGraph
from azure_model import offline_draft

ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/".local/native-backfill/FDEBF14-20261113/native-excel-refresh.json"
KERNEL=ROOT/"kernel/bin/fde-semantic"
RESULT_ROOT=ROOT/".local/operations-excel/native-runs"
RUN=re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,58}\Z")
WINDOWS_HOST="windows-excel-worker"
WINDOWS_ROOT="C:/FDE-Demo/Excel-Worker"
RENDERER=ROOT/"integrations/operations-excel/RenderExcel.ps1"

class State(TypedDict,total=False):
    run_id:str
    windows:bool
    source:dict[str,Any]
    report:dict[str,Any]
    draft:dict[str,Any]
    output_dir:str
    workbook:str
    model_status:str
    status:str
    error:str

def _node(method):
    def wrapper(s):
        try:return method(s)
        except Exception:
            return {"status":"refused","error":method.__name__+"-refused"}
    return wrapper

def validate(s:State):
    runid=s["run_id"]
    if not RUN.fullmatch(runid):raise ValueError("run-id")
    if not SOURCE.is_file() or SOURCE.is_symlink() or SOURCE.stat().st_size>2_000_000:
        raise ValueError("native-extract-path")
    data=json.loads(SOURCE.read_text())
    if (data.get("schema")!="fde.excel-native-refresh/v1" or
        data.get("run_id")!="FDEBF14-20261113" or
        len(data.get("shifts",[]))!=314 or len(data.get("pm",[]))!=149 or
        len(data.get("downtime",[]))!=29 or len(data.get("targets",[]))!=60 or
        len(data.get("exposure",[]))!=314):
        raise ValueError("native-contract")
    if sum(int(x["plan"]) for x in data["shifts"])!=5754:
        raise ValueError("native-plan-total")
    if any(int(x["mes_produced"])!=0 or
           int(x["quality_samples"])!=5 or
           not 0<=int(x["quality_sample_passed"])<=5
           for x in data["shifts"]):
        raise ValueError("native-MES-or-quality-contract")
    if any(x["date"]>=data["source_inventory"]["asof"]+"x"
           for x in []):raise ValueError("never")  # no inferred future source
    return {"source":data,"status":"native-extract-validated"}

def haskell(s:State):
    data=s["source"]
    grouped=defaultdict(lambda:dict(plan=0,good=0,reject=0,unfinished=0))
    for row in data["shifts"]:
        b=grouped[row["period"]]
        for key,source_field in [("plan","plan"),("good","scenario_good"),
                                 ("reject","scenario_reject"),("unfinished","scenario_unfinished")]:
            b[key]+=int(row[source_field])
    result=[]
    for period in sorted(grouped):
        g=grouped[period]
        if g["plan"]!=g["good"]+g["reject"]+g["unfinished"]:
            raise ValueError("source-scenario-reconciliation")
        req={"schema":"fde.production-kpi-request/v1",
           "periodId":period,"lineId":"CNDEMO-LINE-1",
           "sourceClass":"synthetic-worksheet",
           "plannedUnits":str(g["plan"]),"goodUnits":str(g["good"]),
           "losses":[{"id":"scenario-rejected","units":str(g["reject"])},
                     {"id":"scenario-unfinished","units":str(g["unfinished"])}]}
        p=subprocess.run([str(KERNEL)],cwd=ROOT,input=json.dumps(req),text=True,
                         capture_output=True,timeout=16,check=False)
        if p.returncode or len(p.stdout)>200000:raise ValueError("Haskell-KPI-refused")
        value=json.loads(p.stdout)
        if value.get("ok") is not True:raise ValueError("Haskell-interpretation-refused")
        r=value["result"]
        if (r["periodId"]!=period or r["plannedUnits"]!=str(g["plan"]) or
           r["goodUnits"]!=str(g["good"]) or r["sourceWriteAllowed"] is not False):
            raise ValueError("Haskell-reply-binding")
        result.append(r)
    if len(result)!=15:raise ValueError("monthly-period-count")
    report={"schema":"fde.performance-report/v1",
        "sourceClass":"synthetic-worksheet",
        "sourceWriteAllowed":False,
        "sourceMeaning":"Haskell calculations over ERPNext synthetic scenario output; native MES produced=0",
        "periods":result}
    return {"report":report,"status":"Haskell-monthly-verified"}

def draft(s:State):
    result=offline_draft(s["report"])
    if result["origin"]!="deterministic-human-checklist":
        raise ValueError("offline-only")
    return {"draft":result,"model_status":"offline-no-azure-call","status":"draft-prepared"}

def stage(s:State):
    root=RESULT_ROOT
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    if root.is_symlink() or root.stat().st_mode & 0o077:
        raise ValueError("output-root-access")
    out=root/s["run_id"]
    out.mkdir(mode=0o700)
    for name,body in (("performance.json",s["report"]),
                      ("investigation.json",s["draft"])):
        with (out/name).open("x",encoding="utf8") as f:
            os.fchmod(f.fileno(),0o600)
            json.dump(body,f,sort_keys=True,indent=2)
            f.write("\n")
    receipt={"schema":"fde.native-excel-langgraph/v1","run_id":s["run_id"],
      "source_sha256":sha256(SOURCE.read_bytes()).hexdigest(),
      "kernel_sha256":sha256(KERNEL.read_bytes()).hexdigest(),
      "source_class":"native readback + Frappe synthetic modelled scenarios",
      "Haskell_periods":15,"Azure_model_calls":0,"vendor_writes":0,
      "review":"pending","status":"excel-inputs-verified"}
    with (out/"receipt.json").open("x",encoding="utf8") as f:
        os.fchmod(f.fileno(),0o600)
        json.dump(receipt,f,sort_keys=True,indent=2);f.write("\n")
    return {"output_dir":str(out),"status":"excel-inputs-verified"}

def windows(s:State):
    if not s.get("windows"):
        return {"status":"staged-for-windows"}
    out=Path(s["output_dir"])
    run=s["run_id"]
    wdir=WINDOWS_ROOT+"/"+run
    def exec_cmd(argv,seconds=45):
        res=subprocess.run(argv,capture_output=True,text=True,timeout=seconds)
        if res.returncode:return False,res
        return True,res
    remote_cmd = ('powershell.exe -NoProfile -NonInteractive -Command '
                  + '"New-Item -Force -ItemType Directory -Path '
                  + wdir.replace("/", "\\\\") + ' | Out-Null"')
    ok,p=exec_cmd(["ssh","-o","BatchMode=yes","-o","ConnectTimeout=7",
                   WINDOWS_HOST,remote_cmd],20)
    if not ok:raise ValueError("windows-mkdir-refused")
    for src,dest in [(out/"performance.json","performance.json"),
                      (out/"investigation.json","investigation.json"),
                      (RENDERER,"RenderExcel.ps1")]:
        ok,p=exec_cmd(["scp","-q","-o","BatchMode=yes",
            str(src),WINDOWS_HOST+":"+wdir+"/"+dest],25)
        if not ok:raise ValueError("scp-staged-input-refused")
    wfile=wdir+"/Manufacturing_Performance.xlsx"
    argv=["ssh","-o","BatchMode=yes",WINDOWS_HOST,
       "powershell.exe","-NoProfile","-NonInteractive",
       "-ExecutionPolicy","Bypass","-File",wdir+"/RenderExcel.ps1",
       "-ReportJson",wdir+"/performance.json",
       "-InvestigationJson",wdir+"/investigation.json","-OutputXlsx",wfile]
    ok,p=exec_cmd(argv,95)
    if not ok or "EXCEL_FILE=" not in p.stdout:
        raise ValueError("Excel-COM-render-refused")
    local=out/"Manufacturing_Performance.xlsx"
    ok,p=exec_cmd(["scp","-q",WINDOWS_HOST+":"+wfile,str(local)],35)
    if not ok or not local.is_file() or local.stat().st_size<3000:
        raise ValueError("Excel-output-readback-refused")
    import zipfile
    with zipfile.ZipFile(local) as z:
        if z.testzip() is not None or "xl/workbook.xml" not in z.namelist():
            raise ValueError("Excel-corrupt-output")
    return {"workbook":str(local),"status":"windows-excel-produced-review-pending"}

def route(s:State)->str:
    return "refuse" if s.get("error") else "continue"

def graph():
    g=StateGraph(State)
    for name,method in (("validate_native_extract",validate),
                        ("FDE_Haskell_monthly_KPIs",haskell),
                        ("offline_investigation_questions",draft),
                        ("stage_Excel_payloads",stage),
                        ("Windows_Excel_native_render",windows)):
        g.add_node(name,_node(method))
    g.add_node("refuse",lambda s:{"status":"refused"})
    chain=["validate_native_extract","FDE_Haskell_monthly_KPIs",
           "offline_investigation_questions","stage_Excel_payloads","Windows_Excel_native_render"]
    g.add_edge(START,chain[0])
    for name,nextname in zip(chain,chain[1:]):
        g.add_conditional_edges(name,route,{"refuse":"refuse","continue":nextname})
    g.add_edge("Windows_Excel_native_render",END)
    g.add_edge("refuse",END)
    return g.compile()

def run(run_id:str,windows_render:bool=False):
    result=graph().invoke({"run_id":run_id,"windows":windows_render},
                          config={"recursion_limit":16})
    return {key:result[key] for key in ("status","error","output_dir","workbook","model_status")
            if key in result}

if __name__=="__main__":
    import argparse
    p=argparse.ArgumentParser()
    p.add_argument("--run-id",required=True)
    p.add_argument("--windows-render",action="store_true")
    x=p.parse_args()
    result=run(x.run_id,x.windows_render)
    print(json.dumps(result))
    raise SystemExit(0 if result["status"] in
       ("windows-excel-produced-review-pending","staged-for-windows") else 2)
