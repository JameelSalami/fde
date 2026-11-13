"""Export one accepted, read-only PostgreSQL KPI snapshot for Excel presentation.

Exports *mart views*, never queries ERP/MES directly. The workbook requires
no source-system credentials. All records remain explicitly synthetic.
"""
from __future__ import annotations
from datetime import datetime,timezone
from pathlib import Path
from hashlib import sha256
from decimal import Decimal
from typing import Any
import csv,json,os,re,sys

import psycopg
import load

ROOT=load.FDE/".local/kpi-mart/exports"
SOURCES=[
 ("refresh.csv","v_latest_refresh",1),
 ("rolling_5_days.csv","v_rolling_5_days",5),
 ("rolling_12_months.csv","v_rolling_12_months",108),
 ("current_month.csv","v_current_month",9),
 ("kpi_history.csv","v_kpi_history",2961),
 ("source_shifts.csv","v_source_shifts",314),
 ("source_exposure.csv","v_source_exposure",314),
 ("source_ehs.csv","v_source_ehs",29),
 ("source_maintenance.csv","v_source_maintenance",149),
 ("source_downtime.csv","v_source_downtime",29),
 ("calendar.csv","v_calendar",438),
 ("targets.csv","v_targets",60),
 ("definitions.csv","v_kpi_definitions",9)
]

def get_reader():
    c=load.dbconfig()
    return psycopg.connect(host=c["host"],port=c["port"],dbname=c["database"],
        user=c["reader_user"],password=c["reader_password"],connect_timeout=8,
        options="-c statement_timeout=20000")

def _as_csv(x):
    if x is None:return ""
    if isinstance(x,Decimal):return str(x)
    if isinstance(x,(datetime,)):return x.isoformat()
    if isinstance(x,(dict,list)):return json.dumps(x,sort_keys=True,separators=(",",":"))
    return str(x)

def export(export_id:str):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{2,55}",export_id):
        raise ValueError("invalid-export-id")
    ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
    if ROOT.is_symlink() or ROOT.stat().st_mode & 0o077:
        raise ValueError("output-custody")
    dest=ROOT/export_id
    if dest.exists() or dest.is_symlink():raise ValueError("export-identity-already-exists")
    dest.mkdir(mode=0o700)
    try:
        with get_reader() as conn:
            conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            row=conn.execute("""SELECT run_id,source_sha256,kernel_sha256,as_of_date,
                                 state FROM mart.v_latest_refresh""").fetchone()
            if not row or row[0]!="fde-mart-20261113-v1" or row[4]!="accepted":
                raise ValueError("no-accepted-native-report-run")
            fingerprints={}
            views={}
            for name,view,count in SOURCES:
                cur=conn.execute(f"SELECT * FROM mart.{view}")
                cols=[col.name for col in cur.description]
                rows=cur.fetchall()
                if len(rows)!=count:raise ValueError("report-view-population-refused:"+view)
                f=dest/name
                with f.open("x",encoding="utf8",newline="") as stream:
                    os.fchmod(stream.fileno(),0o600)
                    out=csv.writer(stream)
                    out.writerow(cols)
                    out.writerows([_as_csv(cell) for cell in r] for r in rows)
                fingerprints[name]={"sha256":sha256(f.read_bytes()).hexdigest(),
                                    "rows":count,"columns":cols}
                views[view]=count
            # Fresh standalone source checks against the restricted role:
            if conn.execute("SELECT count(DISTINCT erp_work_order) FROM mart.v_source_shifts").fetchone()[0]!=314:
                raise ValueError("source-ERP-duplicate")
            if conn.execute("SELECT sum(mes_produced_units) FROM mart.v_source_shifts").fetchone()[0]!=0:
                raise ValueError("MES-scenario-contamination")
            later=conn.execute("""SELECT metric_value,status FROM mart.v_current_month
                         WHERE metric_id='PM_ON_TIME'""").fetchone()
            if later!=(None,"not-due"):raise ValueError("not-due-PM-incorrect")
            manifest={
                "schema":"fde.kpi-mart-excel-snapshot/v1",
                "state":"accepted-read-only-local-export",
                "source_run_id":row[0],"source_sha256":row[1],
                "kernel_sha256":row[2],"as_of_date":row[3].isoformat(),
                "export_id":export_id,"exported_at":datetime.now(timezone.utc).isoformat(),
                "files":fingerprints,"views":views,
                "source_kind":"ERPNext/OpenMES installed synthetic-lab readbacks",
                "semantics":{
                  "scenario_good":"synthetic ERPNext scenario record; not MES-produced",
                  "native_mes_produced":"0, PENDING planning orders",
                  "quality":"native sample pass rate, not production FPY",
                  "safety":"synthetic EHS per 100k worker-hours, not OSHA",
                  "maintenance":"PM due-only through report cutoff",
                  "calendar":"provisional weekdays and calendar months",
                  "targets":"synthetic, not approved company targets"
                },
                "cloud_model_calls":0,"vendor_mutations":0,
                "excel_mode":"verified batch-specific CSV snapshot; not live DB connection"
            }
            mf=dest/"manifest.json"
            with mf.open("x",encoding="utf8") as stream:
                os.fchmod(stream.fileno(),0o600)
                json.dump(manifest,stream,sort_keys=True,indent=2)
                stream.write("\n")
            return {"export_dir":str(dest),"as_of":row[3].isoformat(),
                "files":len(fingerprints),"source_run_id":row[0],"status":"accepted-local-export"}
    except Exception:
        # Never leave an accepted-looking manifest on a refused export.
        (dest/"manifest.json").unlink(missing_ok=True)
        raise

if __name__=="__main__":
    import argparse
    p=argparse.ArgumentParser()
    p.add_argument("--export-id",required=True)
    a=p.parse_args()
    try:print(json.dumps(export(a.export_id),sort_keys=True))
    except Exception as e:
        print("MART_EXPORT_REFUSED "+type(e).__name__,file=sys.stderr)
        raise SystemExit(2)
