#!/bin/bash
#
# Audit locale translation gaps.
# Compares app/src/locales against Production.Culture (Culture.csv + Culture-ai.csv)
# and the English source. Reports missing folders, missing namespace files,
# keys missing/extra vs en, and wrapped keys ({"": "value"}).
#
# Usage: run from repository root.
#   ./scripts/utilities/audit-locale-gaps.sh
#   ./scripts/utilities/audit-locale-gaps.sh --json   # also emit machine-readable summary
#
set -e

REPO_ROOT="$PWD"
LOCALES_DIR="$REPO_ROOT/app/src/locales"
CULTURE_BASE="$REPO_ROOT/seed-job/sql/Culture.csv"
CULTURE_AI="$REPO_ROOT/seed-job/sql/Culture-ai.csv"
NAMESPACES="common account product cart footer chat"

# --- Require run from repo root ---
if [ ! -d "$LOCALES_DIR/en" ] || [ ! -f "$CULTURE_BASE" ]; then
  echo "Error: Run this script from the repository root." >&2
  echo "  Expected: $LOCALES_DIR/en and $CULTURE_BASE to exist." >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: sudo apt-get install jq" >&2
  exit 1
fi

EMIT_JSON=false
[ "$1" = "--json" ] && EMIT_JSON=true

# --- Load required locales from Culture CSVs (first column, trimmed) ---
required_locales=()
for f in "$CULTURE_BASE" "$CULTURE_AI"; do
  [ -f "$f" ] || continue
  while IFS= read -r line; do
    code=$(echo "$line" | cut -f1 | tr -d '\r' | xargs)
    [ -n "$code" ] || continue
    required_locales+=("$code")
  done < "$f"
done
# Dedupe and sort
required_locales=($(printf '%s\n' "${required_locales[@]}" | sort -u))

# --- Collect all key paths from a JSON file (paths to string values) ---
# Output one path per line, e.g. "header.signIn" or "pages.home"
get_key_paths() {
  local file="$1"
  [ -f "$file" ] || return
  jq -r '
    [paths(type == "string" or type == "number" or type == "boolean")] 
    | .[] 
    | map(tostring) 
    | join(".") 
    | if endswith(".") then .[0:(length - 1)] else . end
  ' "$file" 2>/dev/null || true
}

# --- Report all wrapped keys in a locale namespace file (object with single key "") ---
# One jq pass per file for performance.
report_wrapped_in_file() {
  local locale="$1"
  local ns="$2"
  local loc_file="$LOCALES_DIR/$locale/${ns}.json"
  [ -f "$loc_file" ] || return
  jq -r '
    paths(type == "object") as $p |
    select(getpath($p) | type == "object" and (keys | length == 1) and (keys[0] == "")) |
    $p | map(tostring) | join(".")
  ' "$loc_file" 2>/dev/null | while IFS= read -r key_path; do
    [ -n "$key_path" ] || continue
    echo "$locale/${ns}.json:$key_path"
  done
}

# --- Main ---
missing_folders=()
missing_files=()
missing_keys_by_file=()
extra_keys_by_file=()
wrapped_keys=()
extra_folders=()

# 1) Missing / extra locale folders
for loc in "${required_locales[@]}"; do
  [ -d "$LOCALES_DIR/$loc" ] || missing_folders+=("$loc")
