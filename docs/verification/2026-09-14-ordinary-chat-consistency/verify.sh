#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-experimental-webstorage"
npm test -- tests/client/chatCrossClientSync.test.ts tests/client/chatLifecycle.test.ts \
  tests/client/chatStore.test.ts tests/client/chatModelSync.test.ts \
  tests/client/chatProtocol.test.ts tests/client/sessionProtocol.test.ts \
  tests/server/ordinaryChatLocal.test.ts tests/server/chatCache.test.ts \
  tests/server/chatCachePagination.test.ts tests/server/realtimeBroker.test.ts
npm run typecheck
