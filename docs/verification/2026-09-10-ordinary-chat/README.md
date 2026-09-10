# 普通聊天 Web 完整存储与 SSE 验收

日期：2026-09-10。只修改源码与本地测试；没有更新正在使用的 Web 服务或手机。

## 行为

- 普通聊天列表、详情、正文分页、置顶和未读从 Web SQLite 读取。完整数据读取不访问 Hermes；缺失区间返回 `CHAT_HISTORY_SYNC_PENDING`，已存内容不等待补齐。
- 实时事件与消息更新在同一 SQLite 事务中保存，然后继续 SSE 推送。相同文本的不同事件不会被误去重；SSE 与正文使用同一消息 ID，支持身份提升与运行会话别名迁移。
- 用户消息带稳定提交身份；发送确认和失败独立保存。Web 的标题、置顶和已读位置不被上游历史覆盖。
- 旧历史和缺口交给持久化补齐队列，最多两个并发任务，失败退避重试。校验修订号，保留未确认提交与窗口外的旧历史；服务重启后继续未完成任务。
- 完整历史补齐由 POST `/api/app/sessions/:id/sync` 提交，返回 202。完成后推送 `sessions.changed` / `reason: cache.synced`。原生历史通过显式 `view=history` 或原生入口保留原读取路径。
- `/healthz` 的 `chatCache.reads` 提供本地读取和补齐统计，不包含凭据或消息内容。

## 验证

- `npm run build` 成功（既有前端 chunk 大小提示仍存在）。
- `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/server tests/client --maxWorkers=2`：122 个文件、871 项通过。设置 Node 参数让 jsdom 提供浏览器存储；不改产品配置。
- Chromium `tests/e2e/ordinary-local.spec.ts`：1 项通过。通过真实 Web 服务和假 Hermes 测试后端完成发送、SSE 展示、Web 本地正文读取、页面刷新，并检查用户消息和助手回复各一条。截图见 [browser.png](browser.png)。
- E2E 清除当前进程继承的代理变量，测试只访问回环地址 18801/19119；没有修改系统代理。测试后端为 fixture，不代表真实模型首 token 或设备网络延迟。
- 全量测试中曾有一次 `pushRoutes` 发生 ECONNRESET；最终限制两个测试 worker 后完整通过。

## 本机性能基准

运行 `npx tsx docs/verification/2026-09-10-ordinary-chat/benchmark.ts`。结果见 [benchmark.json](benchmark.json)。

- 1,000 个已登记会话，200 次首屏读取：P95 约 1.99 ms。
- 500 次短文本事件落盘：P95 约 0.23 ms。
- 本轮读取未启动后台补齐。

这是本机 SQLite 微基准，不包含模型生成、网络、真机渲染，不能据此宣称端到端延迟。每个事件当前直接事务保存，没有新增轮询等待。

## 交付边界

没有部署、发布版本、构建分发 IPA 或安装真机。旧库采用增量表结构迁移；普通聊天模式之外的执行模式不迁移成 Web 聊天。附件仍使用现有下载和缓存机制。
