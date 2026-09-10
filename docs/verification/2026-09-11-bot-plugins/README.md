# Bot 模式插件与工具入口验收

日期：2026-09-10 至 2026-09-11。参考 OpenMausBot 的插件管理和侧栏菜单；本次改动位于 Yaoyao，未修改 OpenMausBot。

## 已实现

- 仅 Bot 模式在账号上方显示“工具”：插件、自动化、已连接应用。点击账号打开设置、关于、帮助菜单，管理员保留切换聊天模式入口。
- 插件在设置中心管理，包含应用目录、已连接应用与 MCP 服务。应用目录支持搜索和分批显示。关于页显示当前构建版本；帮助链接为 `https://yaoyao.samien.cn`。
- MCP 支持本机 stdio 程序及 Streamable HTTP（JSON/SSE 响应）；可添加、编辑、测试、启用、停用、移除，并选择授权 Bot。新增或修改配置默认停用，测试成功后才可启用。
- 应用连接使用当前账号自己的 Composio 项目 API Key，支持授权链接、多账号别名、逐账号断开和 Bot 授权；可填写自定义 Auth Config 映射。连接清单读取失败时保留已知状态，不能把错误当成全部断开。
- 自动化入口复用现有 Bot 定时任务：选择 Bot 后创建任务、查看运行日志和立即执行。

## 隔离与兼容

- 数据以账号为边界保存在 Web 的工作区存储中；API Key、MCP 环境变量/请求头及 Composio 会话 URL 加密保存，列表接口不回显凭据。环境变量/请求头的 `true` 表示保留已有值。
- 自定义 MCP 在 Web 所在主机执行或连接，由管理员配置和使用。应用连接属于各自账号。授权只能选择当前账号的有效 Bot，远端引用和临时助手不在列表中。
- 工具通过现有会话工具桥挂载到 Bot 当前调用，不修改 Hermes 的普通聊天配置。对应执行环境需要支持原生工具桥；停用、修改或移除插件后，旧工具调用会被拒绝。
- 普通聊天的侧栏、账号切换和设置入口保持原行为，不显示新增 Bot 工具分类；既有团队、电脑和 Runner 工具共用原授权机制。
- stdio 传输改编自 `OpenMausBot/server/stdio-mcp.ts`，保留 Apache-2.0 来源说明；子进程只获得最小环境及显式配置，不继承应用凭据。

## 验证

相关单元、服务端及客户端回归：11 个文件、176 项通过。

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/server/workspacePlugins.test.ts tests/server/workspaceTeamTools.test.ts tests/server/workspaceRoutes.test.ts tests/server/workspacePanels.test.ts tests/server/workspace.test.ts tests/server/runner.test.ts tests/server/workspaceRemoteAgents.test.ts tests/server/workspacePairedNodes.test.ts tests/client/workspaceShell.test.ts tests/client/settingsCenterDialog.test.ts tests/client/botPluginsPanel.test.ts
npm run typecheck
npm run build
```

类型检查与构建成功。构建仍有既有的前端大 chunk 提示。

浏览器通过 CUA 在独立测试服务验收，覆盖桌面 1280 px、手机 375 px、浅色/深色、菜单键盘操作，以及切换回普通聊天后的边界。环境启动方式：

```sh
WORKSPACE_FIXTURE_PORT=18833 WORKSPACE_FIXTURE_UPSTREAM_PORT=19133 WORKSPACE_FIXTURE_PLUGINS=1 node --import tsx tests/fixtures/workspace-server.ts
```

临时测试账号为 `fixture / fixture-pass`。仅在该 disposable fixture 使用；这些不是生产凭据。

- 从 UI 新增 HTTP MCP 服务，测试发现一个工具，授权并启用后发送 `[plugin-roundtrip]` 验收消息，原生工具实际返回“Bot 插件原生调用成功”。
- 使用模拟 Composio 服务配置应用连接，授权给 Bot；停用自定义 MCP 后，再次单独验证应用工具成功返回。
- 从自动化入口创建任务并立即执行，运行日志显示完成，结果回到 Bot 聊天。
- SQLite 只读核验记录了三次成功运行、三个工具调用、零待执行 turn。摘要见 [browser-result.json](browser-result.json)。

MCP stdio 测试启动了真实的隔离子进程；HTTP MCP 测试和浏览器验收使用回环地址 fixture。Composio OAuth/第三方账号为模拟服务验证，未用真实项目密钥授权第三方应用。

## 参考协议与交付范围

实现参考 [Composio Session API](https://docs.composio.dev/reference/v3/api-reference/tool-router/postToolRouterSession)、[Composio MCP 会话](https://docs.composio.dev/docs/sessions-via-mcp) 和 [MCP HTTP 传输协议](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。

本次仅源码、构建和隔离验收，没有部署或重启 `15300` / `8799` 服务，也没有修改真实用户的插件配置、第三方连接或定时任务。使用应用连接时，需要在 Bot 模式的插件设置中配置自己的 Composio API Key。
