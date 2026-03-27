#!/bin/bash
# Send a poke message to a running harnessd
#
# Usage:
#   ./poke.sh "summarize current packet"
#   ./poke.sh "investigate stale heartbeat"

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
RUNS_DIR="$REPO_ROOT/.harnessd/runs"

# ------------------------------------
# Validate arguments
# ------------------------------------

if [[ $# -lt 1 ]]; then
  echo "Usage: ./poke.sh \"message to send\""
  exit 1
fi

MESSAGE="$1"

# ------------------------------------
# Find latest run
# ------------------------------------

find_latest_run() {
  if [[ ! -d "$RUNS_DIR" ]]; then
    echo ""
    return
  fi
  ls -1d "$RUNS_DIR"/run-* 2>/dev/null | sort | tail -1 | xargs -I{} basename {}
}

RUN_ID="$(find_latest_run)"

if [[ -z "$RUN_ID" ]]; then
  echo "No runs found in $RUNS_DIR"
  exit 1
fi

RUN_DIR="$RUNS_DIR/$RUN_ID"
INBOX_DIR="$RUN_DIR/inbox"

# ------------------------------------
# Write poke message
# ------------------------------------

mkdir -p "$INBOX_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="${TIMESTAMP}-poke.json"
ISO_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$INBOX_DIR/$FILENAME" <<POKE_EOF
{
  "type": "poke",
  "createdAt": "$ISO_TS",
  "message": $(python3 -c "import json; print(json.dumps('$MESSAGE'))" 2>/dev/null || echo "\"$MESSAGE\"")
}
POKE_EOF

echo "Poke sent to run $RUN_ID"
echo "  File: $INBOX_DIR/$FILENAME"
echo "  Message: $MESSAGE"
echo ""

# Show latest status path
STATUS_FILE="$RUN_DIR/status.md"
if [[ -f "$STATUS_FILE" ]]; then
  echo "Status: $STATUS_FILE"
fi
