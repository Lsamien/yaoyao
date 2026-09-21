# Profile 模型与工具桥验证

2026-09-19，使用 Hermes `e6f5ce2` 的临时源码副本、临时 Profile 目录和本地确定性模型接口。实际 Hermes 安装、模型密钥、记忆和聊天数据均未修改，也没有调用外部付费模型。

| 场景 | yaoer 配置 | 创建/恢复返回模型 | 实际请求模型 |
| --- | --- | --- | --- |
| 原版，无启动模型参数 | grok-4.6 | fixture-default（错误读取默认 Profile） | grok-4.6 |
| 原版，启动参数为 gpt-5.6-terra | grok-4.6 | gpt-5.6-terra | gpt-5.6-terra（覆盖配置） |
| 修复后，启动参数为 gpt-5.6-terra | grok-4.6 | grok-4.6 | grok-4.6 |

默认 Profile 另行配置 `fixture-default`，修复后仍使用自己的模型。工具桥绑定和聊天完成事件均成功，命名 Profile 的绑定耗时约 0.2 秒。这证明了复现环境中的模型路由修复；生产服务器的 30 秒超时尚未在本地复现，不能据此宣称线上聊天已经恢复。

复现命令（从 Yaoyao 仓库执行）：

```sh
~/.hermes/hermes-agent/venv/bin/python docs/verification/2026-09-19-profile-routing/verify.py --baseline --no-env-seed
~/.hermes/hermes-agent/venv/bin/python docs/verification/2026-09-19-profile-routing/verify.py --baseline
~/.hermes/hermes-agent/venv/bin/python docs/verification/2026-09-19-profile-routing/verify.py
~/.hermes/hermes-agent/venv/bin/python docs/verification/2026-09-19-profile-routing/verify.py --no-env-seed
```

可用 `--source` 指定其他 Hermes 源码安装。脚本会保留临时验证目录并打印位置，子进程在退出时结束。原版模式预期断言旧行为，修复模式预期断言 Profile 配置得到使用。

自动回归覆盖模型和 Provider 优先级、空配置回退、Profile 上下文恢复、源码修复幂等性和不兼容拒绝、安装备份及失败回滚、延迟会话初始化、绑定锁争用、工具目录回调超时和错误信息脱敏。TypeScript 测试还覆盖管理员安装入口及错误到聊天状态的转换。

安装与回退步骤见[工具桥文档](../../../integrations/hermes-bots-bridge/README.md)。安装器需要在 Hermes 所在服务器执行，并重启 Hermes Dashboard 后生效；客户端无需安装 Hermes。
