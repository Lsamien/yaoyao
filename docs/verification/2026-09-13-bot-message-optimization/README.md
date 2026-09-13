# Bot 模式三端收发优化

两个阶段均在三个仓库各自的 `codex/bot-message-latency` 分支、独立 worktree 中完成。没有合并主线、发布版本或安装到真机。

开发目录：`/Users/samien/git/bot-message-latency/{yaoyao,yaoyao-mobile,yaoyao-android}`。基线为 Web/服务端 `bed10cb`（0.4.16）、Android `8ed6079`（1.3/168）。iOS 基线归属更正：从 main `52e9f12` 创建分支后，实施时快进到了功能分支 `codex/ios-chat-thinking-dots` 的 `aceb477`（1.3/200），额外带入了 Markdown、媒体展示等提交；它不是主分支基线。因此本报告的 iOS 数据只能说明 `aceb477` 到收发优化版本的变化，不能排除相对 `main` 的整体性能回退。原工作区的暂存头像和其他文件未带入分支。

## 实现

第一阶段提交：Web/服务端 `ae7c388`，iOS `88f276e`，Android `b7733bf`。

- `/api/app/capabilities` 通过原有 CSRF 签发器返回 `csrfToken`，并设置 `Cache-Control: no-store`；移动端在进入 Bot 模式时预热，共用正在进行的初始化，旧服务端回退到 bootstrap。
- 发送接口保留 `run`，增加 `requestId、message、conversation、task、cursor`。三端确认后解除发送状态，回执按实体版本合并，既不推进全局 SSE 游标，也不覆盖更新的事件。
- 两秒未追上回执时才进行后台详情补偿；旧协议缺少游标时立即后台补偿。列表、能力和机器人刷新不再阻塞发送，补偿失败不改变已接受的提交结果。
- 冻结提交时的上下文和请求 ID；重试保留原 ID。新草稿、修改后又恢复原文的草稿，以及切换会话后的草稿都不被旧确认清除。

第二阶段客户端提交：iOS `8e72ea2`，Android `975bd76`。

第二阶段：

- 消息增加 `revision`，旧记录按零处理。纯文本追加使用持久化 `message.patch`：`id、conversationId、conversationTaskId、baseRevision、revision、contentAppend、reasoningAppend`。
- 完整消息行与补丁日志在同一事务中提交后才推送；内部观察者仍得到完整消息。首次、重写、可见性/工具/附件变化及终态使用全量消息。
- 服务端首段立即冲刷，后续 33 ms 合并；末尾有定时冲刷。摘要最多每 250 ms 更新，并补上暂停后最后一段摘要的尾刷。结束状态不再等待用量查询；迟到用量不能覆盖后续 run。
- 三端先校验并还原补丁，再使用原有历史和快照合并逻辑。缺少基线或版本不连续时不推进游标，重新同步；重连保留已加载历史，快照未覆盖的旧任务缓存标记为待核对。
- Web 保留已完成消息显示对象，避免破坏 `v-memo`；每个 Markdown 渲染器使用独立、固定配置的净化器，每段 HTML 仍经过相同净化规则。Bot 直接渲染服务端已合并的文本，普通聊天默认 80 ms 节流保持不变。
- Android 根据实际布局的末尾锚点跟随，修复长回复和异步排版后停在消息开头的问题；用户拖动上翻后停止跟随。

## 协议协商与回退

新能力为 `workspace-message-patch-v1`，新客户端使用 `/api/app/events/stream?format=patch-v1`。没有能力时继续使用原协议。

新协议默认启用。设置 `HERMES_YAOYAO_WORKSPACE_MESSAGE_PATCHES=0` 并重启该兼容版本后端，可关闭补丁写入和协商，恢复全量传输及 100 ms 消息节奏。旧客户端实时接收按约 100 ms 有序合并的全量消息；遇到补丁历史重放时通过已有 `reset` 重新取得完整快照。非文本和终态前先冲刷待发文本。

事件日志已有新格式，因此回退应使用这个开关并保留本版日志兼容代码，不能直接用不认识补丁日志的旧后端替换。没有数据库结构迁移，也没有放松 CSRF、账号或文件权限检查。

## 实测结果

相同 160 ms 人工往返延迟（80 ms 上行、80 ms 下行；SSE 增加 80 ms 下行），假上游首段等待 250 ms、每 20 ms 产生一片文本。各端先采集自身基线，再测优化版；短回复每组 6 次，第一轮单列，后 5 次取中位数；每端另测一条 8,000 字符长回复。主性能样本共 42 次发送，额外阅读位置测试不计入这 42 次。

| 端 | 发送恢复：改前 → 改后 | 优化后确认额外等待 | 文本更新：改前 → 改后 |
| --- | ---: | ---: | ---: |
| iOS | 675.09 → 173.66 ms | 0.62 ms | 101.97 → 33.90 ms |
| Android | 519 → 178 ms | 8 ms | 100 → 36 ms |
| Web | 595 → 171 ms | 13 ms | DOM 185 → 34 ms |

