#!/bin/sh
set -eu
dir=${1:?usage: check.sh <repo-dir>}
here=$(cd "$(dirname "$0")" && pwd)
[ -d "$dir" ] || { echo "FAIL 10: no such directory $dir"; exit 2; }
if [ -e "$dir/src/config" ]; then echo "FAIL 10: src/config still exists"; exit 1; fi
if [ ! -f "$dir/src/settings/index.ts" ]; then echo "FAIL 10: src/settings/index.ts is missing"; exit 1; fi
if grep -rnE "from [\"'][^\"']*config([\"']|/)" "$dir/src" "$dir/test" >/dev/null 2>&1; then
  echo "FAIL 10: an import still points at the old config module"; exit 1
fi
if grep -rnE "(loadConfig|defaultConfig|ConfigSource|LoadConfigOptions)" "$dir/src" "$dir/test" >/dev/null 2>&1; then
  echo "FAIL 10: the old symbol names are still present"; exit 1
fi
rm -rf "$dir/test/hidden"
mkdir -p "$dir/test/hidden"
cp "$here"/hidden/*.test.ts "$dir/test/hidden/"
cd "$dir"
out=$(bun test test/hidden 2>&1) || {
  why=$(printf '%s\n' "$out" | grep -m1 -E '\(fail\)|error:|Expected' || printf '%s' "$out" | tail -3)
  echo "FAIL 10: $why"
  exit 1
}
echo "PASS 10: settings module renamed everywhere and behavior kept"
