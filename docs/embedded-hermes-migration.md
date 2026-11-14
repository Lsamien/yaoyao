# 内置 Hermes 迁移方案（草案，待确认）

日期：2026-11-14　状态：**已确认，实施中（M0–M5 一次完成）**

目标：夭夭不再依赖外部 Hermes Dashboard（9119 HTTP/WebSocket），改为与 yaovi-agent 相同的方式，把 Hermes 源码内置在仓库中，由夭夭服务端直接拉起和管理内核进程。

已确认：

- 先出方案，确认后再动手。
- 已有外部 Hermes 安装的数据（`~/.hermes` 的会话、profiles、`auth.json`、`config.yaml`）在**首次启动时只读导入**，不改动原目录。

用户对第 10 节的答复（2026-11-14）：

1. 原生对话：按建议保留，改为内置内核。
2. 移动端：现在直接使用 Hermes gateway 协议；改协议后要求客户端升级，不做兼容层。
3. Profile：同意“模板初始化、Bot 独立 home”。
4. Kanban、cron 等 Dashboard 自带功能：删除。
5. Hermes 副本：使用现在的 0.23.0（yaovi-agent 的 `0.23.0+yaovi`）。
6. 远程节点：同意改为夭夭到夭夭。
7. 范围：一次做到 M5，在独立分支上开发。

---

## 1. 现状：夭夭对外部 Hermes 的依赖面

| # | 依赖面 | 现在的实现 | 主要代码 |
| --- | --- | --- | --- |
| D1 | 服务连接与鉴权 | 服务端用服务账号或回环本机令牌登录 9119，持有 Cookie 和 WS ticket；管理员可在设置里改上游凭据 | `upstream.ts`、`localAuth.ts`（`upstreamCredentials`、`webSocketCredential`）、`loopbackAuthorization.ts`、`config.ts`（`HERMES_YAOYAO_UPSTREAM*`） |
| D2 | Bot 执行 | 每轮通过 Dashboard 的 gateway WS JSON-RPC：`session.create/resume`、`prompt.submit`、`approval.respond`、`clarify.respond`、`session.interrupt`、`image.attach_bytes`、`file.attach` | `workspaceRuntime.ts`、`workspaceGateway.ts`、`sessionStop.ts` |
| D3 | Bot 工具 | Hermes 插件 `yaoyao-bot-bridge` 安装进 Profile，提供 `yaoyao_tools`/`yaoyao_call`，再回调夭夭的电脑、浏览器、手机、团队与应用工具 | `integrations/hermes-bots-bridge/`、`hermesBridge.ts`、`hermesBotRelay.ts`、`workspaceToolLease.ts`、`compose.hermes-bridge.yaml` |
| D4 | 原生（普通）对话 | 浏览器经夭夭转发直连 Hermes `/api/ws`，客户端自己说 gateway 协议；历史读 `/api/sessions*`；归属登记在 `chat-cache.sqlite3` | `realtimeApi.ts`、`realtimeBroker.ts`、`chatCache.ts`、`client/api/realtime.ts`、`client/stores/chat.ts` |
| D5 | Profile、模型与配置 | `/api/profiles`、`/api/config`、`/api/env`、`/api/model/options`、`/api/model/set`、`/api/providers/custom-endpoints`、`/api/auth/providers` | `routes.ts`（模型服务、Profile 模型）、`botModelSettings.ts`、`executionSettings.ts` |
| D6 | 文件 | `/api/files`、`/api/files/download`、`/api/fs/default-cwd`；直接映射 `~/.hermes/{cache,workspace,profiles,attachments,images}` 路径 | `fileAccess.ts`、`routes.ts` 静态文件路由 |
| D7 | 其他 Dashboard 功能 | Kanban 插件（`/api/plugins/kanban`）、记忆抽取（`/api/plugins/yaoyao-bot-bridge/memory-extract`）、`/api/session-unread`，以及兜底转发 `all('/api/*gatewayPath')` | `routes.ts`、`workspaceKnowledge*.ts`、`chatCache.ts` |
| D8 | 远程节点 | 已配对节点经 `/node/:deviceID/api/*` 转发到另一台 9119；远程 Bot 走 `/api/workspace-agents/:id/gateway` | `routes.ts`、`workspaceGateway.ts`、`pairing.ts` |
| D9 | 运维 | Dashboard 守护与重启（launchctl/进程）、桥接插件版本检查与安装、Docker 挂载 Hermes 目录 | `dashboardSupervisor.ts`、`dashboardCommand.ts`、`hermesRuntimeEnvironment.ts`、Docker/compose 文件 |

