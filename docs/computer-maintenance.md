# 电脑镜像与工作区维护

镜像配方和维护工具由本仓库交付，不需要访问 OpenMausBot 的本地目录。`deploy/computer/Dockerfile` 从固定摘要的 CUA XFCE 基础镜像构建，驱动、字体和许可证下载均校验 SHA-256；保留兼容的 CUA 路径与标签，增加夭夭镜像标签及 Firefox 持久资料。派生配方的 Apache-2.0 许可和来源在 `third-party/openmausbot`。

## 准备与离线搬运

先运行 `npm run runner:build`。以下命令也在 macOS App 的 `Contents/Resources/runtime` 内提供，可用 Node.js 24 执行：

```sh
node .runner-build/runner-image.mjs prepare --runtime docker --output /安全目录/computer-image.json
node .runner-build/runner-image.mjs inspect --image sha256:完整镜像ID
node .runner-build/runner-image.mjs export --image sha256:完整镜像ID --archive /安全目录/computer.tar
node .runner-build/runner-image.mjs import --archive /安全目录/computer.tar
```

`--runtime podman` 使用相同流程。Docker/Podman 必须指向本机运行时；远程主机在当地运行 Runner 和准备工具。缺少运行时或驱动未就绪会报错，不创建宿主执行替代路径。

准备与导入都会创建一次独立验收电脑，等待驱动、读取健康状态和真实截图，随后清理验收容器。导出的 `.tar.json` 记录完整镜像 ID、架构、协议、驱动和归档 SHA-256；导入先验证归档，再核对实际镜像身份及架构。导出不覆盖现有归档。工具不会自动修改 Runner 配置，也不会替换运行中的电脑。

更新时先准备并验证新镜像，停止 Runner 后把配置的 `computers.imageId` 改成新的完整 ID，再启动。资源池只在环境空闲时应用新配置，保留工作区；旧镜像不自动删除。回退使用原镜像 ID，必要时恢复升级前的工作区备份。浏览器资料格式也可能升级，因此不能以镜像回退代替数据回退。

## 工作区备份、恢复与重建

必须先停止该 Runner。维护工具获取与 Runner 相同的数据目录独占锁，不能和正在执行的 Agent 或人工接管并行运行。它首先处理崩溃遗留的租约和容器；未确认停止的环境不能维护。

```sh
node .runner-build/runner-maintenance.mjs list --config /安全目录/runner.json
node .runner-build/runner-maintenance.mjs backup --config /安全目录/runner.json --environment UUID --snapshot /备份目录/本次备份
node .runner-build/runner-maintenance.mjs restore --config /安全目录/runner.json --environment UUID --snapshot /备份目录/本次备份
node .runner-build/runner-maintenance.mjs rebuild --config /安全目录/runner.json --environment UUID
```

CLI 默认数据目录为配置旁的 `state/<runnerId>`。App 托管节点的数据目录是 `~/.hermes-yaoyao/runner-state/<runnerId>`，维护时用 `--home` 显式指定该目录，并使用原始私有配置文件；App 加密配置不能直接当作 JSON 读取。

备份包含工作文件及持久浏览器资料，不包含运行中的内存、进程、模型密钥、Runner 身份或整个宿主 HOME。目录设为仅当前用户访问，浏览器资料仍可能包含登录状态，应作为私有数据保存。每份备份有账号/环境归属和逐文件校验；普通文件、目录、符号链接保留，不复制运行时 socket。上限为 20 GiB、20 万项。

恢复先验证完整内容并复制到暂存目录；恢复前的数据经校验保留为 `.before-restore-*`，不自动删除。保留挂载根目录并替换其内容，以兼容 macOS 容器共享文件系统。恢复前写入日志，进程若在恢复中退出，下一次启动先从旧数据副本回退，不使用部分恢复的工作区。重建只退休已停止的容器身份，下次启动从配置镜像重新创建，保留工作区；它不是清空数据。

这是停止电脑后的文件一致备份。浏览器或数据库在强制中断前未落盘的内容不在备份中，不能宣称应用事务快照。

## 验证状态

2026-09-09 在 arm64 Docker 上从本仓库构建、健康/截图检查、归档导出、SHA-256 校验后重新导入通过。验证镜像：`sha256:befa37db3c64fa231237d6898d9403029ca9f02a01beb41ff1cf0de113130f55`。归档：`/tmp/yaoyao-computer-0909.tar`，SHA-256 为 `63a72afff1169439d74b500b883d8cff4bbbf726148c21a64226d8d3b02f2f7e`。

离线测试覆盖驱动/身份/架构不符、损坏归档不调用运行时、拒绝覆盖、在用环境拒绝维护、恢复前校验、保留旧数据及内容恢复中途崩溃回退。Podman 参数一致性有离线证据，真实 Podman 与 amd64 构建尚未验收。

真实电脑备份/恢复后重新启动并读取原文件通过，恢复前文件保留在旧数据副本。新镜像的打包 Runner / Hermes Worker 验收 2 项通过，包含公网访问、临时助手、产物回传、人工接管和原任务续跑。类型检查及 767 项全量测试通过。


2026-09-09 本地虚拟机的新流程以 `local-vm.md` 为准：准备与隔离策略在应用设置，电脑预览和实例操作在 Agent 聊天右侧；手机端仅从当前聊天查看与操作电脑。
