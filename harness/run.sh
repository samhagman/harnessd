#!/bin/bash
# Wiggum Loop launcher
#
# Usage:
#   ./run.sh                              # Run with defaults
#   ./run.sh --sanity-check               # Quick sanity check (1 loop, trivial prompts)
#   WIGGUM_MAX_LOOPS=20 ./run.sh          # Override max loops
#   WIGGUM_COOLDOWN_SECONDS=5 ./run.sh    # Override cooldown
#
# Environment variables:
#   WIGGUM_MAX_LOOPS          Max builder iterations (default: 15)
#   WIGGUM_COOLDOWN_SECONDS   Seconds between iterations (default: 2)
#   WIGGUM_REPO_ROOT          Override repo root detection

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

# TBD: Check required tools for your project
echo "[harness] Checking prerequisites..."
# Example prerequisite checks:
# for tool in python3 node npm; do
#   if ! command -v "$tool" &> /dev/null; then
#     echo "[ERROR] Required tool not found: $tool"
#     echo "Please install it before running the harness."
#     exit 1
#   fi
# done

echo "[harness] Prerequisites OK"
echo ""

# Install deps if needed
if [ ! -d "$HARNESS_DIR/node_modules" ]; then
  echo "[harness] Installing dependencies..."
  cd "$HARNESS_DIR"
  npm install
  cd "$REPO_ROOT"
fi

echo "[harness] Repo root: $REPO_ROOT"
echo "[harness] Harness:   $HARNESS_DIR"
echo "[harness] Starting Wiggum Loop..."
echo ""

# Run from repo root so cwd is correct for the builder/verifier agents
cd "$REPO_ROOT"

export WIGGUM_REPO_ROOT="$REPO_ROOT"
export WIGGUM_HARNESS_DIR="$HARNESS_DIR"

exec npx tsx "$HARNESS_DIR/wiggum-loop.ts" "$@"
