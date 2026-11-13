#!/usr/bin/env python3
"""Public source-only disclosure/secret gate for a curated FDE Git tree."""
from __future__ import annotations
from pathlib import Path
import re,json,sys,hashlib

ROOT=Path(__file__).resolve().parents[1]
SENSITIVE_NAME=re.compile(r"(^|/)(?:\.env(?:\..*)?|\.git|\.local|\.data|node_modules|dist-newstyle|private|credentials?|secrets?)(?:/|$)",re.I)
FORBIDDEN_LITERAL=(
    b"/srv/data/work/",b"/home/kusho/",b"scriptorium-main",
    b"jml-ph-windows",b"C:/Users/JMLpl",b"192.168.",
    b"10.10.",b"BEGIN OPENSSH PRIVATE KEY",
)
TOKEN_RULES=[
 re.compile(rb"gh[pousr]_[A-Za-z0-9]{30,}"),
 re.compile(rb"github_pat_[A-Za-z0-9_]{35,}"),
 re.compile(rb"AKIA[0-9A-Z]{16}"),
 re.compile(rb"sk-[A-Za-z0-9_-]{32,}"),
 re.compile(rb"AIza[0-9A-Za-z_-]{35}"),
 re.compile(rb"-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----"),
]
def main():
    for f in ("LICENSE","package.json","demo/synthetic-native-reporting.json"):
        if not (ROOT/f).is_file():raise RuntimeError("required-file-missing:"+f)
    package=json.loads((ROOT/"package.json").read_text())
    if package.get("license")!="MIT" or package.get("private") is not True:
        raise RuntimeError("package-scope-refused")
    files=[]
    generated={".git","node_modules","dist","dist-newstyle",
               ".local",".venv","__pycache__",".pytest_cache"}
    for p in sorted(ROOT.rglob("*")):
        parts=p.relative_to(ROOT).parts
        if any(part in generated for part in parts):continue
        if p.suffix==".pyc":continue
        rel=p.relative_to(ROOT).as_posix()
        if p.suffix.lower() in (".md",".mdx",".markdown"):
            raise RuntimeError("private-markdown-refused:"+rel)
        if rel.startswith("kernel/bin/"):continue
        if p.is_symlink():raise RuntimeError("symbolic-link-refused:"+rel)
        if p.is_dir():continue
        if not p.is_file() or p.stat().st_size>1_000_000:
            raise RuntimeError("unexpected-file:"+rel)
        if SENSITIVE_NAME.search("/"+rel+"/"):
            raise RuntimeError("sensitive-path:"+rel)
        content=p.read_bytes()
        if p.relative_to(ROOT).as_posix() not in ("scripts/audit-public-source.py","scripts/check-public-fixture.py"):
            for marker in FORBIDDEN_LITERAL:
                if marker in content:raise RuntimeError("private-host-reference:"+rel)
            for regex in TOKEN_RULES:
                if regex.search(content):raise RuntimeError("credential-pattern:"+rel)
        files.append(rel)
    if len(files)<100:raise RuntimeError("incomplete-curated-code")
    return {
      "schema":"fde.public-source-audit/v1",
      "status":"PUBLIC_SAFE_SOURCE_SCAN",
      "file_count":len(files),
      "has_private_git_history":False,
      "license":"MIT",
      "vendor_payloads":"not-bundled",
      "source_list_sha256":hashlib.sha256("\n".join(files).encode()).hexdigest()
    }
if __name__=="__main__":
    try:print(json.dumps(main(),sort_keys=True))
    except Exception as exc:
        print("PUBLIC_SOURCE_REFUSED "+str(exc),file=sys.stderr)
        raise SystemExit(2)
