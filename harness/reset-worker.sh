#!/usr/bin/env bash
# Reset a worker's resumable session so the next --resume starts it fresh.
#
# Harnessd resumes any worker whose artifact dir holds a session.json with a
# valid sessionId. This script removes that file (plus the stale heartbeat and
# any partial result) for one role, so the operator can force a clean restart
# without editing the state machine.
#
# Usage:
#   ./harness/reset-worker.sh <run-id> <packet-id|--planner> <role>
#
# Roles: planner | contract_builder | contract_evaluator | builder | evaluator | qa_agent | round2_planner
#
# Examples:
#   ./harness/reset-worker.sh my-run PKT-001 evaluator
#   ./harness/reset-worker.sh my-run --planner planner
#   ./harness/reset-worker.sh my-run --planner round2_planner

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
# shellcheck source=./_lib.sh
source "$HARNESS_DIR/_lib.sh"

if [ $# -lt 3 ]; then
  echo "Usage: $0 <run-id> <packet-id|--planner> <role>" >&2
  echo "       $0 my-run PKT-001 evaluator" >&2
  echo "       $0 my-run --planner planner" >&2
  exit 1
fi

RUN_ID="$1"
PACKET_ID="$2"
ROLE="$3"

# Resolve run dir via shared helper (requires run.json so we never latch onto
# an empty stub dir left by an earlier misrouted command).
RUN_DIR=$(resolve_run_dir "$HARNESS_DIR" "$REPO_ROOT" "$RUN_ID") || {
  echo "Error: run '$RUN_ID' (with run.json) not found under $REPO_ROOT/.harnessd/runs/ or $HARNESS_DIR/.harnessd/runs/" >&2
  exit 1
}

# Resolve the artifact dir for (packetId, role).
# Per-packet roles live under packets/<id>/<subdir>, where subdir is:
#   builder          → builder/
#   evaluator        → evaluator/
#   contract_builder → contract/
#   contract_evaluator → contract/
# Planning roles live under spec/ (or spec/qa-r<N> for QA rounds) and ignore packet-id.
case "$ROLE" in
  planner|round2_planner)
    ARTIFACT_DIR="$RUN_DIR/spec" ;;
  qa_agent)
    # QA artifacts are round-scoped; operator would need to pass the round,
    # but the common case is "reset the latest round" — pick the highest qa-r*.
    latest=$(ls -d "$RUN_DIR"/spec/qa-r* 2>/dev/null | sort -V | tail -1)
    if [ -z "$latest" ]; then
      echo "Error: no qa-r* artifact dirs found under $RUN_DIR/spec/" >&2
      exit 1
    fi
    ARTIFACT_DIR="$latest" ;;
  builder|evaluator)
    if [ "$PACKET_ID" = "--planner" ]; then
      echo "Error: role '$ROLE' requires a packet-id, not --planner" >&2
      exit 1
    fi
    ARTIFACT_DIR="$RUN_DIR/packets/$PACKET_ID/$ROLE" ;;
  contract_builder|contract_evaluator)
    if [ "$PACKET_ID" = "--planner" ]; then
      echo "Error: role '$ROLE' requires a packet-id, not --planner" >&2
      exit 1
    fi
    ARTIFACT_DIR="$RUN_DIR/packets/$PACKET_ID/contract" ;;
  *)
    echo "Error: unknown role '$ROLE'" >&2
    echo "Valid: planner, contract_builder, contract_evaluator, builder, evaluator, qa_agent, round2_planner" >&2
    exit 1 ;;
esac

if [ ! -d "$ARTIFACT_DIR" ]; then
  echo "Error: artifact dir not found: $ARTIFACT_DIR" >&2
  exit 1
fi

removed=()
for f in session.json heartbeat.json result.json; do
  target="$ARTIFACT_DIR/$f"
  if [ -f "$target" ]; then
    rm "$target"
    removed+=("$f")
  fi
done

if [ ${#removed[@]} -eq 0 ]; then
  echo "Nothing to clear in $ARTIFACT_DIR (no session.json / heartbeat.json / result.json)."
  exit 0
fi

echo "Cleared from $ARTIFACT_DIR:"
for f in "${removed[@]}"; do echo "  - $f"; done
echo
echo "Next \`--resume $RUN_ID\` will start this $ROLE fresh."
