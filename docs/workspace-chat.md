# Web 聊天契约

## 身份和数据

`WorkspaceAgent` 引用不可变的 `(nodeId, profile)`，保存名称、头像及角色规则。`WorkspaceConversation` 为 `direct` 或 `group`；每个角色只有一个 direct，group 支持增减成员，协议不包含 topicId。角色名在用户内唯一，以便精确 @。

创建群聊选择 2～8 位成员；编辑时可以只保留管理员，最多 8 位。当前管理员不能移除，须先更换管理员并保存后再移除原管理员。新增成员必须属于当前用户且未归档。移除成员保留聊天记录及原会话，更新头像组合和提及名单，同时清理自动回复名单；进行中的回复可完成，后续接力不再调度已移除成员。

新建群聊保留原有 8 套团队预设。模板将角色分配给已创建的 Agent，`memberRoles` 以成员 ID 保存群内角色名称与职责。分工仅在对应群聊执行时加入提示词，不修改 Agent 的身份与独立规则；移除成员会同步清理分工。模板所需成员不足时，先创建足够的 Agent 再使用模板。

Web/macOS 建群默认仅展示名称、成员、负责人和可选群规则，模板和高级协作设置折叠。会话任务在界面称为「话题」。建群与普通发消息不会自动创建目标、子任务或验收要求；明确交付时可开启「交付目标」，或让已获准组队的管理员按用户指令启动目标。管理员可直接完成，分工按需使用。

应用数据保存在 Web 数据目录的 `workspace.sqlite3`。每一条实体、命令和事件包含服务端用户归属。隐藏上游会话只由 WorkspaceRuntime 驱动，原生历史及 RPC 不允许直接访问。基础 Hermes Profile 的记忆和工具权限没有被复制为新的隔离运行环境。

## API

- `GET /api/app/capabilities`：协议 1 和能力。
- `GET/POST /api/app/agents`、`PATCH /api/app/agents/:id`：角色；`GET /api/app/agents/sources`：基础来源。
- `GET/POST /api/app/conversations`、`GET/PATCH /api/app/conversations/:id`：混合列表和聊天详情。创建接口仅创建群聊；创建角色自动创建单聊。
- `GET/POST /api/app/conversations/:id/messages`：历史和发送。发送需 UUID `requestId`、`content`、`mentionIds`、`fileIds`。重复编号与内容返回同一运行，内容冲突返回 409。
- 发送的可选 `mode` 为 `chat` 或 `goal`；缺省保持聊天。`goal` 仅用于尚无目标且没有运行中回复的群话题，需要有效管理员及团队工具能力，原子保存用户消息、目标和执行，不创建额外话题。
- `GET/PATCH /api/app/conversations/:id/tasks/:taskId/plan`：查看目标与子任务；PATCH 用 `requestId`、`expectedRevision` 和 `acceptanceCriteria` 修改进行中目标的验收条件。`expectedRevision` 对应 `goal.acceptanceRevision`（旧记录默认为 1），冲突返回 409。完成工具在验收版本大于 1 时必须传入最新 `acceptanceRevision`，旧验收依据不能直接用于完成。
- `PUT /api/app/conversations/:id/read`：单调递增的已读序号。
- `POST /api/app/runs/:id/stop`、`/reconcile`：停止和核对不确定状态。
- `POST /api/app/interactions/:id/respond`：审批或澄清。
- `GET /api/app/events?after=N`：按序号读取持久化事件，最多 250 条，重连从最后序号继续。
- `POST /api/app/uploads`：multipart 上传；`GET /api/app/files` 与文件下载、预览接口：Web 归档库。
- `/api/app/nodes`：用户自己的远端节点。密码加密保存，只返回公开字段。
- `/api/app/voice/*`、`/api/app/tts/settings/*`、`/api/app/stt/settings/*`：语音设置及运行配置。
- `/api/app/session-context/:id?profile=...`：原生会话上下文快照，按观测时间拒绝倒退。

网页与 iOS 均使用相同本地账号认证。应用写入接口校验 Origin 和 CSRF；客户端先从 bootstrap 获取令牌。

## 执行

用户消息先持久化，再创建根运行和成员任务；执行期间的新消息持久化排队。每个群成员有独立上游会话，同一群成员串行，每群最多 3 个执行、全局最多 4 个执行。管理员模式按用户消息顺序协调，同批成员可以并行。

管理员模式始终先由管理员处理，成员整批终结后返回一次管理员复核。自由模式中明确 @ 优先，无明确 @ 时由管理员和自动参与成员响应；后续无明确 @ 时可按自动参与配置接力。自动成员可静默退出，管理员必须公开处理。默认最多 3 轮，支持 1～100 及 -1（不限），管理员复核不额外增加轮数。达到上限给出提示并结束自动接力；引用和代码中的 @ 不触发协作。

每次成员执行前读取最新角色及群规则，附加到本次输入，不修改基础 Profile。网页和手机只展示用户原始消息，不展示执行提示词。

断开客户端不取消运行。提交丢失确认、连接中断或服务重启时，不自动重发可能已执行的请求。核对上游会话及带运行标识的历史后继续；无法核对时显示不确定状态并要求显式停止或核对。

## 15300 子节点

Bot 模式的远程节点由当前主服务器按用户保存。通过 `POST /api/app/nodes`
提交 `{qrPayload, name}`，二维码必须是目标 15300 Web 的 `yaoyao://pair` 一次性子节点码；
服务器登录码和 9119 账号密码表单不再作为添加节点入口。主服务器验证节点身份、兑换授权并加密保存，
手机不会切换登录服务器。当前 Bot 模式不再将已配对子节点的 Profile 列为新 Bot 来源，已有节点配对记录继续保留。

`PATCH /api/app/nodes/:id` 接受 `{name, url}`。修改 IP 前验证目标的 nodeId 和 fingerprint；
验证失败不修改记录，也不向错误地址发送保存的令牌。保存后 node ID 保持不变，已有 Agent/群成员关联继续使用。
已有子节点通道使用 `/node/:deviceId/api/realtime` 的 HTTP/SSE 协议；Bot 对话模型由配置的 Hermes 服务端执行。

升级主服务器后即可使用；子节点需要提供现有 v1 配对协议和 HTTP/SSE 能力。
旧密码连接请重新扫码建立子节点连接，不自动复制主服务器账号或升级子节点权限。

## 已停用的远端 Bot Agent 引用

当前版本不再声明 `remoteAgentReferences` 能力，Web／macOS、iOS 和 Android 均不提供新增远程 Bot 的菜单入口。兼容接口 `GET /api/app/nodes/:id/agents` 与 `POST /api/app/agents/remote` 保留，并明确返回 HTTP 410、`remote_agent_removed`。

已有引用与聊天历史保留，不因能力下线而删除；旧引用不能启动新执行。此限制不改变独立的 Hermes Bot 原生转接入口。

更新或重新扫码配对不会重新启用远程 Bot 引用。节点登录码和子节点配对码仍沿各自授权协议使用。
