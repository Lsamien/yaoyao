# Inspector 最新记录优先验收

日期：2026-09-13。

Events / Raw 都按时间从新到旧展示。先按时间合并连续且同 Agent / run 的流式片段，再反转记录组；组内正文和原始数据仍按时间正序，组时间取最后一个片段。相同时间以返回顺序作为先后顺序。

打开面板、切换视图回到顶部。位于顶部时持续显示新记录，即使记录总数已达到上限；向下查看旧记录时不强制跳回顶部。

验证通过：

- `npm run typecheck`、`npm run build`。
- Vitest：Inspector、电脑选项及服务端权限相关 21 项测试。
- Playwright：`playwright.bot-panels.config.ts` 的 `inspector latest` 用例；包含乱序响应、桌面视图、375px 深色手机视图、切换视图和固定数量刷新。
- Web 和 macOS 桌面壳使用同一 Vue 组件；本次未重新打包桌面安装器。

截图：[桌面 Raw](inspector-desktop.png)、[手机 Events](inspector-phone.png)。
