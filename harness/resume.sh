#!/bin/bash
# Resume a harnessd run
#
# Usage:
#   ./resume.sh              # Resume latest run
#   ./resume.sh --run-id ID  # Resume specific run

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
RUNS_DIR="$REPO_ROOT/.harnessd/runs"

# ------------------------------------
# Parse arguments
# ------------------------------------

RUN_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      RUN_ID="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./resume.sh [--run-id ID]"
      exit 1
      ;;
  esac
done

# ------------------------------------
# Find run to resume
# ------------------------------------

if [[ -z "$RUN_ID" ]]; then
  if [[ ! -d "$RUNS_DIR" ]]; then
    echo "No runs found in $RUNS_DIR"
    exit 1
  fi
  RUN_ID="$(ls -1d "$RUNS_DIR"/run-* 2>/dev/null | sort | tail -1 | xargs -I{} basename {})"
fi

if [[ -z "$RUN_ID" ]]; then
  echo "No runs found to resume."
  exit 1
fi

RUN_DIR="$RUNS_DIR/$RUN_ID"

if [[ ! -d "$RUN_DIR" ]]; then
  echo "Run not found: $RUN_DIR"
  exit 1
fi

echo "Resuming run: $RUN_ID"
echo "Run directory: $RUN_DIR"
echo ""

cd "$REPO_ROOT"
export WIGGUM_REPO_ROOT="$REPO_ROOT"
exec npx tsx "$HARNESS_DIR/src/main.ts" --resume "$RUN_ID"
