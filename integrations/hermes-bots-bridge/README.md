# 夭夭 Bot 的 Hermes 工具桥

这是运行在 Hermes 内的用户插件，版本 1.2.5。它连接 Yaoyao 每轮授权的电脑、团队和应用工具。随附安装器还提供有备份的 Hermes Profile 模型兼容修复。

## Hermes 托管虚拟机会话

Yaoyao 的虚拟机模式和本机协作模式都使用真实 Hermes Profile 会话。模型、视觉路由、配置、认证及 Skill 使用 Hermes 原生实现；Runner 负责虚拟机工具和传输。

- `computer_runtime_version: 2` 表示插件支持托管会话及权限策略。
- `computer_policy: {mode: "isolated" | "profile", hostAccess: boolean}` 由可信 Runner 在绑定时发送，模型不能修改。同一轮续租不能变更策略。
- 隔离模式默认使用虚拟机工具。本机终端、文件、浏览器、代码执行及本机文件传输通过 Hermes 的 `pre_tool_call` 审批机制。Profile 原有的禁用项继续有效。
- 隔离模式在每次绑定时关闭 SOUL.md、AGENTS.md、CLAUDE.md、.cursorrules 等上下文文件的自动加载，并清除系统提示词缓存；恢复会话和子代理继承同一策略。本机协作模式及普通 Hermes 会话保持原行为。
- 该策略保留 Profile 的模型、认证、技能加载和工具能力，以及 Bot 自己的设定、记忆和 Session 历史；不删除或改写 Profile 文件。显式读取文件仍遵循 Hermes 的工具权限，旧历史中已经出现的内容不会自动删除。
- Skill 发现、读取、写入审核和学习由 Hermes 原生工具处理。依赖授权资源的步骤在 Hermes 完成；普通脚本和输入文件可显式传给 Linux 虚拟机。
- Bot 保留 Hermes 原生技能复盘触发条件（`skills.creation_nudge_interval`、`auxiliary.background_review.enabled`）。达到触发条件后，只用 `skills_list`、`skill_view`、`skill_manage` 复盘并维护当前 Profile 的技能，同 Profile 的其他 Bot 后续可以发现和复用。技能写入继续遵循 Hermes 原有策略。
- 技能复盘使用 Hermes 原生后台生命周期，仅持有技能权限；主轮次结束后不再操作电脑、文件、协作或记忆工具。复盘不会写入主 Session，不恢复 Profile 记忆、OpenViking 读写或已关闭的上下文文件加载。
- 停止、过期、换 Agent 或解绑后，旧电脑会话的原生工具与桥接工具均拒绝继续调用；普通 Profile 会话不受影响。

## 安装