Web 内部状态更新为 98 → 33 ms。表中 Web 改用真实 DOM 文本变化，而非仅凭状态更新判断显示速度：初次优化曾出现“状态 34 ms、DOM 67 ms”，去掉 Bot 的二次节流后才达到 DOM 34 ms。

iOS 使用 iPhone 17 Pro / iOS 26.5 模拟器、Xcode 26.6，优化构建保留测试入口和时间探针。Android 使用专用 Pixel 5 / API 31 模拟器，实际 WorkspaceScreen、控制器、网络层和 Compose 界面，校准模拟器与主机时钟。Web 使用 Chromium、实际生产构建和 DOM 观察器。iOS/Android 更新点为原生界面观察/组合到新文本；这些值不是物理屏幕 FPS。每端只与自己的基线比较。

首段进入界面的中位数为：iOS 435.48 → 468.39 ms（增加 32.91 ms，未超过约定的 33 ms）；Android 439 → 442 ms；Web 471 → 434 ms。首段总时间包含夹具适配器、服务端与 UI 调度，不能解释为真实模型生成速度变化。

### 五路并发与完整 SSE 流量

| 指标 | 全量协议 | 补丁协议 |
| --- | ---: | ---: |
| 并发 Bot / 每 Bot 正文 | 5 / 8,000 字符 | 5 / 8,000 字符 |
| 完整 SSE 字节（含状态、摘要、终态） | 2,778,172 | 497,075 |
| 持久化与事件编码 P95 | 3.91 ms | 1.43 ms |
| CPU 总耗时 | 432.96 ms | 568.73 ms |
| 事件日志有效载荷新增 | 2,719,888 字节 | 403,065 字节 |
| WAL 文件观测大小 | 4,190,072 字节 | 4,165,352 字节 |

完整 SSE 减少 **82.1%**，并发写入/编码 P95 低于 10 ms。CPU 总耗时增加约 **31.4%**，是更密集更新的代价；约 4.3 秒窗口消耗 0.57 核秒。WAL 数字是观测文件大小，受 checkpoint/文件复用影响，不等于总写入量。五条回复均按完整文本与持久化记录逐字核对。

## 正确性与界面验收

覆盖：回执/SSE 乱序、旧回执和同游标解码缓存隔离、重复事件、新草稿保护、CSRF 预热与原请求 ID 重试、补丁断层和任务隔离、事务回滚、重启后补丁读取、旧协议 reset、关闭补丁后的兼容、Unicode、终态/工具/附件变化、暂停后的尾刷、历史保留和隐藏消息。

- iOS：58 项 WorkspaceChatTests 通过；7 次基线及 7 次优化原生 UI 发送，优化回复完整文本核对通过。签名模拟器验证，避免未签名 Keychain -34018。
- Android：54 项模型测试、43 项网络测试通过，App 和测试 APK 编译通过；7 次基线及 7 次优化原生发送逐字核对。长回复末尾可见；上翻后接收另一条消息保持阅读位置，手动回到底部通过。
- Web：7 次基线及 7 次优化 UI 发送逐字核对；上翻后触发 snapshot reset、接收新回复，滚动位置保持（误差不超过 4 px）。Markdown 净化、普通聊天默认节流和按钮行为回归通过。
- 服务端：补丁与全量路径均验证，事务失败前不会通知观察者；默认启用后的针对性完整回归和 TypeScript 检查通过。Web/服务端最终 193 项针对性测试通过，TypeScript 检查通过。

测试脚本使用每次唯一的回复标记，防止重跑时历史消息误判成功。Android 最初的启动挂起由继承代理环境引起，移除子进程的代理变量后正常启动；只改了测试进程环境。

没有验证真机、真实模型或真实公网条件。本次未运行模型、Worker 启动或普通聊天业务改造；共享组件的默认行为和安全规则保持兼容。

## 证据与复现

- [逐轮数据与汇总](results/measurements.json)、[五路并发结果](results/server-performance.json)、[测量窗口网络记录](results/network.jsonl)
- [iOS 长回复](optimized-ios-long-1.png)、[Android 长回复](optimized-android-long.png)、[Android 阅读位置](optimized-android-reading.png)、[Web 长回复](optimized-web-long.png)、[Web 阅读位置](optimized-web-reading.png)
- [复现步骤](RUNBOOK.md)、[离线分析脚本](scripts/analyze.mjs)

完整结果包保留于 `/tmp/bot-latency-acceptance/evidence/ios-final.xcresult`，iOS 最后单元测试包为 `/tmp/bot-latency-ios-cursor-final.xcresult`。临时构建目录可能被系统清理；本目录 JSON、截图、脚本及日志随 Git 保留。被修正或失败的中间测量不计入最终样本。
