# Windows 客户端验证

版本：0.4.70。目标为 Windows 10/11 x64 客户端；Windows 不托管本机服务器、Hermes、Runner 或虚拟机。交换协议保持版本 1，无数据库迁移。

## Mac 回归

在 Mac 开发环境执行并通过：

- `npm run typecheck`。
- `npm run desktop:build`，包含生产界面、Mac 桌面资源和 Swift 助手。
- 服务端 `desktopEnvironments`、`desktopHosts`、`fileTransfer`：75 项。
- 桌面平台、模式、登录、凭据、路径、文件传输、更新生命周期等相关单元测试。仅依赖 Windows 的原生命令测试在 Mac 跳过，在 Windows CI 运行。
- Electron 界面回归：首次启动和远程登录、客户端/服务器双向切换、远程及本地重启更新、更新失败恢复；5 项通过。启动反馈与电脑接管窗口也通过初轮回归。
- Mac 原生更新器代理下载、签名拒绝和等待系统准备完成：2 项通过。
- 独立 Chromium 标签页、截图与持久会话隔离；本机服务启动、关窗驻留、故障恢复和退出清理：2 项通过。

## Windows 自动化验收

GitHub Actions 使用 Windows Server 2022 x64、Node 24、锁定的 npm 依赖、MSVC/CMake 和 Windows SDK。该环境与 Windows 10/11 真机矩阵分别记录。

工作流：[Windows client](https://github.com/Lsamien/yaoyao/actions/workflows/windows-client.yml)。安装包只交付 Actions artifact，没有发布正式 Release。

已在 Windows CI 实测通过：63 项桌面测试及 58 项服务端测试。打包后的客户端连接本地测试登录服务，验证了管理员登录流程、DPAPI 加密、会话恢复、仅客户端模式、托盘关窗；原生助手验证了 PowerShell 中文输出、退出码、超时、取消与子进程清理。当前交互桌面在 100% 缩放下验证了截图、点击、中文/emoji 输入、Ctrl+A、显示变化作废截图、撤销授权，以及独立浏览器截图与 Cookie 隔离。

最终运行：[35750511967，全流程通过](https://github.com/Lsamien/yaoyao/actions/runs/35750511967)。CI 源码提交为 `4dc2d8b356649291faa2954f32a4558b04bc8c60`，对应本地代码提交 `0edcc1f`。验证时间为 2026-09-22，记录归档于 2026-09-23，系统版本 Windows Server 2022 / `10.0.20348`。

| 验证 | 结果 |
| --- | --- |
| 类型检查、生产构建、原生助手编译 | 通过；助手使用静态 MSVC 运行时 |
| 安装包结构、EXE、blockmap、更新清单及摘要 | 通过；客户端 ASAR 不含项目 `node_modules` |
| 桌面测试 / 服务端测试 | 63 / 58 项全部通过 |
| NSIS 当前用户安装 | 通过 |
| 隔离源损坏包拒绝及重新下载 | 通过 |
| 0.4.70 → 临时 0.4.71 的实际文件替换 | 通过 |
| 升级后自动重启、登录 Cookie、设置及 DPAPI 数据 | 通过；使用正常用户数据目录 |
| 卸载与应用配置保留 | 通过 |

安装升级测试另外 1 项通过，临时 0.4.71 仅用于验证，未发布。隔离更新源未提供旧版 blockmap，本次验证了回退到完整下载后的真实升级；差分下载尚未实测。当前用户安装与升级在一次性 CI 账号中执行，不代表普通用户权限和所有 Windows 10/11 环境均已验收。

交付：[未签名 Windows 安装包及更新文件](https://github.com/Lsamien/yaoyao/actions/runs/35750511967/artifacts/10705091432)，[测试证据](https://github.com/Lsamien/yaoyao/actions/runs/35750511967/artifacts/10705211454)。本目录 `evidence` 保存对应 JSON、截图及更新日志。Actions artifacts 保留至 2026-12-21；下载可能需要登录 GitHub。

EXE 文件名为 `Yaoyao-0.4.70-win-x64-setup.exe`，SHA-256：

```text
25010f11c7f46c15863090887b933205c1c8076f4c5816c80da6c0307819f1d6
```

完整 [文件校验清单](evidence/SHA256SUMS-win-x64.txt) 取自上述构建日志，与安装包内清单对应。安装包 artifact ZIP 的 SHA-256 为 `1129c806d1d7d0f5f1caabeb5fec252940dc10a2cc56ba5ff22221e02ac96ec4`；测试证据 ZIP 的 SHA-256 为 `ed6950df17a79bd9a8369ce72cf8617db8f4c90b6206a7dcbc4f4902fe6a1bb2`，归档证据下载后已核对。

## 尚需 Windows 10/11 真机验收

以下项目没有可用的 Windows 10/11 真机记录，状态为 **未验证**：

- 干净 Windows 10、Windows 11 普通用户安装；中文 Windows 用户名；登录启动与实际用户登录。
- 100%、150%、200% 缩放及多显示器切主屏；双击、拖拽、滚动、Alt/Win 组合键。
- 原生授权对话框的允许与拒绝；人工接管、锁屏、RDP 断开、UAC 安全桌面、高权限窗口拒绝。
- 与真实夭夭服务器端到端联调：管理员与普通账号、过期会话、更换服务器、断网重连、真实双向文件传输和远程电脑面板。
- Windows 10/11 上实际升级失败后的恢复、签名发布流程及正式证书校验。

完整操作步骤见 [Windows 客户端说明](../../windows-client.md)。CI 编译或 Windows Server 上的功能测试不替代以上验收。
