
## OpenMausBot avatar renderer

Avatar geometry, face data and animation adapted from OpenMausBot commit 3a84701 (Apache-2.0), including its Blob Studio export. Local adaptations integrate Vue/SwiftUI, Yaoyao identity storage, activity and visibility. See licenses/OpenMausBot/LICENSE and NOTICE.

## LaoA-GrokBot

Avatar silhouette paths and original two-eye expressions from zhulin025/LaoA-GrokBot, commit 527c3b5746bed34da3a6d4f9747e483c84534a41. Copyright (c) 2026 老A玩AI. MIT License: see `licenses/LaoA-GrokBot/LICENSE`. Existing OpenMausBot geometry and animation retain their Apache-2.0 notices.

## OpenMausBot MCP transport

`src/server/botPlugins/stdioMcp.ts` is adapted from OpenMausBot `server/stdio-mcp.ts` at commit 8b9f1dbb (Apache-2.0). The local integration uses per-account configuration, explicit Bot grants, a minimal child-process environment and the Yaoyao client name. See `licenses/OpenMausBot/LICENSE` and `NOTICE`.

## OpenMausBot macOS updater preparation

`scripts/patch-mac-updater.mjs` is adapted from OpenMausBot commit 13c5005b (Apache-2.0), Copyright 2026 Milind Soni and OpenMausBot contributors. It waits for Squirrel.Mac's native readiness before allowing a restart. The packaged electron-updater bundle retains its dependencies' license comments. See `licenses/OpenMausBot/LICENSE` and `NOTICE`.
