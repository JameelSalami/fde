#!/usr/bin/env bash
set -euo pipefail
# Local owner-controlled validation; no cloud, ERP or MES mutations.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export FDE_AZURE_MODEL_CALL_APPROVED=0
export FDE_NATIVE_BACKFILL_APPLY=0
export PYTHONDONTWRITEBYTECODE=1
test -x .local/workbook-agent/venv/bin/python
test -f .local/kpi-mart/mart-secrets.json

echo "== Existing FDE Haskell, TypeScript and web tests =="
npm run verify

echo "== Synthetic native backfill contract =="
python3 -m unittest discover -s integrations/native-backfill/tests -v

echo "== Operations Excel / mocked Azure integration =="
PYTHONPATH=integrations/operations-excel .local/workbook-agent/venv/bin/python \
  -m unittest discover -s integrations/operations-excel/tests -v

echo "== PostgreSQL KPI mart / negative oracles / LangGraph =="
PYTHONPATH=integrations/kpi-mart .local/workbook-agent/venv/bin/python \
  -m unittest discover -s integrations/kpi-mart/tests -v

echo "FDE_LOCAL_KPI_ALL_GATES_PASSED"
