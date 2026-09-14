#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-experimental-webstorage"
npm test -- tests/client tests/server/app.test.ts tests/server/security.test.ts tests/server/realtimeApi.test.ts
npm run typecheck
