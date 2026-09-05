# 子账号权限

子账号（`role=user`）只能使用 Bot 模式。管理员在「设置 → 用户与权限」创建账号时分配当前服务的基础 Profile，也可以随后修改分配。子账号只能基于这些 Profile 创建自己的 Bot Agent；不能读取原生 Profile、聊天和历史，不能使用原生 Hermes Bot、看板、节点配对或全局设置。

## 服务端边界

- `assignedProfiles` 保存在本地账号记录中。旧账号没有该字段时视为未分配，不自动授权 default 或全部 Profile。
- 创建 Agent 只接受当前账号获分配的本机 Profile；远程引用和节点管理仅管理员可用。Agent 修改不能更换来源。
- 账号 ID 从登录会话取得。Agent、聊天、任务、运行、交互、文件和事件继续按 owner 隔离，管理员也不会通过自己的 Bot 列表读取子账号会话。
- 创建群、加入成员、发送消息、启动/恢复执行、建立上游会话、提交 prompt 和审批答复都会校验来源权限。异步读取基础目录之后再次校验，避免撤权竞态。
- 修改分配、重置密码、禁用或删除账号会让旧会话失效，并请求停止该账号已存在的运行。撤销后的 Agent 配置和本人历史保留，但不能继续调用、编辑或加入新群。上游已经执行完成的工具副作用无法撤销。
- 子账号采用允许列表访问应用接口；原生 REST、HTTP/SSE 实时接口、原生 Bot 中继、全局语音密钥、原生媒体路径（`/Users/...`、`/attachments/...`）均拒绝。自己的附件使用 owner 隔离的 `/api/app/files/:id/...`。
- Web 在渲染路由前强制进入 `/conversations`。iOS 按当前服务身份强制 Bot 模式；服务器仍是最终权限边界，旧客户端也无法绕过。

本实现是 Web/iOS 账号与服务 API 的授权隔离，不创建 Hermes 工具执行的操作系统沙箱。分配的 Profile 仍按 Hermes 自身的工具权限运行，工具可访问的磁盘和外部服务范围需要在 Hermes 执行环境中约束。

## 验证

- `tests/server/subaccountPermissions.test.ts` 使用真实账号、Cookie 和 CSRF，覆盖默认拒绝、Profile/节点伪造、REST/实时/媒体/密钥入口、跨 owner 资源和撤权。
- `tests/e2e/workspace-chat.spec.ts` 的 subaccount 用例验证管理员分配、首次改密、限制后的创建列表、隐藏模式菜单和手输旧路由重定向。
- iOS `WorkspaceChatTests` 和 `AuthAndRESTTests` 覆盖服务权限解析、能力撤回和保留的原生模式设置被纠正。
