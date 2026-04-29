#!/bin/bash
# Print a structured narrative summary for a harnessd worker session.
#
# Reads <runDir>/<artifactDir>/session-summary.json when present; falls
# back to live computation via summarizeTranscript() when not.
#
# Usage:
#   ./session.sh PKT-R2-001                              # active role, latest session
#   ./session.sh PKT-R2-001 --role evaluator             # specific role
#   ./session.sh PKT-R2-001 --role builder --attempt 1   # specific role + attempt
#   ./session.sh PKT-R2-001 --all                        # every session for this packet
#   ./session.sh --run-id <id> PKT-R2-001                # explicit run-id
#   ./session.sh planner                                 # planner sessions
#
# Output is a 30-line structured narrative — see the implementation in
# harness/scripts/session-summary-cli.mts for the exact format.

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
exec npx tsx "$HARNESS_DIR/scripts/session-summary-cli.mts" "$@"
