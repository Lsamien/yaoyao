# 聊天错误提示统一设计

iOS 原生 Bot 时间线与桌面两套聊天时间线使用相同的展示规则：

- 默认显示中性色的信息图标、中文状态（响应超时／回复暂时中断）和详情入口，最小点击高度 44。
- 原始错误仅在展开后显示，可选择复制；提供稍后重试或切换模型的建议。
- 纯错误正文收进详情；正常的部分回复、用户消息和附件保留。
- 仅合并紧邻且错误相同的 assistant → system 失败提示；优先匹配 runId，旧记录无 runId 时仅合并两秒内的重复。
- 只改变展示，保留存储中的完整消息。模型服务的超时原因未改变。

## 验证

- Web：`npm run typecheck` 通过；messageFailure、toolTimeline、workspaceTimelineIdentity、workspacePresentation、chatLifecycle 共 39 项测试通过。
- iOS：Debug Simulator 编译通过；WorkspaceFailurePresentationTests 2 项通过；已有附件／音频并发等编译警告仍在。
- 浏览器人工检查：桌面浅色、375px 暗色、横屏；默认折叠与展开／收起正常，长文本换行无横向溢出。
- iOS Simulator 人工检查：浅色折叠与展开、暗色、最大辅助功能字号。错误标题可换行，详情入口可用。

Web 预览：运行 Vite 后访问 `/tests/fixtures/message-failure/index.html`，可加 `?mobile&dark`。
iOS 预览：Debug 启动参数 `-ui-testing-scenario workspace-failure`，暗色另加 `-ui-testing-color-scheme dark`。

附图为独立测试数据，不连接真实模型服务。`ios-collapsed.jpg`、`ios-expanded.jpg`、`ios-dark.jpg`。
