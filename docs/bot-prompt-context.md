# Bot 提示词与环境上下文

2026-09-21，第一、二批优化。适用于应用的 Bot 模式；设备扩展信息需要桌面端与服务端均升级。

## 提示词组织

`src/server/workspacePrompt.ts` 负责纯文本组装；`workspaceRuntime.ts` 提供本轮身份、协作状态、已挂载能力、已确认的工作目录和消息来源。

顺序为基础行为规则、Bot 身份与长期规则、本轮任务与协作、环境与设备、已连接应用、Bot 记忆、运行标记、用户消息或对话上下文、附件。保留现有群聊参与、静默、讨论轮次、目标验收、临时助手和运行恢复语义。

这些是现有 `prompt.submit.text` 中的文本分段，不是 Hermes 新增的 system/developer 消息角色。没有修改共享 Profile、用户保存的 Bot 提示词或既有聊天记录。

## 环境与工具

- 环境说明由本轮实际挂载的工具决定，不再扫描整段历史或通过“本机”“Grok”“虚拟机”等关键词决定环境描述。简短能力说明随每轮提供，后续“继续”也能获得完整的工具边界。
- 所有环境说明使用“操作某环境时”的条件表达。模型会话仍在服务端 Hermes，桌面、VM 和云电脑是工具目标；普通聊天不会因提示词组装启动 VM。
- 全局开放、工具已挂载、设备在线、设备授权是不同状态。原生工具以 Hermes 实际目录为准，不再一概宣称全部可用。
- Hermes 文件与命令作用于其服务器运行环境；Docker 等部署不能假定该路径与服务器桌面共享。已确认的 `session.cwd.set` 结果可注入提示，没有确认的路径不猜测。
- 文件和命令能力与屏幕控制分别提示。文件操作不先截图；窗口操作使用新截图。跨设备传文件继续使用 `desktop_file_copy`，保留文件大小限制、覆盖规则和校验要求。
- 设备清单每轮只出现一次，包含名称、稳定的工具 `host` 值、平台及该账号的屏幕控制／文件与命令状态。服务器工具目标固定为 `server`；同名电脑可按 ID 区分。
- “本机”继续取本轮来源。用户明确指定目标时使用指定目标；未知来源、离线、未开放或未授权不得回退到其他设备。协作、定时任务、并发来源和执行时权限校验沿用原机制。

## 第二批：统一环境快照

`src/shared/botEnvironment.ts` 定义本轮结构化环境数据；`desktopEnvironments.snapshot()` 采集设备状态，`workspaceEnvironment.ts` 汇总 Hermes、桌面、VM 和云电脑能力。提示词、电脑工具目录和 Inspector 的 `bot.environment` 记录共用这一份快照。

- 设备按稳定 ID 列出，包含已登记但离线、已关闭的电脑，以及本轮来源。分别记录查看、输入、文件读写、命令和文件传输能力；区分离线、未开放、不支持、未授权、系统权限缺失、人工接管和暂停等原因。
- 桌面端上报白名单信息：系统内核版本、架构、Shell、主目录、默认工作目录、文件工具允许根目录、Shell 权限范围和时区。没有上报的信息保持未知，不推测路径，也不采集环境变量、令牌或凭据。
- 服务端按当前账号裁剪设备信息。没有文件与命令授权时，提示词和诊断快照均不包含设备运行路径；离线设备也不提供缓存路径。文件工具受允许根目录约束，Shell 使用桌面用户的系统权限，不宣称它受同一根目录限制。
- 每台设备单独标记分块／旧版传输协议与读写上限。旧版读取最多 12 MiB、写入最多 10 MiB，且仍受全局传输上限约束；没有连接信息时标记未知。
- 人工接管期间保留已经可用的工具，调用等待交还。执行时仍实时校验授权、全局开关和连接代次；撤权立即生效，设备重连或本轮快照之外的新设备不能沿用旧上下文执行。
- VM 和云电脑仅记录配置及按需可用状态；采集快照不启动电脑、不探测连接。运行状态和 VM 工作目录由首次调用确认。Hermes 工作目录仍只使用成功确认的结果。
- Inspector 同时记录结构化快照及实际挂载的电脑工具 ID，便于比对模型收到的环境说明与工具目录。

### 客户端兼容

本机和远程设备入口共用严格的协议校验。新版桌面端先发送旧格式，服务器通过 `capabilities.environmentMetadata=1` 声明支持后，客户端才发送扩展信息和分块传输版本。连接失败或服务器不再声明支持时清除协商结果，下一次按旧格式重试。

| 服务端 | 桌面端 | 行为 |
| --- | --- | --- |
| 新版 | 新版 | 协商后上报完整元数据与分块能力 |
| 新版 | 旧版 | 接收原有字段，缺失元数据明确显示未知 |
| 旧版 | 新版 | 使用旧格式，按旧版传输上限工作 |

服务端原有的远程设备入口未接受 `fileTransferVersion`，现在与本机入口统一，避免桌面端发送该字段时被严格校验拒绝。

## 验证

修改前的五组相关测试 163 项通过。修改后的十二组测试 267 项通过，包括新增的 9 项提示词、设备清单和真实 Bot WebSocket 提交链路测试。

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run \
  tests/server/workspacePrompt.test.ts \
  tests/server/workspace.test.ts \
  tests/server/desktopEnvironments.test.ts \
  tests/server/workspacePanels.test.ts \
  tests/server/workspaceCollaboration.test.ts \
  tests/server/personaSection.test.ts \
  tests/server/taskCoordinator.test.ts \
  tests/server/workspacePlugins.test.ts \
  tests/server/sessionWorkingDirectory.test.ts \
  tests/server/workspaceKnowledge.test.ts \
  tests/server/workspaceMemorySynthesis.test.ts \
  tests/server/workspaceTeamTools.test.ts --maxWorkers=4
npm run typecheck
npm run build
```

类型检查和构建通过，构建保留大包体积提示。验证使用模拟 Hermes 与设备传输，没有调用外部模型或操作生产设备，不能据此认定真实模型的目标选择准确率或 Token 开销已改善。

第二批在以上测试组基础上增加 `workspaceEnvironment.test.ts`、`desktopHosts.test.ts`，合计 14 组、285 项通过。另有 13 项桌面端测试通过：

```sh
node --test desktop/host-environment.test.mjs \
  desktop/host-manager.test.mjs desktop/host-files.test.mjs
npm run typecheck
npm run desktop:build
```

覆盖新旧协议协商、服务器回退、按账号裁剪路径、离线与关闭设备、人工接管与撤权、连接变更，以及真实 Bot 提交链路中提示词／工具目录／Inspector 的一致性。类型检查和桌面完整构建通过，构建仍有大包体积提示。未进行多台真实 Mac 联调或外部模型效果评测。

上下文预算、按任务检索记忆和 Hermes 独立上下文角色留待第三批；前两批均未部署或重启运行中的服务。
