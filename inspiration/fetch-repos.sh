#!/usr/bin/env bash
#
# Fetches inspiration/reference repositories
# Run from the inspiration/ directory or repo root
#

set -e

# Navigate to inspiration directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Fetching inspiration repositories..."

# Repository definitions: directory=url
declare -A REPOS=(
    ["openclaw-bot"]="https://github.com/openclaw/openclaw.git"
    ["pal-mcp-server"]="https://github.com/BeehiveInnovations/pal-mcp-server.git"
)

for dir in "${!REPOS[@]}"; do
    url="${REPOS[$dir]}"

    if [ -d "$dir/.git" ]; then
        echo "→ $dir: already exists, pulling latest..."
        (cd "$dir" && git pull --ff-only 2>/dev/null || echo "  (pull skipped - may have local changes)")
    else
        echo "→ $dir: cloning from $url..."
        rm -rf "$dir"  # Remove any partial/empty directory
        git clone "$url" "$dir"
    fi
done

echo ""
echo "Done! All inspiration repos are ready."
