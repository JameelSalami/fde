#!/usr/bin/env python3
"""FDE KPI mart: atomic load from independently checked synthetic ERP/MES export.

Numerical meanings:
- Production scenario attainment is calculated by FDE compiled Haskell.
- Quality is *sample pass rate*, NEVER production first pass yield.
- Safety synthetic event incidence is NOT OSHA's regulatory TRIR.
- Maintenance PM due/on-time counts exclude obligations after report cutoff.
- MES recorded production remains separate from synthetic scenario-good.
The source ERP/MES services are never modified by this program.
"""
from __future__ import annotations

from collections import defaultdict,Counter
from datetime import date,datetime,timezone
from decimal import Decimal,ROUND_HALF_UP
from hashlib import sha256
from pathlib import Path
from typing import Any
import argparse,json,os,re,subprocess,sys

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg import sql

FDE=Path(__file__).resolve().parents[2]
SOURCE=FDE/".local/native-backfill/FDEBF14-20261113/native-excel-refresh.json"
SECRETS=FDE/".local/kpi-mart/mart-secrets.json"
KERNEL=FDE/"kernel/bin/fde-semantic"
AS_OF=date(2026,11,12)
NATIVE_RUN="FDEBF14-20261113"
SOURCE_CLASS="SYNTHETIC_LAB_NATIVE_OBSERVATIONS_AND_EXPLICIT_SCENARIO_VALUES"
ZERO=Decimal(0)
CENT=Decimal("0.01")
RATIOS=[
("SCENARIO_ATTAINMENT","Production","Scenario attainment","Synthetic scenario-good units",
 "Approved synthetic planned units","percent","FDE Haskell","fde.production-kpi-result/v1",
 "Modelled good is NOT native MES-produced output"),
("NATIVE_MES_OUTPUT_UNITS","Production","Native MES-produced units","Native MES produced_qty",
 None,"units","native sum","native-erp-mes/v1","PENDING native MES Work Orders currently report zero"),
("QC_SAMPLE_PASS","Quality","QC sample pass rate","Passed native QC samples",
 "All native QC samples","percent","Python Decimal/SQL verification","qc-sample-ratio/v1",
 "Five sampled checks per batch; NOT production first-pass yield"),
("QC_CHECK_COUNT","Quality","Native QC checks","Quality Check rows",None,"checks",
 "native sum","native-openmes/v1","QC checks are not finished-product unit acceptance"),
("SYNTHETIC_EVENT_RATE","Safety","Synthetic events per 100k worker hours",
 "Modelled synthetic safety events","Synthetic completed worker exposure hours",
 "events-per-100k-hours","Python Decimal/SQL verification","synthetic-ehs-frequency/v1",
 "NOT reportable OSHA TRIR, not an established physical incident population"),
("SYNTHETIC_EVENT_COUNT","Safety","Synthetic EHS event count",
 "Modelled synthetic incidents/near misses/observations",None,"events","native sum",
 "synthetic-ehs-count/v1","Kinds retained; no OSHA reportability asserted"),
("PM_ON_TIME","Maintenance","Synthetic PM compliance",
 "Native PM completed no later than scheduled due date",
 "Native PM obligations due through as-of","percent","Python Decimal/SQL verification",
 "synthetic-PM/v1","Do not include future obligations in denominator"),
("PM_DUE_COUNT","Maintenance","PM obligations due","Native scheduled PM due through as-of",
 None,"events","native sum","native-openmes-PM/v1",
 "Completed scenario PMs are not physical equipment service"),
("DOWNTIME_MINUTES","Maintenance","Modelled downtime minutes",
 "Native synthetic downtime duration in minutes",None,"minutes",
 "native sum","native-openmes-downtime/v1",
 "Synthetic downtime, not machine telemetry"),
]
METRIC={d[0]:d for d in RATIOS}

class Refused(Exception):pass

def refusal(reason:str):
    raise Refused(reason)

