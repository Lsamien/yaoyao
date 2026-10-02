
## OpenMausBot avatar renderer

Avatar geometry, face data and animation adapted from OpenMausBot commit 3a84701 (Apache-2.0), including its Blob Studio export. Local adaptations integrate Vue/SwiftUI, Yaoyao identity storage, activity and visibility. See licenses/OpenMausBot/LICENSE and NOTICE.

## LaoA-GrokBot

Avatar silhouette paths and original two-eye expressions from zhulin025/LaoA-GrokBot, commit 527c3b5746bed34da3a6d4f9747e483c84534a41. Copyright (c) 2026 老A玩AI. MIT License: see `licenses/LaoA-GrokBot/LICENSE`. Existing OpenMausBot geometry and animation retain their Apache-2.0 notices.

## OpenMausBot MCP transport

`src/server/botPlugins/stdioMcp.ts` is adapted from OpenMausBot `server/stdio-mcp.ts` at commit 8b9f1dbb (Apache-2.0). The local integration uses per-account configuration, explicit Bot grants, a minimal child-process environment and the Yaoyao client name. See `licenses/OpenMausBot/LICENSE` and `NOTICE`.

## OpenMausBot macOS updater preparation

`scripts/patch-mac-updater.mjs` is adapted from OpenMausBot commit 13c5005b (Apache-2.0), Copyright 2026 Milind Soni and OpenMausBot contributors. It waits for Squirrel.Mac's native readiness before allowing a restart. The packaged electron-updater bundle retains its dependencies' license comments. See `licenses/OpenMausBot/LICENSE` and `NOTICE`.

## libsodium.js credential vault cryptography

`libsodium-wrappers-sumo` 0.8.4 and its locked `libsodium-sumo` 0.8.4 dependency provide Argon2id and XChaCha20-Poly1305 for the manually unlocked credential vault. Copyright 2015-2026 Ahmad Ben Mrad, Frank Denis and Ryan Lester. ISC license: see `licenses/libsodium.js/LICENSE`. Source: https://github.com/jedisct1/libsodium.js.

## ssh2 credential execution

`ssh2` 1.17.0 provides SSH public-key authentication, host key verification and SFTP for the protected credential executor. Copyright Brian White. MIT license: see `licenses/ssh2/LICENSE`. Source: https://github.com/mscdex/ssh2. Installation lifecycle scripts are not required for the pure JavaScript fallback.

## Application supplier logos

`public/provider-logos/*.svg` contains the Gmail, Google Drive, Google Calendar, GitHub, Notion, Slack, Linear, Discord, Outlook, Trello, Airtable and X logos retrieved from `https://logos.composio.dev/api/{slug}` on 2026-10-02. These assets identify the corresponding integrations. Each brand's logo and trademark rights belong to its respective owner.
