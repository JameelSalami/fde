"""FDE deterministic synthetic backfill plan; NO vendor writes.

Reconstructs one proposed SHIFT-A production-planning record for each
Monday-Friday date. Holidays/shutdowns and accounting calendar remain
explicit UNCONFIRMED until a site-specific source is supplied. Scenario
outcomes are deliberately separate from native accepted records.
"""
from __future__ import annotations
from datetime import date,timedelta
from hashlib import sha256
import argparse
import json
from pathlib import Path

RUN="FDEBF14-20261113"
START=date(2025,9,1)
ASOF=date(2026,11,12)
LINE="CNDEMO-LINE-1"
SITE="CN Fictional Seat-Rail Lab"
TIMEZONE="Asia/Shanghai"
STATIONS=("CNDEMO-ST-01","CNDEMO-ST-02","CNDEMO-ST-03","CNDEMO-ST-05",
          "CNDEMO-ST-06","CNDEMO-ST-07","CNDEMO-ST-08","CNDEMO-ST-09")

def marker(work_date:date)->str:
    return RUN+"-"+work_date.strftime("%Y%m%d")+"-A"

def units(work_date:date)->int:
    digest=sha256((RUN+"|"+work_date.isoformat()).encode()).digest()
    return 12+int.from_bytes(digest[:2],"big")%13

def days(start:date=START,end:date=ASOF):
    if not start<=end or (end-start).days>500:raise ValueError("backfill-date-budget")
    results=[]
    cursor=start
    while cursor<=end:
        if cursor.weekday()<5:
            results.append(cursor)
        cursor+=timedelta(days=1)
    return results

def months_between(start:date,end:date)->list[str]:
    result=[]
    y,m=start.year,start.month
    while (y,m)<=(end.year,end.month):
        result.append(f"{y:04d}-{m:02d}")
        y,m=(y+1,1) if m==12 else (y,m+1)
    return result

def months_closed(asof:date)->list[str]:
    allmonths=months_between(date(asof.year-2,1,1),asof)
    return [m for m in allmonths if m<asof.strftime("%Y-%m")][-12:]

def generate(start:date=START,asof:date=ASOF):
    dated=days(start,asof)
    if len(dated)<12:raise ValueError("insufficient-backfill-window")
    all_months=months_between(start,asof)
    current_month=asof.strftime("%Y-%m")
    report_days=dated[-5:]
    plans=[]
    for d in dated:
        count=units(d)
        plans.append({
          "shiftKey":marker(d),"workDate":d.isoformat(),"lineCode":LINE,"shift":"A",
          "scheduled":True,"plannedUnits":count,
          "erpWorkOrder":None,"mesWorkOrder":None,
          "nativeProductionStatus":"not-applied",
          "goodUnits":None,"rejectUnits":None,
          "reasonGoodMissing":"MES execution not created or independently reviewed",
          "dataClass":"SYNTHETIC_BACKFILL_PLAN_ONLY",
          "erpNativePlanningProposal":{
            "plannedStart":d.isoformat()+" 08:00:00","plannedUnits":count,
            "bom":"BOM-CNDEMO-GM0032140-001"},
          "mesNativePlanningProposal":{
            "plannedStart":d.isoformat()+"T08:00:00+08:00",
            "orderNo":marker(d),"plannedUnits":count,
            "sourceOrderBindingStatus":"awaiting-new-ERP-native-readback"}
        })
    events=[]
    for month in all_months:
        # Planning occurrences only, NOT fabricated completed maintenance.
        due=month+"-20"
        for station in STATIONS:
            events.append({
               "occurrenceKey":RUN+"|"+due+"|"+station,
               "scheduleMonth":month,"dueLocalDate":due,"workstationCode":station,
               "eventType":"planned","status":"proposed-pending-native-event",
               "actualStart":None,"actualComplete":None,
               "sourceClass":"SYNTHETIC_BACKFILL_PLAN_ONLY"})
    targets=[]
    for department,metric in [
        ("production","PROD_ATTAINMENT"),("quality","QUALITY_FIRST_PASS"),
        ("safety","SAFETY_EXPOSURE_COVERAGE"),("maintenance","PM_ON_TIME")]:
        targets.append({
         "department":department,"metricId":metric,"target":None,
         "effectiveFrom":start.isoformat(),"effectiveUntil":None,
         "direction":None,"approved":False,
         "reason":"real site target definition, direction and calendar not provided"})
    return {
      "schema":"fde.native-backfill-plan/v1","runId":RUN,
      "authorization":"synthetic-lab-only","status":"PROPOSAL_NOT_WRITTEN",
      "site":SITE,"timezone":TIMEZONE,
      "startLocalDate":start.isoformat(),"asOfLocalDate":asof.isoformat(),
      "calendar":{
        "version":"PROVISIONAL_WEEKDAYS_A_NOT_SITE_APPROVED",
        "productionWeekdays":["Mon","Tue","Wed","Thu","Fri"],
        "holidaySource":"NOT_PROVIDED", "siteShutdowns":"NOT_PROVIDED",
        "shiftDefinitions":"one synthetic 08:00-16:00 SHIFT-A",
        "fiscalCalendar":"calendar months PROVISIONAL; approved ACC calendar absent",
        "historicalAuditTimestamps":"retain actual insertion timestamps"},
      "reporting":{
        "rollingFiveScheduledDates":[d.isoformat() for d in report_days],
        "rollingTwelveClosedMonths":months_closed(asof),
        "currentMonth":current_month,"currentMonthPartial":True,
        "rolloverPolicy":"reporting window changes, native records never deleted"},
      "records":{
        "productionShiftPlans":plans,"maintenanceOccurrences":events,
        "quality":"requires batch/inspection native contract; not created",
        "safety":"requires EHS custom DocTypes/exposure hours; not created",
        "targets":targets},
      "proposedNativeTotals":{"erpPlannedWorkOrders":len(plans),
                              "mesPlannedWorkOrders":len(plans),
                              "mesPlannedMaintenanceEvents":len(events),
                              "nativeFinishedOutput":0,
                              "nativeQualityInspections":0,
                              "nativeSafetyEvents":0},
      "constraints":[
        "No manufactured good count is backfilled without vendor-native production workflow",
        "No approved quality standard/tolerance or completed maintenance assumed",
        "No numeric target asserted before business owner review",
        "No fabricated public holidays or accounting fiscal periods",
        "Original application records and snapshots are preserved",
        "All proposed records are fictional and distinct from native accepted pilot"]
    }

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    payload=generate()
    path=Path(args.output).resolve()
    if not path.parent.is_dir() or path.exists() or path.is_symlink():
        raise SystemExit("Output must be a NEW file in a preexisting directory")
    raw=(json.dumps(payload,sort_keys=True,indent=2)+"\n").encode()
    with path.open("xb") as out:out.write(raw)
    path.chmod(0o600)
    print(json.dumps({"schema":payload["schema"],"status":payload["status"],
      "workdays":len(payload["records"]["productionShiftPlans"]),
      "maintenancePlans":len(payload["records"]["maintenanceOccurrences"]),
      "fiveDays":payload["reporting"]["rollingFiveScheduledDates"],
      "twelveMonths":payload["reporting"]["rollingTwelveClosedMonths"],
      "digest":sha256(raw).hexdigest(),"output":str(path)}))

if __name__=="__main__":
    main()
