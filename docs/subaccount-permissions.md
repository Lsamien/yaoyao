# 子账号权限

子账号（`role=user`）只能使用 Bot 模式。管理员在「设置 → 用户与权限」创建账号时分配当前服务的基础 Profile，也可以随后修改分配。子账号只能基于这些 Profile 创建自己的 Bot Agent；不能读取原生 Profile、聊天和历史，不能使用原生 Hermes Bot、看板、节点配对或全局设置。

## 服务端边界

- `assignedProfiles` 保存在本地账号记录中。旧账号没有该字段时视为未分配，不自动授权 default 或全部 Profile。
- 创建 Agent 只接受当前账号获分配的本机 Profile；远程引用和节点管理仅管理员可用。Agent 修改不能更换来源。
- 账号 ID 从登录会话取得。Agent、聊天、任务、运行、交互、文件和事件继续按 owner 隔离，管理员也不会通过自己的 Bot 列表读取子账号会话。
- 创建群、加入成员、发送消息、启动/恢复执行、建立上游会话、提交 prompt 和审批答复都会校验来源权限。异步读取基础目录之后再次校验，避免撤权竞态。
- 修改分配、重置密码、禁用或删除账号会让旧会话失效，并请求停止该账号已存在的运行。撤销后的 Agent 配置和本人历史保留，但不能继续调用、编辑或加入新群。上游已经执行完成的工具副作用无法撤销。
- 子账号采用允许列表访问应用接口；Bot 初始化快照，以及项目、记忆、协作接口按方法和路径放行，内部继续检查 owner 和来源分配。原生 REST、HTTP/SSE 实时接口、原生 Bot 中继、全局语音密钥、原生媒体路径（`/Users/...`、`/attachments/...`）均拒绝。自己的附件使用 owner 隔离的 `/api/app/files/:id/...`。
- Web 等待路由初始化后检查账号模式，保留合法的 Bot 会话深链接。四端子账号均使用 Bot 模式；服务器仍是最终权限边界，旧客户端也无法绕过。能力声明不向子账号提供全局语音、原生上下文和节点入口。

## 注册与开通

- Web、macOS 独立启动页、iOS、Android 的登录界面提供“没有账号？注册子账号”。注册仅作用于当前连接的服务器；成功后不登录、不创建 Bot。
- 匿名 `GET /api/app/bootstrap` 提供 CSRF 和 `registrationAvailable`。管理员尚未初始化时为 false；旧服务器未提供标记时，新客户端提示不支持注册。
- `POST /api/app/register` 仅接收 `username`、`password`，沿用用户名规则和至少 8 位密码要求。创建 `role=user`、`enabled=false`、`assignedProfiles=[]`、`mustChangePassword=false`、`registrationStatus=pending`，返回 201，不签发业务会话。
- 注册复用 Origin/Cookie/CSRF 校验，额外按直连 IP 限制每 15 分钟 10 次请求，超限返回 429 和 `Retry-After`。不信任转发 IP 请求头；多用户共享反向代理出口时共享该限额。
- 正确密码登录待开通账号返回 403 / `account_pending_approval`，错误密码仍为原有 401。兼容登录入口同样生效。
- 管理员在现有“用户与权限”中选择基础机器人并点击“分配并开通”。`POST /api/app/admin/users/:userID/approve` 接收 `assignedProfiles`，核对实时本机 Profile 目录，要求至少一个可用来源，在同次保存中写入分配、已开通、启用状态。
- 普通启用接口不能开通 pending 账号。管理员原有创建、分配、启停、重置密码、删除操作继续保留。旧账号缺失 `registrationStatus` 时按 approved 处理，不改变其启用状态、密码、分配或首次改密要求。
- 先更新服务端，再更新客户端。旧客户端保持现有登录协议，管理员开通后即可登录；原有账号不会获得默认机器人分配。

本实现是 Web/iOS 账号与服务 API 的授权隔离，不创建 Hermes 工具执行的操作系统沙箱。分配的 Profile 仍按 Hermes 自身的工具权限运行，工具可访问的磁盘和外部服务范围需要在 Hermes 执行环境中约束。

## 验证

- `tests/server/subaccountPermissions.test.ts` 使用真实账号、Cookie 和 CSRF，覆盖默认拒绝、Profile/节点伪造、REST/实时/媒体/密钥入口、跨 owner 资源和撤权。
- `tests/e2e/workspace-chat.spec.ts` 的 subaccount 用例验证管理员分配、首次改密、限制后的创建列表、隐藏模式菜单和手输旧路由重定向。
- iOS `WorkspaceChatTests` 和 `AuthAndRESTTests` 覆盖服务权限解析、能力撤回和保留的原生模式设置被纠正。
- `tests/server/subaccountRegistration.test.ts` 通过完整应用中间件覆盖注册、审核、知识与附件隔离、SSE 鉴权和禁用后的旧连接关闭；不替换认证。
- 四端具体结果和未完成的真实环境验收见 [2026-09-21 验证记录](verification/2026-09-21-subaccount-bot.md)。
