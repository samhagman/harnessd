#!/bin/bash
# Tail harness logs in various formats
#
# Usage:
#   ./tail.sh              # Tail everything (default: --all)
#   ./tail.sh --all        # Unified live view: events + agent thinking/text/tools
#   ./tail.sh --events     # Tail events.jsonl only
#   ./tail.sh --status     # Alias for ./status.sh --watch
#   ./tail.sh --packet PKT-001  # Tail builder log for specific packet
#   ./tail.sh --builder    # Latest builder transcript
#   ./tail.sh --evaluator  # Latest evaluator transcript
#   ./tail.sh --run-id ID  # Use a specific run (works with any mode)

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

# shellcheck source=./_lib.sh
source "$HARNESS_DIR/_lib.sh"

EXPLICIT_RUN_ID=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      EXPLICIT_RUN_ID="${2:?Usage: ./tail.sh --run-id <ID> [mode]}"
      shift 2
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

MODE="${ARGS[0]:---all}"
EXTRA_ARG="${ARGS[1]:-}"

get_run_dir() {
  if [[ -n "$EXPLICIT_RUN_ID" ]]; then
    resolve_run_dir "$HARNESS_DIR" "$REPO_ROOT" "$EXPLICIT_RUN_ID" || {
      echo "Run not found: $EXPLICIT_RUN_ID" >&2
      exit 1
    }
  else
    find_latest_run_dir "$HARNESS_DIR" "$REPO_ROOT" || {
      echo "No runs found" >&2
      exit 1
    }
  fi
}

find_latest_transcript() {
  local run_dir="$1"
  local role="$2"
  {
    find "$run_dir/transcripts" -name "${role}-*.jsonl" -type f 2>/dev/null
    find "$run_dir/packets" -path "*/$role/transcript.jsonl" -type f 2>/dev/null
    if [[ "$role" == "planner" ]]; then
      find "$run_dir/spec" -name "transcript.jsonl" -type f 2>/dev/null
    fi
  } | while read -r f; do
    echo "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null) $f"
  done | sort -rn | head -1 | awk '{print $2}'
}

BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'
CYAN='\033[36m'
YELLOW='\033[33m'
GREEN='\033[32m'
BLUE='\033[34m'
MAGENTA='\033[35m'
RED='\033[31m'
WHITE='\033[37m'

