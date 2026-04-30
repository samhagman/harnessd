#!/bin/bash
# Send a poke message to a running harnessd
#
# Usage:
#   ./poke.sh "summarize current packet"
#   ./poke.sh "investigate stale heartbeat"

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

# shellcheck source=./_lib.sh
source "$HARNESS_DIR/_lib.sh"

if [[ $# -lt 1 ]]; then
  echo "Usage: ./poke.sh \"message to send\"" >&2
  exit 1
fi

MESSAGE="$1"

RUN_DIR="$(find_latest_run_dir "$HARNESS_DIR" "$REPO_ROOT")" || {
  echo "No runs found" >&2
  exit 1
}
RUN_ID="$(basename "$RUN_DIR")"
INBOX_DIR="$RUN_DIR/inbox"
mkdir -p "$INBOX_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="${TIMESTAMP}-poke.json"
ISO_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
JSON_MESSAGE=$(printf '%s' "$MESSAGE" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')

printf '{"type":"poke","createdAt":"%s","message":%s}\n' "$ISO_TS" "$JSON_MESSAGE" > "$INBOX_DIR/$FILENAME"

echo "Poke sent to run $RUN_ID"
echo "  File: $INBOX_DIR/$FILENAME"
echo "  Message: $MESSAGE"
echo ""

STATUS_FILE="$RUN_DIR/status.md"
if [[ -f "$STATUS_FILE" ]]; then
  echo "Status: $STATUS_FILE"
fi
