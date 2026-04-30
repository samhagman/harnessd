#!/usr/bin/env bash
# Shared helpers for harnessd operator shell scripts.
# Source with: source "$(dirname "$0")/_lib.sh"

# find_latest_run_dir <harness-dir> <repo-root>
# Prints the absolute path of the most recently modified run directory that
# contains a run.json. Checks both HARNESS_DIR/.harnessd/runs and
# REPO_ROOT/.harnessd/runs so scripts work whether invoked from harness/ or
# the repo root. Prints nothing and returns 1 if no run is found.
find_latest_run_dir() {
  local harness_dir="$1"
  local repo_root="$2"
  local best="" best_time=0

  for base in "$harness_dir/.harnessd/runs" "$repo_root/.harnessd/runs"; do
    [[ -d "$base" ]] || continue
    for dir in "$base"/*/; do
      [[ -f "${dir}run.json" ]] || continue
      local mtime
      mtime=$(stat -f %m "${dir}run.json" 2>/dev/null || stat -c %Y "${dir}run.json" 2>/dev/null || echo 0)
      if (( mtime > best_time )); then
        best_time=$mtime
        best="${dir%/}"
      fi
    done
  done

  if [[ -z "$best" ]]; then
    return 1
  fi
  echo "$best"
}

# resolve_run_dir <harness-dir> <repo-root> <run-id>
# Prints the absolute path of a specific run directory (with run.json check).
# Prints nothing and returns 1 if not found.
resolve_run_dir() {
  local harness_dir="$1"
  local repo_root="$2"
  local run_id="$3"

  for base in "$repo_root/.harnessd/runs" "$harness_dir/.harnessd/runs"; do
    local candidate="$base/$run_id"
    if [[ -f "$candidate/run.json" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}
