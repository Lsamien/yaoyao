#!/usr/bin/env bash
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-experimental-webstorage"
npm test -- tests/server/workspace.test.ts tests/server/workspaceSync.test.ts \
  tests/server/workspaceTeamTools.test.ts tests/server/taskCoordinator.test.ts \
  tests/server/runner.test.ts tests/server/computerPool.test.ts \
  tests/server/desktopEnvironments.test.ts
npx tsc --noEmit -p tsconfig.server.json
npm run release:verify
