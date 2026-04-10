#!/usr/bin/env bash
# Query harnessd run memory.
#
# Usage:
#   ./harness/memory.sh "why did evaluator fail AC-005?"
#   ./harness/memory.sh --run-id my-run "CSS modules decision"
#   ./harness/memory.sh --timeline --since 1h
#   ./harness/memory.sh --k 10 --mode sem "authentication patterns"
#   ./harness/memory.sh --help
#
# Options:
#   --run-id <id>    Run to query (default: most recent)
#   --timeline       Chronological view instead of relevance search
#   --since <dur>    Timeline start: 1h, 30m, 2d, etc.
#   --k <n>          Number of results (default: 5)
#   --mode <mode>    Search mode: auto | lex | sem (default: auto)
#
# Requires @memvid/sdk: npm install @memvid/sdk

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" && exec npx tsx src/memvid-query.ts "$@"
