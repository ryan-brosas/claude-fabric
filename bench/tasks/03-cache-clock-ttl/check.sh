#!/bin/sh
set -eu
dir=${1:?usage: check.sh <repo-dir>}
here=$(cd "$(dirname "$0")" && pwd)
[ -d "$dir" ] || { echo "FAIL 03: no such directory $dir"; exit 2; }
rm -rf "$dir/test/hidden"
mkdir -p "$dir/test/hidden"
cp "$here"/hidden/*.test.ts "$dir/test/hidden/"
cd "$dir"
out=$(bun test test/hidden 2>&1) || {
  why=$(printf '%s\n' "$out" | grep -m1 -E '\(fail\)|error:|Expected' || printf '%s' "$out" | tail -3)
  echo "FAIL 03: $why"
  exit 1
}
echo "PASS 03: expiry, ttl, size, sweep and stats follow the injected clock"