def dbconfig():
    if not SECRETS.is_file() or SECRETS.is_symlink() or SECRETS.stat().st_mode & 0o077:
        refusal("private-credential-custody")
    d=json.loads(SECRETS.read_text())
    if (d.get("host")!="127.0.0.1" or d.get("port")!=55433 or
        d.get("database")!="fde_kpi" or d.get("owner_user")!="fde_kpi_owner"):
        refusal("db-identity-drift")
    return d

def connect():
    d=dbconfig()
    return psycopg.connect(host=d["host"],port=d["port"],dbname=d["database"],
        user=d["owner_user"],password=d["owner_password"],connect_timeout=8,
        options="-c statement_timeout=30000 -c idle_in_transaction_session_timeout=30000")

def _safe_date(value):
    try:d=date.fromisoformat(value)
    except (ValueError,TypeError):refusal("non-iso-business-date")
    return d

def source():
    if not SOURCE.is_file() or SOURCE.is_symlink() or SOURCE.stat().st_size>3_000_000:
        refusal("source-path-budget")
    raw=SOURCE.read_bytes()
    d=json.loads(raw)
    if (d.get("schema")!="fde.excel-native-refresh/v1" or
        d.get("run_id")!=NATIVE_RUN or d.get("source_type")!=SOURCE_CLASS):
        refusal("source-identity-or-data-grade")
    lengths={"shifts":314,"exposure":314,"ehs":29,"calendar":438,
             "targets":60,"pm":149,"downtime":29}
    for key,length in lengths.items():
        if len(d.get(key,[]))!=length:refusal("source-cardinality:"+key)
    if d.get("source_inventory",{}).get("MES_produced_units")!=0:
        refusal("native-MES-produced-measure-changed")
    if d["source_inventory"].get("asof")!=AS_OF.isoformat():
        refusal("source-asof-changed")
    dates=set();erp_ids=set();mes_ids=set()
    plan=0;quality_samples=0
    for x in d["shifts"]:
        work_date=_safe_date(x["date"])
        if work_date in dates or work_date>AS_OF:refusal("duplicate-or-future-work-date")
        dates.add(work_date)
        if x["erp"] in erp_ids or x["mes"] in mes_ids:refusal("nonunique-source-order")
        erp_ids.add(x["erp"]);mes_ids.add(x["mes"])
        qty=[int(x[k]) for k in ("plan","scenario_good","scenario_reject","scenario_unfinished","mes_produced")]
        if any(v<0 for v in qty) or qty[0]!=sum(qty[1:4]) or qty[4]!=0:
            refusal("source-native-vs-scenario-quantity")
        if int(x["quality_checks"])!=1 or int(x["quality_samples"])!=5 or not 0<=int(x["quality_sample_passed"])<=5:
            refusal("quality-source-cardinality")
        if x["period"]!=work_date.strftime("%Y-%m") or x["data_class"]!="SYNTHETIC_SCENARIO":
            refusal("source-period-class")
        plan+=qty[0];quality_samples+=int(x["quality_samples"])
    if plan!=5754 or quality_samples!=1570 or len(dates)!=314:
        refusal("independent-control-totals")
    cal={x["date"]:x for x in d["calendar"]}
    if len(cal)!=438 or any(day not in cal or int(cal[day]["scheduled"])!=1 for day in (x["date"] for x in d["shifts"])):
        refusal("calendar-shift-completeness")
    if len(set((x["period"],x["department"],x["metric"]) for x in d["targets"]))!=60:
        refusal("target-key-conflict")
    if len(set(x["title"] for x in d["pm"]))!=149 or len(set(x["notes"] for x in d["downtime"]))!=29:
        refusal("native-maintenance-identity")
    if sha256(SOURCE.read_bytes()).digest()!=sha256(raw).digest():
        refusal("source-changed-during-review")
    return d,sha256(raw).hexdigest()

def ratio(num:int|Decimal,den:int|Decimal,factor:int=100):
    if den==0:return None
    return (Decimal(num)*Decimal(factor)/Decimal(den)).quantize(CENT,rounding=ROUND_HALF_UP)

