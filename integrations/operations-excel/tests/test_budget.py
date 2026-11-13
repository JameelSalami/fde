"""Offline guard qualification: disposable ledgers and fake Responses only.

No fixture, kernel, credentials, cloud SDK or real .local ledger is needed.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from azure_model import AzureRefused, call_azure, offline_draft, context_approval_digest
from budget import BudgetRefused, initialize, reserve


class TestBudget(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fde-azure-budget-test-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "azure-budget.sqlite"
        self.env = {
            "FDE_AZURE_MODEL_CALL_APPROVED": "1",
            "FDE_AZURE_MODEL_ID": "gpt-4.1-mini",
            "FDE_AZURE_BUDGET_DB": str(self.path),
            "AZURE_OPENAI_ENDPOINT": "https://fixture.openai.azure.com",
            "AZURE_OPENAI_DEPLOYMENT": "owner-verified-deployment",
        }
        self.report = {"sourceClass": "handwritten-fixture", "periods": [{
            "periodId": "synthetic-shift", "lineId": "demo-line",
            "attainmentPercent": "90", "shortfallUnits": "10",
            "unclassifiedUnits": "0", "lossStatus": "reconciled", "pareto": []}]}
        self.env["FDE_AZURE_APPROVED_CONTEXT_SHA256"] = context_approval_digest(self.report)
        self.calls = []
        initialize(self.env, test_mode=True)

    def rows(self):
        # This helper reads only the freshly created disposable test ledger.
        with sqlite3.connect(self.path) as con:
            return con.execute("SELECT month, cents FROM reservations").fetchall()

    def factory(self, **kwargs):
        # Reservation must already be durable even BEFORE factory construction.
        self.assertGreaterEqual(sum(c for _, c in self.rows()), 10)
        return SimpleNamespace(responses=SimpleNamespace(create=self.create))

    def create(self, **kwargs):
        self.assertGreaterEqual(len(self.rows()), len(self.calls) + 1)
        self.calls.append(kwargs)
        return SimpleNamespace(output_text=json.dumps({
            "focusPeriod": "synthetic-shift",
            "questionIds": ["verify-shift-boundary"],
            "rationale": "Review the shift boundary before drawing conclusions."}))

    def call(self, env=None, report=None, factory=None):
        return call_azure(self.report if report is None else report,
                          env=self.env if env is None else env,
                          client_factory=self.factory if factory is None else factory)

    def test_fake_end_to_end_reserves_first_and_bounds_request(self):
        result = self.call()
        self.assertEqual(result["authority"], "review-only")
        self.assertEqual(len(self.rows()), 1)
        request = self.calls[0]
        self.assertEqual(request["model"], "owner-verified-deployment")
        self.assertEqual(request["max_output_tokens"], 320)
        self.assertIs(request["store"], False)
        self.assertEqual(request["tools"], [])
        self.assertEqual(request["tool_choice"], "none")
        self.assertLessEqual(len(json.dumps(request["input"], separators=(",", ":")).encode()), 32768)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(self.path.parent).st_mode & 0o777, 0o700)

    def test_eighty_requests_then_refuses_at_eight_dollars(self):
        for _ in range(80):
            self.call()
        with self.assertRaisesRegex(AzureRefused, "monthly-cutoff"):
            self.call()
        self.assertEqual(len(self.calls), 80)
        self.assertEqual(sum(c for _, c in self.rows()), 800)

    def test_concurrent_fake_requests_cannot_overbook(self):
        # Each worker opens its own SQLite connection, like separate processes.
        def worker(_):
            fake = SimpleNamespace(responses=SimpleNamespace(create=lambda **kw:
                SimpleNamespace(output_text=json.dumps({
                    "focusPeriod": "synthetic-shift",
                    "questionIds": ["verify-shift-boundary"],
                    "rationale": "Review the boundary before drawing conclusions."}))))
            try:
                self.call(factory=lambda **kw: fake)
                return True
            except AzureRefused as exc:
                self.assertIn("monthly-cutoff", str(exc))
                return False
        with ThreadPoolExecutor(max_workers=12) as pool:
            admitted = list(pool.map(worker, range(100)))
        self.assertEqual(sum(admitted), 80)
        self.assertEqual(sum(c for _, c in self.rows()), 800)

    def test_utc_month_boundary_and_restart_persistence(self):
        january = datetime(2027, 1, 31, 23, 59, tzinfo=timezone.utc)
        for _ in range(80):
            reserve(dict(self.env), test_mode=True, now=january)
        # Local February is still January UTC: it must not reset allowance.
        local_feb = datetime(2027, 2, 1, 0, 30,
                             tzinfo=timezone(timedelta(hours=1)))
        with self.assertRaisesRegex(BudgetRefused, "monthly-cutoff"):
            reserve(dict(self.env), test_mode=True, now=local_feb)
        reserve(dict(self.env), test_mode=True,
                now=datetime(2027, 2, 1, tzinfo=timezone.utc))
        self.assertEqual(self.rows().count(("2027-01", 10)), 80)
        self.assertEqual(self.rows().count(("2027-02", 10)), 1)
        with self.assertRaises(BudgetRefused):
            initialize(self.env, test_mode=True)  # never resets an existing DB
        self.assertEqual(len(self.rows()), 81)

    def test_wrong_or_missing_model_and_no_approval_reserve_nothing(self):
        for value in ("gpt-4.1", "", "gpt-4.1-mini-other"):
            with self.assertRaisesRegex(AzureRefused, "model-must-be-pinned"):
                self.call(env={**self.env, "FDE_AZURE_MODEL_ID": value})
        for value in ("0", "", "true"):
            with self.assertRaisesRegex(AzureRefused, "explicit-enabled-flag"):
                self.call(env={**self.env, "FDE_AZURE_MODEL_CALL_APPROVED": value})
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.calls, [])

    def test_non_synthetic_and_oversize_reject_before_reservation(self):
        with self.assertRaisesRegex(AzureRefused, "non-synthetic"):
            self.call(report={**self.report, "sourceClass": "company-export"})
        # Encoded size, not character count; non-ASCII expands when serialized.
        self.report["periods"][0]["lineId"] = "\u2603" * 6000
        with self.assertRaisesRegex(AzureRefused, "encoded-input-budget"):
            self.call()
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.calls, [])

    def test_exact_payload_must_be_independently_approved(self):
        altered = json.loads(json.dumps(self.report))
        altered["periods"][0]["lineId"] = "user-provided-secret-like-identifier"
        with self.assertRaisesRegex(AzureRefused, "exact-context-disclosure-not-approved"):
            self.call(report=altered)
        with self.assertRaisesRegex(AzureRefused, "exact-context-disclosure-not-approved"):
            self.call(env={key:value for key,value in self.env.items()
                           if key!="FDE_AZURE_APPROVED_CONTEXT_SHA256"})
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.calls, [])

    def test_provider_error_retains_reservation_without_retry(self):
        attempts = []
        def fail(**kwargs):
            attempts.append(kwargs)
            self.assertEqual(len(self.rows()), 1)
            raise RuntimeError("simulated uncertain provider failure")
        fake = SimpleNamespace(responses=SimpleNamespace(create=fail))
        with self.assertRaisesRegex(RuntimeError, "uncertain provider"):
            self.call(factory=lambda **kw: fake)
        self.assertEqual(len(attempts), 1)
        self.assertEqual(self.rows()[0][1], 10)

    def test_invalid_response_and_factory_failure_also_keep_reservation(self):
        fake = SimpleNamespace(responses=SimpleNamespace(create=lambda **kw:
                               SimpleNamespace(output_text="not json")))
        with self.assertRaisesRegex(AzureRefused, "not-strict-json"):
            self.call(factory=lambda **kw: fake)
        def fail(**kwargs):
            raise RuntimeError("factory failure")
        with self.assertRaisesRegex(RuntimeError, "factory failure"):
            self.call(factory=fail)
        self.assertEqual(len(self.rows()), 2)

    def test_missing_and_corrupt_database_fail_closed(self):
        self.path.unlink()
        with self.assertRaisesRegex(AzureRefused, "ledger-unavailable"):
            self.call()
        self.assertFalse(self.path.exists())
        self.path.write_bytes(b"not a sqlite database")
        self.path.chmod(0o600)
        with self.assertRaisesRegex(AzureRefused, "ledger-unavailable"):
            self.call()
        self.assertEqual(self.calls, [])

    def test_empty_or_wrong_schema_is_not_reinitialized(self):
        with sqlite3.connect(self.path) as con:
            con.execute("DROP TABLE reservations")
        with self.assertRaisesRegex(AzureRefused, "ledger-invalid"):
            self.call()
        self.assertEqual(self.calls, [])

    def test_symlink_database_and_ancestor_refused(self):
        target = self.path.with_name("preserved.sqlite")
        self.path.rename(target)
        self.path.symlink_to(target)
        with self.assertRaises(AzureRefused):
            self.call()
        self.path.unlink()
        target.rename(self.path)
        with tempfile.TemporaryDirectory(prefix="fde-azure-budget-test-") as alias:
            alias_path = Path(alias)
            alias_path.rmdir()
            alias_path.symlink_to(self.path.parent, target_is_directory=True)
            try:
                with self.assertRaises(AzureRefused):
                    self.call(env={**self.env, "FDE_AZURE_BUDGET_DB":
                                   str(alias_path / "azure-budget.sqlite")})
            finally:
                alias_path.unlink()
                alias_path.mkdir(mode=0o700)
        self.assertEqual(self.rows(), [])

    def test_loose_permissions_and_hardlinks_refused(self):
        for path, loose, safe in ((self.path, 0o644, 0o600),
                                  (self.path.parent, 0o755, 0o700)):
            path.chmod(loose)
            try:
                with self.assertRaisesRegex(AzureRefused, "owner-private"):
                    self.call()
            finally:
                path.chmod(safe)
        link = self.path.with_name("hardlink")
        os.link(self.path, link)
        with self.assertRaisesRegex(AzureRefused, "owner-private"):
            self.call()
        link.unlink()
        self.assertEqual(self.rows(), [])

    def test_test_override_forbidden_without_fake_factory(self):
        # Refuses before imports/authentication; no actual SDK can be invoked.
        with self.assertRaisesRegex(AzureRefused, "outside-private-local"):
            call_azure(self.report, env=self.env)
        for raw in (str(self.path.parent / "other.sqlite"), "relative.sqlite",
                    str(self.path.parent) + "/../azure-budget.sqlite"):
            with self.assertRaises(AzureRefused):
                self.call(env={**self.env, "FDE_AZURE_BUDGET_DB": raw})
        self.assertEqual(self.rows(), [])

    def test_offline_baseline_never_touches_guard(self):
        with patch("azure_model.reserve", side_effect=AssertionError("must stay offline")):
            self.assertEqual(offline_draft(self.report)["origin"],
                             "deterministic-human-checklist")
        self.assertEqual(self.rows(), [])

    def test_azure_sdk_namespace_not_shadowed_by_local_adapter(self):
        # No local module may shadow azure.identity, even when the optional
        # Azure SDK is absent from a portable offline test environment.
        import azure_model
        self.assertFalse((Path(__file__).resolve().parents[1] / "azure.py").exists())
        self.assertTrue(callable(azure_model.call_azure))
        try:
            from azure.identity import AzureCliCredential
        except ModuleNotFoundError as exc:
            if exc.name in ("azure", "azure.identity"):
                self.skipTest("Optional azure-identity SDK is not installed")
            raise
        self.assertTrue(callable(AzureCliCredential))
        self.assertEqual(self.rows(), [])


if __name__ == "__main__":
    unittest.main()