tail_all() {
  local run_dir="$1"
  local run_id
  run_id=$(basename "$run_dir")
  local events_file="$run_dir/events.jsonl"

  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}${CYAN}║  HARNESSD LIVE — ${WHITE}${run_id}${CYAN}$(printf '%*s' $((40 - ${#run_id})) '')║${RESET}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${RESET}"
  echo ""

  if [[ -f "$run_dir/run.json" ]]; then
    python3 -c "
import json, sys
with open('$run_dir/run.json') as f:
    d = json.load(f)
phase = d.get('phase','?')
pkt = d.get('currentPacketId','—')
done = d.get('completedPacketIds',[])
order = d.get('packetOrder',[])
print(f'  Phase: \033[1m{phase}\033[0m  |  Packet: {pkt}  |  Done: {len(done)}/{len(order)}')
" 2>/dev/null
    echo ""
  fi

  local current_transcript=""
  local transcript_pid=""

  find_active_transcript() {
    {
      find "$run_dir/spec" -name "transcript.jsonl" -type f 2>/dev/null
      find "$run_dir/transcripts" -name "*.jsonl" -type f 2>/dev/null
      find "$run_dir/packets" -name "transcript.jsonl" -type f 2>/dev/null
    } | while read -r f; do
      echo "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null) $f"
    done | sort -rn | head -1 | awk '{print $2}'
  }

  FORMAT_SCRIPT=$(cat <<'PYEOF'
import sys, json

BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
BLUE = "\033[34m"
MAGENTA = "\033[35m"
RED = "\033[31m"
WHITE = "\033[37m"

def format_time(ts):
    if not ts: return ""
    try:
        return ts[11:19]
    except:
        return ""

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except:
        print(line)
        continue

    if "event" in d and "phase" in d:
        ts = format_time(d.get("ts",""))
        event = d.get("event","")
        detail = d.get("detail","")
        pkt = d.get("packetId","")

        icon = "●"
        color = WHITE
        if "started" in event: icon = "▶"; color = GREEN
        elif "completed" in event or "passed" in event or "accepted" in event: icon = "✓"; color = GREEN
        elif "failed" in event: icon = "✗"; color = RED
        elif "awaiting" in event: icon = "⏸"; color = YELLOW
        elif "selected" in event: icon = "→"; color = CYAN
        elif "approved" in event: icon = "✓"; color = GREEN

        parts = [f"{DIM}{ts}{RESET}", f"{color}{icon} {BOLD}{event}{RESET}"]
        if pkt: parts.append(f"{CYAN}{pkt}{RESET}")
        if detail: parts.append(f"{DIM}{detail[:80]}{RESET}")
        print("  ".join(parts))
        continue

    msg = d.get("msg", {})
    ts = format_time(d.get("ts",""))
    msg_type = msg.get("type","")
    raw = msg.get("raw", {})

    if msg_type == "system":
        model = raw.get("model","?")
        print(f"\n{DIM}{ts}{RESET}  {MAGENTA}⚡ session started{RESET}  {DIM}model={model}{RESET}")
        continue

    if msg_type == "result":
        is_error = msg.get("isError", False)
        cost = msg.get("costUsd", 0)
        turns = msg.get("numTurns", 0)
        if is_error:
            print(f"\n{DIM}{ts}{RESET}  {RED}✗ session error{RESET}  {DIM}turns={turns} cost=${cost:.2f}{RESET}")
        else:
            print(f"\n{DIM}{ts}{RESET}  {GREEN}✓ session done{RESET}  {DIM}turns={turns} cost=${cost:.2f}{RESET}")
        continue

    if msg_type == "assistant":
        message = raw.get("message", {})
        content = message.get("content", [])
        if not isinstance(content, list):
            continue

        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type","")

            if btype == "thinking":
                thinking = block.get("thinking","")
                if thinking:
                    lines = thinking.strip().split("\n")
                    preview = lines[0][:120]
                    if len(lines) > 1:
                        preview += f" (+{len(lines)-1} lines)"
                    print(f"  {DIM}{ts}  💭 {preview}{RESET}")

            elif btype == "text":
                text = block.get("text","")
                if text:
                    for tline in text.strip().split("\n"):
                        if tline.strip():
                            print(f"  {DIM}{ts}{RESET}  {WHITE}{tline}{RESET}")

            elif btype == "tool_use":
                name = block.get("name","?")
                inp = block.get("input",{})

                detail = ""
                if name in ("Read", "Glob", "Grep"):
                    detail = inp.get("file_path","") or inp.get("pattern","") or inp.get("path","")
                elif name == "Bash":
                    cmd = inp.get("command","")
                    detail = cmd[:80] + ("..." if len(cmd) > 80 else "")
                elif name in ("Edit", "Write"):
                    detail = inp.get("file_path","")
                elif name == "Agent":
                    detail = inp.get("description","")
                elif name == "Skill":
                    detail = inp.get("skill","")
                else:
                    for k, v in list(inp.items())[:1]:
                        detail = f"{k}={str(v)[:60]}"

                icon = "🔧"
                color = BLUE
                if name in ("Edit", "Write"): icon = "✏️"; color = YELLOW
                elif name in ("Bash",): icon = "⚡"; color = MAGENTA
                elif name in ("Read", "Glob", "Grep"): icon = "🔍"; color = CYAN
                elif name == "Agent": icon = "🤖"; color = GREEN

                print(f"  {DIM}{ts}{RESET}  {color}{icon} {name}{RESET}  {DIM}{detail}{RESET}")

    sys.stdout.flush()
PYEOF
)

  {
    if [[ -f "$events_file" ]]; then
      tail -f "$events_file" &
    fi

    while true; do
      local latest
      latest=$(find_active_transcript)

      if [[ -n "$latest" && "$latest" != "$current_transcript" ]]; then
        if [[ -n "$transcript_pid" ]]; then
          kill "$transcript_pid" 2>/dev/null || true
          wait "$transcript_pid" 2>/dev/null || true
        fi

        current_transcript="$latest"

        local role_label=""
        if [[ "$latest" == *"/spec/"* ]]; then
          role_label="planner"
        elif [[ "$latest" == *"builder"* ]]; then
          role_label="builder"
        elif [[ "$latest" == *"evaluator"* ]]; then
          role_label="evaluator"
        fi

        echo -e "\n${BOLD}${CYAN}── [$role_label] $(basename "$latest") ──${RESET}\n"

        tail -f "$latest" &
        transcript_pid=$!
      fi

      sleep 2
    done
  } | python3 -u -c "$FORMAT_SCRIPT"
}

case "$MODE" in
  --status)
    exec "$HARNESS_DIR/status.sh" --watch
    ;;

  --all)
    RUN_DIR="$(get_run_dir)"
    tail_all "$RUN_DIR"
    ;;

  --events)
    RUN_DIR="$(get_run_dir)"
    EVENTS_FILE="$RUN_DIR/events.jsonl"
    if [[ ! -f "$EVENTS_FILE" ]]; then
      echo "No events.jsonl found in $RUN_DIR" >&2
      exit 1
    fi
    echo "Tailing events: $EVENTS_FILE"
    tail -f "$EVENTS_FILE" | while read -r line; do
      echo "$line" | python3 -m json.tool 2>/dev/null || echo "$line"
    done
    ;;

  --packet)
    PACKET_ID="${EXTRA_ARG:?Usage: ./tail.sh --packet PKT-001}"
    RUN_DIR="$(get_run_dir)"
    TRANSCRIPT="$RUN_DIR/packets/$PACKET_ID/builder/transcript.jsonl"
    if [[ ! -f "$TRANSCRIPT" ]]; then
      echo "No builder transcript for packet $PACKET_ID" >&2
      echo "  Expected: $TRANSCRIPT" >&2
      exit 1
    fi
    echo "Tailing builder for $PACKET_ID: $TRANSCRIPT"
    tail -f "$TRANSCRIPT" | jq -r 'select(.msg.type=="assistant") | .msg.text // empty'
    ;;

  --builder)
    RUN_DIR="$(get_run_dir)"
    TRANSCRIPT="$(find_latest_transcript "$RUN_DIR" "builder")"
    if [[ -z "$TRANSCRIPT" ]]; then
      echo "No builder transcripts found in $RUN_DIR" >&2
      exit 1
    fi
    echo "Tailing: $TRANSCRIPT"
    tail -f "$TRANSCRIPT" | jq -r 'select(.msg.type=="assistant") | .msg.text // empty'
    ;;

  --evaluator)
    RUN_DIR="$(get_run_dir)"
    TRANSCRIPT="$(find_latest_transcript "$RUN_DIR" "evaluator")"
    if [[ -z "$TRANSCRIPT" ]]; then
      echo "No evaluator transcripts found in $RUN_DIR" >&2
      exit 1
    fi
    echo "Tailing: $TRANSCRIPT"
    tail -f "$TRANSCRIPT" | jq -r 'select(.msg.type=="assistant") | .msg.text // empty'
    ;;

  *)
    echo "Usage: ./tail.sh [--run-id ID] [--all|--events|--status|--builder|--evaluator|--packet PKT-ID]"
    echo ""
    echo "  --all        Unified live view: events + agent thinking/text/tools (default)"
    echo "  --events     Event stream only"
    echo "  --status     Refreshing status display"
    echo "  --builder    Latest builder transcript"
    echo "  --evaluator  Latest evaluator transcript"
    echo "  --packet ID  Builder transcript for specific packet"
    echo "  --run-id ID  Target a specific run (default: most recent)"
    exit 1
    ;;
esac