规模：服务端约 45 处 `upstream.request`，集中在 `routes.ts`（36 处）、`chatCache.ts`、`realtimeApi.ts`、`fileAccess.ts`；另有 gateway RPC 链路和桌面端的 Dashboard 生命周期代码。

## 2. 目标架构（对齐 yaovi-agent）

yaovi-agent 的做法：

- `runtime/hermes/`：内置 Hermes 源码，当前为 `0.23.0+yaovi`（commit `2bd378e`），约 79MB；去掉了 TUI gateway，Dashboard 路由只作为函数库使用。
- `runtime/worker.py`：**每个运行中的会话一个进程**，NDJSON over stdio。Node 下发模型路由、指令、工具清单和输入；Python 用 Hermes 的 `AIAgent` 推理，工具调用通过 `tool.request` 回到 Node 执行。支持插话（steer）、中断、上下文压缩和用量回报。Node 侧入口是 `src/server/yaoviKernel.ts`，由 `src/server/harness/agentRuntime.ts` 编排。
- `runtime/hermes_service.py`：**每个 Hermes home 一个常驻进程**，按需启动、空闲退出。复用 Hermes Dashboard 的函数完成供应商目录、OAuth、`.env`、模型选择、凭据池、媒体生成和辅助模型调用；存储仍是 Hermes 原生的 `config.yaml`、`.env`、`auth.json`。Node 侧入口是 `src/server/hermes/service.ts`（`HermesServicePool`）和 `src/server/hermes/routes.ts`。
- 目录结构：系统 home 为 `<data>/hermes`，每个 Bot 的 home 为 `<data>/bots/<botId>/runtime`，以系统 home 作为父级读取凭据（`YAOVI_HERMES_ROOT`）。
- 安装：`bin/lib/agent-setup.mjs` 用 uv 准备 Python 3.11 和锁定依赖（`runtime/requirements.lock`），对应 `npm run agent:setup`、npm `postinstall` 和 `yaovi setup`；打包时把 Python 一并放进主机包。

夭夭迁移后的形态：

```
浏览器 / iOS / Android / 桌面客户端
        │  /api/app/*（契约不变）
        ▼
夭夭服务端（Node）
  ├─ Bot 执行：harness/agentRuntime → yaoyaoKernel → runtime/worker.py（每会话一个进程）
  ├─ 工具：服务端直接执行（替代 yaoyao-bot-bridge 插件回调）
  ├─ 配置/OAuth/模型：hermes/service → runtime/hermes_service.py（每个 home 一个进程）
  ├─ 原生对话：同一内核 + 本地会话存储（替代 /api/ws 直连）
  └─ 数据：~/.yaoyao/hermes（系统）、~/.yaoyao/bots/<id>/runtime（Bot）
```

运行时不再需要 9119，也不再需要 `HERMES_YAOYAO_UPSTREAM`。

## 3. 各依赖面的替代方案

