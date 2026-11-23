#!/bin/sh
set -eu
dir=${1:?usage: check.sh <repo-dir>}
here=$(cd "$(dirname "$0")" && pwd)
[ -d "$dir" ] || { echo "FAIL 12: no such directory $dir"; exit 2; }
if [ -e "$dir/src/http" ]; then echo "FAIL 12: src/http still exists"; exit 1; fi
if [ ! -f "$dir/src/client/client.ts" ]; then echo "FAIL 12: src/client/client.ts is missing"; exit 1; fi
if grep -rnE "HttpClient|fetchJson|HttpError" "$dir/src" "$dir/test" >/dev/null 2>&1; then
  echo "FAIL 12: the old names are still used in src or test"; exit 1
fi
rm -rf "$dir/test/hidden"
mkdir -p "$dir/test/hidden"
cp "$here"/hidden/*.test.ts "$dir/test/hidden/"
cd "$dir"
out=$(bun test test/hidden 2>&1) || {
  why=$(printf '%s\n' "$out" | grep -m1 -E '\(fail\)|error:|Expected' || printf '%s' "$out" | tail -3)
  echo "FAIL 12: $why"
  exit 1
}
echo "PASS 12: client renamed everywhere and behavior kept"
