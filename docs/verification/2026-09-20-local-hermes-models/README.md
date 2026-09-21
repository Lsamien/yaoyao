# 本地 Hermes 服务模式与 Bot 多模型实测

2026-09-20，在本机已安装的夭夭 macOS App 中切换到服务器模式，进入 Bot 模式，使用第二个基础 Hermes「运维 / server」对应的现有「瑶儿」单聊。整个测试使用同一条对话，未新建替代 Bot，未使用假模型回复。

## 启动准备

- 原有 `com.samien.hermes-yaoyao` LaunchAgent 处于 disabled，导致 App 同步时出现 `launchctl bootstrap 未完成`。启用该既有服务后通过 App 重试成功。
- 本地 Web 运行于 15300，Hermes Dashboard 运行于回环地址 9119；桌面启动偏好为本地服务器。
- App 将原有 Web 0.4.25 同步至 0.4.49，按内置流程备份数据。
- default、server 的既有工具桥从 1.2.3 更新至 1.3.0。安装器保留了原配置与插件备份。更新发生在 Dashboard 启动前。

## 发现并修复的问题

保存 `custom:tingly / GLM-5.3` 后，Bot 能回复，`config.set` 也确认了 GLM，但真正的 `session.info` 和 `message.complete.usage.model` 仍为 `GPT-5.6-terra`。

Hermes 的冷恢复先返回会话，再异步初始化 Agent。显式 Provider 的模型设置可以在 Agent 未构建时返回成功，但随后工具桥绑定触发构建，恢复的旧运行配置覆盖了这些设置。仅检查设置回执不足以证明本轮使用了目标模型。

修复将 Bot 模型、思考等级和速度的应用移到工具桥绑定、工作目录准备之后，仍在 `prompt.submit` 之前。此时不再使用初始化前的 `opened.info` 跳过模型应用。未确认、失败或需要费用确认的配置仍不提交聊天请求。

新增回归用例模拟这个真实边界，验证初次会话、已有会话切换 Provider、恢复继承时，提交请求所用的实际模型、思考等级、速度。修复前该用例失败，修复后通过。

## 真实模型结果

测试口令为「青竹4729」，所有正常回复都来自同一条单聊。通过 Inspector 的实际会话 Provider、模型和完成事件的模型字段核对，未依赖模型自报身份。

| 场景 | 实际模型 / Provider | 结果 |
| --- | --- | --- |
| 默认继承 | GPT-5.6-terra / custom:tingly | 正常返回「收到，青竹4729。」 |
| 修复前选 GLM | 实际仍为 GPT-5.6-terra | 复现模型选择被冷恢复覆盖，不能算 GLM 通过 |
| 修复后选 GLM | GLM-5.3 / custom:tingly | 4.36 秒完成，返回「青竹4729；42」，上下文保留 |
| 切换 omni | omni / custom:tingly | 路由生效，上游 HTTP 429，`RequestBurstTooFast`；88.74 秒时主动停止重试，未获得正常回复 |
| 跨 Provider 切换 | deepseek-v4-flash-free / opencode-free | 路由生效，21.05 秒后上游 HTTP 400：`Model is unavailable`；界面正确展示失败 |
| 恢复继承并续聊 | GPT-5.6-terra / custom:tingly | 5.58 秒完成，返回「可以继续聊天，青竹4729。」 |

脱敏后的设置回执、实际模型、回复与运行状态见 [runs.jsonl](runs.jsonl)。omni 的限流原因来自 Hermes server Profile 的错误日志；中断后的运行记录只保留「已停止」，因此不将它标记为聊天通过。

## 校验与最终状态

- `npm run typecheck`、`npm run desktop:build`、`git diff --check` 通过。
- `botModelSettings`、`workspace`、`workspaceRemoteAgents`、`workspaceTeamTools` 共 139 项通过、2 项失败。失败为原有两个上下文统计断言；临时恢复修改前的 `workspaceRuntime.ts` 后，单独复跑仍出现相同失败。
- 修复已通过内置本机服务同步流程部署到 15300；没有发布远端版本。
- Bot 模型、思考等级、速度均恢复为继承；有效值为 `custom:tingly / GPT-5.6-terra / medium / normal`。
- 两个 Hermes Profile 的 model 配置和 agent 默认配置与工具桥安装前备份一致；其他 Bot 的模型选择未修改。
- App 保留本地服务器模式和 Bot 对话页，后台服务继续运行。

本次验证范围为文本聊天、同会话模型切换、上下文连续性和上游错误后的恢复；没有将上游限流或下架的模型报告为成功。
