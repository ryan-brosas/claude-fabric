#!/bin/sh
# Proves every task: check.sh must fail on the untouched repo copy and pass
# after solution.patch is applied in a fresh copy.
set -eu
root=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failures=0
count=0
for dir in "$root"/[0-9][0-9]-*; do
  [ -d "$dir/repo" ] || continue
  id=$(basename "$dir")
  count=$((count + 1))

  rm -rf "$tmp/before" "$tmp/after"
  cp -r "$dir/repo" "$tmp/before"
  if "$dir/check.sh" "$tmp/before" > "$tmp/before.log" 2>&1; then
    echo "BAD  before passed: $id"
    tail -1 "$tmp/before.log"
    failures=$((failures + 1))
  else
    echo "ok   before fails: $id | $(tail -1 "$tmp/before.log" | cut -c1-100)"
  fi

  cp -r "$dir/repo" "$tmp/after"
  git -C "$tmp/after" init -q
  if ! git -C "$tmp/after" apply "$dir/solution.patch"; then
    echo "BAD  patch did not apply: $id"
    failures=$((failures + 1))
    continue
  fi
  if "$dir/check.sh" "$tmp/after" > "$tmp/after.log" 2>&1; then
    echo "ok   after passes: $id | $(tail -1 "$tmp/after.log" | cut -c1-100)"
  else
    echo "BAD  after failed: $id"
    tail -3 "$tmp/after.log"
    failures=$((failures + 1))
  fi
done
if [ "$failures" -ne 0 ]; then
  echo "verify: $failures problem(s) across $count tasks"
  exit 1
fi
echo "verify: $count tasks, all fail before the solution and pass after"
