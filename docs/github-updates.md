# GitHub 版本升级

官方发布源为 `https://github.com/Lsamien/yaoyao.git`。检查使用公开稳定 Release，不需要 GitHub 账号、访问令牌或安装 GitHub CLI；尚未发布的标签和预发布版本不会被选为更新。

## Web

进入设置中的“更新与回滚”即可检查版本，页面显示实际发布源与发布说明。检查会解析标签提交，并从固定提交读取 `release.json`；安装时再次校验下载提交。GitHub 限流、网络失败或清单异常会显示错误，不能据此宣称已是最新版。

macOS 独立 Web 继续使用现有升级事务：构建新版本、等待任务空闲、备份、切换并验证，失败恢复。回滚仍保留已写入的新数据，数据库不兼容时拒绝降级。检查和升级不依赖 9119；只以 Web 自身健康判断升级结果。Docker 显示最新版本与发布页，由部署者重新构建镜像和容器。

通过 `HERMES_YAOYAO_RELEASE_SOURCE` 可指定自定义仓库；自定义源（包括其他 GitHub 仓库）保留现有 Git 标签流程。官方 GitHub 仓库必须提供稳定 Release 和版本一致的 `release.json`。同一语义版本在 GitHub 与内网拥有不同提交编号，不会单凭编号触发升级。

## macOS App

使用“夭夭 → 检查 App 更新…”打开独立窗口。它直接连接官方 GitHub，即使 Web 或 9119 未启动也可使用，不受 Web 自定义源设置影响。

新版提供当前架构的 `Yaoyao-{版本}-{架构}.dmg` 和 `SHA256SUMS.txt` 后，窗口显示下载按钮。下载可取消或重试，不会停止聊天、Runner 或后台服务。文件写入 Web 数据目录下的 `updates/desktop-downloads`，通过大小、SHA-256 和 DMG 完整性检查后才提供“打开安装包”。GitHub 附件摘要存在时也必须一致，缓存重新使用和打开前会核对文件。

打开 DMG 后手动拖入“应用程序”安装。不会自动覆盖正在运行的 App、申请提权或自动重启；开发签名包尚未公证，请遵循 macOS 提示。安装后首次启动仍只向上同步较旧的本机 Web，保留较新的独立服务。

下载和打开接口只授权给本地更新窗口，远程页面、普通聊天页面和启动页不能调用。发布说明按纯文本显示，不执行远端 HTML 或脚本。

## 旧安装迁移

加载新版本后，空发布源、`github.com/Lsamien/hermes-yaoyao`（包括 HTTPS 与 SSH）以及官方旧仓库 `git.samien.cn/samien/hermes-yaoyao`、`192.168.153.8:3000/samien/hermes-yaoyao` 的无凭据 HTTP(S) 地址会映射到 GitHub；兼容 `.git` 后缀、尾部斜杠和既有 `git@git.samien.cn:samien/hermes-yaoyao.git` 地址。其他用户自定义仓库保持原样。

运行时先使用归一化后的源；下次生成或更新本应用管理的 LaunchAgent 配置时持久化，保留地址、TLS、上游等其他环境变量。不会直接改写用户维护的环境文件。

旧程序不会凭空获得迁移能力：首次需手动安装包含此功能的新 App，或更新源码并重启。既有发布标签和安装包不会被改写。

从 v0.4.4 起默认应用数据为 `~/.yaoyao`，兼容读取旧配置并迁移 `~/.hermes-yaoyao`。迁移按服务所有权和 SQLite 锁检查，旧升级事务完成后才改名；上传与缓存索引、通知配置及更新记录中的内部路径一起更新。新旧目录都已有数据时不覆盖。`YAOYAO_HOME` 可覆盖默认值，既有 `HERMES_YAOYAO_HOME` 继续有效。

现有 LaunchAgent 标识和 `~/.local/share/hermes-yaoyao` 程序目录用于延续服务与回滚历史，不是 Web 应用数据目录。客户端历史缓存与身份命名空间也保留兼容。
