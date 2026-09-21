# 电脑间直接复制文件

用户说「把 mac1 桌面的 a.txt 放到 mac2（或服务器）桌面」时，Bot 使用 `desktop_file_copy`：

```json
{
  "sourceHost": "mac1",
  "sourcePath": "Desktop/a.txt",
  "targetHost": "mac2",
  "targetPath": "Desktop/a.txt"
}
```

目标服务器写 `targetHost: "server"`。设备名解析为已连接的设备编号；`本机` 随本轮消息来源设备变化。名称重复、来源未知、设备离线或未授权时失败，不会切换到别的设备。

服务器通过现有桌面连接读取来源文件，再转送给目标电脑。原始字节不进入模型上下文，不创建聊天附件或文件库条目。来源和目标都遵守全局电脑开关、当前账号文件权限、运行授权、连接代次和人工接管状态。两个设备按稳定顺序占用执行队列，避免相反方向同时复制发生死锁。

目标先将文件写到同目录临时文件，落盘并读回校验 SHA-256，再原子地提交到目标路径。默认保留来源、拒绝覆盖已有文件；只有用户要求覆盖时才设置 `overwrite: true`。返回成功时包含两端设备、路径、字节数和 SHA-256。写入回执不确定时不自动重传。

当前支持用户主目录内的单个文件，最大 **10 MiB**，包括图片、压缩包和空文件；目录、断点续传和 Grok/VM 与 Mac 之间的传输不在此次实现内。两端无需互相开放网络端口；电脑继续连接服务器，客户端不运行 Hermes。

服务器端和电脑端的 HTTP 接收上限从 256 KiB 调整到 16 MiB，以容纳 10 MiB 文件编码后的命令；超过上限仍拒绝。目标桌面端新增 `file/receive` 操作，旧客户端拒绝该操作，服务端会提示更新，不降级成覆盖写入。

## 验证

- `tests/server/desktopEnvironments.test.ts`：37 项通过，覆盖 mac1→mac2、mac1→服务器、服务器→本机、相反方向并发、二进制完整性、双端授权、失联/撤权/取消/损坏/超限、回执校验和读取期间的人工接管。
- `tests/server/desktopHosts.test.ts`：8 项通过。
- `tests/server/workspace.test.ts` 新增实际 HTTP 工具桥调用测试通过，验证工具目录、自然语言请求上下文、来源/目标路由、重复调用去重，以及不会生成附件。Hermes 模型响应使用本地测试替身，不代表线上模型的执行证明。
- `node --test desktop/host-files.test.mjs desktop/host-manager.test.mjs desktop/host-transfer-transport.test.mjs`：13 项通过。包含真实临时目录复制、内容校验、空文件、覆盖保护、清理临时文件，以及服务器和电脑真实 HTTP 通道的 10 MiB/超限测试。
- `npm run build`、服务端 TypeScript 检查、修改的桌面模块语法检查和 `git diff --check` 通过。
- 扩展运行上述三个服务端测试文件：134 项通过，2 项失败。失败均为原有上下文用量投影断言（`workspace.test.ts:374` 和 `:528`），在未修改的 `5b4ae36` 临时完整源码副本上也复现。首次桌面测试中原有 HTTP 用例发生一次 `ECONNRESET`，单独复跑和随后整组运行均通过。

本次未连接真实 mac1/mac2 传送用户文件，也未部署到 `10.10.1.200`。更新服务器及目标电脑桌面端后，新的 Bot 轮次会获得这条工具。
