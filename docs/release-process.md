# 夭夭 AI 发布流程

“发布新版本”包括本地构建、GitHub Release 附件和 Docker Hub 远程镜像。三部分均完成并验证后，才算发布完成。

## 版本与产物

1. 核对当前提交、工作区、已发布版本和客户端改动。`release.json` 的 `releaseVersion`、`webVersion`、`gitTag` 与根目录 package/lock 版本保持一致。
2. 完成适用的单元测试、浏览器验证和生产构建；用中文提交修改。正式产物对应已确认的源码提交，并记录真实构建身份。
3. 构建 Web 源码包、macOS 桌面安装包和适用的 Android 正式签名 APK，验证签名、架构、启动及完整性，生成 `SHA256SUMS.txt`。
4. 推送源码与版本标签，上传 GitHub Release 附件，核对远端附件状态、大小和 SHA-256。已发布的 Git 标签与旧附件保持不变。

### macOS 发布方式

macOS 新版本默认使用 Developer ID Application 正式分发签名、Apple 公证和下方的完整自动更新产物流程。本机公证凭据使用钥匙串配置 `yaoyao-notary`，通过 `APPLE_KEYCHAIN_PROFILE` 指定。正式发布应同时提供首次安装用的 DMG 和自动升级用的 ZIP、清单及差分文件。

开发签名 DMG 仅用于明确选择的手动安装测试版本：从干净源码快照执行 `npm run desktop:build`，再执行 `npx electron-builder --mac dmg --arm64 --publish never --config.mac.type=development`。这类包需要验证签名完整性、架构、内置服务身份、实际启动和 DMG 完整性，并明确标记开发签名、未公证、手动安装；不上传自动升级 ZIP、差分文件或 `latest-mac.yml`。

### macOS 正式签名与自动更新产物

`npm run desktop:pack` 用于本地打包；发布支持自动升级的正式分发包时使用 `npm run desktop:release`，其上传行为固定为 `never`，先生成可检查的本地产物。需要：

- `CSC_NAME` 指定 `Developer ID Application: ...` 分发签名身份。
- 公证优先使用本机钥匙串：运行 `xcrun notarytool store-credentials yaoyao-notary --apple-id <邮箱> --team-id <团队 ID>`，按隐藏输入提示录入 App 专用密码，验证通过后设置 `APPLE_KEYCHAIN_PROFILE=yaoyao-notary`。自定义钥匙串可另设 `APPLE_KEYCHAIN` 路径。
- 也支持配置 `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`，或 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。凭据通过钥匙串或环境注入，不写入仓库或发布说明。

正式命令启用强制签名与公证，并校验包内 `app-update.yml` 指向 `Lsamien/yaoyao`、签名完整性、公证票据，以及 `latest-mac.yml` 的版本、附件名、大小和 SHA-512。当前仍只发布 Apple Silicon 桌面包；不要上传指向不存在的 Intel 包的清单。

支持自动升级的 GitHub Release 必须同时上传同一次构建生成的 `Yaoyao-{版本}-arm64.dmg`、`Yaoyao-{版本}-arm64.zip`、各自 `.blockmap`、`latest-mac.yml` 和 `SHA256SUMS.txt`。ZIP 是自动更新载荷，DMG 是首次安装与旧客户端迁移载荷。命令生成的 SHA-256 清单包含桌面附件；本次有源码包等其他附件时，发布前一并补入清单。不能在生成 ZIP 和更新摘要之后再修改应用或重新签名。

既有手动安装版客户端需先手动安装一次正式包，之后才能使用“下载更新 → 重启更新”。发布前应使用同一签名身份的两个版本，在隔离机器上验证实际替换与重新启动；单元测试或未签名包的打包成功不能代替这项验收。

### Windows 测试安装包

Windows 原生助手和安装包在 Windows x64 环境从同一发布提交构建，并验证安装、启动和升级。未配置正式证书时须标为未签名测试版；经用户选择交付后，Release 可提供 EXE 与独立测试元数据 ZIP，但不在 Release 根目录上传 Windows `latest.yml`。元数据包含同次构建的更新清单、blockmap、校验值和构建身份。Windows Server CI 与 Windows 10/11 真机验收结果分别说明。

## Docker Hub 远程镜像

固定仓库为 `samienluo/yaoyao`。以每次发布的 `vX.Y.Z` 为版本标签：

| 标签 | 内容 | 更新规则 |
| --- | --- | --- |
| `samienluo/yaoyao:vX.Y.Z-amd` | `linux/amd64` | 每个新版本发布，保留旧版本标签 |
| `samienluo/yaoyao:vX.Y.Z` | 同时包含 `linux/amd64`、`linux/arm64` 的通用镜像 | 每个新版本发布，客户端自动选择架构 |
| `samienluo/yaoyao:latest` | 最新稳定版本的同一通用镜像 | 新版本验证通过后更新 |

- 远程镜像必须使用本次版本对应的源码与构建产物，不能只改标签或复用旧版内容。
- 先推送、验证固定版本标签，再将 `latest` 指向已验证的通用镜像。保留全部旧版本标签，不覆盖或删除旧版本。
- 检查远端 manifest/index：通用版本包含两个目标架构，`-amd` 标签对应 AMD64，`latest` 与新通用版本的 index digest 一致。
- 拉取并检查两个架构的版本与运行情况，验证 `/healthz`。记录原生或模拟运行方式；`/readyz` 的上游连接状态另行说明。
- 本地离线 tar 不能代替远程镜像推送。用户另有离线包要求时，同时交付可加载的 tar、镜像标签和校验值。

## 发布说明与最终核验

版本标题与更新说明只描述夭夭 AI 自身的功能、修复和兼容性，不出现其他参考产品的名称或对比。

每次在 `docs/releases/vX.Y.Z.md` 和 GitHub Release 中同步说明：

- 本次改动、Web/桌面/Android 版本、下载附件与签名状态。
- 三个 Docker Hub 标签及对应架构，并提供拉取或 Compose 更新方法。
- 远端固定版本与 `latest` 的 digest、架构和运行验证结果。未完成的项目明确标出，不写“已验证”。
- `latest` 已更新，旧版本标签保留；数据备份、权限或迁移方面的必要说明。

发布完成前，确认 GitHub Release 为正式版本（非草稿、非预发布），最新版本接口指向目标版本，所有附件摘要一致，远程镜像与 `latest` 已按上述规则验证。

当前镜像标签与部署方法见 [Docker 部署说明](docker-install.md)。
