#!/bin/bash
#
# Flatten locale JSON files: replace any value that is {"": "string"} with "string"
# so i18next resolves keys (e.g. footer:quickLinks) to a string, not an object.
#
# Usage: run from repository root.
#   ./scripts/utilities/flatten-locale-json.sh           # dry run (print what would change)
#   ./scripts/utilities/flatten-locale-json.sh --write    # write changes to files
#
set -e

REPO_ROOT="$PWD"
LOCALES_DIR="$REPO_ROOT/app/src/locales"

# --- Require run from repo root ---
if [ ! -d "$LOCALES_DIR/en" ]; then
  echo "Error: Run this script from the repository root." >&2
  echo "  Expected: $LOCALES_DIR/en to exist." >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: sudo apt-get install jq" >&2
  exit 1
fi

WRITE=false
[ "$1" = "--write" ] && WRITE=true

# jq walk: if object has single key "" then replace with its value
JQ_FLATTEN='walk(if type == "object" and (keys | length == 1) and (keys[0] == "") then .[""] else . end)'

changed=0
for f in "$LOCALES_DIR"/*/*.json; do
  [ -f "$f" ] || continue
  out=$(jq -c "$JQ_FLATTEN" "$f" 2>/dev/null) || continue
  if ! diff -q <(jq -c . "$f" 2>/dev/null) <(echo "$out") &>/dev/null; then
    echo "$f"
    if [ "$WRITE" = true ]; then
      echo "$out" > "$f"
      changed=$((changed + 1))
    fi
  fi
done

if [ "$WRITE" = false ]; then
  echo ""
  echo "Dry run. To apply changes, run with --write"
else
  echo ""
  echo "Flattened $changed file(s)."
fi
