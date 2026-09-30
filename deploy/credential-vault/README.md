# 密码库正式适配器：人工部署审阅材料

这些文件仅是可审阅模板；本轮没有安装、执行或启用服务，也没有创建用户、控制 token、真实密码库或修改网络规则。JSON 中 UID/PID/时间均为无效示例，批准默认 false。不要直接复制成已批准配置。

首先选择同一执行节点上的可信控制身份：Web/BFF 与 broker 使用同一非 root 控制 UID，Hermes、其任意 shell 和通用浏览器使用另一个非 root UID。当前 Unix socket 实现没有安全的跨节点控制通道，不能把 socket 改成公开 TCP 或通过 Runner 传输主密码。控制身份下不得提供给模型任意本机执行/调试/资料读取能力；若目前 Web 内运行这样的 host tools，须在实际部署前隔离它们，不能仅另起一个同 UID broker。服务器/Runner 的 `credential-ref-v1` 必须匹配；Runner 不持有秘密。

需管理员另行批准和实施：

1. 用实际 UID/PID 替换配置值，审核服务身份、组/ACL、父目录、备份目录、交换区/core dump/调试策略。Hermes 不能 root、sudo、调试控制进程或读取管理登录会话；必须验证其 shell 无法读取 vault/config/token/browser 资料或连接 socket。控制文件 0600、目录 0700；token 由管理员生成高熵随机值，仅用于 IPC，不是 DEK。不要放入仓库、环境日志或 Hermes 工作区。
2. 安装 Node >=24、锁定的生产依赖和 Chromium（由管理员批准来源/版本），审核 Linux unit 的真实路径/浏览器 sandbox。不能以 `--no-sandbox` 或宽化私有权限解除启动问题。unit 不是 OS 隔离证明；实际平台需要等价的可信沙箱/防调试控制。模板不启动或修改 Hermes。
3. 建立并验证网络策略：broker/browser 的出口只允许批准目标地址/端口与受信 DNS，禁止 loopback/内网管理面、云 metadata、通用 CDP/调试端口及非批准 SSH。网站外部资源/重定向须逐项审批，首次实现仅接受同 origin 的指定成功页。Chromium 请求路由不能控制所有后台/WebRTC 网络；网络过滤必须在 OS/容器层生效。DNS/CDN/IPv6 变化需明确审核，不把域名字符串当网络防火墙。
4. 验证浏览器每次授权独立 pipe/context/profile，Hermes 无法访问其 PID、DOM、Cookie、请求、截图/CDP。Web 专用管理页必须经可信 HTTPS，不能让 Bot 控制的浏览器录入主密码。管理 Web、broker 和其依赖属于可信计算边界；批准文件只能由可信管理员维护。
5. 完成上述实际攻击检查后，人工填写 `approved:true`、毫秒 `approvedAt/expiresAt`（最长31天）、broker/Hermes UID 和实际 Hermes PID；所有四项 controls 必须已经实测。代码会复查私有文件、时效和 `ps` 返回的实际 Hermes UID，失效会锁库/撤权；它不会证明四项控制本身。Hermes 重启 PID 变化后须重新审核，不自动恢复批准。
6. BFF 配置 `HERMES_YAOYAO_VAULT_SOCKET`、`HERMES_YAOYAO_VAULT_TOKEN_FILE`、`HERMES_YAOYAO_VAULT_HERMES_UID`，前台启动命令为 `node dist-server/server/credentialVault/index.js --config /私有路径/vault.json`。这是后续部署操作，本轮未执行。只有独立部署批准才能启用 unit 或改线上配置。
7. 用户亲自在「Bot模式 → 设置 → 密码管理」创建、解锁、录入凭据/使用计划，并逐任务授权。首次真实账号登录还需相应批准。先用专门的 dummy 测试账号验证锁定/登出/撤权/取消/断线/重连、host key 拒绝、Cookie 清理和备份恢复，不把同进程测试算作隔离验收。

网站是标准表单认证验证，不支持任意网站登录后的通用浏览动作。正常完成可访问配置的 GET 退出页；取消或没有退出页时远端会话按网站规则处理，必要时人工撤销。SSH 仅固定无参数绝对程序，返回退出码；非零码表示程序已完成但失败。SFTP read 只返回有界字节数/摘要，write 创建固定正文的新文件，不覆盖。SHA256 摘要也属于目标数据的派生信息，只有授权任务可得到。中断后的远端命令/部分文件可能已生效；回执未知时需人工核对，不重试、删除或覆盖。

支持证据：`tests/server/credentialVaultBotFlow.test.ts` 经 WorkspaceRuntime 工具 HTTP 目录、调用上下文、专用授权 API、私有 Unix IPC、正式 Playwright/ssh2 adapter 访问本地 dummy HTTPS/SSH/SFTP 服务。Hermes/模型是 stub，隔离 gate 是明确的测试替身；没有跨 OS 身份、真实外部账号、真实 Hermes 自主推理或部署验收。
