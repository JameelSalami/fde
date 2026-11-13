"""Complete FDE LangGraph KPI mart → 16-sheet Windows Excel refresh.

All source reads use the accepted, isolated PostgreSQL KPI mart. Every output
is run-scoped, checksum-pinned, independently recalculated by Haskell, and
opened in native Windows Excel for validation. Source systems and cloud models
are never called with write credentials or inference. A completed candidate
still requires human acceptance of the engineering report.
"""
from __future__ import annotations
from hashlib import sha256
from pathlib import Path
from typing import Any,TypedDict
import argparse,json,os,subprocess,sys,zipfile

from langgraph.graph import StateGraph,START,END
import mart_excel_flow as base
from mart_excel_flow import (
    ROOT,State,validate_mart,compare_haskell,questions,
    export,stage,route,_guard
)

WINHOST="windows-excel-worker"
WINBASE="C:/FDE-Demo/Excel-Worker"
SCRIPT=ROOT/"integrations/kpi-mart/RefreshFullMartWorkbook.ps1"
VERIFY=ROOT/"integrations/kpi-mart/VerifyFullMartWorkbook.ps1"
FILENAME="FDE_KPI_Mart_16_Sheet.xlsx"

class FullState(State,total=False):
    native_excel_receipt:dict[str,Any]
    previous_run:str

def _full_guard(name,action):
    # Use the FULL graph schema when invoking a node. The base graph's
    # narrower State annotation strips previous_run during node dispatch.
    def wrapped(state:FullState)->FullState:
        try:
            return action(state)
        except Exception:
            return {"status":"refused","error":name+"-refused"}
    return wrapped

def execute(argv:list[str],timeout:int=45)->str:
    if not argv or argv[0] not in ("ssh","scp"):
        raise ValueError("disallowed-process-boundary")
    try:
        p=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                 text=True,timeout=timeout,check=False)
    except (OSError,subprocess.TimeoutExpired):
        raise ValueError("authorized-Windows-boundary-unavailable")
    if p.returncode:
        raise ValueError("Windows-boundary-refused")
    return p.stdout.strip()

def install_windows_stage(s:FullState)->FullState:
    if not s.get("windows"):
        return {"status":"mart-snapshot-prepared-no-Windows-action"}
    run_id=s["run_id"]
    if not base.RUN_RE.fullmatch(run_id):raise ValueError("invalid-run-id")
    previous=s.get("previous_run")
    if previous and (not base.RUN_RE.fullmatch(previous) or previous==run_id):
        raise ValueError("invalid-prior-workbook-identity")
    d=Path(s["export_dir"])
    out=Path(s["output_dir"])
    if not d.is_dir() or d.is_symlink() or not out.is_dir():
        raise ValueError("uncertain-source-or-output")
    manifest=json.loads((d/"manifest.json").read_text())
    if (manifest.get("schema")!="fde.kpi-mart-excel-snapshot/v1"
        or manifest.get("source_run_id")!=s["mart"]["run_id"]
        or manifest.get("source_sha256")!=s["mart"]["source_sha256"]
        or manifest.get("state")!="accepted-read-only-local-export"
        or manifest.get("cloud_model_calls")!=0):
        raise ValueError("mart-export-not-accepted")
    expected={str(x) for x in manifest["files"].keys()}|{"manifest.json"}
    if len(expected)!=14 or {x.name for x in d.iterdir()}!=expected:
        raise ValueError("unexpected-export-file-identity")
    for n in expected:
        f=d/n
        if not f.is_file() or f.is_symlink() or f.stat().st_size>1_200_000:
            raise ValueError("invalid-snapshot-input")
        if n!="manifest.json" and sha256(f.read_bytes()).hexdigest()!=manifest["files"][n]["sha256"]:
            raise ValueError("source-snapshot-rewritten")
    if not SCRIPT.is_file() or not VERIFY.is_file():
        raise ValueError("missing-reviewed-Windows-renderer")
    remote=WINBASE+"/"+run_id
    # The root is an existing owner-controlled, Windows-local temp location.
    # No public endpoint or exposed database listener is created.
    dirs=[remote,remote+"/snapshot"]
    create='; '.join("New-Item -Force -ItemType Directory -Path "+path.replace("/",r"\\")+" | Out-Null"
                     for path in dirs)
    cmd='powershell.exe -NoProfile -NonInteractive -Command "'+create+'"'
    execute(["ssh","-o","BatchMode=yes","-o","ConnectTimeout=8",WINHOST,cmd],20)
    dest=WINHOST+":"+remote+"/snapshot/"
    inputs=[str(d/f) for f in sorted(expected)]
    execute(["scp","-q","-o","BatchMode=yes",*inputs,dest],35)
    execute(["scp","-q","-o","BatchMode=yes",str(SCRIPT),str(VERIFY),
             WINHOST+":"+remote+"/"],25)
    return {"status":"Windows-16sheet-snapshot-staged"}

