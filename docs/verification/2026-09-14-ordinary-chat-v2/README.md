# 普通聊天 v2 统一消息链路

实现范围为普通聊天。Web/macOS、iOS、Android 同时使用 `ordinary-chat-transcript-v2`；原生 Hermes Bot 和 Bot 模式保留原来的运行边界。本次只交付源码和验证，未发布、部署或安装正式客户端，也没有操作实际聊天数据库。

## 服务端职责

`ChatTranscriptStore` 直接消费经过规范化的输入回执、运行事件和恢复快照，持久化回合、消息、片段归属及上游别名。`chat_messages` 仅保留上游历史导入和核验职责；旧的 `chatEventProjection.ts` 与实时写入旧缓存的路径已移除。

- 显示 ID 在流式输出、恢复、上游数据库 ID 出现后保持不变。回合、消息、工具调用分别建立身份关系。
- 增量追加，完整快照替换所属片段；预览后的完成事件结束同一条消息。工具调用、明确的新消息边界和后续片段保留各自的正文。
- 排队输入不会改变当前输出的归属，steer 保持在当前回合。迟到的命令回执或旧回合完成事件不会重新开启、结束当前运行。
- 事件收据、源游标、规范记录和 SSE 日志在同一 SQLite 事务提交。上游事件 ID 使用上游 epoch、运行路由和序号，服务端进程重启不改变已保存收据的身份。
- 无法取得连续上游重放时，保留当前记录并接收完整恢复快照，暂不追加无法确定位置的增量；终态和后台历史核验补齐内容。
- 列表、附件来源及最终回复未读数从规范记录读取。历史核验不重新提交问题、不重发历史完成通知。流式热路径不再扫描整份聊天正文。

## v2 契约与客户端

沿用 `/api/app/chat/sessions/:id/snapshot` 和 `/events`。消息包含稳定 `id`、服务端顺序 `seq`、`revision`、`turn_id`、`segment_kind`，用户输入另有 `client_message_id`。上游 ID 只作为关联元数据。

快照包含会话 epoch、游标、消息覆盖、删除 ID、运行/排队状态和待处理交互。每个事件包含 epoch、cursor、previousCursor、total；previousCursor 检测同一会话漏掉的事件，无须假设全局 SQLite cursor 连续。

三端仅从规范记录生成普通聊天正文。运行路由的 resume 不再直接插入 assistant，旧历史拼接不再进入普通聊天路径。客户端保留独立的待确认输入，通过 client_message_id 消除本地输入与服务端回显的双份表示。

消息、删除标记和 checkpoint 一起保存，保存失败不推进消费者游标；重复版本不再次应用。旧分页返回不能覆盖新版本或恢复已删除消息，分页不确认 SSE 游标。会话代次变化时替换已确认窗口并保留本地待发送输入。前台恢复重新订阅已保存位置，事件连接使用 45 秒无数据超时。

新客户端不接受 v1 checkpoint，不回退到旧消息生成路径。新服务器对缺少 v2 声明的普通聊天通道返回 426 升级提示；原生 Bot 通道不受此门禁影响。v1 的试验环境变量不再控制这条正式代码路径。

## 已有数据的核验修复

启动时登记旧的已拥有会话，使用现有持久化后台队列核验，最多两个会话并发。运行中的会话延后，读取期间版本发生变化则重试。

原始历史和规范记录、别名在切换前存入 `chat_transcript_archives`；修复任务保留状态，可中断后继续。结构变化产生新的会话 epoch，使三端用一个新快照替换旧窗口。无法确认的已接收输入及其关联回合保留，等待后续核验，不根据文本相同删除消息。用户真正重复发送的消息保持独立。

实际旧数据的修复将在部署新服务后后台执行，本次验证仅使用临时 SQLite。

## 验证

- Web/服务端：全量 Vitest 1172 项通过、19 项按原配置跳过，`npm run typecheck`、`npm run build` 通过。
- 服务端使用隔离事件驱动真实 HTTP/SSE 接口验证：事件重放结果与终态快照完全一致；预览和完成仅产生一个显示消息；旧普通聊天通道收到升级响应。
- 场景覆盖：预览重复、ID 变化、保存失败、源游标重启、缺失重放、迟到事件、队列拒绝、steer、附件、删除与分页交错、旧 epoch、旧缓存升级以及会话切换。
- Web、Swift、Kotlin 使用相同 JSON 协议输入；执行 `python3 docs/verification/2026-09-14-ordinary-chat-v2/verify-fixtures.py` 校验三份语义一致。规范化 SHA-256：`4512ac92a07783cd49f23949830c7c7e6fe94e96ce3164fa0a9b63760fdf6dbc`。
- Android：`:core:model:test` 54 项、`:core:network:test` 46 项通过；`:app:compileDebugKotlin` 通过。
- iOS 模拟器：ChatHistoryStore、ChatRuntime、HermesHTTPRealtime、OrdinaryTranscriptV2 共 355 项通过，包括将旧回复替换为规范记录、保留待确认输入并按身份合并回显。

较大范围 iOS 检查还发现两个文件库已有失败：`testMessageFileArchiveQueryUsesContextAndReturnsCacheState`、`testYaoyaoFileLibraryUsesSupportedPluginQueryAndDecodesArchive`。在独立的未修改 `3dc20b6` 源码副本中，两项测试以同样的 URLProtocol transport 错误失败；这两个失败未混入本次修复。

实体 iPhone 当前不可用。模拟器与协议重放验证不代表实体设备的后台挂起、蜂窝/Wi-Fi 切换已经验收；正式发布前还需在实体设备完成这部分验证。

## 复验命令

在 yaoyao：

```sh
NODE_OPTIONS=--no-experimental-webstorage npm test
npm run typecheck
npm run build
python3 docs/verification/2026-09-14-ordinary-chat-v2/verify-fixtures.py
```

在 yaoyao-android（使用本机 JDK 17）：

```sh
JAVA_HOME=/Users/samien/.local/share/hermes-android-toolchain/jdk-17 ./gradlew :core:model:test :core:network:test :app:compileDebugKotlin
```

在 yaoyao-mobile（将 destination 替换为可用模拟器）：

```sh
xcodebuild -project YaoYaoAI.xcodeproj -scheme YaoYaoAI \
  -destination 'platform=iOS Simulator,id=2AB1845D-8B54-4828-BA6E-0538CD08D488' \
  test -only-testing:YaoYaoAITests/ChatRuntimeTests \
  -only-testing:YaoYaoAITests/ChatHistoryStoreTests \
  -only-testing:YaoYaoAITests/HermesHTTPRealtimeTests \
  -only-testing:YaoYaoAITests/OrdinaryTranscriptV2Tests CODE_SIGNING_ALLOWED=NO
```