Yaoyao 管理员可从“设置 → Hermes 连接 → 工具桥插件”执行检查和安装。本机安装会同时备份并修复 Hermes 的 Profile 模型解析与会话元信息；Docker 映射模式只安装共享数据目录中的插件，模型兼容修复需在运行 Hermes 的容器或节点单独执行，见 [Docker 安装说明](../../docs/docker-install.md#docker-安装报-profile-模型兼容修复失败)。默认 Profile 提供共享后台入口，应先安装默认入口，再处理命名 Profile。界面依据磁盘与已加载插件代码的指纹区分待重启与已就绪。


使用 Hermes 的 Python，从 Yaoyao 仓库运行：

```sh
~/.hermes/hermes-agent/venv/bin/python scripts/install-hermes-bridge.py \
  --hermes-home ~/.hermes --profile default --profile yaoer --repair-profile-runtime
```

Runner 包内可直接运行同目录的 `install-hermes-bridge.py`。安装器备份原插件与配置，保留其他插件和显式禁用项，不重启服务。每个使用中的 Named Profile 都需安装；在空闲时重启 Hermes，再使用新版 Runner。

`--repair-profile-runtime` 只在 Hermes 所在服务器执行，客户端不需要安装 Hermes。它定位所用 Python 实际导入的 Hermes，验证源码结构后修复 `tui_gateway/server.py` 和 `tui_gateway/methods_session.py`：

- 创建、恢复会话的模型元信息在请求指定的 Profile 中读取。
- 已配置的 Profile 模型及 Provider 优先于启动进程中的 `HERMES_MODEL`、`HERMES_INFERENCE_MODEL` 和 `HERMES_TUI_PROVIDER`；不会把 `yaoer` 配置的 `grok-4.6` 换成默认 Profile 或启动环境里的模型。
- Hermes 的显式会话模型覆盖仍使用原生逻辑。未配置模型时继续使用原生回退，不写死任何模型名称，也不改动 Profile 的模型、认证、记忆文件或聊天历史。

修复先完整验证两份源码，再备份至本次安装返回的 `backup/hermes-runtime/`，最后原子替换；安装失败会回滚插件、配置及已替换的源码。源码结构不兼容时拒绝修改。该修复需要重启 Hermes Dashboard，升级 Hermes 后应重新安装以检查兼容性并恢复修复。需要手动回退时，在服务停止后用备份中的同名文件恢复这两份源码，再恢复该次备份的插件和配置。单独安装插件时可省略这个参数；`--check` 始终只读。

需要支持原生插件工具注册、`pre_tool_call` 审批及 Dashboard 非进程隔离 WebSocket 会话的 Hermes。插件通过实际 Profile 的工具目录检查就绪状态；接口或插件未更新时会明确拒绝启动新路径。

## API 与认证

前缀：`/api/plugins/yaoyao-bot-bridge`。

- `GET /capabilities?profile=...`：检查对应 Profile 及托管能力。
- `GET /model-options?profile=...`：读取 Profile 的模型目录、默认值、思考能力与速度能力；只返回公开配置，不返回凭据。
- `POST /model-settings/resolve`：接收 `profile` 与 `settings`，通过 Hermes 原生解析器校验完整组合，返回版本 1 的有效配置和模型确认提示；不写 Profile 配置。
- `POST /bind`：绑定真实 Hermes 会话、Profile 和当前轮次；最多 30 分钟，支持同轮续租。
- `POST /unbind`：只撤销匹配的会话与轮次。
- `POST /computer-file`：当前运行轮次的文件传输；验证 HTTP 身份、会话、轮次、Profile、文件保护规则，最多 25 MiB。请求不能选择其他 Profile。
- `POST /memory-extract`：在选定 Profile 下使用 Hermes 原生辅助模型提炼给定内容，不提供执行工具、不启动 Worker。
- `POST /sampling`：保留既有的有界 MCP sampling。

HTTP 使用 Hermes 自身认证。绑定身份必须与 WebSocket 的真实身份一致。文件与工具接口按当前会话对象、Agent、Profile、轮次校验；模型参数不能指定调用身份。密钥不进入提示词或全局 MCP 配置。

桥接回调只接受指定端口的 `http://127.0.0.1`，禁用代理与重定向。每轮工具注册独立命名空间；子代理只通过 Hermes 可信生命周期继承权限。多媒体内容保留原有转换与附件语义。

## Bot 工具发现与会话复用

`yaoyao_tools` 支持 `service`、`query`、`offset`、`limit`：按服务标签或工具名称/描述筛选，直接返回本轮有效 ID 与完整参数结构，随后可调用 `yaoyao_call`。筛选默认每页 20 项、最多 50 项，`nextOffset` 非空表示还有下一页。聚合的已连接应用可用 `query: "GMAIL"` 查询。无参数仍返回完整目录，兼容已有调用；筛选不改变授权与撤权校验。

未设置 `HERMES_KANBAN_TASK` 的 Bot 会话会清除 Hermes 自动注入的“已分配看板任务”规则；`kanban_show/comment/heartbeat` 缺少真实任务 ID 时返回明确的跳过说明。看板工具仍可用于用户明确要求的看板操作，普通 Hermes 会话不受影响。

Web 服务将已确认注入的记忆记录在各 Bot 会话绑定中。新增事实通过下一轮提示词增量注入，未变化的事实不重复发送；事实修改、删除或授权范围变化会重建会话。历史绑定没有完整基线时首次使用会保守重建一次。只有 `prompt.submit` 确认接收后才推进基线；恢复未确认执行时不重放提示词。检查器中的 `bot.session-reset` 记录具体重建原因。

工具发现和看板规则优化需要更新工具桥并在获准的维护窗口重载 Hermes Dashboard；记忆复用需要更新 Web 服务。仅修改源码或通过测试不会改变正在运行的服务。

## 验证

```sh
~/.hermes/hermes-agent/venv/bin/python -m unittest discover \
  -s integrations/hermes-bots-bridge/tests -v
```

覆盖隔离与本机策略、撤权、会话替换、续租变更、文件身份和保护路径、安装备份及失败回滚。

`docs/verification/2026-09-19-profile-routing/verify.py` 使用已安装 Hermes 的临时源码副本与本地模拟模型服务，验证 Profile 模型、会话创建/恢复元信息以及工具桥绑定；不会修改实际 Hermes 安装。`--baseline` 可复现启动环境覆盖配置的问题。

`tests/live/profileComputer.live.test.ts` 使用临时 Hermes 目录、真实 Hermes、真实 Docker 和确定性模型响应，验证两种模式的 Skill、Profile 环境变量、授权文件双向传输、原图输入及无工具记忆提炼。Worker 路径故意配置为不存在，证明新链路不依赖 Worker 配置读取。

真实测试使用已安装的 Tirith 检查器，默认查找 Hermes 主目录的 `bin/tirith`，也可通过 `YAOYAO_TIRITH_BIN` 指定，避免临时环境下载依赖造成超时。隔离模式关闭 YOLO，实际接收审批 RPC 并逐次回复 `once`；模型响应与授权文件使用测试数据。

`tests/live/workspaceSkillLearning.live.test.ts` 验证真实 Hermes 在主轮次结束后创建、读取并更新自动生成的技能，随后由同 Profile 的另一个 Bot 复用。覆盖同模型及独立复盘模型，检查记忆和上下文隔离，以及复盘不污染主 Session。

CLI 增加 `--check` 可只读检查默认及命名 Profile；`--enable` 明确启用所选插件及工具集，仅移除这个工具桥的显式禁用项。默认安装行为继续保留禁用设置。

1.2.5 增加上述 Profile 模型兼容修复；工具桥绑定会主动触发延迟会话的原生初始化，并区分初始化失败、绑定锁等待超时及工具目录回调失败。锁获取计入绑定截止时间，工具目录回调最多等待 10 秒；这些步骤失败时尚未提交聊天消息。实际工具执行仍保留原有等待期限。

1.2.1 将 Bot 记忆隔离放在受认证的 `/bind` 授权中（`workspace_memory: true`），在首个模型请求前关闭该会话的 Profile 记忆注入、原生记忆工具及后台复盘。不会向 Hermes 的严格 `session.create` 接口发送自定义记忆字段，也不修改 Profile 配置。安装后需重启 Dashboard 服务（默认 9119），消息网关的重启不负责重载这份插件。

1.2.2 对 `computer_policy.mode: isolated` 的会话应用 Hermes 现有的 `skip_context_files=True`、`load_soul_identity=False`，关闭自动上下文文件加载。策略只在工具桥内部应用，不增加 `session.create` 参数；`isolated_context_files: true` 表示已加载的插件支持此行为。

1.2.3 将技能复盘与记忆隔离分开：`skill_learning: true` 表示插件允许受限的原生技能复盘。不会强制每次对话创建技能，也不会另建发布流程。

1.2.4 修复非默认 Profile 在工具桥绑定、工具目录刷新及子代理继承时误读默认 Profile 工具目录的问题。目录重建使用绑定会话的 Profile，完成或失败后恢复调用方上下文。更新后需重启 Hermes Dashboard 服务，再发起新一轮对话。

1.3.0 增加 Bot 个人资料的模型设置协议（`model_settings_version: 1`）。模型与 Provider 成对选择，思考等级和 `normal / fast / auto / cold` 速度可分别继承。Web 服务在每轮提交前解析配置，并通过原生 `config.set` 按模型、思考、速度的顺序应用到当前 Bot 会话；保存资料不修改 Profile 默认值，也不打断正在运行的回复。恢复中的原轮次只继续追踪，不重新设置或提交。模型目录未声明具体等级时返回 `reasoningKnown: false`；快速能力同时检查模型和 Provider 路由。

发布时先更新工具桥与 Web 服务，在空闲时重启 Hermes Dashboard，再发布 Web／桌面端、iOS 和 Android 客户端。旧桥不能编辑新增设置，会明确提示升级；未设置 `modelSettings` 的旧 Bot 继续按原有继承路径运行。原生会话配置回执不兼容、模型无效或应用失败会停止本轮，不使用旧配置继续运行。
