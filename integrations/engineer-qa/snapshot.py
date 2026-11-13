"""Offline, fail-closed snapshot reader; no source acquisition or arithmetic."""
from __future__ import annotations

import csv
import io
import json
import os
import re
import stat
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from hashlib import sha256
from pathlib import Path

SCHEMA = "fde.kpi-mart-excel-snapshot/v1"
STATE = "accepted-read-only-local-export"
SOURCE_KIND = "ERPNext/OpenMES installed synthetic-lab readbacks"
RUN = "fde-mart-20261113-v1"
# Fixed presentation metadata from load.py, not a second calculation owner.
METRICS = {
    "SCENARIO_ATTAINMENT": ("Production", "percent"),
    "NATIVE_MES_OUTPUT_UNITS": ("Production", "units"),
    "QC_SAMPLE_PASS": ("Quality", "percent"),
    "QC_CHECK_COUNT": ("Quality", "checks"),
    "SYNTHETIC_EVENT_RATE": ("Safety", "events-per-100k-hours"),
    "SYNTHETIC_EVENT_COUNT": ("Safety", "events"),
    "PM_ON_TIME": ("Maintenance", "percent"),
    "PM_DUE_COUNT": ("Maintenance", "events"),
    "DOWNTIME_MINUTES": ("Maintenance", "minutes"),
}
COLUMNS = (
    "run_id", "grain", "period_key", "department", "metric_id", "numerator",
    "denominator", "metric_value", "unit", "formula_version",
    "calculation_owner", "status", "interpretation_note",
)
RATIOS = frozenset(("SCENARIO_ATTAINMENT", "QC_SAMPLE_PASS",
                    "SYNTHETIC_EVENT_RATE", "PM_ON_TIME"))
NATIVE = frozenset(("NATIVE_MES_OUTPUT_UNITS", "QC_CHECK_COUNT", "DOWNTIME_MINUTES"))
MAX_MANIFEST = 64_000
MAX_FILE = 4_000_000
MAX_TOTAL = 16_000_000


class Refused(ValueError):
    """Snapshot did not satisfy this offline candidate's input contract."""


def require(ok: bool, reason: str) -> None:
    if not ok:
        raise Refused(reason)


