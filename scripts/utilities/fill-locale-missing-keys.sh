#!/bin/bash
#
# Fill missing keys in locale JSON files by copying values from en.
# Only adds key paths that exist in en but are missing in the locale (setpath per path).
# Then runs flatten-locale-json.sh so the audit (audit-locale-gaps.sh) passes:
# the audit treats both "missing keys" and "wrapped keys" (e.g. {"": "value"}) as gaps.
# Run from repository root.
#
set -e
REPO_ROOT="${PWD}"
LOCALES_DIR="${REPO_ROOT}/app/src/locales"
NAMESPACES="common account product cart footer chat"
SCRIPT_DIR="${REPO_ROOT}/scripts/utilities"

if [ ! -d "$LOCALES_DIR/en" ]; then
  echo "Error: Run from repo root. Expected $LOCALES_DIR/en" >&2
  exit 1
fi
command -v jq &>/dev/null || { echo "Error: jq required" >&2; exit 1; }

get_key_paths() {
  local file="$1"
  [ -f "$file" ] || return
  jq -r '
    [paths(type == "string" or type == "number" or type == "boolean")] 
    | .[] | map(tostring) | join(".") 
    | if endswith(".") then .[0:(length - 1)] else . end
  ' "$file" 2>/dev/null || true
}

filled=0
for ns in $NAMESPACES; do
  en_file="$LOCALES_DIR/en/${ns}.json"
  [ -f "$en_file" ] || continue
  en_keys=$(get_key_paths "$en_file" | sort -u)
  for dir in "$LOCALES_DIR"/*/; do
    [ -d "$dir" ] || continue
    loc=$(basename "$dir")
    [ "$loc" = "en" ] && continue
    loc_file="$LOCALES_DIR/$loc/${ns}.json"
    [ -f "$loc_file" ] || continue
    loc_keys=$(get_key_paths "$loc_file" | sort -u)
    missing=$(comm -23 <(echo "$en_keys") <(echo "$loc_keys"))
    if [ -z "$missing" ]; then
      continue
    fi
    # Add each missing path from en into loc (one jq pass with reduce)
    missing_count=$(echo "$missing" | wc -l)
    out=$(jq -n --slurpfile en "$en_file" --slurpfile loc "$loc_file" \
      --rawfile miss <(echo "$missing") '
      $loc[0] as $loc | $en[0] as $en |
      ($miss | split("\n") | map(select(length > 0))) as $paths |
      reduce $paths[] as $p ($loc; setpath(($p | split(".")); $en | getpath($p | split("."))))
    ')
    if [ -n "$out" ]; then
      echo "$loc_file (+$missing_count keys)"
      echo "$out" > "$loc_file"
      filled=$((filled + 1))
    fi
  done
done
echo "Filled missing keys in $filled file(s)."

# Flatten wrapped keys ({"": "value"} -> "value") so audit-locale-gaps.sh passes
if [ -x "$SCRIPT_DIR/flatten-locale-json.sh" ]; then
  echo ""
  "$SCRIPT_DIR/flatten-locale-json.sh" --write
fi