def haskell_production(period_key:str,plan:int,good:int,scenario_reject:int,scenario_unfinished:int):
    if not KERNEL.is_file() or KERNEL.is_symlink():
        refusal("compiled-kernel-unavailable")
    req={"schema":"fde.production-kpi-request/v1","periodId":period_key,
         "lineId":"CNDEMO-LINE-1","sourceClass":"synthetic-worksheet",
         "plannedUnits":str(plan),"goodUnits":str(good),
         "losses":[{"id":"scenario-rejected","units":str(scenario_reject)},
                   {"id":"scenario-unfinished","units":str(scenario_unfinished)}]}
    try:
        p=subprocess.run([str(KERNEL)],input=json.dumps(req),text=True,
                         capture_output=True,timeout=12,check=False,env={"PATH":"/usr/bin:/bin"})
    except (OSError,subprocess.TimeoutExpired):
        refusal("Haskell-execution-unavailable")
    if p.returncode!=0 or len(p.stdout)>240_000:refusal("Haskell-execution-refused")
    try:r=json.loads(p.stdout)
    except ValueError:refusal("Haskell-protocol-non-JSON")
    if r.get("ok") is not True or not isinstance(r.get("result"),dict):
        refusal("Haskell-diagnostic-refusal")
    v=r["result"]
    if (v.get("schema")!="fde.production-kpi-result/v1" or
        v.get("authority")!="non-authoritative-diagnostic" or
        v.get("sourceWriteAllowed") is not False or
        v.get("periodId")!=period_key or v.get("plannedUnits")!=str(plan) or
        v.get("goodUnits")!=str(good) or v.get("sourceClass")!="synthetic-worksheet" or
        v.get("lossStatus")!="reconciled"):
        refusal("Haskell-response-boundary")
    expected=ratio(good,plan)
    result=Decimal(v["attainmentPercent"]) if v.get("attainmentPercent") is not None else None
    if expected!=result:refusal("independent-Haskell-arithmetic-crosscheck")
    return result

def _numeric(row:dict[str,Any]):
    return {k:int(v) for k,v in row.items() if k not in
        ("date","period","line","erp","mes","data_class")}

