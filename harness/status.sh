#!/bin/bash
# Print harnessd run status
#
# Usage:
#   ./status.sh              # Latest run, human-readable
#   ./status.sh --json       # Latest run, JSON
#   ./status.sh --watch      # Refresh every 5s
#   ./status.sh --run-id ID  # Specific run

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
# Harness uses its own dir as repoRoot (cwd), so check both locations
if [[ -d "$HARNESS_DIR/.harnessd/runs" ]]; then
  RUNS_DIR="$HARNESS_DIR/.harnessd/runs"
elif [[ -d "$REPO_ROOT/.harnessd/runs" ]]; then
  RUNS_DIR="$REPO_ROOT/.harnessd/runs"
else
  RUNS_DIR="$HARNESS_DIR/.harnessd/runs"
fi

# ------------------------------------
# Parse arguments
# ------------------------------------

FORMAT="md"
WATCH=false
RUN_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      FORMAT="json"
      shift
      ;;
    --watch)
      WATCH=true
      shift
      ;;
    --run-id)
      RUN_ID="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./status.sh [--json] [--watch] [--run-id ID]"
      exit 1
      ;;
  esac
done

# ------------------------------------
# Find run directory
# ------------------------------------

find_latest_run() {
  if [[ ! -d "$RUNS_DIR" ]]; then
    echo ""
    return
  fi
  # Find the most recently modified run directory (any name, must have run.json)
  local best=""
  local best_time=0
  for dir in "$RUNS_DIR"/*/; do
    if [[ -f "${dir}run.json" ]]; then
      local mtime
      mtime=$(stat -f %m "${dir}run.json" 2>/dev/null || stat -c %Y "${dir}run.json" 2>/dev/null || echo 0)
      if (( mtime > best_time )); then
        best_time=$mtime
        best="$(basename "${dir%/}")"
      fi
    fi
  done
  echo "$best"
}

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(find_latest_run)"
fi

if [[ -z "$RUN_ID" ]]; then
  echo "No runs found in $RUNS_DIR"
  exit 1
fi

RUN_DIR="$RUNS_DIR/$RUN_ID"

if [[ ! -d "$RUN_DIR" ]]; then
  echo "Run not found: $RUN_DIR"
  exit 1
fi

# ------------------------------------
# Status file path
# ------------------------------------

if [[ "$FORMAT" == "json" ]]; then
  STATUS_FILE="$RUN_DIR/status.json"
else
  STATUS_FILE="$RUN_DIR/status.md"
fi

if [[ ! -f "$STATUS_FILE" ]]; then
  echo "Status file not found: $STATUS_FILE"
  exit 1
fi

# ------------------------------------
# Display
# ------------------------------------

print_status() {
  if [[ "$FORMAT" == "json" ]]; then
    cat "$STATUS_FILE" | python3 -m json.tool 2>/dev/null || cat "$STATUS_FILE"
  else
    cat "$STATUS_FILE"
  fi
}

if [[ "$WATCH" == true ]]; then
  while true; do
    clear
    echo "=== harnessd status (refreshing every 5s) === Run: $RUN_ID ==="
    echo ""
    print_status
    sleep 5
  done
else
  print_status
fi
