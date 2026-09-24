# Hermes 执行节点

Runner 在运行 Hermes 的电脑上主动连接夭夭服务。用于 Web 位于 Docker、另一台电脑或远程服务器时，将 Bot 会话和本轮组队工具交给 Hermes 所在电脑执行。Runner 源码、构建入口和管理页面均位于 hermes-yaoyao。

普通执行方式继续使用原有 Hermes。配置电脑 Worker 后，Agent 可选择隔离电脑执行，模型工具不会退回宿主。公网代理、屏幕接管和共享环境均已接入，使用流程见 `docs/local-vm.md`。Docker 部署与程序包下载见 `docs/docker-install.md`。

网页任务可独立启用 Runner 托管 Chromium，无需启动完整 VM，配置、接管与文件互通见 [托管浏览器](managed-browser.md)。节点默认启用环境检测；全局 Bot 工具开关仍默认关闭，首次授权使用时才安装缺失浏览器，保留现有电脑工具路径。显式 `browser.enabled:false` 会保持关闭。

## 启用

1. 管理员打开设置 → Hermes 连接 → 执行节点。
2. 选择接管的 Bot 来源、允许的 Profile、能从执行电脑访问的夭夭地址，以及 Runner 本机 Hermes 的回环地址。
3. 注册后下载 `runner.json`。节点凭据只在注册响应中返回；列表和刷新不会返回凭据。
4. 将配置放到执行电脑，执行 `chmod 600 /完整路径/runner.json`。
5. 在项目目录执行 `npm run build`，然后执行 `npm run runner -- --config /完整路径/runner.json`。

也可执行 `npm run runner:build`，将整个 `.runner-build/` 目录复制到执行电脑，以 Node.js 24 或更高版本运行。不要只复制单个 `runner.mjs`，虚拟桌面还需要同目录的 Worker 和桌面资源：

```sh
node runner.mjs --config /完整路径/runner.json
```

macOS App 可直接通过菜单栏“执行节点 → 导入节点配置…”导入下载的配置，无需另外安装 Node.js。App 使用系统钥匙串支持的加密存储保存配置，通过私有进程消息传入内置 Runner；凭据不进入命令行或子进程环境变量。随后每次打开 App 都会自动启动已配置的 Runner。关闭窗口保持连接，退出 App 时清理自己管理的 Runner；“断开并忘记配置”移除本机保存的配置。原始下载文件仍由用户管理。

配置文件至少包括以下字段。`token` 由注册操作生成，不需要填写模型密钥。

```json
{
  "protocol": 1,
  "serverURL": "https://yaoyao.example.com",
  "runnerId": "注册响应中的节点 UUID",
  "token": "注册后下载的节点凭据",
  "hermesURL": "http://127.0.0.1:9119",
  "allowedProfiles": ["default"],
  "artifactRoots": []
}
```

若 Hermes 启用了账号鉴权，可在本机私有配置添加 `hermesCredentials` 对象，包含 `username` 和 `password`；它们留在执行电脑，控制面不接收 Hermes 密码。回环授权则由现有 UpstreamServiceSession 自动协商。远程明文 HTTP 必须明确设置 `allowInsecureLan: true`。

每个来源同时只允许一个启用的 Runner。已有配对 Web 来源应在目的 Web 服务内注册自己的 Runner。停用会立即关闭控制面的工具授权，执行电脑在连接恢复或轮询时收到拒绝。配置丢失时停用并重新注册；旧配置不能恢复已撤销的节点。

## 协议与执行边界

- 浏览器管理接口使用原有管理员登录和 CSRF。机器接口使用独立 Bearer 凭据、Runner 实例 UUID、协议版本与连接代次；拒绝带 Origin 的请求。
- Runner 以 HTTP 长轮询领取有期限的命令，通过独立请求提交结果、会话事件和工具调用。慢操作不会阻塞后续关闭命令。
- 控制面重启、Runner 更换、断线重连都会更换连接代次；旧结果、旧实例和旧工具授权不能接管新执行。
- 命令执行前再次向控制面核对授权和期限。账号权限变化会使旧轮次失效。一个会话被撤权只关闭自己的通道和工具。
- 本机 SQLite 保存命令指纹和执行回执。重复命令复用回执；未完成的历史命令视为结果不确定，禁止自动重放。大响应一小时后压缩为禁止重放的记录。
- 组队工具只在 Hermes 本机建立回环租约，远端不开放原有回环接口。模型获得的是当轮不透明工具 ID；账号、来源、会话和调用身份由服务端绑定。
- Gateway RPC 使用固定允许列表；会话操作必须属于自己的通道。HTTP 仅允许必要的只读查询。文件导出要求真实路径位于 `artifactRoots`，留空拒绝导出。
- 单个只读结果目前最多 8 MiB；大型产物的分块传输仍待实现。待传命令有数量和总字节限制。
- 断线后的在途操作可能结果不确定。系统沿用原会话核对，不在另一个节点重放原任务。已完成会话切换节点后带入近期文字记录；历史附件路径需要重新核实。
- 托管浏览器通过节点能力协商使用会话保留协议。普通 Bot 的持久上下文在正常任务结束或无任务的人工交还后暂停联网，下一轮使用或接管取得新授权后恢复；独立会话授权只保留资源，不继续授予已结束任务的操作权限。默认空闲回收为 30 分钟，状态和截图轮询不会续期。
- 不支持保留协议的旧 Runner 继续按原方式关闭上下文，不发送其不认识的保留命令。临时会话、主动关闭、断线、权限撤销仍清理上下文；为取消在途命令也可能立即回收。持久资料与 VM 隔离策略保持独立。

## 验收

`tests/server/runner.test.ts` 使用独立 HTTP/WebSocket 服务验证实际传输、权限交集、调用去重、未完成回执、连接代次、断线重连、取消竞态和会话隔离。

`tests/e2e/team-tools.spec.ts` 覆盖注册、配置下载、列表不返回凭据、停用以及窄屏布局。

真实 Hermes 协议验收沿用 `docs/bot-agent-teams.md` 的隔离 fixture。添加 `HERMES_TEAM_RUNNER=1` 后，原生工具创建成员、组队、分派、复核、完成目标、回传原会话和双管理员并发都经过 Runner。模型决策由确定脚本替代，不代表真实模型自主决策质量，也不代表 VM 验收。