def aggregate(data:dict[str,Any]):
    # All reporting dates and scenario states already validated by source().
    by_day={}
    by_month=defaultdict(list)
    for x in data["shifts"]:
        day=x["date"]
        if day in by_day:refusal("duplicate-day")
        by_day[day]=x
        by_month[x["period"]].append(x)
    if len(by_month)!=15:refusal("historical-month-horizon")

    expos={x["date"]:x for x in data["exposure"]}
    if len(expos)!=314 or set(expos)!=set(by_day):
        refusal("exposure-shift-population-mismatch")
    events=defaultdict(list)
    for e in data["ehs"]:events[e["date"]].append(e)
    maint=defaultdict(list)
    for e in data["pm"]:maint[e["due"]].append(e)
    down=defaultdict(list)
    for x in data["downtime"]:down[x["date"]].append(x)

    results=[]
    for grain,groups in (
        ("day",{day:[x] for day,x in by_day.items()}),
        ("month",dict(by_month))
    ):
        for period,shifts in sorted(groups.items()):
            is_day=(grain=="day")
            date_set={x["date"] for x in shifts}
            base_period=shifts[0]["period"]
            plan=sum(int(x["plan"]) for x in shifts)
            good=sum(int(x["scenario_good"]) for x in shifts)
            reject=sum(int(x["scenario_reject"]) for x in shifts)
            unfinished=sum(int(x["scenario_unfinished"]) for x in shifts)
            mes=sum(int(x["mes_produced"]) for x in shifts)
            samples=sum(int(x["quality_samples"]) for x in shifts)
            passed=sum(int(x["quality_sample_passed"]) for x in shifts)
            checks=sum(int(x["quality_checks"]) for x in shifts)
            if is_day:
                ehs=[e for e in events.get(period,[])]
                exp_hours=Decimal(str(expos[period]["hours"]))
                current_maint=maint.get(period,[])
                current_down=down.get(period,[])
            else:
                ehs=[e for date_str,group in events.items()
                       if date_str[:7]==period for e in group]
                exp_hours=sum((Decimal(str(expos[x["date"]]["hours"])) for x in shifts),ZERO)
                current_maint=[e for day,group in maint.items() if day[:7]==period for e in group]
                current_down=[x for day,group in down.items() if day[:7]==period for x in group]
            pm_due=[e for e in current_maint if e["type"]=="planned" and
                       _safe_date(e["due"])<=AS_OF]
            pm_on=[e for e in pm_due if e["completed"] and
                   _safe_date(e["completed"])<=_safe_date(e["due"])]
            downtime=sum(int(x["duration_minutes"]) for x in current_down)
            hresult=haskell_production(period,plan,good,reject,unfinished)
            # metric ID, numerator, denominator, value, status
            tuples=[
             ("SCENARIO_ATTAINMENT",good,plan,hresult,"calculated-synthetic"),
             ("NATIVE_MES_OUTPUT_UNITS",mes,None,Decimal(mes),"native-reported"),
             ("QC_SAMPLE_PASS",passed,samples,ratio(passed,samples),"calculated-synthetic"),
             ("QC_CHECK_COUNT",checks,None,Decimal(checks),"native-reported"),
             ("SYNTHETIC_EVENT_RATE",len(ehs),exp_hours,ratio(len(ehs),exp_hours,100000),"calculated-synthetic"),
             ("SYNTHETIC_EVENT_COUNT",len(ehs),None,Decimal(len(ehs)),"calculated-synthetic"),
             ("PM_ON_TIME",len(pm_on),len(pm_due),ratio(len(pm_on),len(pm_due)),
               "calculated-synthetic" if pm_due else "not-due"),
             ("PM_DUE_COUNT",len(pm_due),None,Decimal(len(pm_due)),"calculated-synthetic"),
             ("DOWNTIME_MINUTES",downtime,None,Decimal(downtime),"native-reported")
            ]
            for metric,numerator,denominator,value,status in tuples:
                if denominator==0 and value is None and status!="not-due":
                    status="unknown-denominator"
                m=METRIC[metric]
                results.append((grain,period,m[1],metric,
                                Decimal(numerator) if numerator is not None else None,
                                Decimal(denominator) if denominator is not None else None,
                                value,m[5],m[7],m[6],status,m[8]))
    return results