| 依赖面 | 替代 | 从 yaovi-agent 引入 | 夭夭侧改动 |
| --- | --- | --- | --- |
| D1 连接与鉴权 | 删除。内核是子进程，没有上游账号；夭夭自己的 Web 账号继续作为唯一登录 | — | 删除 `upstreamCredentials`、`webSocketCredential`、上游凭据设置页和 `/api/app/admin/upstream-*`；`/auth/password-login`、`/api/auth/me` 等兼容路由改为夭夭本地实现或返回固定结果 |
| D2 Bot 执行 | `agentRuntime` + `yaoyaoKernel` 替换 `WorkspaceGateway` | `yaoviKernel.ts`、`harness/*`、`runtime/worker.py`、`native_authorization.py`、`tool_discovery.py`、`dialogue_usage.py` | 改写 `workspaceRuntime.ts` 的执行段；保留审批/澄清、停止、插话、附件和用量的现有数据结构和事件 |
| D3 Bot 工具 | 工具清单在每轮请求中下发，`tool.request` 回到 Node 执行，不再安装插件 | `dialogueToolCatalog.ts`、`workspaceToolLease` 的执行方式 | 把 bridge 插件转发的工具目录直接接到内核；删除 `integrations/hermes-bots-bridge`、`hermesBridge.ts`、桥接安装/重启接口和 `compose.hermes-bridge.yaml` |
| D4 原生对话 | 改为内核会话：服务端用同一个 worker 运行，转录存进夭夭的会话存储，通过夭夭自己的事件流推给客户端 | 会话存储和事件流的做法（yaovi-agent 已删除原生对话，这部分要新写） | 新增本地实现的 `/api/app/sessions*` 和实时事件；`client/api/realtime.ts`、`stores/chat.ts` 从 gateway 协议改为夭夭事件协议；`chatCache` 的 `upstream-only/shadow` 模式删除，只保留本地 |
| D5 Profile/模型/配置 | `hermes_service.py` 的 `config.*`、`env.*`、`model.*`、`endpoints.*`、`oauth.*`、`pool.*` | `hermes/service.ts`、`hermes/config.ts`、`hermes/routes.ts`、`hermes/network.ts`、`runtime/hermes_service.py`、`hermes_external_auth.py`、`model_network.py` | 模型服务、Profile 模型和 Bot 模型设置改调服务池；**Profile 概念映射**见第 5 节 |
| D6 文件 | 文件就在本机数据目录，直接读写，不经 HTTP | `sessionWorkingDirectory.ts`、`workspaceFiles.ts` 的做法 | `fileAccess.ts` 改为本地路径；`/Users/:owner/.hermes/*` 路由改为指向 `~/.yaoyao/hermes` 下对应目录，旧链接保持可用 |
| D7 其他 | 记忆抽取改为 `hermes_service` 的 `aux.complete`；未读改为本地；Kanban 和兜底 `/api/*` 转发见第 8 节待确认 | `runtime/native_*`、`memoryHarness.ts` 的抽取方式 | 删除 `all('/api/*gatewayPath')` |
| D8 远程节点 | 远程节点本身也是内置内核的夭夭实例，节点之间走夭夭协议，不再转发 9119 | — | `/node/:deviceID/api/*` 的白名单路由改为对端夭夭的 `/api/app/*` |
| D9 运维 | 删除 Dashboard 守护；新增内核安装检查（`yaoyao setup` / `yaoyao doctor`） | `bin/lib/agent-setup.mjs`、`scripts/agent-setup.mjs`、`scripts/verify-hermes-runtime.py`、`runtime/requirements.*` | 删除 `dashboardSupervisor.ts`、`dashboardCommand.ts`；桌面完整版改为拉起内置内核 |

## 4. 旧数据导入（首次启动，只读）

触发：`~/.yaoyao/hermes` 不存在或为空，并且检测到旧 Hermes 目录（默认 `~/.hermes`，可用 `YAOYAO_IMPORT_HERMES_HOME` 指定；Docker 用户用原来的 `HERMES_YAOYAO_HERMES_DIR` 挂载）。

