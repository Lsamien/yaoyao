# Bot 输入动画与电脑状态提示修复验证

在本地服务 `http://127.0.0.1:15300` 的既有「瑶儿」单聊验证，基础 Hermes 为 `server`。

## 原因与修复

- 9 月 3 日的一条历史消息和所属运行均已完成，但匿名工具事件残留 `tool.generating`。页面扫描全部历史工具，将这条旧记录当成仍在输出，导致最新回复完成后一直显示「机器人正在输入」。现在以消息终态为准；旧工具在展示时收束状态，真实失败的工具结果仍显示失败，不改写原始聊天记录。
- 本机记录的「本机虚拟机」Runner 已停用。原代码将节点不存在、停用、未连接以及能力不支持统一报告为需要更新 Runner。现在区分未启用、离线和能力不兼容；虚拟机问题显示在虚拟机区域。服务器画面和权限状态继续独立显示。未启用或升级虚拟机 Runner。

## 验证

- 相关 7 个测试文件、76 项全部通过：workspaceTranscript、workspacePresentation、typingIndicator、computerTargetSelection、localVmImages、runner、localVmRoutes。
- `npm run typecheck`、`npm run desktop:build`、`git diff --check` 通过。
- 本机服务经内置备份与升级流程更新到 0.4.50、构建 528；构建摘要为 `b28bae519cd3be71135f74528c25cfc29ff441af41f7a5980646682acbf61ed7`。
- 更新前浏览器 DOM 有 1 个输入指示器；刷新加载修复后为 0，旧工具记录保留。
- 同一对话真实调用 GPT-5.6-terra：5.70 秒返回「验证G：42」，完成后指示器为 0。
- 切换 GLM-5.3：3.85 秒返回「青竹4729；64」，保留上下文，完成后指示器为 0。
- 实际模型由 `session.info` 和 `message.complete.usage.model` 双重核对，脱敏记录见 [runs.jsonl](runs.jsonl)。
- 服务器预览正常；预览下方没有全局错误提示，虚拟机区域准确显示「本地虚拟机执行节点尚未启用，请在本地虚拟机设置中完成配置」。
- Bot 的 Provider、模型、思考等级、速度均恢复继承，未结束的运行数为 0。本地服务继续运行。

之前跨 Provider 测试的 `Model is unavailable` 是上游错误，历史失败记录仍保留。本次没有将该模型报告为已恢复。