def apply(run_id:str="fde-mart-20261113-v1"):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{2,79}",run_id):
        refusal("mart-run-id-invalid")
    data,source_digest=source()
    kdigest=sha256(KERNEL.read_bytes()).hexdigest()
    report=aggregate(data)
    if len(report)!= (314+15)*len(RATIOS):
        refusal("metric-result-count-changed")
    # Completely load in one transaction; charts never see partially imported facts.
    with connect() as conn:
        conn.execute("SET LOCAL lock_timeout='5000ms'")
        conn.execute("SET LOCAL statement_timeout='45000ms'")
        previous=conn.execute("SELECT state,source_sha256,kernel_sha256 FROM mart.refresh_run WHERE run_id=%s",(run_id,)).fetchone()
        if previous:
            if previous[0]=='accepted' and previous[1]==source_digest and previous[2]==kdigest:
                got=conn.execute("SELECT count(*) FROM mart.kpi_result WHERE run_id=%s",(run_id,)).fetchone()[0]
                if got!=len(report):refusal("existing-mart-run-result-cardinality")
                return {"status":"already-accepted","run_id":run_id,"kpi_results":got}
            refusal("mart-run-identity-reuse-refused")
        with conn.cursor() as cur:
            cur.execute(
              """INSERT INTO mart.refresh_run
                 (run_id,native_source_run_id,source_sha256,kernel_sha256,as_of_date,state,source_data_class,source_inventory)
                 VALUES (%s,%s,%s,%s,%s,'loading',%s,%s)""",
              (run_id,NATIVE_RUN,source_digest,kdigest,AS_OF,SOURCE_CLASS,Jsonb(data["source_inventory"])))
            cur.executemany(
              """INSERT INTO mart.calendar_day
               (run_id,work_date,period_key,scheduled,holiday_state,fiscal_year,fiscal_period,calendar_version)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
              [(run_id,x["date"],x["period"],bool(x["scheduled"]),x["holiday"],
                int(x["fiscal_year"]),int(x["fiscal_period"]),"PROVISIONAL_WEEKDAYS_SHIFT_A")
               for x in data["calendar"]])
            cur.executemany(
              """INSERT INTO mart.kpi_target
              (run_id,period_key,department,metric_id,target_value,status)
              VALUES (%s,%s,%s,%s,%s,'SYNTHETIC_NOT_BUSINESS_APPROVED')""",
              [(run_id,x["period"],x["department"],x["metric"],Decimal(str(x["value"])))
                for x in data["targets"]])
            cur.executemany(
              """INSERT INTO mart.source_shift
              (run_id,work_date,period_key,line_code,erp_work_order,mes_work_order,
              planned_units,scenario_good_units,scenario_reject_units,scenario_unfinished_units,
              mes_produced_units,qc_sample_count,qc_passed_count,qc_check_count,data_class)
              VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
              [(run_id,x["date"],x["period"],x["line"],x["erp"],x["mes"],
                x["plan"],x["scenario_good"],x["scenario_reject"],x["scenario_unfinished"],
                x["mes_produced"],x["quality_samples"],x["quality_sample_passed"],
                x["quality_checks"],x["data_class"])
                for x in data["shifts"]])
            cur.executemany(
              """INSERT INTO mart.source_exposure
              (run_id,work_date,period_key,exposure_hours,worker_count,coverage)
              VALUES (%s,%s,%s,%s,%s,%s)""",
              [(run_id,x["date"],x["period"],Decimal(str(x["hours"])),x["workers"],x["coverage"])
               for x in data["exposure"]])
            cur.executemany(
              """INSERT INTO mart.source_ehs_event
              (run_id,event_key,occurred_date,period_key,event_kind,lost_days,action_status)
              VALUES (%s,%s,%s,%s,%s,%s,%s)""",
              [(run_id,NATIVE_RUN+"|EHS|"+x["date"]+"|"+x["kind"],x["date"],x["period"],
                x["kind"],x["lost_days"],x["action_status"])
               for x in data["ehs"]])
            cur.executemany(
              """INSERT INTO mart.source_maintenance
              (run_id,source_title,event_type,source_status,scheduled_date,completed_date,workstation_code)
              VALUES (%s,%s,%s,%s,%s,%s,%s)""",
              [(run_id,x["title"],x["type"],x["state"],x["due"] or None,x["completed"] or None,str(x["workstation"]))
               for x in data["pm"]])
            cur.executemany(
              """INSERT INTO mart.source_downtime
              (run_id,source_notes,work_date,reason_id,duration_minutes)
              VALUES (%s,%s,%s,%s,%s)""",
              [(run_id,x["notes"],x["date"],x["reason_id"],x["duration_minutes"])
               for x in data["downtime"]])
            cur.executemany(
              """INSERT INTO mart.kpi_definition
              (metric_id,department,display_name,numerator_description,denominator_description,
              unit,calculation_owner,formula_version,interpretation_note)
              VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (metric_id) DO NOTHING""",
              [tuple(x) for x in RATIOS])
            cur.executemany(
              """INSERT INTO mart.kpi_result
              (run_id,grain,period_key,department,metric_id,numerator,denominator,
              metric_value,unit,formula_version,calculation_owner,status,interpretation_note)
              VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
              [(run_id,*x) for x in report])
            counts={}
            for table,expected in (
                ("source_shift",314),("source_exposure",314),("source_ehs_event",29),
                ("source_maintenance",149),("source_downtime",29),("calendar_day",438),
                ("kpi_target",60),("kpi_result",len(report))):
                actual=cur.execute(sql.SQL("SELECT count(*) FROM mart.{} WHERE run_id=%s").format(
                    sql.Identifier(table)),(run_id,)).fetchone()[0]
                if actual!=expected:refusal("mart-post-insert-count-"+table)
                counts[table]=actual
            control=cur.execute(
              "SELECT sum(planned_units),sum(scenario_good_units),sum(mes_produced_units) FROM mart.source_shift WHERE run_id=%s",
                (run_id,)).fetchone()
            if control[0]!=5754 or control[2]!=0:refusal("mart-independently-readback-control-totals")
            future_pm=cur.execute(
               """SELECT metric_value,status FROM mart.kpi_result WHERE run_id=%s
                AND grain='month' AND period_key='2026-11' AND metric_id='PM_ON_TIME'""",
               (run_id,)).fetchone()
            if future_pm!=(None,"not-due"):
                refusal("future-PM-was-presented-as-completed")
            last=cur.execute("""SELECT metric_value FROM mart.kpi_result WHERE run_id=%s
               AND grain='month' AND period_key='2026-11'
               AND metric_id='SCENARIO_ATTAINMENT'""",(run_id,)).fetchone()
            if last is None or last[0]!=Decimal("85.26"):
                refusal("Haskell-month-control-mismatch")
            cur.execute(
               """UPDATE mart.refresh_run SET state='accepted',accepted_at=clock_timestamp(),
               output_inventory=%s WHERE run_id=%s""",(Jsonb(counts),run_id))
        # commit is automatic only if all metrics and control checks passed.
    return {"status":"accepted","run_id":run_id,"source_sha256":source_digest,
            "kernel_sha256":kdigest,"tables":counts,
            "last_attainment_percent":"85.26","native_MES_produced":"0"}

def init_reader_role():
    config=dbconfig()
    with connect() as conn:
        reader=config["reader_user"]
        exists=conn.execute("SELECT 1 FROM pg_roles WHERE rolname=%s",(reader,)).fetchone()
        if not exists:
            conn.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION").format(
                sql.Identifier(reader),sql.Literal(config["reader_password"])))
        conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
            sql.Identifier(config["database"]),sql.Identifier(reader)))
        conn.execute(sql.SQL("GRANT USAGE ON SCHEMA mart TO {}").format(sql.Identifier(reader)))
        conn.execute(sql.SQL("REVOKE SELECT ON ALL TABLES IN SCHEMA mart FROM {}").format(sql.Identifier(reader)))
        conn.execute(sql.SQL("ALTER DEFAULT PRIVILEGES IN SCHEMA mart REVOKE SELECT ON TABLES FROM {}").format(sql.Identifier(reader)))
        approved=("v_latest_refresh","v_source_shifts","v_kpi_history",
                  "v_rolling_5_days","v_rolling_12_months","v_current_month",
                  "v_targets","v_calendar","v_source_exposure",
                  "v_source_ehs","v_source_maintenance","v_source_downtime",
                  "v_kpi_definitions")
        conn.execute(sql.SQL("GRANT SELECT ON {} TO {}").format(
            sql.SQL(",").join(sql.SQL("mart.{}").format(sql.Identifier(n)) for n in approved),
            sql.Identifier(reader)))
        # No raw mart table reads or write grants; only vetted presentation views.
    return "read-only-reader-role-configured"

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--run-id",default="fde-mart-20261113-v1")
    p.add_argument("--roles-only",action="store_true")
    args=p.parse_args()
    try:
        result=init_reader_role() if args.roles_only else apply(args.run_id)
        print(json.dumps(result,indent=2,sort_keys=True))
    except (Refused,psycopg.Error,ValueError,OSError) as err:
        # Prevent credential/schema/sql disclosure in CLI output.
        print("KPI_MART_REFRESH_REFUSED "+type(err).__name__,file=sys.stderr)
        raise SystemExit(2)

if __name__=="__main__":main()
