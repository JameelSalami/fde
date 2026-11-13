#!/usr/bin/env python3
"""One saved FDE case -> review-only Excel artifact; no cloud/vendor effects."""
import argparse
import json
import sys
from workflow import run

def main() -> int:
    p = argparse.ArgumentParser(description="FDE source-pinned workbook")
    p.add_argument("--case", required=True, help="absolute FDE connected-case/v1 JSON")
    p.add_argument("--run-id", required=True, help="new output identity")
    a = p.parse_args()
    result = run(a.case, a.run_id)
    print(json.dumps(result, sort_keys=True))
    return 0 if result.get("status") == "pending-human-review" else 2

if __name__ == "__main__":
    sys.exit(main())
