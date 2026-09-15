# 夭夭 Bot 的 Hermes 工具桥

这是运行在 Hermes 内的用户插件，版本 1.2.3。它连接 Yaoyao 每轮授权的电脑、团队和应用工具，不修改 Hermes 核心。

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

Yaoyao 管理员可从“设置 → Hermes 连接 → 工具桥插件”执行检查和安装。默认 Profile 提供共享后台入口，应先安装默认入口，再处理命名 Profile。界面依据磁盘与已加载代码的指纹区分待重启与已就绪。


使用 Hermes 的 Python，从 Yaoyao 仓库运行：

```sh
~/.hermes/hermes-agent/venv/bin/python scripts/install-hermes-bridge.py \
  --hermes-home ~/.hermes --profile default --profile server
```

Runner 包内可直接运行同目录的 `install-hermes-bridge.py`。安装器备份原插件与配置，保留其他插件和显式禁用项，不重启服务。每个使用中的 Named Profile 都需安装；在空闲时重启 Hermes，再使用新版 Runner。

需要支持原生插件工具注册、`pre_tool_call` 审批及 Dashboard 非进程隔离 WebSocket 会话的 Hermes。插件通过实际 Profile 的工具目录检查就绪状态；接口或插件未更新时会明确拒绝启动新路径。

## API 与认证

前缀：`/api/plugins/yaoyao-bot-bridge`。

- `GET /capabilities?profile=...`：检查对应 Profile 及托管能力。
- `POST /bind`：绑定真实 Hermes 会话、Profile 和当前轮次；最多 30 分钟，支持同轮续租。
- `POST /unbind`：只撤销匹配的会话与轮次。
- `POST /computer-file`：当前运行轮次的文件传输；验证 HTTP 身份、会话、轮次、Profile、文件保护规则，最多 25 MiB。请求不能选择其他 Profile。
- `POST /memory-extract`：在选定 Profile 下使用 Hermes 原生辅助模型提炼给定内容，不提供执行工具、不启动 Worker。
- `POST /sampling`：保留既有的有界 MCP sampling。

HTTP 使用 Hermes 自身认证。绑定身份必须与 WebSocket 的真实身份一致。文件与工具接口按当前会话对象、Agent、Profile、轮次校验；模型参数不能指定调用身份。密钥不进入提示词或全局 MCP 配置。

桥接回调只接受指定端口的 `http://127.0.0.1`，禁用代理与重定向。每轮工具注册独立命名空间；子代理只通过 Hermes 可信生命周期继承权限。多媒体内容保留原有转换与附件语义。

## 验证

```sh
~/.hermes/hermes-agent/venv/bin/python -m unittest discover \
  -s integrations/hermes-bots-bridge/tests -v
```

覆盖隔离与本机策略、撤权、会话替换、续租变更、文件身份和保护路径、安装备份及失败回滚。

`tests/live/profileComputer.live.test.ts` 使用临时 Hermes 目录、真实 Hermes、真实 Docker 和确定性模型响应，验证两种模式的 Skill、Profile 环境变量、授权文件双向传输、原图输入及无工具记忆提炼。Worker 路径故意配置为不存在，证明新链路不依赖 Worker 配置读取。

真实测试使用已安装的 Tirith 检查器，默认查找 Hermes 主目录的 `bin/tirith`，也可通过 `YAOYAO_TIRITH_BIN` 指定，避免临时环境下载依赖造成超时。隔离模式关闭 YOLO，实际接收审批 RPC 并逐次回复 `once`；模型响应与授权文件使用测试数据。

`tests/live/workspaceSkillLearning.live.test.ts` 验证真实 Hermes 在主轮次结束后创建、读取并更新自动生成的技能，随后由同 Profile 的另一个 Bot 复用。覆盖同模型及独立复盘模型，检查记忆和上下文隔离，以及复盘不污染主 Session。

CLI 增加 `--check` 可只读检查默认及命名 Profile；`--enable` 明确启用所选插件及工具集，仅移除这个工具桥的显式禁用项。默认安装行为继续保留禁用设置。

1.2.1 将 Bot 记忆隔离放在受认证的 `/bind` 授权中（`workspace_memory: true`），在首个模型请求前关闭该会话的 Profile 记忆注入、原生记忆工具及后台复盘。不会向 Hermes 的严格 `session.create` 接口发送自定义记忆字段，也不修改 Profile 配置。安装后需重启 Dashboard 服务（默认 9119），消息网关的重启不负责重载这份插件。

1.2.2 对 `computer_policy.mode: isolated` 的会话应用 Hermes 现有的 `skip_context_files=True`、`load_soul_identity=False`，关闭自动上下文文件加载。策略只在工具桥内部应用，不增加 `session.create` 参数；`isolated_context_files: true` 表示已加载的插件支持此行为。

1.2.3 将技能复盘与记忆隔离分开：`skill_learning: true` 表示插件允许受限的原生技能复盘。不会强制每次对话创建技能，也不会另建发布流程。
