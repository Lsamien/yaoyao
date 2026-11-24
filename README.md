# 夭夭 AI

当前 Web 与 macOS 桌面发布版本：**v0.5.0**。桌面版提供 Apple Silicon（arm64）客户端正式 DMG；本次提供 Android 正式安装包，完整版桌面安装包与 Windows 继续沿用旧版，详见 [发布说明](docs/releases/v0.5.0.md)。

夭夭 AI 为网页、iOS 和安卓提供统一的 Agent、群聊、文件库及语音配置服务。Hermes（0.23.0）已内置在夭夭服务中，由服务端直接拉起内核进程执行任务，不再需要单独运行 9119 服务。

## 聊天与 Agent

- 在已有 Hermes Profile 基础上创建角色，填写名称、头像、提示词和规则。创建不会复制或修改基础 Profile。
- 每个角色只有一条连续单聊；角色可加入多个群聊。单聊与各群聊分别使用独立会话。
- 聊天列表混排角色单聊与群聊，不含默认 Profile 对话，没有独立话题列表。
- 群聊可增减成员，当前管理员不能移除。可修改群规则、管理员、协作方式和自动回复轮数；默认管理员协调、3 轮。
- 角色规则在下一次执行生效。归档角色隐藏单聊并禁止再加入群聊，但不自动移出现有群聊。
- 所有账号统一通过 Bot 模式使用聊天和工具。
- 新聊天、事件及文件按登录用户隔离；基础 Profile 的工具、技能和既有记忆能力继续由 Hermes 管理。

Bot 模式的“工具”菜单提供“自动化”和“已连接应用”两个独立入口。“已连接应用”统一管理应用连接与 MCP；“自动化”使用独立的日历、任务列表和运行日志页面。所有账号均可从底部菜单打开独立的“关于”对话框。这些页面不属于设置中心。

远程电脑：其他 Mac 上的夭夭 App 启动时可选择「登录远程」或「进入本地」；登录远程用服务器地址加账号密码登录（与手机端一致的凭据方式），窗口直接使用远程服务器（15300）的夭夭界面，本机不运行 Web 服务；管理员账号登录同时把这台 Mac 注册为可远程控制的电脑，供服务器上的 Bot 操作。每个机器人可并列启用本地虚拟机、云端和多台 Mac 的电脑控制，工具按在线情况同时可用。详见 [服务器与电脑](docs/desktop-hosts.md)。

## 运行

需要 Node.js 24。内置 Hermes 内核需要 Python 3.11 和锁定依赖，`npm run kernel:setup` 会用 uv 自动准备（缺少 uv 时自动下载）。

```sh
npm ci
npm run kernel:setup
npm run build
npm start
```

默认 Web 地址为 `http://127.0.0.1:15300`。首次打开 Web 时自行创建管理员账号；服务不会生成固定的默认账号或密码。之后在服务器本机打开管理后台 `http://127.0.0.1:15301`，用管理员账号登录，在「模型服务」中配置模型供应商和默认模型。

### 管理后台

用户、模型服务与 API Key、执行与权限、电脑与执行节点、本地虚拟机、推送、语音、访问地址和更新，都在独立的管理后台中设置。后台与 Web 同进程运行，但使用单独的端口（默认只监听 `127.0.0.1:15301`）、登录和会话，只允许管理员登录；支持验证器 App 二次验证、高风险操作再次确认密码和审计日志。夭夭 Web 不再提供管理接口。从其他电脑管理请用 SSH 隧道。详见 [管理后台](docs/admin-console.md)。

### 内置 Hermes

