#!/bin/bash
# Tail harness logs in various formats
#
# Usage:
#   ./tail.sh              # Tail events.jsonl from latest run
#   ./tail.sh --events     # Same as default
#   ./tail.sh --status     # Alias for ./status.sh --watch
#   ./tail.sh --packet PKT-001  # Tail builder log for specific packet
#   ./tail.sh --builder    # Latest builder transcript
#   ./tail.sh --evaluator  # Latest evaluator transcript

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
RUNS_DIR="$REPO_ROOT/.harnessd/runs"

MODE="${1:---events}"

find_latest_run_dir() {
  if [[ ! -d "$RUNS_DIR" ]]; then
    echo ""
    return
  fi
  ls -1d "$RUNS_DIR"/run-* 2>/dev/null | sort | tail -1
}

find_latest_transcript() {
  local run_dir="$1"
  local role="$2"
  # Check new transcripts/ directory first, fall back to old packets/ location
  {
    find "$run_dir/transcripts" -name "${role}-*.jsonl" -type f 2>/dev/null
    find "$run_dir/packets" -path "*/$role/transcript.jsonl" -type f 2>/dev/null
  } | while read -r f; do
    echo "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null) $f"
  done | sort -rn | head -1 | awk '{print $2}'
}

case "$MODE" in
  --status)
    exec "$HARNESS_DIR/status.sh" --watch
    ;;

  --events)
    RUN_DIR="$(find_latest_run_dir)"
    if [[ -z "$RUN_DIR" ]]; then
      echo "No runs found in $RUNS_DIR"
      exit 1
    fi
    EVENTS_FILE="$RUN_DIR/events.jsonl"
    if [[ ! -f "$EVENTS_FILE" ]]; then
      echo "No events.jsonl found in $RUN_DIR"
      exit 1
    fi
    echo "Tailing events: $EVENTS_FILE"
    tail -f "$EVENTS_FILE" | while read -r line; do
      echo "$line" | python3 -m json.tool 2>/dev/null || echo "$line"
    done
    ;;

  --packet)
    PACKET_ID="${2:?Usage: ./tail.sh --packet PKT-001}"
    RUN_DIR="$(find_latest_run_dir)"
    if [[ -z "$RUN_DIR" ]]; then
      echo "No runs found in $RUNS_DIR"
      exit 1
    fi
    TRANSCRIPT="$RUN_DIR/packets/$PACKET_ID/builder/transcript.jsonl"
    if [[ ! -f "$TRANSCRIPT" ]]; then
      echo "No builder transcript for packet $PACKET_ID"
      echo "  Expected: $TRANSCRIPT"
      exit 1
    fi
    echo "Tailing builder for $PACKET_ID: $TRANSCRIPT"
    tail -f "$TRANSCRIPT" | jq -r 'select(.msg.type=="assistant") | .msg.text // empty'
    ;;

  --builder)
    RUN_DIR="$(find_latest_run_dir)"
    if [[ -z "$RUN_DIR" ]]; then
      echo "No runs found in $RUNS_DIR"
      exit 1
    fi
    TRANSCRIPT="$(find_latest_transcript "$RUN_DIR" "builder")"
    if [[ -z "$TRANSCRIPT" ]]; then
      echo "No builder transcripts found in $RUN_DIR"
      exit 1
    fi
    echo "Tailing: $TRANSCRIPT"
    tail -f "$TRANSCRIPT" | jq -r 'select(.msg.type=="assistant") | .msg.text // empty'
    ;;

  --evaluator)
    RUN_DIR="$(find_latest_run_dir)"
    if [[ -z "$RUN_DIR" ]]; then
      echo "No runs found in $RUNS_DIR"
      exit 1
    fi
    TRANSCRIPT="$(find_latest_transcript "$RUN_DIR" "evaluator")"
    if [[ -z "$TRANSCRIPT" ]]; then
      echo "No evaluator transcripts found in $RUN_DIR"
      exit 1
    fi
    echo "Tailing: $TRANSCRIPT"
    tail -f "$TRANSCRIPT" | jq -r 'select(.msg.type=="assistant") | .msg.text // empty'
    ;;

  *)
    echo "Usage: ./tail.sh [--events|--status|--builder|--evaluator|--packet PKT-ID]"
    exit 1
    ;;
esac