def digest(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def iso_date(value: object) -> str:
    require(isinstance(value, str), "date-type")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise Refused("date-format") from exc
    require(parsed.isoformat() == value, "date-format")
    return value


@dataclass(frozen=True)
class Approval:
    """Pins supplied separately by the owner, never inferred from the manifest."""
    source_run_id: str
    source_sha256: str
    kernel_sha256: str
    as_of_date: str


@dataclass(frozen=True)
class Provenance:
    approval: Approval
    source_kind: str
    manifest_sha256: str
    csv_sha256: str
    filename: str = "current_month.csv"
    authority: str = "none; offline byte validation only"


@dataclass(frozen=True)
class Fact:
    metric_id: str
    value: str | None
    numerator: str | None
    denominator: str | None
    status: str
    unit: str
    period: str
    formula_version: str
    calculation_owner: str
    interpretation_note: str
    provenance: Provenance


def _pairs(pairs: list[tuple[str, object]]) -> dict:
    out = {}
    for key, value in pairs:
        require(key not in out, "duplicate-json-key")
        out[key] = value
    return out


def _table(raw: bytes, metadata: dict) -> list[list[str]]:
    try:
        text = raw.decode("utf-8", errors="strict")
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        headers = next(reader)
        require(headers and len(headers) <= 64 and len(set(headers)) == len(headers),
                "duplicate-or-invalid-headers")
        require(headers == metadata.get("columns"), "manifest-columns")
        rows = []
        for row in reader:
            require(len(rows) < 5000 and len(row) == len(headers), "csv-shape-budget")
            require(all(len(cell) <= 4096 and not any(ord(c) < 32 or ord(c) == 127
                                                     for c in cell) for cell in row),
                    "csv-cell-budget-or-control")
            rows.append(row)
        require(type(metadata.get("rows")) is int and len(rows) == metadata["rows"],
                "manifest-row-count")
        return [headers, *rows]
    except (UnicodeError, csv.Error, StopIteration) as exc:
        raise Refused("malformed-utf8-csv") from exc


def _number(text: str) -> str | None:
    if text == "":
        return None
    require(re.fullmatch(r"[0-9]{1,14}(?:\.[0-9]{1,6})?", text) is not None,
            "invalid-exact-decimal")
    return text


def _refuse_json_constant(value: str) -> None:
    # Python's default JSON decoder accepts NaN and Infinity; real JSON does not.
    raise Refused("nonstandard-json-number")


def _admit_manifest(manifest_bytes: bytes, approval: Approval) -> dict:
    """Approve envelope, owner-supplied pins, and inventory BEFORE opening CSVs."""
    require(approval.source_run_id == RUN and digest(approval.source_sha256)
            and digest(approval.kernel_sha256), "unapproved-source-pins")
    iso_date(approval.as_of_date)
    require(len(manifest_bytes) <= MAX_MANIFEST, "manifest-budget")
    try:
        m = json.loads(manifest_bytes.decode("utf-8"), object_pairs_hook=_pairs,
                       parse_constant=_refuse_json_constant)
    except Refused:
        raise
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise Refused("malformed-manifest") from exc
    require(isinstance(m, dict), "manifest-object")
    require(m.get("schema") == SCHEMA and m.get("state") == STATE, "manifest-admission")
    require(m.get("source_kind") == SOURCE_KIND, "unapproved-source-kind")
    for field in ("source_run_id", "source_sha256", "kernel_sha256", "as_of_date"):
        require(m.get(field) == getattr(approval, field), "unapproved-source:" + field)
    require(type(m.get("cloud_model_calls")) is int and m["cloud_model_calls"] == 0
            and type(m.get("vendor_mutations")) is int and m["vendor_mutations"] == 0,
            "manifest-disallowed-effects")
    inventory = m.get("files")
    require(isinstance(inventory, dict) and 1 <= len(inventory) <= 16
            and "current_month.csv" in inventory, "manifest-files")
    for name, metadata in inventory.items():
        require(isinstance(name, str) and
                re.fullmatch(r"[a-z][a-z0-9_]{0,63}\.csv", name) is not None,
                "unsafe-file-path")
        require(isinstance(metadata, dict) and digest(metadata.get("sha256")),
                "file-sha-field")
        require(type(metadata.get("rows")) is int and 0 <= metadata["rows"] <= 5000
                and isinstance(metadata.get("columns"), list)
                and 1 <= len(metadata["columns"]) <= 64
                and all(isinstance(c, str) for c in metadata["columns"]),
                "manifest-file-shape")
    return m


def validate(manifest_bytes: bytes, files: dict[str, bytes], approval: Approval,
             metric_id: str) -> Fact:
    """Pure validation/selection over bounded bytes; preserves exported decimals."""
    require(metric_id in METRICS, "unknown-metric")
    m = _admit_manifest(manifest_bytes, approval)
    inventory = m["files"]
    require(set(files) == set(inventory), "file-inventory")
    require(sum(len(raw) for raw in files.values()) <= MAX_TOTAL, "total-budget")
    current = None
    for name, metadata in inventory.items():
        require(re.fullmatch(r"[a-z][a-z0-9_]{0,63}\.csv", name) is not None,
                "unsafe-file-path")
        require(isinstance(metadata, dict) and digest(metadata.get("sha256")), "file-sha-field")
        raw = files[name]
        require(len(raw) <= MAX_FILE, "file-budget")
        require(sha256(raw).hexdigest() == metadata["sha256"], "file-sha-mismatch")
        table = _table(raw, metadata)
        if name == "current_month.csv":
            current = table
    require(current is not None and current[0] == list(COLUMNS), "current-month-columns")
    require(len(current) == 10, "current-month-population")
    facts = {}
    provenance = Provenance(approval, SOURCE_KIND, sha256(manifest_bytes).hexdigest(),
                            inventory["current_month.csv"]["sha256"])
    for cells in current[1:]:
        row = dict(zip(COLUMNS, cells))
        metric = row["metric_id"]
        require(metric in METRICS and metric not in facts, "unknown-or-duplicate-metric")
        require(row["run_id"] == approval.source_run_id and row["grain"] == "month"
                and row["period_key"] == approval.as_of_date[:7], "current-month-scope")
        require((row["department"], row["unit"]) == METRICS[metric], "metric-metadata")
        require(bool(row["formula_version"]) and bool(row["calculation_owner"]), "formula-metadata")
        num, den, value = (_number(row[k]) for k in ("numerator", "denominator", "metric_value"))
        status = row["status"]
        require(num is not None, "missing-numerator")
        if metric in RATIOS:
            require(den is not None, "missing-denominator")
            if Decimal(den) == 0:
                require(value is None and status == ("not-due" if metric == "PM_ON_TIME"
                                                     else "unknown-denominator"), "zero-denominator")
            else:
                require(value is not None and status == "calculated-synthetic", "ratio-status")
        else:
            require(den is None and value is not None and status ==
                    ("native-reported" if metric in NATIVE else "calculated-synthetic"), "count-status")
        facts[metric] = Fact(metric, value, num, den, status, row["unit"], row["period_key"],
                             row["formula_version"], row["calculation_owner"],
                             row["interpretation_note"], provenance)
    require(set(facts) == set(METRICS), "missing-metric")
    return facts[metric_id]


def _read_at(directory_fd: int, name: str, budget: int) -> bytes:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= budget, "file-type-budget")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(budget + 1)
        require(len(raw) <= budget, "file-growth-budget")
        return raw
    finally:
        os.close(fd)


def select(directory: str | Path, metric_id: str, approval: Approval) -> Fact:
    """Read only an explicit exported directory, refusing symlinks in every component.

    Requires POSIX dir_fd/O_NOFOLLOW. No fallback to weaker path checks.
    """
    path = Path(directory)
    require(path.is_absolute() and ".." not in path.parts, "absolute-explicit-path-required")
    require(hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY"), "safe-open-unavailable")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        manifest = _read_at(fd, "manifest.json", MAX_MANIFEST)
        # Refuse an unapproved manifest BEFORE opening any inventoried CSV.
        m = _admit_manifest(manifest, approval)
        files = {}
        total = 0
        for name in m["files"]:
            require(re.fullmatch(r"[a-z][a-z0-9_]{0,63}\.csv", name) is not None,
                    "unsafe-file-path")
            files[name] = _read_at(fd, name, min(MAX_FILE, MAX_TOTAL - total))
            total += len(files[name])
        return validate(manifest, files, approval, metric_id)
    except (OSError, NotImplementedError) as exc:
        raise Refused("unsafe-or-unreadable-snapshot-path") from exc
    finally:
        os.close(fd)
