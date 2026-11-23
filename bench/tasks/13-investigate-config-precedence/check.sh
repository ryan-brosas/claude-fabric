#!/bin/sh
set -eu
dir=${1:?usage: check.sh <repo-dir>}
file="$dir/ANSWER.md"
[ -f "$file" ] || { echo "FAIL 13: ANSWER.md is missing"; exit 1; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
sed -e 's/[[:space:]]*$//' -e '/^$/d' "$file" > "$tmp"
fail=0
check() {
  if ! grep -qxF "$1" "$tmp"; then echo "FAIL 13: expected the line '$1'"; fail=1; fi
}
check "port: 8080"
check "overlay: src/profiles/overlay.ts:applyProfileOverlay"
check "list_merge: src/resolve/merge.ts:mergeLists"
check "sources: 4"
check "overlay_disable_env: CONF_NO_PROFILE"
check "schema_keys: 7"
[ "$fail" -eq 0 ] || exit 1
echo "PASS 13: effective port, overlay, list merge, sources and schema count all correct"
