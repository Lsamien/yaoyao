# 本地虚拟机

本实现参照 OpenMausBot 的 `LocalComputerSection.tsx`、`ComputerPanel.tsx`、`LocalVmWorkspace.tsx` 及手机 `ComputerView.swift` / `ComputerScreen.kt`。

## 使用流程

1. 进入应用设置 → **本地虚拟机**。macOS App 的应用菜单也提供“本地虚拟机设置…”。
2. 检查 Docker/Podman 已安装并启动，在 **准备虚拟机镜像** 中选择 **标准桌面** 或 **Cursor Universal**，点击 **准备所选镜像**。两个镜像可分别准备；会复用对应的兼容镜像或构建固定版本，验证驱动和实际截图后标记就绪。准备前先停止所有虚拟机任务和实例。外部执行节点需更新配套 Runner。
3. 选择 **共享虚拟机** 或 **每个 Agent 独立**，最多同时运行 1–4 台，默认 2 台。同一账号、同一执行节点的持久 Agent 共用桌面、工作文件和浏览器资料，新建成员会继承当前共享策略。临时任务助手继续使用任务隔离环境，完成后单独清理，不会删除持久共享工作区。
4. 打开 Agent 聊天，点击右上角 **电脑**。右侧电脑面板中选择 **本地虚拟机**，在 **虚拟机镜像** 中选择已准备的镜像，再创建桌面。独立桌面可分别选择不同镜像并同时运行；同一个共享桌面的所有成员只能使用这台桌面的一个镜像。
5. 右侧显示真实画面及运行状态，可停止或重建虚拟机；点击预览或 **打开桌面** 后接管交互。
6. **打开双桌面** 在主工作区显示两台虚拟机，保留聊天侧栏。进入时仅查看，不会创建/启动机器；切换操作对象时先交还前一台的控制权。

虚拟机实例移除或重建均保留工作目录和浏览器资料。正常完成任务和主动交还后桌面进入空闲状态；空闲 5 分钟后自动停止。取消、授权撤销、异常退出仍停止旧执行实例，以隔离迟到操作。基础 Profile 工作目录变化会在空闲时重建运行实例，数据保留。

切换共享方式不会修改普通 Profile 成员，也不会因其聊天任务而被阻止。已经交还控制权的空闲桌面可保持运行；虚拟机任务仍在执行、人工控制尚未交还或停止状态待核对时，继续保护原执行并拒绝切换。成员任务造成阻挡时，提示会显示具体成员名称。

`terminal.cwd` 默认的 `.`（以及 `auto`、`cwd`、未设置）指向虚拟机的持久工作区 `/home/cua/workspace`；相对路径以该工作区为起点，显式绝对路径继续沿用配置。创建、启动和人工接管只读取工作目录，不要求模型可用；停止和移除已有实例也不依赖 Profile 配置。模型仅在运行 Agent 时解析，Profile、目录和模型错误分别提示。

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
