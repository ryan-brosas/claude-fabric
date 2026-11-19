#!/usr/bin/env bash
# Plugin entry point. An installed plugin has no node_modules; install them once
# (output to stderr so stdout stays a clean MCP stream), then start the server.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ ! -d "$root/node_modules/@modelcontextprotocol/sdk" ] || [ ! -d "$root/node_modules/typescript" ]; then
  (cd "$root" && bun install --frozen-lockfile --production 1>&2)
fi
exec bun "$root/src/server/index.ts"