| 内容 | 处理 |
| --- | --- |
| `config.yaml`、`.env`、`auth.json`、凭据池 | 复制到系统 home `~/.yaoyao/hermes`，权限 0600 |
| `profiles/<name>/` | 按第 5 节映射复制到对应 Bot 的 runtime home；没有 Bot 使用的 Profile 只导入到 `~/.yaoyao/hermes/imported-profiles/` 备查 |
| 会话数据库（`state.db` 等） | 仅导入夭夭已登记归属的会话（`chat-cache.sqlite3` 中的 Profile + Session ID）以及 Bot 绑定的会话；其余保留在原目录，不复制 |
| 附件、图片、缓存 | 只复制被导入会话引用的文件 |
| skills、memories | 按 Profile 复制到对应 Bot home |

规则：

- 源目录只读，不改名、不删除。导入前检查源 Hermes 是否还在运行；在运行就提示先停掉，避免读到写了一半的 SQLite（也可以用 SQLite 在线备份 API 读快照）。
- 导入写入 `~/.yaoyao/hermes/.import.json`，记录来源路径、时间、Hermes 版本和文件散列。重启不会重复导入；用户可以在设置里手动重新导入。
- 源 Hermes 版本低于内置版本时，用内置 Hermes 的迁移代码升级**副本**的 schema。
- 失败时整个导入回滚，内核从空数据启动，并在系统设置里提示原因。

## 5. Profile 与 Bot 的映射

现在：Bot 基于一个 Hermes Profile 创建，不复制也不修改基础 Profile；多个 Bot 可以共用同一个基础 Profile。

yaovi-agent：没有 Profile，每个 Bot 有独立 runtime home，以系统 home 为父级。

建议：

- 系统 home 相当于原来的默认 Profile。
- 每个 Bot 有独立 runtime home（`~/.yaoyao/bots/<id>/runtime`）。创建 Bot 时选的“基础 Profile”改为“从模板初始化”：复制该 Profile 的 `config.yaml` 覆盖项、skills 和 SOUL 到 Bot home，之后各自独立。
- 现有 Bot 在导入时从各自原 Profile 初始化。
- `/api/profiles` 兼容接口返回“系统 + 已导入模板”，旧客户端不报错。

## 6. 分阶段实施

每个阶段单独提交，都要通过 `npm run typecheck`、`npm test`、`npm run build`，以及新增的 Python 运行时测试。

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M0 引入内核 | 复制 `runtime/`（Hermes 源码、worker、service、requirements）、`agent-setup` 脚本和 `yaoyao setup`/`doctor`；补齐许可证与 `THIRD_PARTY_NOTICES` | 干净环境下 `npm run agent:setup` 成功；`hermes_service` 能 `ping`；`worker.py` 用受控模型跑通一轮 |
| M1 配置与模型 | 接入 `HermesServicePool`；模型服务、OAuth、`.env`、Profile 模型改为本地；实现第 4 节的导入 | 不启动 9119 时，设置页能读写供应商和模型；导入矩阵测试（空目录、已有数据、源在运行、失败回滚、重复启动）全部通过 |
| M2 Bot 执行 | `agentRuntime` + 内核替换 gateway；工具直连；审批、澄清、停止、插话、附件、用量对齐现有事件 | 现有 Bot 单聊和群聊的 vitest/Playwright 回归通过；真实内核用受控模型跑通工具调用、审批拒绝、停止和插话 |
| M3 原生对话 | 本地会话存储 + 夭夭事件流；Web 客户端改协议；保留已导入会话的历史 | 新建、续聊、搜索、删除、未读、附件下载均不经 9119；旧会话可读 |
| M4 文件与其他 | 文件本地化；记忆抽取、未读、远程节点协议；删除兜底转发 | `grep` 不到 `upstream.request`；远程节点用两台夭夭实例验证 |
| M5 清理与打包 | 删除 `upstream.ts`、上游配置、桥接插件、Dashboard 守护和相关测试；更新 Dockerfile、compose、npm 打包、桌面完整版和文档 | Docker 镜像不带 9119 即可启动；npm 全局安装后 `yaoyao doctor` 全绿；文档不再要求 9119 |

