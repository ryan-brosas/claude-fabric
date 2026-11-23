#!/bin/sh
set -eu
dir=${1:?usage: check.sh <repo-dir>}
file="$dir/ANSWER.md"
[ -f "$file" ] || { echo "FAIL 14: ANSWER.md is missing"; exit 1; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
sed -e 's/[[:space:]]*$//' -e '/^$/d' "$file" > "$tmp"
fail=0
check() {
  if ! grep -qxF "$1" "$tmp"; then echo "FAIL 14: expected the line '$1'"; fail=1; fi
}
check "owner: src/cache/remember.ts"
check "function: memoize"
check "lru_limit: 500"
check "unbounded_call_sites: 3"
[ "$fail" -eq 0 ] || exit 1
echo "PASS 14: cache owner, function, limit and call sites all correct"