done
for dir in "$LOCALES_DIR"/*/; do
  [ -d "$dir" ] || continue
  loc=$(basename "$dir")
  if [[ " ${required_locales[*]} " != *" $loc "* ]]; then
    extra_folders+=("$loc")
  fi
done

# 2) Missing namespace files
for loc in "${required_locales[@]}"; do
  [ -d "$LOCALES_DIR/$loc" ] || continue
  for ns in $NAMESPACES; do
    if [ ! -f "$LOCALES_DIR/$loc/${ns}.json" ]; then
      missing_files+=("$loc/${ns}.json")
    fi
  done
done

# 3) Key comparison and wrapped detection (en as reference)
for loc in "${required_locales[@]}"; do
  [ "$loc" = "en" ] && continue
  [ -d "$LOCALES_DIR/$loc" ] || continue
  for ns in $NAMESPACES; do
    loc_file="$LOCALES_DIR/$loc/${ns}.json"
    en_file="$LOCALES_DIR/en/${ns}.json"
    [ -f "$en_file" ] || continue
    [ -f "$loc_file" ] || continue

    en_keys=$(get_key_paths "$en_file" | sort -u)
    loc_keys=$(get_key_paths "$loc_file" | sort -u)

    missing=$(comm -23 <(echo "$en_keys") <(echo "$loc_keys"))
    extra=$(comm -13 <(echo "$en_keys") <(echo "$loc_keys"))

    while IFS= read -r k; do
      [ -n "$k" ] || continue
      missing_keys_by_file+=("$loc/${ns}.json:$k")
    done <<< "$missing"
    while IFS= read -r k; do
      [ -n "$k" ] || continue
      extra_keys_by_file+=("$loc/${ns}.json:$k")
    done <<< "$extra"

    while IFS= read -r line; do
      [ -n "$line" ] || continue
      wrapped_keys+=("$line")
    done < <(report_wrapped_in_file "$loc" "$ns")
  done
done

# --- Human-readable report ---
echo "========================================="
echo "Locale translation gap audit"
echo "========================================="
echo "Run from repo root: $REPO_ROOT"
echo "Required locales (from Culture CSVs): ${required_locales[*]}"
echo ""

has_issues=false

if [ ${#missing_folders[@]} -gt 0 ]; then
  has_issues=true
  echo "Missing locale folders (${#missing_folders[@]}):"
  printf '  %s\n' "${missing_folders[@]}"
  echo ""
fi

if [ ${#extra_folders[@]} -gt 0 ]; then
  echo "Extra locale folders (not in Culture CSVs) (${#extra_folders[@]}):"
  printf '  %s\n' "${extra_folders[@]}"
  echo ""
fi

if [ ${#missing_files[@]} -gt 0 ]; then
  has_issues=true
  echo "Missing namespace files (${#missing_files[@]}):"
  printf '  %s\n' "${missing_files[@]}"
  echo ""
fi

if [ ${#missing_keys_by_file[@]} -gt 0 ]; then
  has_issues=true
  echo "Missing keys vs en (${#missing_keys_by_file[@]}):"
  printf '  %s\n' "${missing_keys_by_file[@]}"
  echo ""
fi

if [ ${#extra_keys_by_file[@]} -gt 0 ]; then
  echo "Extra keys (not in en) (${#extra_keys_by_file[@]}):"
  printf '  %s\n' "${extra_keys_by_file[@]}"
  echo ""
fi

if [ ${#wrapped_keys[@]} -gt 0 ]; then
  has_issues=true
  echo "Wrapped keys (object with single key \"\") - fix with flatten script (${#wrapped_keys[@]}):"
  printf '  %s\n' "${wrapped_keys[@]}"
  echo ""
fi

if [ "$has_issues" = false ] && [ ${#missing_folders[@]} -eq 0 ] && [ ${#missing_files[@]} -eq 0 ] && [ ${#missing_keys_by_file[@]} -eq 0 ] && [ ${#wrapped_keys[@]} -eq 0 ]; then
  echo "No gaps found."
fi

echo "========================================="

# --- Optional JSON output ---
if [ "$EMIT_JSON" = true ]; then
  echo ""
  echo "--- JSON summary ---"
  jq -n \
    --argjson missing_folders "$(printf '%s\n' "${missing_folders[@]}" | jq -R . | jq -s .)" \
    --argjson extra_folders "$(printf '%s\n' "${extra_folders[@]}" | jq -R . | jq -s .)" \
    --argjson missing_files "$(printf '%s\n' "${missing_files[@]}" | jq -R . | jq -s .)" \
    --argjson missing_keys "$(printf '%s\n' "${missing_keys_by_file[@]}" | jq -R . | jq -s .)" \
    --argjson extra_keys "$(printf '%s\n' "${extra_keys_by_file[@]}" | jq -R . | jq -s .)" \
    --argjson wrapped_keys "$(printf '%s\n' "${wrapped_keys[@]}" | jq -R . | jq -s .)" \
    '{ missing_folders: $missing_folders, extra_folders: $extra_folders, missing_files: $missing_files, missing_keys: $missing_keys, extra_keys: $extra_keys, wrapped_keys: $wrapped_keys }'
fi

[ ${#missing_folders[@]} -eq 0 ] && [ ${#missing_files[@]} -eq 0 ] && [ ${#missing_keys_by_file[@]} -eq 0 ] && [ ${#wrapped_keys[@]} -eq 0 ] || exit 1
