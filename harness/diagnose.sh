#!/bin/bash
# Classify a harnessd worker session's current state with bounded evidence.
#
# Outputs ONE classification (sealed enum, first-match-wins) with supporting
# evidence and a recommended action. Use this BEFORE claiming a session is
# stuck/silent/crashed/looping/etc., per the Diagnostic-First Rule in the
# harnessd-operator skill.
#
# Usage:
#   ./diagnose.sh PKT-R2-001                              # active role, latest session
#   ./diagnose.sh PKT-R2-001 --role evaluator             # specific role
#   ./diagnose.sh PKT-R2-001 --role builder --attempt 1   # specific attempt
#   ./diagnose.sh --run-id <id> PKT-R2-001                # explicit run-id
#
# Built on top of session-summary.json (Fix 2). Falls back to live computation
# if the harness hasn't yet written the artifact.

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
exec npx tsx "$HARNESS_DIR/scripts/diagnose-cli.mts" "$@"
