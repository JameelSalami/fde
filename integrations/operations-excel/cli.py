#!/usr/bin/env python3
"""Engineer-operated Excel report pipeline. Azure inference is opt-in only."""
from __future__ import annotations
import argparse
import json
import sys
from workflow import run

def main()->int:
    p=argparse.ArgumentParser(description="FDE Haskell KPI -> LangGraph -> Excel handoff")
    p.add_argument("--summary",required=True,help="absolute path to normalized shift summary CSV")
    p.add_argument("--losses",required=True,help="absolute path to loss categories CSV")
    p.add_argument("--run-id",required=True)
    p.add_argument("--source-class",default="manual-export",
      choices=["handwritten-fixture","synthetic-worksheet","manual-export"])
    p.add_argument("--mode",default="offline",choices=["offline","azure"])
    a=p.parse_args()
    result=run(a.summary,a.losses,a.run_id,a.source_class,a.mode)
    print(json.dumps(result,sort_keys=True))
    return 0 if result.get("status")=="excel-render-ready" else 2

if __name__=="__main__":sys.exit(main())