- 源码位于 `runtime/hermes`（Hermes 0.23.0，取自 yaovi-agent 的内置适配版本）；`runtime/worker.py` 每轮对话启动一个内核进程，`runtime/hermes_service.py` 负责模型、配置与授权等管理操作。
- 数据保存在 `<数据目录>/hermes`：默认 Profile 即该目录，具名 Profile 在 `hermes/profiles/<名称>`；每个 Bot 使用独立的 `bots/<Bot ID>/runtime`，以所选 Profile 为父级读取配置和凭据。
- 首次启动时如果检测到原有 `~/.hermes`（或 `YAOYAO_IMPORT_HERMES_HOME` 指定的目录），会只读导入会话、Profile、配置、凭据、技能和附件，不修改原目录；导入失败时从空数据启动并在日志中提示。设置 `YAOYAO_IMPORT_HERMES=0` 可跳过导入。
- Hermes 原生终端、文件和代码工具在服务器上执行，按系统设置中的审批策略逐次确认。
- 管理员在管理后台「模型服务」中配置供应商与默认模型、订阅账号登录（设备码 / 粘贴凭据）、API Key 与工具密钥，以及视觉、压缩、标题等辅助模型，替代原来的 Hermes Dashboard 页面。可按 Profile 分别配置。
- 不再支持：连接外部 9119、工具桥插件 `yaoyao-bot-bridge`、Hermes 看板（Kanban）、直连远程 Hermes 的节点。设置 `HERMES_YAOYAO_UPSTREAM*`、`HERMES_YAOYAO_SUPERVISE_DASHBOARD`、`HERMES_YAOYAO_BRIDGE_*` 后，启动时会提示这些变量已停用。
- 迁移方案与实施记录见 [内置 Hermes 迁移](docs/embedded-hermes-migration.md)。

Web 数据默认保存在 `~/.yaoyao`，可用 `YAOYAO_HOME` 指定（兼容 `HERMES_YAOYAO_HOME`）。旧默认目录 `~/.hermes-yaoyao` 会在服务空闲并停止后整体迁移至 `~/.yaoyao`，保留账号、会话、文件和密钥；两目录同时有数据时停止迁移，避免覆盖。备份应包含整个数据目录及加密密钥。

夭夭只保留 Bot 模式：所有账号（包括管理员）都在「聊天」中通过 Bot 单聊和群聊使用 Hermes。原来的普通聊天、只读历史、文件库页面和 `chat-cache.sqlite3` 已删除，旧链接 `/chat`、`/history`、`/files` 会跳转到 `/conversations`；需要旧会话内容时，请在 Bot 中引用或重新发起。

## macOS 桌面版

桌面版分两种，安装包均为 Apple Silicon（arm64）：

- **夭夭（客户端）**：连接远程服务器使用，本机不运行 Web 服务。下载 `Yaoyao-<版本>-arm64.dmg`，拖到应用程序后打开，首次启动填写服务器地址并登录。适合服务器已部署（Docker 或 npm）的场景，也是此后主推的桌面形态。
- **夭夭完整版**：内嵌本机 Web 服务与执行节点的双模式版本，可「本机运行」也可「连接远程」。适合希望一台 Mac 同时充当服务器与客户端的用户。

两份 App 的安装目录与数据目录相互独立，可以并存。客户端沿用历史安装身份，从旧版「夭夭」升级安装时原地替换、保留登录与配置。

桌面安装包的签名、公证状态及自动升级可用范围见对应版本的 GitHub 发布说明。详细说明见 [macOS App](docs/macos-app.md)。

## npm 安装

已有 Node.js 24 环境时，服务端可通过 npm 一条命令安装：

```sh
npm install -g @lsamien/yaoyao
yaoyao service install
```

安装脚本会准备内置 Hermes 内核；若 npm 跳过了安装脚本，可运行 `yaoyao setup`（首次启动也会自动补做），并用 `yaoyao doctor` 检查。安装后访问 `http://127.0.0.1:15300` 创建管理员账号。macOS 通过 LaunchAgent 开机自启；Linux 的服务安装支持在路线图中。详见 [npm 安装说明](docs/npm-install.md)。

执行 `yaoyao service restart` 重启服务，执行 `yaoyao --version`（或 `yaoyao version` / `yaoyao -v`）查询已安装的 npm 包版本。

## Docker 安装

