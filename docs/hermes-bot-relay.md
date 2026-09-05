# Hermes Bot 原生转接

Hermes Bot 使用 Hermes Desktop 的 Profile、机器人和群聊数据；与 Web 自建的 Bot 模式分开。手机不创建 Profile 或群聊，也不复制群聊到子节点。

- 本地路径：手机 → 主服务器 15300 → 本机 Hermes Gateway。
- 远程路径：手机 → 主服务器 15300 → 已配对的子节点 15300 → 子节点 Hermes Gateway。
- `GET /api/app/hermes-bot/roster` 返回当前账号已配对子节点的原生名单及各节点错误。
- `/api/app/hermes-bot/nodes/:id/api/...` 转接名单、历史、附件和 HTTP/SSE 聊天。主账号拥有节点记录；子节点凭据只保存在服务端。保留命令幂等键、事件游标；禁止跟随重定向。
- 搜索类型为“机器人和群聊 / 仅机器人 / 仅群聊”，另有显示隐藏机器人的开关；置顶和隐藏保留原生语义。
- 群聊支持新帖子、讨论串切换、回复、分享。未发送的新帖子没有记录；选择按账号和群聊保存。成员配置只读，仅解析已确认的连接身份。
- 同步只更新主节点已有群聊的消息及讨论串，保留名称、成员、头像等原生配置。不存在或已删除的群聊拒绝写入；不会通过裁剪清除其他群聊配置。

旧版仅保存在手机上的子节点需在主服务器重新扫码授权。保留旧记录，不上传手机中的长期凭据。已经添加到主服务器的扫码节点可直接使用；子节点需支持现有配对及 HTTP/SSE 协议。

验证：`hermesBotRelay.test.ts`、`workspacePairedNodes.test.ts`、`workspaceRemoteAgents.test.ts`、`workspaceRoutes.test.ts`；iOS 的 Bots、BotGroupRuntime、BotGatewayConnectionPool、WorkspaceChat 测试及原生名单、新帖子、只读成员界面测试。远程协议使用受控子节点夹具验证，未以用户真实远程机器人发送消息。

## 已有原生会话的恢复授权

本地机器人使用 `/api/app/hermes-bot/local/api/...`；远程单聊使用 `/api/app/hermes-bot/nodes/:id/native/api/...`，主服务转到子节点 `/node/:device/api/hermes-bot/api/...`。普通节点请求继续走原路径，保持群聊工作会话的授权语义。

原生通道拥有独立身份。恢复前由服务端通过原生 `profiles.list` 读取 Profile 的 `ui_meta.hermes-bots.chat`，只允许恢复该绑定会话。REST `/api/profiles` 不包含这份元数据，不能用于这一授权判断。普通聊天的原生历史仍然只读；原生通道不会把旧聊天导入普通 Web 聊天的所有权记录。
