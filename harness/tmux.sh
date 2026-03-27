#!/bin/bash
# Create a 3-pane tmux session for harnessd operation
#
# Pane layout:
#   ┌──────────────────┬──────────────────┐
#   │                  │                  │
#   │   orchestrator   │  status --watch  │
#   │                  │                  │
#   │                  ├──────────────────┤
#   │                  │                  │
#   │                  │   tail --events  │
#   │                  │                  │
#   └──────────────────┴──────────────────┘
#
# Usage:
#   ./tmux.sh                     # Start new run (will prompt for objective)
#   ./tmux.sh --resume            # Resume latest run
#   ./tmux.sh --resume --run-id X # Resume specific run

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION_NAME="harnessd"

# Check tmux is available
if ! command -v tmux &>/dev/null; then
  echo "tmux is not installed. Install it with: brew install tmux"
  exit 1
fi

# Kill existing session if present
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

# Build orchestrator command from args
ORCH_CMD="echo 'Waiting for run to start...'"
if [[ $# -gt 0 ]]; then
  ORCH_CMD="$HARNESS_DIR/run.sh $*"
fi

# Create tmux session with 3 panes
tmux new-session -d -s "$SESSION_NAME" -x 200 -y 50

# Pane 0 (left): orchestrator
tmux send-keys -t "$SESSION_NAME:0.0" "cd $REPO_ROOT && $ORCH_CMD" C-m

# Split right
tmux split-window -h -t "$SESSION_NAME:0.0"

# Pane 1 (top-right): status --watch
tmux send-keys -t "$SESSION_NAME:0.1" "sleep 3 && $HARNESS_DIR/status.sh --watch" C-m

# Split bottom-right
tmux split-window -v -t "$SESSION_NAME:0.1"

# Pane 2 (bottom-right): tail --events
tmux send-keys -t "$SESSION_NAME:0.2" "sleep 3 && $HARNESS_DIR/tail.sh --events" C-m

# Select the orchestrator pane
tmux select-pane -t "$SESSION_NAME:0.0"

# Attach
tmux attach-session -t "$SESSION_NAME"
