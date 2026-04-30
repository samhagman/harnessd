#!/usr/bin/env bash
# Send a nudge to the currently running builder/evaluator agent.
#
# Usage:
#   ./harness/nudge.sh "Your message here"
#   ./harness/nudge.sh --context "Injected into context-overrides.md"
#   cat message.md | ./harness/nudge.sh --stdin
#
# The message is written as JSON to the inbox/ directory where the
# orchestrator's nudge poller picks it up within ~100ms. It gets:
# 1. Live-injected into the running session via streamInput() (if active)
# 2. Written to packets/<packetId>/nudge.md as fallback
# 3. Appended to context-overrides.md for persistence

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

# shellcheck source=./_lib.sh
source "$HARNESS_DIR/_lib.sh"

RUN_ID="${HARNESSD_RUN_ID:-}"

if [[ -z "$RUN_ID" ]]; then
  RUN_DIR="$(find_latest_run_dir "$HARNESS_DIR" "$REPO_ROOT")" || {
    echo "Error: No runs found" >&2
    exit 1
  }
  RUN_ID="$(basename "$RUN_DIR")"
else
  RUN_DIR="$(resolve_run_dir "$HARNESS_DIR" "$REPO_ROOT" "$RUN_ID")" || {
    echo "Error: run '$RUN_ID' (with run.json) not found" >&2
    exit 1
  }
fi

INBOX_DIR="$RUN_DIR/inbox"
mkdir -p "$INBOX_DIR"

MSG_TYPE="send_to_agent"
MESSAGE=""

if [[ "${1:-}" == "--context" ]]; then
  MSG_TYPE="inject_context"
  shift
fi

if [[ "${1:-}" == "--stdin" ]]; then
  MESSAGE=$(cat)
else
  MESSAGE="${1:-}"
fi

if [[ -z "$MESSAGE" ]]; then
  echo "Usage: nudge.sh [--context] \"message\"" >&2
  echo "       nudge.sh --stdin < message.md" >&2
  exit 1
fi

JSON_MESSAGE=$(printf '%s' "$MESSAGE" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')

TIMESTAMP=$(date +%s)
FILENAME="nudge-${TIMESTAMP}.json"

if [[ "$MSG_TYPE" == "inject_context" ]]; then
  printf '{"type": "inject_context", "context": %s}\n' "$JSON_MESSAGE" > "$INBOX_DIR/$FILENAME"
else
  printf '{"type": "send_to_agent", "message": %s}\n' "$JSON_MESSAGE" > "$INBOX_DIR/$FILENAME"
fi

echo "Nudge sent → $INBOX_DIR/$FILENAME (type: $MSG_TYPE, run: $RUN_ID)"
