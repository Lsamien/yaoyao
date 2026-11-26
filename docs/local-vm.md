# 本地虚拟机

本实现参照 OpenMausBot 的 `LocalComputerSection.tsx`、`ComputerPanel.tsx`、`LocalVmWorkspace.tsx` 及手机 `ComputerView.swift` / `ComputerScreen.kt`。

## 设计（2026-11 重新设计）

- **Docker 版不支持虚拟机。** Docker 部署（`YAOYAO_DEPLOYMENT=docker`）中虚拟机入口只显示说明，所有虚拟机接口返回 `local_vm_docker_unsupported`。需要虚拟机时使用 macOS App 或 npm 安装的服务端。
- **按账号单独许可，默认关闭。** 管理员账号始终可用；子账号需要管理员在 **设置 → 用户与权限** 中打开该账号的“虚拟机”开关。关闭开关会立即使该账号进行中的虚拟机请求失效，并停止它的虚拟机；工作文件和浏览器资料保留，重新开通后继续使用。全局开关（电脑设置中的“本地虚拟机”）仍是总闸，关闭后所有人都不能使用。
- **一个账号一台虚拟机，每个机器人一个桌面。** 同一账号的所有机器人共用一个容器和共享工作目录 `/home/cua/workspace`；每个机器人在容器里分到自己的桌面（显示编号 2 起），有独立的窗口会话、D-Bus、HOME（`/home/cua/desktops/<机器人 ID>`）、浏览器资料和电脑驱动连接。`computer_desktop_state` / `computer_action` 只操作这个机器人自己的桌面，`computer_shell` 打开的图形程序也显示在它的桌面上。不同账号的虚拟机完全分开。
- 临时任务助手仍使用任务隔离环境，完成后单独清理。

原来的“每个机器人独立虚拟机”和“多个机器人共用一个桌面”两种模式、手动创建的“共享电脑”均已取消。

## 使用流程

1. 管理员进入 **Bot 设置 → 本地虚拟机**，确认 Docker 或 Podman 已启动，选择 **标准桌面** 或 **Cursor Universal** 后点击 **准备所选镜像**。旧版本准备的镜像不支持多个桌面，需要重新准备。
2. 在 **容量** 中设置“同时运行的账号虚拟机”（1–8，默认 2）和“每台虚拟机的机器人桌面”（1–8，默认 4）。每个机器人桌面约占用 200–400 MB 内存；上限只影响新启动的虚拟机和桌面。
3. 在 **设置 → 用户与权限** 为需要的子账号打开“虚拟机”。
4. 在机器人聊天右上角打开 **电脑**，点击 **启动 <机器人> 的桌面**。账号虚拟机在第一次需要时自动创建或启动，然后为这个机器人分配桌面。机器人第一次使用桌面工具时也会自动完成这一步。
5. 面板中的 **停止桌面 / 重启桌面 / 移除桌面** 只作用于这个机器人的桌面，同一账号的其他机器人不受影响；移除桌面会释放显示编号，保留该机器人的 HOME 和浏览器资料。人工接管时只暂停这个机器人。
6. 整台账号虚拟机按空闲策略自动停止，也可由管理员在 **本账号的虚拟机** 中停止或移除实例（数据保留）。服务启动时会恢复已开通账号的虚拟机及其机器人桌面。

镜像属于整台账号虚拟机：在电脑面板选择镜像对该账号的所有机器人生效，切换前需要先移除实例。已有虚拟机如果仍在使用旧镜像，下次在面板启动桌面时会自动移除旧实例（保留数据）并换用新准备的同类镜像。

### 旧虚拟机的迁移

新版本首次连接执行节点时，每个已开通账号自动迁移一次：

- 所有本地机器人加入该账号唯一的虚拟机。
- 原来每个机器人独立虚拟机的工作目录复制到共享工作目录下的 `migrated/<机器人 ID>/`；其中的 Chrome / Chromium / Firefox 资料复制到该机器人桌面的 HOME，登录状态随之保留。手动创建的旧共享电脑按其第一个成员迁移一次。
- 原数据只读挂载、只复制不删除，已存在的目标文件不覆盖。复制在一次性的无网络容器中以虚拟机用户身份进行。
- 迁移需要镜像已准备、相关虚拟机空闲；条件不满足时下次检查自动重试。
- 原来“多个机器人共用一个桌面”的共享虚拟机直接成为账号虚拟机，工作文件原地保留；原共享浏览器资料仍在 `workspace/.browser-profiles`，各机器人的新桌面使用各自的资料。

## 同一 Bot 使用本机和虚拟机

两种执行方式都使用 Hermes 的独立 Profile 会话。Hermes 统一管理模型、视觉路由、配置、技能和认证；Runner 负责指定 Linux 虚拟机的执行、控制权和文件传输，不复制 Profile 配置，也不启动模型 Worker。

