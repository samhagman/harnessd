#!/bin/bash
# Resume a harnessd run
#
# Usage:
#   ./resume.sh              # Resume latest run
#   ./resume.sh --run-id ID  # Resume specific run

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

# shellcheck source=./_lib.sh
source "$HARNESS_DIR/_lib.sh"

RUN_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      RUN_ID="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: ./resume.sh [--run-id ID]" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$RUN_ID" ]]; then
  RUN_DIR="$(resolve_run_dir "$HARNESS_DIR" "$REPO_ROOT" "$RUN_ID")" || {
    echo "Run not found: $RUN_ID" >&2
    exit 1
  }
else
  RUN_DIR="$(find_latest_run_dir "$HARNESS_DIR" "$REPO_ROOT")" || {
    echo "No runs found to resume." >&2
    exit 1
  }
  RUN_ID="$(basename "$RUN_DIR")"
fi

echo "Resuming run: $RUN_ID"
echo "Run directory: $RUN_DIR"
echo ""

cd "$REPO_ROOT"
export HARNESSD_REPO_ROOT="$REPO_ROOT"
exec npx tsx "$HARNESS_DIR/src/main.ts" --resume "$RUN_ID"
