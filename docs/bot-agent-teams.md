# Bot Agent 自主组建团队

分支：`feat/bot-agent-teams`。配套 iOS 使用同名分支；该功能没有修改基础 Hermes Profile。

## 使用

在 Bot 模式创建或编辑 Agent，打开「允许组建团队」并保存。例如给它发送：

> 帮我完成项目调研，需要哪些成员就先查看已有 Agent，缺少时再创建。组建团队、启动任务，并告诉我到哪个团队查看结果。

Agent 可以查看可用基础 Agent、复用已有成员、创建持久成员和团队、启动独立团队任务、读取进展和结果。新团队自动加入发起者并将其设为管理员，随后使用已有的 @分派和管理员复核机制。成员、团队和任务写入当前账号的 `workspace.sqlite3`，发布既有变更事件供 Web/iOS 同步。

启动任务返回「已启动，尚未完成」。工作在团队任务内继续。子任务执行结束后，结果自动回到原会话并唤醒管理员复核；可通过「打开任务」进入具体任务。执行结束与目标完成分开记录，完成必须满足子任务验收和目标检查。

## 运行条件

- Web 服务和发起者的 Hermes 必须在同一机器/网络命名空间，以回环地址连接。远程节点和远端引用 Agent 可作为成员，不能开启发起组队权限。
- 发起者的基础 Profile 需安装并启用既有 `yaoyao-bot-bridge` 工具桥，能力响应必须包含 `version: 1`、`ready: true`、`in_process: true`、`native_tools: true`。插件由 Hermes Bot 提供；按其安装流程部署并重新加载，Named Profile 需要各自安装、启用。
- 服务端在首次授予权限及每轮执行前检查条件。不满足时返回具体错误，普通 Agent 对话仍不查询工具桥。
- 先部署 Web 分支，再使用配套 iOS 分支。现有记录缺少 `canManageTeam` 时按关闭处理；新建成员默认关闭。

## 工具与权限

| 工具 | 作用 |
| --- | --- |
| `workspace_list_sources` | 当前账号获准的基础 Profile |
| `workspace_list_agents` | 当前账号可使用的已有成员 |
| `workspace_list_teams` | 发起者担任管理员的团队 |
| `workspace_create_agent` | 创建成员，禁止授予组队权限 |
| `workspace_create_team` | 创建管理员协作模式的团队 |
| `workspace_start_team_task` | 在发起者管理的团队启动任务 |
| `workspace_get_team_task` | 读取状态、最近 20 条消息和待处理问题 |
| `workspace_assign_task` | 分派具有负责人、依赖和验收条件的子任务 |
| `workspace_update_assignment` / `workspace_cancel_assignment` | 调整或停止子任务，保留原因与历史 |
| `workspace_review_assignment` | 验收、明确返工或记录受阻 |
| `workspace_finish_team_task` / `workspace_resume_team_task` | 记录目标结论，或从用户新指令恢复目标 |
| `workspace_update_created_agent` / `workspace_archive_created_agent` | 管理自己创建且符合使用状态限制的成员 |
| `workspace_update_team` | 调整空闲团队的规则、成员或归档状态 |

所有变更工具要求 `requestId`（UUID）；重试同一操作必须复用它。服务端持久保存回执；相同编号用于不同参数返回冲突，重复请求不会重复创建。原生工具调用 ID 也在本轮去重。

账号和调用 Agent 从正在运行的服务端轮次取得，模型参数不能指定 owner、token 或调用身份。创建成员只能引用当前账号获准的基础 Profile；子账号的分配规则保持有效。只有团队管理员可以启动或读取该团队的任务，禁止从当前团队任务递归启动自身任务。

每轮使用独立随机凭据、独立原生工具 ID 和回环监听端口，凭据仅传给经过认证的工具桥绑定接口。权限、账号、Profile、成员归属、归档和停止状态在每次调用时校验，异步操作在写入前再次校验。绑定保留 Agent 的配置版本；关闭后重新开启权限也不能使旧轮次重新生效。完成、取消、连接结束或服务关闭时销毁监听器并解绑；最长 30 分钟，运行时每 5 分钟续租。断线恢复只核对原执行，不重新提交已有工具副作用；下一轮重新授权。

自动组队的范围：每队 2–8 人，最多管理 20 个有效团队，账号最多保留 100 个有效 Agent，每轮最多 128 次团队工具调用。结构化目标最多 32 个子任务，每次授权默认允许子任务执行 3 次、目标自动唤醒 8 次。恢复旧目标需要用户新指令，并确认旧执行已结束。同一持久 Agent 跨会话和任务串行执行；不同 Agent 保留全局最多 4 个执行槽。用户指令优先于后台分派，排队超过 60 秒的工作会提升优先级。

停止与停止完成分别表示为 `cancelling`、`cancelled`，状态不确定时不重放副作用。结果投递、复核轮次和恢复代次都持久保存并去重。账号授权版本或组队权限变化使旧目标和工具授权失效。

Web、iOS、Android 均可查看任务分工、验收和结果，停止或继续当前目标。Web 的任务选择会保留各自的文字、引用及附件草稿。macOS App 与 Web 共用界面，桌面托管实现位于 `desktop/`。

## 验证

```sh
npm run typecheck
npm test
npm run test:e2e:team-tools
```

`tests/server/workspaceTeamTools.test.ts` 验证创建、持久去重、账号隔离、Profile 撤销、配置版本失效、停止、回环认证、不同轮次的工具 ID/凭据隔离、过期和取消绑定竞态。

真实 Hermes 协议验收使用隔离测试实例（不调用付费模型、不访问用户会话）：

1. 使用 Hermes 的 Python，运行 Hermes Bot 仓库内 `integrations/hermes-bots-bridge/tests/hermes_wire_fixture.py /path/to/hermes-agent`。
2. 将它打印的回环 URL 设为 `HERMES_TEAM_WIRE_URL`，运行 `npm test -- tests/live/workspaceTeamTools.live.test.ts`。

此测试必须校验实例的专用 fixture 标记，实际经过 HTTP 登录、WebSocket 会话、插件原生工具注册、回环工具调用、持久成员/团队/任务和权限撤销。未设置 URL 时跳过该项；模型决策使用确定脚本，因此不代表真实模型在任意任务下的自主组队质量。

### 2026-09-08 分支验收

- 类型检查及生产构建通过。
- 完整 Vitest：98 个文件、649 项通过；上述需显式指定实例的用例默认跳过，并已单独执行通过。
- 真实 Hermes 隔离实例通过创建、重试去重、团队任务、撤销和两个发起者同时调用的验证，实际注册的原生函数名称互不冲突。
- Playwright：新开关保存/重载/撤销 1 项、原有成员/团队及子账号权限回归 2 项通过。检查了桌面浅色与 375px 手机宽度深色截图。
- iOS：24 项 WorkspaceChatTests 通过；开关保存往返在普通显示与深色大字体下均通过模拟器验收。
- 首次全量并发运行有 1 项既有语音配置用例失败；聚焦重跑及最终全量运行均通过，未修改语音功能。

所有结果来自分支代码和隔离数据。没有部署正式 Web、调用付费模型、安装实体手机或合并主分支。