- **虚拟机模式**：默认通过 `computer_*` 在虚拟机执行。Hermes 原生 Skill 和已启用的服务工具可直接使用。需要本机命令、文件或浏览器操作时，工具桥交给 Hermes 原生审批机制；用户拒绝后不能通过另一条 Worker 路径继续。勾选“允许本机环境”后，沿用 Profile 已开放的本机能力。
- **本机协作模式**：沿用 Profile 的本机工具、配置和上下文，同时加入虚拟机工具。本机操作与虚拟机操作采用各自路径；`computer_copy_file` 显式传递一个文件，`computer_export` 将虚拟机产物回传当前聊天。

`vmExecution: worker | profile` 继续作为客户端兼容的模式字段，`worker` 在新版 Runner 中表示上述虚拟机权限策略。Bot 创建的成员、临时助手不自动继承本机协作授权。人工接管前，Runner 等待 Hermes 会话和正在执行的虚拟机工具结束；交还后继续同一个 Hermes 会话。

旧会话的聊天记录、虚拟机镜像、工作区及浏览器资料保留。首次进入新版执行路径时建立 Hermes 会话，并携带近期聊天记录；新编号保存到 Runner 会话映射。已经提交而尚未确认的旧执行不能在新版会话中自动重放。停止和权限撤销会使该轮的本机及虚拟机工具失效。

### Skill、授权文件与配置

- 由 Hermes 原生 `skills_list`、`skill_view`、`skill_manage` 发现、读取和维护技能，包括 Hermes 自己支持的外部目录及插件技能。
- 技能依赖的本机登录态、环境变量和授权文件，由 Hermes 在对应 Profile 下使用。技能脚本需要在本机执行时，遵循该模式及 Hermes 的授权规则。
- Linux 脚本和普通输入文件可经 `computer_copy_file` 传入虚拟机。原文件由 Hermes 读取，Runner 只接收本次传输的字节；反向传输也由 Hermes 写入目标文件。每个文件上限 25 MiB，并检查会话、轮次及 Hermes 文件保护规则。
- 图片直接通过 Hermes 的 `image.attach_bytes` 接口进入会话。模型原生图片支持、辅助视觉模型和图片回退全部采用 Hermes 的完整配置。
- 不再注入 `computer_skills_list` / `computer_skill_view` / `computer_skill_publish` 等独立 Skill 实现。技能学习、扫描、写入审核及发布方式沿用 Hermes；既有 `skills/bot-learned` 文件继续保留。
- 虚拟机工作目录属于虚拟机。已有桌面沿用其保存的目录，新桌面使用 `/home/cua/workspace`；Hermes 自行解析本机 Profile 工作目录。创建、停止和人工接管不读取本机 Profile 配置。

### 更新配套组件

管理员可在 **设置 → Hermes 连接 → 工具桥插件** 检查、安装、更新或重新安装。

