#!/usr/bin/env python3
"""Create ignored local fixture input; does not touch vendor services or DB."""
from pathlib import Path
from shutil import copyfile
import subprocess,sys
root=Path(__file__).resolve().parents[1]
check=subprocess.run([sys.executable,str(root/"scripts/check-public-fixture.py")],
    cwd=root,check=False,capture_output=True,text=True,timeout=15)
if check.returncode:raise SystemExit("fixture-validation-refused")
target=root/".local/native-backfill/FDEBF14-20261113/native-excel-refresh.json"
if target.exists() or target.is_symlink():
    raise SystemExit("destination-exists-no-overwrite")
target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
with target.open("xb") as out:
    out.write((root/"demo/synthetic-native-reporting.json").read_bytes())
    out.flush()
target.chmod(0o600)
print("SYNTHETIC_OFFLINE_INPUT_STAGED",target.relative_to(root))
