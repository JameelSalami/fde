"""Finite LangGraph workflow: source admission -> local workbook -> readback -> human handoff."""
from __future__ import annotations
from pathlib import Path
from typing import Any, TypedDict
from hashlib import sha256
import json
import os
import re
import subprocess
from langgraph.graph import StateGraph, START, END
from engine import Refused, admitted_rows, write_xlsx, reopen_and_verify, make_manifest

ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "bin" / "fde-workbook-source.mjs"
OUTPUTS = ROOT / ".local" / "workbook-agent" / "outputs"
RUN_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")

class State(TypedDict, total=False):
    case_path: str
    run_id: str
    source: dict[str, Any]
    rows: dict[str, list[list[str]]]
    run_dir: str
    temporary_workbook: str
    workbook: str
    manifest: str
    error: str
    status: str

def read_evidence(state: State) -> State:
    try:
        proc = subprocess.run(["node", str(BRIDGE), state["case_path"]],
                              cwd=ROOT, capture_output=True, text=True, check=False, timeout=35)
        if proc.returncode != 0 or len(proc.stdout) > 700_000:
            raise Refused("fde-haskell-native-source-refused")
        source = json.loads(proc.stdout)
        if not isinstance(source, dict): raise Refused("source-envelope-refused")
        return {"source": source, "status": "source-readback-verified"}
    except (Refused, ValueError, OSError, subprocess.TimeoutExpired):
        return {"error": "fde-evidence-admission-refused", "status": "refused"}

def bind_report(state: State) -> State:
    try:
        rows = admitted_rows(state["source"])
        return {"rows": rows, "status": "workbook-plan-validated"}
    except (Refused, KeyError, TypeError, AttributeError):
        return {"error": "workbook-evidence-contract-refused", "status": "refused"}

def safe_dir(run_id: str) -> Path:
    if not isinstance(run_id, str) or not RUN_ID_RE.fullmatch(run_id):
        raise Refused("run-identifier-refused")
    OUTPUTS.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = OUTPUTS.lstat()
    if not OUTPUTS.is_dir() or OUTPUTS.is_symlink() or st.st_mode & 0o077 or st.st_uid != os.getuid():
        raise Refused("output-custody-refused")
    d = OUTPUTS / run_id
    if d.exists() or d.is_symlink(): raise Refused("run-already-exists")
    d.mkdir(mode=0o700)
    return d

def render(state: State) -> State:
    try:
        directory = safe_dir(state["run_id"])
        temporary = directory / "unverified.xlsx"
        write_xlsx(state["rows"], temporary)
        temporary.chmod(0o600)
        if temporary.stat().st_size > 3_000_000:raise Refused("output-size-refused")
        return {"run_dir": str(directory), "temporary_workbook": str(temporary),
                "status": "local-workbook-built-unverified"}
    except (Refused, ValueError, OSError):
        return {"error": "local-workbook-render-refused", "status": "refused"}

def verify_and_seal(state: State) -> State:
    directory = Path(state["run_dir"])
    temporary = Path(state["temporary_workbook"])
    final = directory / "FDE_Investigation.xlsx"
    document = directory / "handoff-manifest.json"
    temp_manifest = directory / "unverified-manifest.json"
    manifest_linked = False
    workbook_linked = False
    try:
        verified = reopen_and_verify(temporary, state["rows"])
        metadata = make_manifest(state["source"], verified, state["run_id"])
        with temp_manifest.open("x", encoding="utf8") as f:
            os.fchmod(f.fileno(), 0o600)
            json.dump(metadata, f, indent=2, sort_keys=True)
            f.write("\n")
        check = json.loads(temp_manifest.read_text())
        if check["workbookSha256"] != sha256(temporary.read_bytes()).hexdigest():
            raise Refused("manifest-binary-mismatch")
        if check["humanReview"] != "pending" or check["sourceWriteAllowed"] is not False:
            raise Refused("manifest-authority-refused")
        # Hardlink publication is O_EXCL-like on POSIX: an existing name
        # cannot be overwritten by another concurrent run.
        os.link(temp_manifest, document, follow_symlinks=False)
        manifest_linked = True
        os.link(temporary, final, follow_symlinks=False)
        workbook_linked = True
        temporary.unlink()
        temp_manifest.unlink()
        return {"workbook":str(final), "manifest":str(document),
                "status":"verified-local-workbook"}
    except (Refused, ValueError, KeyError, OSError):
        # Refusal never leaves a final-named workbook/manifest behind.
        if workbook_linked:
            try:final.unlink()
            except OSError:pass
        if manifest_linked:
            try:document.unlink()
            except OSError:pass
        return {"error":"independent-workbook-verification-refused","status":"refused"}

def pending_review(state: State) -> State:
    return {"status": "refused" if state.get("error") else "pending-human-review"}

def refuse(state: State) -> State:
    return {"status": "refused"}

def route(state: State) -> str:
    return "refuse" if state.get("error") else "continue"

def make_graph():
    g = StateGraph(State)
    g.add_node("load_native_evidence", read_evidence)
    g.add_node("plan_projection", bind_report)
    g.add_node("render_local_xlsx", render)
    g.add_node("independent_readback", verify_and_seal)
    g.add_node("human_handoff", pending_review)
    g.add_node("refuse", refuse)
    g.add_edge(START, "load_native_evidence")
    g.add_conditional_edges("load_native_evidence", route, {"continue": "plan_projection", "refuse": "refuse"})
    g.add_conditional_edges("plan_projection", route, {"continue": "render_local_xlsx", "refuse": "refuse"})
    g.add_conditional_edges("render_local_xlsx", route, {"continue": "independent_readback", "refuse": "refuse"})
    g.add_conditional_edges("independent_readback", route, {"continue": "human_handoff", "refuse": "refuse"})
    g.add_edge("human_handoff", END)
    g.add_edge("refuse", END)
    return g.compile()

def run(case_path: str, run_id: str) -> State:
    if not RUN_ID_RE.fullmatch(run_id):
        return {"status": "refused", "error": "run-identifier-refused"}
    result = make_graph().invoke({"case_path": case_path, "run_id": run_id})
    return {k: result[k] for k in ("status", "error", "workbook", "manifest") if k in result}
