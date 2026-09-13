# 夭夭 AI 发布流程

“发布新版本”包括本地构建、GitHub Release 附件和 Docker Hub 远程镜像。三部分均完成并验证后，才算发布完成。

## 版本与产物

1. 核对当前提交、工作区、已发布版本和客户端改动。`release.json` 的 `releaseVersion`、`webVersion`、`gitTag` 与根目录 package/lock 版本保持一致。
2. 完成适用的单元测试、浏览器验证和生产构建；用中文提交修改。正式产物对应已确认的源码提交，并记录真实构建身份。
3. 构建 Web 源码包、macOS 桌面安装包和适用的 Android 正式签名 APK，验证签名、架构、启动及完整性，生成 `SHA256SUMS.txt`。
4. 推送源码与版本标签，上传 GitHub Release 附件，核对远端附件状态、大小和 SHA-256。已发布的 Git 标签与旧附件保持不变。

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
