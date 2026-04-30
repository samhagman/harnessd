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

# shellcheck source=./_lib.sh
source "$HARNESS_DIR/_lib.sh"

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
      echo "Unknown option: $1" >&2
      echo "Usage: ./status.sh [--json] [--watch] [--run-id ID]" >&2
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
    echo "No runs found" >&2
    exit 1
  }
  RUN_ID="$(basename "$RUN_DIR")"
fi

if [[ "$FORMAT" == "json" ]]; then
  STATUS_FILE="$RUN_DIR/status.json"
else
  STATUS_FILE="$RUN_DIR/status.md"
fi

if [[ ! -f "$STATUS_FILE" ]]; then
  echo "Status file not found: $STATUS_FILE" >&2
  exit 1
fi

print_status() {
  if [[ "$FORMAT" == "json" ]]; then
    python3 -m json.tool "$STATUS_FILE" 2>/dev/null || cat "$STATUS_FILE"
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
