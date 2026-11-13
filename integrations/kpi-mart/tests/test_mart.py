"""Independent KPI mart acceptance, negative and source-law tests."""
from __future__ import annotations
from contextlib import contextmanager
from decimal import Decimal,ROUND_HALF_UP
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from datetime import date
import json,sys,hashlib,unittest

import psycopg
import load

RUN="fde-mart-20261113-v1"

class MartAcceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg=load.dbconfig()

    def test_01_mart_and_source_inventory_readback(self):
        with load.connect() as conn:
            row=conn.execute("SELECT state,source_sha256,kernel_sha256,as_of_date FROM mart.v_latest_refresh").fetchone()
            self.assertEqual(row[0],"accepted")
            self.assertEqual(row[1],hashlib.sha256(load.SOURCE.read_bytes()).hexdigest())
            self.assertEqual(row[2],hashlib.sha256(load.KERNEL.read_bytes()).hexdigest())
            self.assertEqual(row[3],date(2026,11,12))
            for table,size in (
                ("source_shift",314),("source_exposure",314),("source_ehs_event",29),
                ("source_maintenance",149),("source_downtime",29),("calendar_day",438),
                ("kpi_target",60),("kpi_result",2961)):
                value=conn.execute("SELECT count(*) FROM mart."+table+" WHERE run_id=%s",(RUN,)).fetchone()[0]
                self.assertEqual(value,size,table)

    def test_02_independently_reconciled_totals(self):
        with load.connect() as conn:
            fact=conn.execute("""SELECT sum(planned_units),sum(scenario_good_units),
                  sum(scenario_reject_units),sum(scenario_unfinished_units),
                  sum(mes_produced_units),sum(qc_sample_count),sum(qc_passed_count)
                  FROM mart.source_shift WHERE run_id=%s""",(RUN,)).fetchone()
            self.assertEqual(fact[0],5754)
            self.assertEqual(fact[0],fact[1]+fact[2]+fact[3])
            self.assertEqual(fact[4],0)
            self.assertEqual(fact[5],1570)
            self.assertTrue(0<fact[6]<1570)
            self.assertEqual(conn.execute("SELECT count(*) FROM mart.v_source_shifts").fetchone()[0],314)

    def test_03_five_days_and_twelve_closed_months(self):
        with load.connect() as conn:
            days=[x[0].isoformat() for x in conn.execute(
                "SELECT work_date FROM mart.v_rolling_5_days ORDER BY work_date").fetchall()]
            self.assertEqual(days,["2026-11-06","2026-11-09","2026-11-10",
                                   "2026-11-11","2026-11-12"])
            months=[x[0] for x in conn.execute(
                 "SELECT DISTINCT period_key FROM mart.v_rolling_12_months ORDER BY period_key").fetchall()]
            self.assertEqual(len(months),12)
            self.assertEqual(months[0],"2025-11")
            self.assertEqual(months[-1],"2026-10")
            self.assertNotIn("2026-11",months)
            self.assertEqual(conn.execute("SELECT count(*) FROM mart.v_current_month").fetchone()[0],9)

    def test_04_haskell_month_and_weighted_ratio(self):
        with load.connect() as conn:
            result=conn.execute("""
                SELECT numerator,denominator,metric_value,calculation_owner,formula_version
                FROM mart.v_current_month WHERE metric_id='SCENARIO_ATTAINMENT'
            """).fetchone()
            self.assertEqual((result[0],result[1],result[2]),(133,156,Decimal("85.26")))
            self.assertEqual(result[3],"FDE Haskell")
            self.assertEqual(result[4],"fde.production-kpi-result/v1")
            independent=(Decimal(result[0])*100/Decimal(result[1])).quantize(
                Decimal("0.01"),rounding=ROUND_HALF_UP)
            self.assertEqual(result[2],independent)
            # Weighted ratio is NOT average of daily percentages.
            s=conn.execute("""SELECT sum(scenario_good_units),sum(planned_units)
                  FROM mart.source_shift WHERE run_id=%s AND period_key='2026-11'""",(RUN,)).fetchone()
            self.assertEqual(s,(133,156))

    def test_05_quality_safety_and_pm_null_boundary(self):
        with load.connect() as conn:
            q=conn.execute("""SELECT numerator,denominator,metric_value FROM
               mart.v_current_month WHERE metric_id='QC_SAMPLE_PASS'""").fetchone()
            self.assertEqual(q,(40,45,Decimal("88.89")))
            pm=conn.execute("""SELECT numerator,denominator,metric_value,status
              FROM mart.v_current_month WHERE metric_id='PM_ON_TIME'""").fetchone()
            self.assertEqual(pm,(0,0,None,"not-due"))
            safety=conn.execute("""SELECT denominator,status FROM mart.v_current_month
             WHERE metric_id='SYNTHETIC_EVENT_RATE'""").fetchone()
            self.assertGreater(safety[0],0)
            self.assertEqual(safety[1],"calculated-synthetic")
            target=conn.execute("SELECT distinct status FROM mart.v_targets").fetchall()
            self.assertEqual(target,[("SYNTHETIC_NOT_BUSINESS_APPROVED",)])

    def test_06_reader_view_grants_and_raw_table_denial(self):
        c=self.cfg
        with psycopg.connect(host=c["host"],port=c["port"],dbname=c["database"],
            user=c["reader_user"],password=c["reader_password"],connect_timeout=6) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM mart.v_rolling_5_days").fetchone()[0],5)
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                with conn.transaction():
                    conn.execute("SELECT count(*) FROM mart.source_shift")
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                with conn.transaction():
                    conn.execute("DELETE FROM mart.kpi_result WHERE 1=0")

    def test_07_idempotent_reload(self):
        x=load.apply(RUN)
        self.assertEqual(x["status"],"already-accepted")
        self.assertEqual(x["kpi_results"],2961)

    def mutated(self,fn):
        data=json.loads(load.SOURCE.read_text())
        fn(data)
        with TemporaryDirectory() as temp:
            path=Path(temp)/"mutant.json"
            path.write_text(json.dumps(data),encoding="utf8")
            with patch.object(load,"SOURCE",path):
                with self.assertRaises(load.Refused):
                    load.source()

    def test_08_mutant_scenario_as_mes_produced_refuses(self):
        self.mutated(lambda d:d["shifts"][0].__setitem__("mes_produced",
                              d["shifts"][0]["scenario_good"]))

    def test_09_mutant_scenario_quantity_conservation_refuses(self):
        self.mutated(lambda d:d["shifts"][0].__setitem__("scenario_good",
                              d["shifts"][0]["scenario_good"]+1))

    def test_10_mutant_duplicate_vendor_identity_refuses(self):
        self.mutated(lambda d:d["shifts"][1].__setitem__("erp",
                              d["shifts"][0]["erp"]))

    def test_11_mutant_sample_population_refuses(self):
        self.mutated(lambda d:d["shifts"][0].__setitem__("quality_samples",4))

    def test_12_mutant_calendar_missing_scheduled_day_refuses(self):
        self.mutated(lambda d:d.__setitem__("calendar",
                              d["calendar"][:-1]))

    def test_13_postgres_quantity_constraint_mutant_refuses(self):
        # Disposable same-session table, not an operational data mutation.
        with load.connect() as conn:
            cur=conn.cursor()
            cur.execute("CREATE TEMP TABLE mutant_shift (LIKE mart.source_shift INCLUDING CONSTRAINTS)")
            with self.assertRaises(psycopg.errors.CheckViolation):
                with conn.transaction():
                    cur.execute("""
                     INSERT INTO mutant_shift SELECT run_id,work_date,period_key,
                     line_code,erp_work_order,mes_work_order,planned_units,
                     scenario_good_units+1,scenario_reject_units,scenario_unfinished_units,
                     mes_produced_units,qc_sample_count,qc_passed_count,qc_check_count,
                     data_class FROM mart.source_shift WHERE run_id=%s LIMIT 1""",(RUN,))

if __name__=="__main__":unittest.main()
