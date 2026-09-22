# 本地虚拟机

本实现参照 OpenMausBot 的 `LocalComputerSection.tsx`、`ComputerPanel.tsx`、`LocalVmWorkspace.tsx` 及手机 `ComputerView.swift` / `ComputerScreen.kt`。

## 使用流程

1. 进入应用设置 → **本地虚拟机**。macOS App 的应用菜单也提供“本地虚拟机设置…”。
2. 检查 Docker/Podman 已安装并启动，在 **准备虚拟机镜像** 中选择 **标准桌面** 或 **Cursor Universal**，点击 **准备所选镜像**。两个镜像可分别准备；会复用对应的兼容镜像或构建固定版本，验证驱动和实际截图后标记就绪。准备前先停止所有虚拟机任务和实例。外部执行节点需更新配套 Runner。
3. 选择 **共享虚拟机** 或 **每个 Agent 独立**，最多同时运行 1–4 台，默认 2 台。同一账号、同一执行节点的持久 Agent 共用桌面、工作文件和浏览器资料，新建成员会继承当前共享策略。临时任务助手继续使用任务隔离环境，完成后单独清理，不会删除持久共享工作区。切换共享方式或重建本机执行节点时，服务会自动把成员归并到当前唯一共享组，并停止不再使用的旧桌面，避免旧实例占用运行数量上限。共享桌面上多个机器人的轮次并行执行：命令与文件操作并发运行（执行车道，最多 8 路同时），桌面鼠标键盘操作交替进行（桌面车道，一次一个）；启动、停止、换镜像等生命周期操作会先排空所有操作再执行。任一机器人的轮次失败只作废自己的执行权，最后一个使用者离开后才按空闲策略停止桌面。人工接管时暂停该桌面上的所有机器人，接管者与桌面上的其他持有者一样获得自己的执行权；交还后机器人继续原会话。
4. 打开 Agent 聊天，点击右上角 **电脑**。右侧电脑面板中选择 **本地虚拟机**，在 **虚拟机镜像** 中选择已准备的镜像，再创建桌面。独立桌面可分别选择不同镜像并同时运行；同一个共享桌面的所有成员只能使用这台桌面的一个镜像。
5. 右侧显示真实画面及运行状态，可停止或重建虚拟机；点击预览或 **打开桌面** 后接管交互。
6. **打开双桌面** 在主工作区显示两台虚拟机，保留聊天侧栏。进入时仅查看，不会创建/启动机器；切换操作对象时先交还前一台的控制权。

虚拟机实例移除或重建均保留工作目录和浏览器资料。正常完成任务和主动交还后桌面进入空闲状态；默认空闲 5 分钟后自动停止。应用设置 → **本地虚拟机 → 空闲自动停止** 可选择 1、5、10、15、30、60、120 分钟或 **永不自动停止**。设置保存在执行节点，适用于该节点的所有动态本地虚拟机。再次执行任务或接管时结束空闲计时，交还后重新计时；仅查看画面不会重置计时。

“永不自动停止”仅关闭空闲计时。手动停止、取消、授权撤销、运行中的控制租约过期及执行节点关闭仍会停止旧实例，以隔离迟到操作。虚拟机沿用已保存的工作目录，Hermes 本机工作目录单独解析。旧版 Runner 需要更新后才能修改此设置；Compose 桌面的启停仍由 Compose 管理。

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
- 支持 Yaoyao 服务端自己持有的 Dashboard 子进程，以及 macOS 服务端的 `com.samien.hermes.dashboard.local` / `ai.hermes.dashboard` LaunchAgent。系统服务须使用 Hermes 启动命令，且其运行 PID 必须与服务端 9119 的唯一监听进程匹配；重启前重新核对，重启后确认新 PID 和 HTTP 健康状态。无需开启桌面模式或 Dashboard 自动拉起。
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
- `GET /api/app/admin/local-vm` 提供准备状态、隔离策略和实例清单；`POST /prepare` 准备托管镜像，`PUT /policy` 更新策略。
- `/api/app/agents/:id/local-vm` 提供该 Agent 的配置和状态，`POST /:action` 提供 create/start/stop/recreate/remove。
- 屏幕与输入沿用受控的 `/api/app/agents/:id/computer` 通道。输入绑定账号、Agent、当前控制令牌、租约版本和截图；旧租约不能继续操作。
- 应用设置只向管理员开放。共享不会跨账号或执行节点；实例操作会拒绝正在由 Agent 或其他人控制的虚拟机。

## 验收

测试覆盖准备与权限、持久化、实例生命周期、空闲配额、控制权失效、共享范围、聊天右侧面板、双桌面移交及手机聊天入口。另有真实 Docker + Hermes Worker 和从设置自动准备到聊天内操作真实桌面的测试，界面截图来自隔离验收环境。


本轮验收结果：787 项单元/集成测试通过；7 项环境限定测试跳过。7 项浏览器流程、iOS 3 项界面流程、Android 2 项界面流程通过。真实 Hermes Worker + Docker 流程 2 项通过；自动准备本机 Runner、真实桌面键盘输入及快捷键、重启保留文件、双桌面控制切换的完整界面流程通过。

截图：[本地虚拟机设置](screenshots/local-vm/settings.png)、[Agent 聊天右侧电脑面板](screenshots/local-vm/agent-panel.png)、[交互桌面](screenshots/local-vm/interactive-desktop.png)、[双桌面工作区](screenshots/local-vm/two-desktops.png)、[手机聊天入口](screenshots/local-vm/phone-chat-entry.png)。

## Docker Web 的固定桌面

Docker Web 使用配套 `compose.desktops.yaml` 时，桌面由 Compose 预先创建。数量固定为部署清单中的数量，全部作为已有共享桌面供 Agent 选择。页面和 API 都不提供数量修改、镜像准备或桌面增删；每个桌面独立保留工作数据。此模式不会改变 macOS 本机的动态虚拟机流程。部署步骤见 [Docker 部署](docker-install.md)。

Bot 独立记忆通过工具桥的 `/bind` 授权设置。`session.create` 只使用 Hermes 公开参数；首次发言和恢复会话均先绑定独立记忆，再提交提示。工具桥只调整该会话 Agent 的记忆注入、记忆工具和后台复盘，Profile 配置及其他会话不受影响。
