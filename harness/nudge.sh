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

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="${HARNESSD_RUN_ID:-}"

# Find the active run if not specified
if [ -z "$RUN_ID" ]; then
  RUNS_DIR="$REPO_ROOT/.harnessd/runs"
  if [ ! -d "$RUNS_DIR" ]; then
    echo "Error: No .harnessd/runs directory found" >&2
    exit 1
  fi
  # Pick the most recently updated run
  RUN_ID=$(ls -t "$RUNS_DIR" | head -1)
  if [ -z "$RUN_ID" ]; then
    echo "Error: No runs found" >&2
    exit 1
  fi
fi

INBOX_DIR="$REPO_ROOT/.harnessd/runs/$RUN_ID/inbox"
mkdir -p "$INBOX_DIR"

# Parse args
MSG_TYPE="send_to_agent"
MESSAGE=""

if [ "${1:-}" = "--context" ]; then
  MSG_TYPE="inject_context"
  shift
fi

if [ "${1:-}" = "--stdin" ]; then
  MESSAGE=$(cat)
else
  MESSAGE="${1:-}"
fi

if [ -z "$MESSAGE" ]; then
  echo "Usage: nudge.sh [--context] \"message\"" >&2
  echo "       nudge.sh --stdin < message.md" >&2
  exit 1
fi

# Escape for JSON (handle newlines, quotes, backslashes)
JSON_MESSAGE=$(printf '%s' "$MESSAGE" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')

TIMESTAMP=$(date +%s)
FILENAME="nudge-${TIMESTAMP}.json"

if [ "$MSG_TYPE" = "inject_context" ]; then
  cat > "$INBOX_DIR/$FILENAME" <<EOF
{"type": "inject_context", "context": $JSON_MESSAGE}
EOF
else
  cat > "$INBOX_DIR/$FILENAME" <<EOF
{"type": "send_to_agent", "message": $JSON_MESSAGE}
EOF
fi

echo "Nudge sent → $INBOX_DIR/$FILENAME (type: $MSG_TYPE, run: $RUN_ID)"
