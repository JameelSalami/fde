"""Fail-closed local estimated-cost admission. No network, pricing or refunds.

Provision the empty ledger explicitly with initialize(); reserve() never creates
or repairs a missing ledger. Integer US cents are exact decimal cents.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile

ROOT = Path(__file__).absolute().parents[2]
DEFAULT_DB = ROOT / ".local" / "operations-excel" / "azure-budget.sqlite"
RESERVE_CENTS = 10
CUTOFF_CENTS = 800
MAX_REQUESTS = 80
MAX_INPUT_BYTES = 32 * 1024
_SCHEMA = ("CREATE TABLE reservations (id INTEGER PRIMARY KEY, month TEXT NOT NULL, "
           "cents INTEGER NOT NULL CHECK (typeof(cents) = 'integer' AND cents = 10))")
_APPLICATION_ID = 0x46444542


class BudgetRefused(ValueError):
    pass


def _location(env, test_mode):
    raw = env.get("FDE_AZURE_BUDGET_DB", str(DEFAULT_DB))
    path = Path(raw)
    # Do not resolve(): it would silently accept symlinks and traversal.
    if not path.is_absolute() or str(path) != raw or ".." in path.parts:
        raise BudgetRefused("budget-path-not-canonical")
    if path == DEFAULT_DB:
        return path, ROOT / ".local"
    # This escape hatch is exclusively for explicitly injected fake transports.
    # Only a fresh owner-private temp root with this prefix is accepted.
    temp = Path(tempfile.gettempdir()).absolute()
    if (not test_mode or path.name != "azure-budget.sqlite" or
            path.parent.parent != temp or
            not path.parent.name.startswith("fde-azure-budget-test-")):
        raise BudgetRefused("budget-path-outside-private-local")
    return path, path.parent


def _private(st, directory=False):
    expected = 0o700 if directory else 0o600
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if (not kind(st.st_mode) or st.st_uid != os.geteuid() or
            stat.S_IMODE(st.st_mode) != expected or
            (not directory and st.st_nlink != 1)):
        raise BudgetRefused("budget-path-not-owner-private")


@contextmanager
def _directory(path, private_start, create=False):
    """Walk without following symlinks; pin parent for all SQLite operations."""
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    current = Path("/")
    try:
        for component in path.parent.parts[1:]:
            current /= component
            private = current == private_start or private_start in current.parents
            if create and private:
                try:
                    os.mkdir(component, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=fd)
            os.close(fd)
            fd = child
            if private:
                _private(os.fstat(fd), directory=True)
        yield fd
    finally:
        os.close(fd)


def _check_files(fd, name):
    _private(os.stat(name, dir_fd=fd, follow_symlinks=False))
    for suffix in ("-journal", "-wal", "-shm"):
        try:
            st = os.stat(name + suffix, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        _private(st)


def _connect(fd, name):
    # Linux-only, intentionally fail closed elsewhere. The pinned directory
    # avoids reopening a replaceable ancestor. mode=rw cannot create a ledger.
    con = sqlite3.connect(f"file:/proc/self/fd/{fd}/{name}?mode=rw", uri=True,
                          timeout=30, isolation_level=None)
    try:
        con.execute("PRAGMA trusted_schema=OFF")
        con.execute("PRAGMA synchronous=FULL")
        if con.execute("PRAGMA journal_mode").fetchone()[0] != "delete":
            raise BudgetRefused("budget-journal-mode-refused")
        return con
    except BaseException:
        con.close()
        raise


def _validate(con):
    if (con.execute("PRAGMA application_id").fetchone()[0] != _APPLICATION_ID or
            con.execute("PRAGMA user_version").fetchone()[0] != 1 or
            con.execute("PRAGMA integrity_check").fetchall() != [("ok",)] or
            con.execute("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
            != [("reservations", _SCHEMA)]):
        raise BudgetRefused("budget-ledger-invalid")
    totals = {}
    for month, cents in con.execute("SELECT month, cents FROM reservations"):
        if (not isinstance(month, str) or
                not re.fullmatch(r"[0-9]{4}-(0[1-9]|1[0-2])", month) or
                type(cents) is not int or cents != RESERVE_CENTS):
            raise BudgetRefused("budget-ledger-invalid")
        totals[month] = totals.get(month, 0) + cents
        if totals[month] > CUTOFF_CENTS:
            raise BudgetRefused("budget-ledger-invalid")
    return totals


def initialize(env=None, *, test_mode=False):
    """Explicit local owner provisioning only; NEVER called by model admission.

    Existing files are refused, not reset. Do not delete/replace an active ledger.
    A failed initialization leaves a refused file for independent owner review.
    """
    try:
        path, private = _location({} if env is None else env, test_mode)
        with _directory(path, private, create=True) as fd:
            file_fd = os.open(path.name, os.O_CREAT | os.O_EXCL | os.O_WRONLY |
                              os.O_NOFOLLOW, 0o600, dir_fd=fd)
            os.close(file_fd)
            _check_files(fd, path.name)
            con = _connect(fd, path.name)
            try:
                con.execute("BEGIN IMMEDIATE")
                con.execute(_SCHEMA)
                con.execute(f"PRAGMA application_id={_APPLICATION_ID}")
                con.execute("PRAGMA user_version=1")
                con.execute("COMMIT")
            finally:
                con.close()
            os.fsync(fd)
    except (OSError, sqlite3.Error) as exc:
        raise BudgetRefused("budget-initialization-failed") from exc


def reserve(env, *, test_mode=False, now=None):
    """Commit 10 cents before transport construction; never refund attempts.

    now is an offline test clock. Production call_azure never supplies it.
    """
    try:
        path, private = _location(env, test_mode)
        with _directory(path, private) as fd:
            _check_files(fd, path.name)
            con = _connect(fd, path.name)
            try:
                con.execute("BEGIN IMMEDIATE")
                instant = datetime.now(timezone.utc) if now is None else now
                if instant.tzinfo is None or instant.utcoffset() is None:
                    raise BudgetRefused("budget-clock-must-be-aware")
                month = instant.astimezone(timezone.utc).strftime("%Y-%m")
                totals = _validate(con)
                if totals.get(month, 0) + RESERVE_CENTS > CUTOFF_CENTS:
                    raise BudgetRefused("budget-monthly-cutoff-reached")
                con.execute("INSERT INTO reservations(month, cents) VALUES (?, ?)",
                            (month, RESERVE_CENTS))
                con.execute("COMMIT")
            finally:
                # Only an uncommitted local admission can roll back. Once
                # committed, errors anywhere downstream cannot release it.
                con.close()
    except (OSError, sqlite3.Error) as exc:
        raise BudgetRefused("budget-ledger-unavailable") from exc
    return month
