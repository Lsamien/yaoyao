# 私有电脑 Provider 基础

实现位于 `src/runner/computers/container.ts`，提供统一的创建、查询、执行、停止和删除接口。每个环境有独立 UUID、账号归属键、Runner 身份、容器和持久工作目录。`pool.ts` 提供持久电脑租约与资源配额。现在已通过受控 Worker 接入 Bot 任务，详见 `docs/computer-worker.md`。本文记录 Provider 和资源租约本身的边界。

## 已实现的约束

- Docker 和 Podman 使用同一份接口与配置校验；远程引擎要求将 Runner 放到目的电脑，避免把本机目录误当作远程挂载路径。
- 镜像必须使用完整不可变 ID，并验证兼容的 CUA 驱动标签。当前采用本机已有的 OpenMausBot CUA 0.20.0、layer 5 镜像接口；没有复制或修改参考仓库。
- 环境运行在容器隔离层。macOS 上 Docker/Podman 的底层 Linux 虚拟机由运行时提供，每个环境不是一台独占内核的 VM。
- 仅挂载该环境的持久工作目录；不挂载 Docker socket、宿主 HOME、Hermes 配置或凭据。命令固定以 guest UID/GID 1000 执行，工作目录为 `/home/cua/workspace`。
- 固定独立 IPC/cgroup 命名空间、禁止提权、收紧 capability，并设置 CPU、内存、swap 与进程数上限。每次执行前核对运行实例、镜像、归属、挂载与约束。
- 默认 `--network none`，不发布任何端口。容器只有 loopback 网卡，不能直接访问宿主服务或外网。自己的主机名映射到 loopback，保证 XFCE/VNC 在无网络环境下正常启动。可通过专属进程通道启用受控公网代理，仍不增加外部网卡或端口。详见 `docs/computer-network.md`。
- 桌面通过容器内的 CUA socket 操作；验收已读取真实截图。查看和人工接管已接入账号鉴权及独立控制租约，见 `docs/computer-control.md`。
- 取消或无法确认的 guest 命令会停止所属私有容器，确认停止后才释放串行执行位置。仅终止 `docker exec` 客户端不能证明 guest 进程已停止。
- 删除容器保留工作目录，重建后可继续读取工作文件。停止后的工作区备份、校验恢复和重建见 `docs/computer-maintenance.md`；可信共享电脑见 `docs/shared-computers.md`。

权限校验以回调传入，在异步检查与实际执行的前后重验。ComputerPool 在 SQLite 中保存持有者、租约代次、期限与停止状态，默认每个 Runner 同时 2 个环境、总计最多 32 个环境。启动时必须先恢复未确认停止的资源；旧租约先失效，再停止并删除旧容器身份，保留工作区。不确认停止的环境保持占用，不能交给新任务。当前 Provider 与资源池都不作为裸命令接口对浏览器或模型开放，通过 Worker 和任务授权检查使用。

## 参考与差异

吸收 OpenMausBot `server/container-computer.ts` 的不可变镜像、每 Bot 环境、持久工作目录、能力检查和实际健康/画面验证；默认网络进一步收紧为无网络环境。吸收 rakazo 的屏幕租约和接管机制，在任务协调层加入持久 fencing 代次，先确认旧执行停止，再允许新控制者使用资源。

## 验收状态

Provider 的 15 项与 ComputerPool 的 6 项离线测试通过，覆盖 Docker/Podman 参数边界、账号/Runner 归属、挂载/网络/权限/资源篡改、异步撤权、危险目录、配额、取消、重启恢复及过期扫描不误停新的持有者。Podman 尚未做真实运行验收。

真实 Docker 验收通过：创建独立电脑、验证只有 loopback 网卡、guest UID 1000 写入文件、读取 CUA 健康报告和真实桌面截图、删除重建后读取持久文件、通过 ComputerPool 取消延迟写入，确认旧容器被删除，拒绝旧租约继续执行。截图在 `test-results/computer/desktop.png`。每次测试均使用新的 UUID 和临时目录，并清理本轮容器。

```sh
YAOYAO_COMPUTER_IMAGE=sha256:本机已验证镜像的完整ID \
  npx vitest run tests/live/computer.live.test.ts
```

本轮 arm64 验证镜像为 `sha256:574b51992c53e22d48997d4286ba83e47b872de34250276c99d2f390bf3640e0`。镜像构建与跨端电脑面板已有实现，见对应文档；可信共享环境见 `docs/shared-computers.md`，不能以本测试替代整个 VM 功能验收。
