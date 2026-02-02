#!/bin/bash
# Tail harness logs in various formats
#
# Usage:
#   ./tail.sh              # Pretty-print latest builder log
#   ./tail.sh --raw        # Raw JSONL
#   ./tail.sh --master     # Master log only
#   ./tail.sh --tools      # Show only tool calls
#   ./tail.sh --verifier   # Latest verifier log

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HARNESS_DIR/logs"

MODE="${1:-pretty}"

get_latest_builder_log() {
  ls -t "$LOG_DIR"/builder_*.jsonl 2>/dev/null | head -1
}

get_latest_verifier_log() {
  ls -t "$LOG_DIR"/verifier_*.jsonl 2>/dev/null | head -1
}

case "$MODE" in
  --raw)
    LATEST=$(get_latest_builder_log)
    if [[ -z "$LATEST" ]]; then
      echo "No builder logs found in $LOG_DIR"
      exit 1
    fi
    echo "Tailing: $LATEST"
    tail -f "$LATEST"
    ;;
  --master)
    tail -f "$LOG_DIR/wiggum_master.log"
    ;;
  --tools)
    LATEST=$(get_latest_builder_log)
    if [[ -z "$LATEST" ]]; then
      echo "No builder logs found in $LOG_DIR"
      exit 1
    fi
    echo "Tailing tool calls from: $LATEST"
    tail -f "$LATEST" | jq -r 'select(.msg.type == "assistant") | .msg.message.content[]? | select(.type == "tool_use") | "\(.name): \(.input | tostring | .[0:100])"'
    ;;
  --verifier)
    LATEST=$(get_latest_verifier_log)
    if [[ -z "$LATEST" ]]; then
      echo "No verifier logs found in $LOG_DIR"
      exit 1
    fi
    echo "Tailing: $LATEST"
    tail -f "$LATEST" | jq -r 'select(.msg.type=="assistant") | (.msg.message.content[]? | select(.type=="text") | .text)'
    ;;
  pretty|*)
    LATEST=$(get_latest_builder_log)
    if [[ -z "$LATEST" ]]; then
      echo "No builder logs found in $LOG_DIR"
      exit 1
    fi
    echo "Tailing: $LATEST"
    tail -f "$LATEST" | jq -r 'select(.msg.type=="assistant") | (.msg.message.content[]? | select(.type=="text") | .text)'
    ;;
esac