远程镜像发布在 [Docker Hub](https://hub.docker.com/r/samienluo/yaoyao)：

| 镜像 | 架构 |
| --- | --- |
| `samienluo/yaoyao:v0.5.0-amd` | AMD64 |
| `samienluo/yaoyao:v0.5.0` | 自动匹配 AMD64 / ARM64 |
| `samienluo/yaoyao:latest` | 最新稳定版通用镜像，当前与 `v0.5.0` 相同 |

准备好 Docker Engine/Compose，在仓库目录将 `docker.env.example` 复制为 `docker.env`。镜像已内置 Hermes 内核和 Python 依赖；如需导入原有 Hermes 数据，设置 `HERMES_YAOYAO_HERMES_DIR` 并在启动命令中加 `-f compose.hermes-import.yaml`。设置 `HERMES_YAOYAO_IMAGE=samienluo/yaoyao:v0.5.0`（或 `samienluo/yaoyao:latest`），即可使用远程镜像：

```sh
docker compose --env-file docker.env pull web
docker compose --env-file docker.env up -d --no-build web
```

从本地源码构建时，在仓库目录执行：

```sh
cp docker.env.example docker.env
# 按实际环境修改 docker.env 中的发布地址
docker compose --env-file docker.env config --quiet
docker compose --env-file docker.env up -d --build
```

默认访问 `http://127.0.0.1:15300`。应用数据保存在 `yaoyao-data` 命名卷，容器内路径为 `/home/node/.yaoyao`。首次打开页面创建管理员账号，并在管理后台（`http://127.0.0.1:15301`）的「模型服务」中配置模型。

宿主机连接、局域网访问、验证及升级步骤见 [Docker 部署说明](docs/docker-install.md)。

需要随 Docker Web 部署电脑环境，可使用 `compose.desktops.yaml`（两台标准桌面）或 `compose.desktops.cursor.yaml`（一台 Cursor Universal 开发桌面）。Cursor 方案基于 `public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest` 加入夭夭桌面桥接层，配置与启动命令见 [Cursor 桌面部署](docs/docker-install.md#cursor-universal-可选配置)。

## iOS

iOS 与 Android 统一连接 Web 地址，通过设置中的手机登录二维码或账号密码登录。服务端已内置 Hermes，手机端需升级到支持内置 Hermes 的版本；旧 15300 Web 账号和本机聊天缓存继续保留。

## 数据与升级

npm 安装的 macOS 服务支持在「更新与回滚」中下载 npm 新版本，下载完成后点击「重启服务器」覆盖当前安装，不保留旧版本，临时包自动清理。参见 [npm 安装说明](docs/npm-install.md)。

源码 Web 默认从 [GitHub Releases](https://github.com/Lsamien/yaoyao/releases) 检查稳定版本；桌面菜单“检查 App 更新…”可下载并校验 DMG 后手动安装。旧官方发布源会自动归一化为 GitHub，自定义仓库保留。详见 [GitHub 版本升级](docs/github-updates.md)。

发布版本由 `release.json` 记录。macOS 源码/发布包服务支持在系统设置中升级 Web 或回滚到上一个版本；其他源码部署更新代码、重新构建并重启服务，Docker 部署通过拉取远程镜像（或自行构建）并重建容器更新。升级前备份 Web 数据目录，客户端版本要求见对应发布说明。

后续发布同时交付本地构建和 Docker Hub 远程镜像，验证固定版本后更新 `latest`，保留旧版本标签。发布者按 [发布流程](docs/release-process.md) 执行，并将镜像地址、架构和验证结果写入发布说明。

## 开发验证

```sh
npm run typecheck
npm test
npm run build
npm run kernel:test   # 内置 Hermes 内核与模型服务（需先运行 npm run kernel:setup）
```

接口契约见 [聊天接口与运行模型](docs/workspace-chat.md)，安装步骤见 [部署说明](docs/agent-install.md)。

## 许可证

Apache-2.0，详见 [LICENSE](LICENSE)。第三方组件保留各自许可与署名，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
