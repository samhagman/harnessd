#!/bin/bash
# Harnessd v2 launcher
#
# Usage:
#   ./run.sh "your objective"            # Run the harness
#   ./run.sh --plan-only "objective"     # Plan only, don't build
#   ./run.sh --resume [run-id]           # Resume an interrupted run
#   ./run.sh --status [run-id]           # Show run status
#
# Environment variables:
#   HARNESSD_REPO_ROOT        Override repo root detection
#                             (also accepts legacy WIGGUM_REPO_ROOT)

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

# Install deps if needed
if [ ! -d "$HARNESS_DIR/node_modules" ]; then
  echo "[harness] Installing dependencies..."
  cd "$HARNESS_DIR"
  npm install
  cd "$REPO_ROOT"
fi

# Run from repo root so cwd is correct for the builder/verifier agents
cd "$REPO_ROOT"

export HARNESSD_REPO_ROOT="$REPO_ROOT"

exec npx tsx "$HARNESS_DIR/src/main.ts" "$@"
