#!/bin/sh
set -eu
dir=${1:?usage: check.sh <repo-dir>}
here=$(cd "$(dirname "$0")" && pwd)
[ -d "$dir" ] || { echo "FAIL 11: no such directory $dir"; exit 2; }
if [ ! -f "$dir/src/storage/json-store.ts" ]; then echo "FAIL 11: src/storage/json-store.ts is missing"; exit 1; fi
if grep -rnE "Bun\.write\(|Bun\.file\(|JSON\.parse\(" "$dir/src/services" >/dev/null 2>&1; then
  echo "FAIL 11: a service still reads or writes JSON by hand"; exit 1
fi
rm -rf "$dir/test/hidden"
mkdir -p "$dir/test/hidden"
cp "$here"/hidden/*.test.ts "$dir/test/hidden/"
cd "$dir"
out=$(bun test test/hidden 2>&1) || {
  why=$(printf '%s\n' "$out" | grep -m1 -E '\(fail\)|error:|Expected' || printf '%s' "$out" | tail -3)
  echo "FAIL 11: $why"
  exit 1
}
echo "PASS 11: shared json store, atomic writes, behavior kept"
