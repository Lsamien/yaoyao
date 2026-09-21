# 服务端 Bot 与消息设备上下文修整

基于 `feature/remote-desktop-hosts`，修改前提交为 `391d01f`。

## 统一行为

- 所有 Bot 的聊天与记忆整理使用服务端 Hermes；旧 Worker 会话迁移一次后继续复用服务端会话。VM 只执行按需调用的工具。
- 服务器、电脑、Grok Bot 云电脑与 VM 使用同一套全局开放设置；审批策略也统一管理，旧 Bot 的单独配置不覆盖全局权限。
- “本机”由本条消息的 `deviceHost` 决定，保存到运行快照。设备未知、离线、关闭或名称有歧义时明确报错；不会切到服务器或旧绑定机器执行。
- Bot 协作、团队启动、子任务及回传保留来源。用户换设备后新建或重试的子任务使用该次指令的来源，来源缺失会清空语义，不沿用旧目标的设备。
- 定时任务单独保存“本机”目标。文件与命令授权独立于屏幕授权。接管面板在选定设备后获取控制权，切换设备时先交还原设备。
- App 明确区分客户端和服务器角色，默认选择客户端；客户端无需安装 Hermes。

账号边界、设备系统授权、任务助手生命周期、人工接管和离线检查继续生效。权限一致不表示跳过这些实际可用性条件。

## 自动验证

环境：macOS，Node `v26.7.0`。该 Node 的原生 Web Storage 会影响 jsdom 测试，所以 Vitest 使用 `NODE_OPTIONS=--no-experimental-webstorage`。

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过；保留原有大包体积提示 |
| `npm run typecheck` | 通过 |
| `npm run desktop:test` | 37 / 37 通过 |
| `npx playwright test -c playwright.desktop-hosts.config.ts` | 2 / 2 通过；已查看电脑权限面板截图 |
| 全量 `npm test -- --maxWorkers=4` | 1318 通过、14 失败、26 跳过 |

全量剩余 14 项失败均在修改前提交的独立临时目录复现，未通过跳过或放宽断言来掩盖：

- `botProfileDialog.test.ts`：旧身份草稿测试仍把新增描述栏当作规则栏（1 项）。
- `workspaceShell.test.ts`：旧列表标题预期（1 项）。
- `hostComputerTools.test.ts`、`workerCompaction.test.ts`：旧 Worker 工具错误形式和上下文压缩行为（6 项）。
- `workspace.test.ts`：上下文用量记录缺失（2 项）。
- `workspacePairedNodes.test.ts`、`workspaceRoutes.test.ts`：已停用的旧远程 Bot / 子节点行为（4 项）。

本次针对设备解析、同权策略、独立授权、并发来源、任务转交、定时任务保存、VM 会话迁移和接管界面的新增/更新测试均通过。另一次并发全量运行中出现的 HTTP 连接重置已单独复测通过，最后一轮全量也通过该用例。

## 实机验证边界

自动测试使用模拟服务器、模拟主机和桌面测试环境。尚未连接真实的多台 Mac、Grok Bot 云电脑及 VM 联合执行任务。发布前可用两台已配对 Mac 在同一聊天交替发送“读取本机文件”，核对目标；再断开原来源设备，确认不会回退到服务器。
