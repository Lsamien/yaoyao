# Windows 客户端

Windows 首版支持 Windows 10/11 x64，安装后连接已有夭夭服务器。聊天、团队、文件库和服务器上的电脑环境沿用服务器功能；当前 Windows 客户端不托管本机 Web、Hermes、Runner 或虚拟机。用户无需安装 Node、Python 或开发工具。

## 使用

1. 安装 `Yaoyao-<版本>-win-x64-setup.exe`，填写服务器地址并登录。测试包未签名，Windows 可能显示未知发布者。安装在当前用户目录，不申请管理员权限。
2. 管理员登录后会注册这台电脑；普通账号可登录聊天。屏幕控制与文件、命令分别在本机确认授权，可从“电脑”菜单重新授权、导入配置或断开，也可从应用菜单撤销本机授权。
3. Windows 电脑控制需要配套升级服务器。旧服务器仍可用于聊天；电脑菜单状态会提示升级要求。新版服务器继续支持现有 Mac 客户端。
4. 截图与键鼠操作面向当前交互会话的主屏。锁屏、会话断开、UAC 安全桌面和高于客户端权限的窗口不能由普通权限客户端控制；在电脑上恢复会话或手动处理受保护操作。
5. 文件工具限定在用户主目录，拒绝越界、目录联接逃逸、设备路径、UNC 和 NTFS 备用数据流。命令使用 Windows PowerShell，按当前 Windows 用户权限执行，**不受文件工具根目录约束**；命令最长 120 秒，两路输出分别截断至 512 KiB。原生助手使用 Windows Job Object 管理 PowerShell 及其普通子进程，命令结束、超时或撤销时一起清理。
6. 关闭窗口保留托盘连接；“退出夭夭”断开设备、结束应用自有操作。登录启动默认关闭，开启后可选择仅驻留托盘。更新和卸载默认保留用户数据。

配置与设备令牌位于 `%USERPROFILE%\.yaoyao`（可由既有数据目录环境变量指定），Chromium 会话、浏览器和设备授权位于 Electron `userData`。令牌由当前 Windows 账号的 DPAPI 加密，密码不落盘。复制 Mac 加密文件不能迁移登录，应在 Windows 重新登录授权。

## 构建与安装包

日常可以在 Mac 修改共享代码；原生助手和 EXE 安装包在 Windows x64 上构建。需要 Node 24、CMake、Visual Studio 2022 C++ 工具链和 Windows SDK；GitHub Actions `windows-2022` 提供该构建环境。

```powershell
npm ci
npm run desktop:pack:win
npm run desktop:test:win
```

GitHub Actions 工作流 `Windows client` 支持手动触发、相关 PR 和 `codex/windows-client*` 分支。CI 只上传 artifacts，不发布正式 Release。下载 `yaoyao-windows-x64-unsigned`，其中包含 EXE、blockmap、`latest.yml`、`SHA256SUMS-win-x64.txt` 和构建身份。生成目录为 `desktop-release/windows-x64`。

默认构建为未签名测试包。正式签名构建设置 `YAOYAO_WINDOWS_SIGNED=1`、`CSC_LINK`、适用的 `CSC_KEY_PASSWORD` 和证书对应的 `YAOYAO_WINDOWS_PUBLISHER`；凭据仅通过 CI secret 或本机环境注入。正式构建强制签名和更新签名校验。

Windows 更新使用 NSIS，只有用户点击“重启更新”才安装，先清理设备连接和自有操作。Windows 使用 `latest.yml`，Mac 继续使用 `latest-mac.yml`。更新附件必须来自同一次构建，并在清单引用的安装包和差分文件齐备后发布；测试包不写入正式更新源。

## 验证记录与人工验收

自动测试覆盖平台模式、路径边界、凭据提供器、更新状态、设备权限与来源路由。Windows CI 另外编译并自检原生助手，测试真实 PowerShell，以及打包应用的登录、DPAPI 配置保存、会话恢复、菜单与托盘行为。测试证据位于 `test-results/windows-client`。

以下项目需要真实 Windows 10 和 Windows 11 交互环境，不以 CI 编译或模拟响应代替：

| 项目 | 验收方法 |
| --- | --- |
| 安装与卸载 | 干净用户、中文用户名、无开发运行时；核对快捷方式、单实例、数据保留 |
| 登录与网络 | 管理员及普通账号、会话过期、更换服务器、断网恢复、旧服务器升级提示 |
| 主屏控制 | 100%、150%、200% 缩放；单击、双击、拖拽、滚动、Ctrl/Alt/Win 组合键及中文/emoji；切主屏后旧截图被拒绝 |
| 授权与会话 | 分别拒绝/授予两档权限、撤销在途操作、人工接管、锁屏、RDP 断开、UAC 和管理员窗口 |
| 浏览器与文件 | 独立浏览器与文件双向传输，中文路径、跨盘越界、junction 逃逸、空文件、覆盖保护、校验失败 |
| 生命周期 | 关闭驻留、退出清理、登录启动、仅托盘启动；不启动本机服务 |
| 实际升级 | 隔离更新源提供两个递增版本；已安装旧版下载并重启替换新版；版本、设置、登录和设备身份保留；断网、损坏包和安装失败可恢复 |

首版的真实桌面控制与两个已安装版本之间的升级，必须在记录 Windows 版本、构建提交及测试结果后才可标记通过。未执行的项目标记为“未验证”。