- 每个 Profile 单独显示安装版本、实际加载版本和状态。缺少后台入口时，先安装或更新默认 Profile，再安装命名 Profile。
- “安装并启用”只启用选中的工具桥及其工具集，保留其他插件、禁用项和模型配置。每次安装保留原插件与配置备份，界面可查看备份位置。
- 检查会比较插件文件指纹与 Hermes 启动时加载的指纹；同版本修复后未重启也会显示“待重启”，不会仅凭安装文件判断就绪。
- 安装不会自动重启 Hermes。页面中的“重启服务端 Hermes Dashboard”始终通过当前连接的 Yaoyao 服务端执行；页面显示的 `127.0.0.1:9119` 指服务端本机，手机、浏览器或桌面客户端不会在自己的电脑上执行重启。重启影响整个 Dashboard，而非单个 Profile，完成后自动检查各 Profile 的实际加载状态。
- 支持 Yaoyao 服务端自己持有的 Dashboard 子进程，以及 macOS 服务端当前账号的 Hermes LaunchAgent（包括自定义服务名）。服务的运行 PID 必须与 9119 的唯一监听进程匹配，支持 `hermes dashboard/serve`、Python 脚本和 `python -m hermes_cli.main` 入口及 Profile 参数。
- macOS 同账号通过终端启动的 Hermes 也可重启：检查唯一监听 PID、UID、Hermes 入口、父进程及有限的启动参数后，只向该 PID 发出 SIGTERM，确认退出和端口空闲后按原参数和工作目录启动。不会调用停止所有 Dashboard 的命令，不接管未知服务包装器或 SSH 会话后端。重启前重新核对，重启后确认新 PID 和 HTTP 健康状态；本机健康检查不继承外网代理。无需开启桌面模式或 Dashboard 自动拉起。
- 正在执行任务、安装工具桥或已有重启操作时不可重启；重启期间暂不接受新任务，定时任务等待下一次检查。无法确认归属的外部进程、其他系统的外部服务、Docker 目录映射与远程 Hermes 会保留禁用按钮并显示原因，需在 Hermes 所在节点重启，再点击“重新检查”。正在执行任务时暂不可安装。
- 本机安装用于当前服务可访问的本机 Hermes。Docker 可显式映射对应 Hermes 数据目录以安装工具桥，详见 [Docker 目录映射](docker-install.md#映射-hermes-目录以安装工具桥)；其他远程节点支持状态检查，需在对应节点安装。

管理员 API：`GET /api/app/admin/hermes-bridge`、`POST /api/app/admin/hermes-bridge/install` 与 `POST /api/app/admin/hermes-bridge/restart`。重启接口无需参数，状态中的 `dashboard` 提供托管状态、是否可重启及原因；安装参数仅为 `profile` 和可选的 `enable`。不接受客户端指定重启目标或执行命令。

需要 Runner 的 `hermes-computer-v2` 和 `workspace-memory-bind-v1` 能力，以及每个使用中的 Profile 安装工具桥 **1.2.1**，能力响应包含 `computer_runtime_version: 2`。旧插件会明确提示更新，不回退启动 Worker。

插件源码位于 `integrations/hermes-bots-bridge`，并随 Runner 和桌面服务打包。使用 Hermes 的 Python 安装，例如：

```sh
~/.hermes/hermes-agent/venv/bin/python scripts/install-hermes-bridge.py \
  --hermes-home ~/.hermes --profile default --profile server
```

安装器备份原插件和配置，只启用对应插件，保留其他配置及显式禁用项。Named Profile 需要分别指定；安装器不重启服务。部署新版 Yaoyao / Runner 并在空闲时重启 Hermes 后生效。升级运行中的服务前应结束或停止已有任务。

Compose 桌面也走同一个 Hermes 会话接口；桌面数量、生命周期、网络策略及端口转发边界保持原有配置。

## 上下文与恢复

上下文压缩、模型限额、代理和辅助模型配置都由 Hermes 使用完整 Profile 处理。Runner 保存虚拟机租约和 Hermes 持久会话编号，压缩后的新编号继续更新，后续历史读取通过对应 Hermes 会话。

Hermes 主动发起的审批与澄清 RPC 会转换为 Bot 交互卡；答复使用对应请求编号回传，取消和恢复连接后的待答请求也会同步。

普通聊天、Bot 聊天显示记录和 Hermes 执行会话仍分别保存。切换执行版本不删除原记录，也不重做已完成的工具调用。会话失败按 Hermes 的结构化结果展示；中断和撤权继续停止旧执行并关闭工具桥。

## 镜像与持久状态

动态 Docker/Podman 桌面按环境 UUID 在 Runner 的 `computer-userdata/<UUID>/` 保存 `/home/cua`、`/root` 和 machine-id；工作区仍位于 `computer-workspaces/<UUID>/`。浏览器完整配置、软件用户配置及用户钥匙串随环境保留。普通停止、重建、移除实例、服务重启和切换镜像不会删除这些目录；明确删除环境数据（包括临时助手清理）才删除。独立环境各自保存资料，共享环境的成员共享同一份资料。

旧容器首次移除或重建时先确认停止，再复制用户目录，全部完成后才发布持久目录。迁移失败保留旧容器并报错，不会用空白资料继续创建。宿主资料目录仅当前用户可访问，不把文件内容写入日志或模型上下文。已有浏览器工作区路径继续兼容。

配套 macOS 服务更新器在旧 Web 进入维护状态后、退出前运行资料迁移，避免旧版退出时删除尚未迁移的容器。使用外部 Runner 或旧版更新器时，应先停止任务并用新版维护工具备份，再结束旧进程；不要先删除旧容器。

更换镜像首次启动前会在 `computer-backups/<UUID>/before-image-*` 自动备份工作区和用户资料；备份失败不会启动新镜像。备份可通过维护工具恢复，且不会被后续重建覆盖或自动删除。资料目录意外缺失时停止自动重建，避免把原有环境变成空白登录状态。

持久化保留本地授权材料，网站的到期、撤销、设备验证规则仍生效。现有钥匙串密码和加密方式不变，需要交互解锁的钥匙串仍按原方式解锁。安装在 `/usr`、`/opt`、`/var/lib` 等系统目录的软件及授权需要通过镜像或该软件的持久目录安排；更换大版本前应备份，降级时配合恢复数据。Compose 外部桌面的卷仍由部署配置，这里的自动迁移适用于动态桌面。

- 标准桌面沿用现有 XFCE 镜像；Cursor Universal 基于 `public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest` 的固定 amd64 摘要，并添加相同的 CUA 0.20.0 驱动和私有桥接协议。原始镜像不能直接填入现有桌面镜像配置。
- Cursor 镜像目前只有 Linux amd64；Apple 芯片上的 Docker/Podman 需要支持 amd64 模拟。macOS arm64 App 安装包不代表有 Linux arm64 桌面镜像。
- 每台独立桌面拥有自己的工作目录和浏览器资料。同一共享桌面只有一个持久镜像选择，所有成员看到同一个选择。
- 准备第二个镜像不会替换已有实例的镜像。切换前先停止任务、交还控制权，在电脑面板点击“移除实例”，再选择新镜像并创建。实例移除保留持久数据，后续启动和重启沿用已选镜像。
- `POST /api/app/admin/local-vm/prepare` 接受可选的 `imageKey: standard | cursor`；`PUT /api/app/agents/:id/local-vm/image` 保存该桌面的镜像选择。客户端只能选择已准备的配套镜像，不能提交任意镜像 ID。

## 手机端

iOS/Android 没有全局虚拟桌面清单、镜像设置或执行环境选择。入口在 **当前 Agent 聊天右上角的电脑图标**。单个 Agent 直接打开画面，群聊有多台电脑时选择当前聊天成员的电脑，同一共享环境只显示一次。

黑底全屏、按原比例显示画面，顶部是 Agent 名称、共享标识和状态，底部是接管/交还操作。键盘、文字、滚动及交还说明单独展开。未启用电脑的 Agent 显示桌面端配置提示，不由手机自动创建环境。

## 范围与接口

- 已删除此前的“电脑与环境”聊天列表入口、独立镜像目录、应用/回退/导入/导出界面及相应管理 HTTP API。
- 旧工作区、旧共享数据、已下载归档和 Docker 镜像不会因删除界面而被删除。无人使用的保留实例可在本地虚拟机设置中停止或移除，工作文件继续保留。
- 托管的本机 Runner 凭据只在服务端加密保存，重启 Web 后自动连接；高级外部 Runner 仍可沿用现有连接配置。
- 本地虚拟机运行在当前连接的服务所在电脑，不跨机器合并容量。
- `GET /api/app/admin/local-vm` 提供准备状态、容量和本账号虚拟机实例（含机器人桌面数）；Docker 版返回 `supported:false`。`POST /prepare` 准备托管镜像；`PUT /policy` 只接受 `maxInstances`（同时运行的账号虚拟机，1–8）和可选的 `maxDesktops`（每台虚拟机的机器人桌面，1–8），不再接受 `mode`。
- `/api/app/agents/:id/local-vm` 返回该机器人的状态，含 `licensed`、`supported`、`desktop:{display,running}`、`desktops`/`maxDesktops`；`PUT` 打开或关闭该机器人的虚拟机；`POST /:action` 的 create/start/stop/recreate/remove 只作用于这个机器人的桌面。未开通的账号返回 `403 local_vm_unlicensed`。
- `PATCH /api/app/admin/users/:id` 和创建用户接口接受 `vmLicensed`；用户列表返回 `vmLicensed`（管理员恒为 true）。`GET /api/app/settings/host-tools` 额外返回 `vmSupported`、`vmLicensed`，子账号看到的 `vm` 已结合许可。
- `POST /api/app/computers/shared` 返回 `410 shared_computer_retired`。
- 执行节点需要声明 `bot-desktops-v1`；旧 Runner 会提示更新。
- 屏幕与输入沿用受控的 `/api/app/agents/:id/computer` 通道。输入绑定账号、Agent、当前控制令牌、租约版本和截图；旧租约不能继续操作。
- 应用设置只向管理员开放。虚拟机不会跨账号或执行节点共享；面板操作会拒绝正在由这个机器人或人工控制的桌面，镜像切换要求整台账号虚拟机空闲。

## 验收

测试覆盖准备与权限、持久化、实例生命周期、空闲配额、控制权失效、共享范围、聊天右侧面板、双桌面移交及手机聊天入口。另有真实 Docker + Hermes Worker 和从设置自动准备到聊天内操作真实桌面的测试，界面截图来自隔离验收环境。


本轮验收结果：787 项单元/集成测试通过；7 项环境限定测试跳过。7 项浏览器流程、iOS 3 项界面流程、Android 2 项界面流程通过。真实 Hermes Worker + Docker 流程 2 项通过；自动准备本机 Runner、真实桌面键盘输入及快捷键、重启保留文件、双桌面控制切换的完整界面流程通过。

截图：[本地虚拟机设置](screenshots/local-vm/settings.png)、[Agent 聊天右侧电脑面板](screenshots/local-vm/agent-panel.png)、[交互桌面](screenshots/local-vm/interactive-desktop.png)、[双桌面工作区](screenshots/local-vm/two-desktops.png)、[手机聊天入口](screenshots/local-vm/phone-chat-entry.png)。
