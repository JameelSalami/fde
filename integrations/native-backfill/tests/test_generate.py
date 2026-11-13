"""Read-only synthetic native-backfill calendar and planning contract tests."""
from __future__ import annotations
import unittest
from datetime import date
from hashlib import sha256
import json
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from generate import RUN, generate, marker, days, months_closed, STATIONS

class TestNativeBackfillPlan(unittest.TestCase):
    def setUp(self):
        self.plan=generate()

    def test_report_windows_are_distinct(self):
        w=self.plan["reporting"]
        self.assertEqual(w["rollingFiveScheduledDates"],
            ["2026-11-06","2026-11-09","2026-11-10","2026-11-11","2026-11-12"])
        self.assertEqual(len(w["rollingTwelveClosedMonths"]),12)
        self.assertEqual(w["rollingTwelveClosedMonths"][0],"2025-11")
        self.assertEqual(w["rollingTwelveClosedMonths"][-1],"2026-10")
        self.assertEqual(w["currentMonth"],"2026-11")
        self.assertTrue(w["currentMonthPartial"])

    def test_plans_are_one_unique_shift_per_scheduled_weekday(self):
        rows=self.plan["records"]["productionShiftPlans"]
        self.assertEqual(len(rows),314)
        self.assertEqual(len({x["shiftKey"] for x in rows}),len(rows))
        self.assertEqual([x["workDate"] for x in rows[:2]],["2025-09-01","2025-09-02"])
        self.assertTrue(all(date.fromisoformat(x["workDate"]).weekday()<5 for x in rows))
        self.assertTrue(all(x["shift"]=="A" for x in rows))
        self.assertTrue(all(12<=x["plannedUnits"]<=24 for x in rows))

    def test_no_modeled_good_units_are_promoted_to_native(self):
        for row in self.plan["records"]["productionShiftPlans"]:
            self.assertIsNone(row["goodUnits"])
            self.assertIsNone(row["rejectUnits"])
            self.assertIsNone(row["erpWorkOrder"])
            self.assertIsNone(row["mesWorkOrder"])
            self.assertEqual(row["nativeProductionStatus"],"not-applied")
            self.assertEqual(row["dataClass"],"SYNTHETIC_BACKFILL_PLAN_ONLY")

    def test_maintenance_is_unique_month_and_station(self):
        events=self.plan["records"]["maintenanceOccurrences"]
        self.assertEqual(len(events),120)
        self.assertEqual(len(set(e["occurrenceKey"] for e in events)),120)
        self.assertEqual(len(STATIONS),8)
        self.assertTrue(all(e["actualComplete"] is None for e in events))
        self.assertTrue(all(e["status"]=="proposed-pending-native-event" for e in events))

    def test_calendar_and_targets_are_explicitly_unapproved(self):
        assert self.plan["calendar"]["holidaySource"]=="NOT_PROVIDED"
        assert "PROVISIONAL" in self.plan["calendar"]["fiscalCalendar"]
        self.assertEqual(len(self.plan["records"]["targets"]),4)
        self.assertTrue(all(t["target"] is None and not t["approved"]
                            for t in self.plan["records"]["targets"]))

    def test_deterministic_same_manifest_and_no_live_effect(self):
        a=json.dumps(self.plan,sort_keys=True,separators=(",",":"))
        b=json.dumps(generate(),sort_keys=True,separators=(",",":"))
        self.assertEqual(sha256(a.encode()).hexdigest(),sha256(b.encode()).hexdigest())
        self.assertEqual(self.plan["status"],"PROPOSAL_NOT_WRITTEN")

    def test_restrict_horizon_and_id(self):
        with self.assertRaises(ValueError):
            generate(date(2020,1,1),date(2026,11,12))
        with self.assertRaises(ValueError):
            generate(date(2026,11,13),date(2026,11,12))
        self.assertEqual(marker(date(2026,11,12)),RUN+"-20261112-A")

    def test_calendar_month_window_changes_without_deleting_history(self):
        self.assertEqual(months_closed(date(2026,12,3))[-1],"2026-11")
        self.assertEqual(months_closed(date(2026,12,3))[0],"2025-12")
        self.assertIn("records never deleted",self.plan["reporting"]["rolloverPolicy"])

if __name__=="__main__":
    unittest.main()
