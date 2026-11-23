#!/bin/sh
set -eu
dir=${1:?usage: check.sh <repo-dir>}
file="$dir/ANSWER.md"
[ -f "$file" ] || { echo "FAIL 15: ANSWER.md is missing"; exit 1; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
sed -e 's/[[:space:]]*$//' -e '/^$/d' "$file" > "$tmp"
fail=0
check() {
  if ! grep -qxF "$1" "$tmp"; then echo "FAIL 15: expected the line '$1'"; fail=1; fi
}
check "shadow_route: GET /api/*"
check "shadow_file: src/app.ts:createApp"
check "unreachable: 3"
check "orders_file: src/routes/orders.ts"
[ "$fail" -eq 0 ] || exit 1
echo "PASS 15: shadowing route, owner, unreachable count and orders file all correct"