建议先做 M0 → M1 → M2，这三步完成后 Bot 功能已经不依赖外部 Hermes；M3 涉及客户端协议，风险最高，单独确认后再做。

## 7. 打包与部署变化

- **npm**：包体积增加约 80MB（Hermes 源码）；`postinstall` 用 uv 下载 Python 3.11 和锁定依赖，需要联网。被 `--ignore-scripts` 跳过时，可以运行 `yaoyao setup`，首次启动也会补做。
- **Docker**：镜像内置 Python 和依赖（参考 yaovi-agent 的 `Dockerfile`），去掉 `HERMES_YAOYAO_UPSTREAM` 和 Hermes 目录挂载；保留一次性导入用的可选只读挂载。
- **macOS 完整版**：App 内运行的服务端需要带上 Python 运行时（参考 yaovi-agent 的 `build-agent-host.mjs`）；客户端版不变。
- **环境变量**：废弃 `HERMES_YAOYAO_UPSTREAM*`、`HERMES_YAOYAO_BRIDGE_*`、`HERMES_YAOYAO_SUPERVISE_DASHBOARD`、`HERMES_YAOYAO_CHAT_CACHE_MODE`；仍设置时启动日志给出警告，不报错。

## 8. 不随本次迁移带入的 yaovi-agent 改动

yaovi-agent 在内置 Hermes 的同时还做了很多产品层改动，本方案**不引入**：

- 删除原生（普通）对话（夭夭保留，见 M3）；
- Bot 运行环境固定为 Host、VM 模型调整（spec 060/090/091）；
- Tailcat 连接、Yaovi 账号与远程访问、Jev Auto 选模；
- 单用户模型（夭夭保持多用户 Web 账号和用户隔离）；
- 品牌、包名、端口和数据目录（夭夭保持 `@lsamien/yaoyao`、15300、`~/.yaoyao`）。

从 yaovi-agent 复制的 Node 代码会去掉对上述功能的引用。

## 9. 风险

1. **多用户隔离**：yaovi-agent 是单用户，内核进程不区分登录用户。夭夭需要把用户 ID 加进 Bot/会话的 home 路径和工具授权，否则不同用户的 Bot 可能共用凭据和记忆。
2. **客户端协议**：iOS、Android 如果直接使用 `/api/ws` gateway 协议做原生对话，M3 之后需要兼容层或客户端发新版。要先确认移动端实际用到的接口。
3. **Hermes 版本**：yaovi-agent 的副本有 Yaovi 专有修改（`+yaovi`）。直接复用最省事，但以后升级 Hermes 要两边同步。
4. **资源占用**：每个运行中的会话一个 Python 进程（约 100–200MB），群聊并发多时内存会上升，需要沿用 yaovi-agent 的并发准入（`modelAdmission.ts`）。
5. **工作量**：M0–M2 预计改动数十个服务端文件，M3 还要改客户端；测试夹具（Playwright 的 hermes-bridge、execution-auth 等配置）需要重写为受控内核。

## 10. 需要你确认的问题

1. **原生对话**：保留并在 M3 改为内置内核（建议），还是像 yaovi-agent 一样删除？
2. **移动端**：iOS/Android 是否直接说 Hermes gateway 协议？如果是，M3 需要兼容层还是可以要求客户端升级？
3. **Profile**：同意按第 5 节改为“模板初始化、Bot 独立 home”吗？
4. **Kanban 与其他 Dashboard 功能**（cron、Dashboard 自带页面）：删除，还是改用内置 Hermes 的函数重新实现？
5. **Hermes 副本**：直接复用 yaovi-agent 的 `0.23.0+yaovi`（建议），还是从官方 0.23.0 重新内置、只带夭夭需要的修改？
6. **远程节点**：同意节点之间改为夭夭到夭夭（要求对端也升级）吗？
7. **范围**：先只做 M0–M2（Bot 不再依赖外部 Hermes），还是一次做到 M5？