def render_full_excel(s:FullState)->FullState:
    if not s.get("windows"):
        return {"status":"mart-snapshot-prepared-no-Windows-action"}
    remote=WINBASE+"/"+s["run_id"]
    workbook=remote+"/"+FILENAME
    argv=["ssh","-o","BatchMode=yes","-o","ConnectTimeout=8",WINHOST,
          "powershell.exe","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass",
          "-File",remote+"/RefreshFullMartWorkbook.ps1",
          "-SourceFolder",remote+"/snapshot","-Destination",workbook]
    previous=s.get("previous_run")
    if previous:
        if not base.RUN_RE.fullmatch(previous) or previous==s["run_id"]:
            raise ValueError("invalid-prior-workbook-identity")
        argv.extend(["-Previous",WINBASE+"/"+previous+"/"+FILENAME])
    out=execute(argv,160)
    if "FDE_FULL_16_SHEET_CREATED=" not in out or "SHEETS=16" not in out:
        raise ValueError("Windows-did-not-confirm-full-workbook")
    local=Path(s["output_dir"])/FILENAME
    if local.exists() or local.is_symlink():
        raise ValueError("output-overwrite-refused")
    execute(["scp","-q","-o","BatchMode=yes",WINHOST+":"+workbook,str(local)],35)
    if not local.is_file() or local.stat().st_size<10000 or local.stat().st_size>8_000_000:
        raise ValueError("unexpected-xlsx-size")
    with zipfile.ZipFile(local) as z:
        names=set(z.namelist())
        if z.testzip() is not None or "xl/workbook.xml" not in names:
            raise ValueError("invalid-xlsx-archive")
        if any(x in names for x in ("xl/connections.xml","xl/vbaProject.bin")):
            raise ValueError("external-connections-or-macros-in-xlsx")
    return {"status":"Windows-16sheet-candidate-produced","workbook":str(local)}

def excel_readback(s:FullState)->FullState:
    if not s.get("windows"):
        return {"status":"mart-snapshot-prepared-no-Windows-action"}
    remote=WINBASE+"/"+s["run_id"]
    argv=["ssh","-o","BatchMode=yes","-o","ConnectTimeout=8",WINHOST,
          "powershell.exe","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass",
          "-File",remote+"/VerifyFullMartWorkbook.ps1",
          "-Workbook",remote+"/"+FILENAME]
    raw=execute(argv,35)
    try:
        info=json.loads(raw.splitlines()[-1])
    except (ValueError,IndexError):
        raise ValueError("Excel-review-not-structured")
    if (info.get("status")!="COM_VERIFIED" or info.get("sheetCount")!=16
        or info.get("latestDay")!="2026-11-12"
        or info.get("latestClosed")!="2026-10"
        or abs(float(info.get("currentScenario",-1))-.8526)>1e-6
        or abs(float(info.get("currentQc",-1))-.8889)>1e-6
        or float(info.get("nativeMesProduced",-1))!=0
        or info.get("futurePmStatus")!="blank-not-due"
        or info.get("externalConnections")!=0 or info.get("monthlyCharts",0)<1):
        raise ValueError("Excel-acceptance-inconsistent")
    local=Path(s["workbook"])
    receipt={
      "schema":"fde.16sheet-native-Excel-acceptance/v1",
      "run_id":s["run_id"],"mart_run":s["mart"]["run_id"],
      "source_sha256":s["mart"]["source_sha256"],
      "kernel_sha256":s["mart"]["kernel_sha256"],
      "xlsx_sha256":sha256(local.read_bytes()).hexdigest(),
      "native_excel":info,"cloud_model_calls":0,"source_system_writes":0,
      "source_class":"SYNTHETIC_SCENARIO_NOT_PHYSICAL",
      "status":"software-accepted-human-review-pending",
      "previous_action_run":s.get("previous_run")
    }
    receipt_file=Path(s["output_dir"])/"full-excel-validation.json"
    with receipt_file.open("x",encoding="utf8") as file:
        os.fchmod(file.fileno(),0o600)
        json.dump(receipt,file,sort_keys=True,indent=2)
        file.write("\n")
    return {"native_excel_receipt":info,"status":"software-accepted-human-review-pending"}

def graph():
    g=StateGraph(FullState)
    stages=[
      ("validate_accepted_mart",validate_mart),
      ("independent_Haskell_replay",compare_haskell),
      ("offline_review_questions",questions),
      ("read_only_SQL_export",export),
      ("stage_run_receipt",stage),
      ("stage_approved_Windows_snapshot",install_windows_stage),
      ("render_full_16_sheet_workbook",render_full_excel),
      ("independent_Windows_Excel_readback",excel_readback)
    ]
    for name,fn in stages:g.add_node(name,_full_guard(name,fn))
    g.add_node("refuse",lambda s:{"status":"refused"})
    g.add_edge(START,stages[0][0])
    for (name,_),(nextname,_) in zip(stages,stages[1:]):
        g.add_conditional_edges(name,route,{"continue":nextname,"refuse":"refuse"})
    g.add_edge(stages[-1][0],END)
    g.add_edge("refuse",END)
    return g.compile()

def run(run_id:str,windows:bool=True,previous_run:str|None=None):
    state={"run_id":run_id,"windows":windows}
    if previous_run:state["previous_run"]=previous_run
    r=graph().invoke(state,
            config={"recursion_limit":25})
    return {k:r[k] for k in ("status","error","output_dir","export_dir",
             "workbook","native_excel_receipt") if k in r}

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--run-id",required=True)
    parser.add_argument("--skip-windows",action="store_true")
    parser.add_argument("--previous-run-id",
        help="Optional earlier Windows run ID whose manual Action Tracker entries are preserved")
    args=parser.parse_args()
    result=run(args.run_id,windows=not args.skip_windows,previous_run=args.previous_run_id)
    print(json.dumps(result,sort_keys=True))
    raise SystemExit(0 if result.get("status") in
       ("software-accepted-human-review-pending","mart-snapshot-prepared-no-Windows-action") else 2)
