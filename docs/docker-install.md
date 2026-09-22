# Docker 部署夭夭 AI

## 准备

- 安装 Docker Engine 和 Compose，或 Docker Desktop。
- 准备容器可访问的 Hermes Dashboard/Gateway，通常使用 9119 端口。
- 获取本项目源码，在仓库目录执行后续命令。

## 已发布的远程镜像

镜像仓库：[samienluo/yaoyao](https://hub.docker.com/r/samienluo/yaoyao)。

| 标签 | 架构 |
| --- | --- |
| `v0.4.67-amd` | `linux/amd64` |
| `v0.4.67` | `linux/amd64`、`linux/arm64`，拉取时自动匹配 |
| `latest` | 最新稳定通用镜像，当前指向与 `v0.4.67` 相同的镜像 |

```sh
docker pull samienluo/yaoyao:v0.4.67
# 需要固定 AMD64 时：
docker pull samienluo/yaoyao:v0.4.67-amd
```

每次新版本发布都会更新 `latest`，旧版本标签继续保留。需要固定部署版本时使用具体版本标签。

## 配置与启动

```sh
cp docker.env.example docker.env
```

编辑 `docker.env`：

| 配置 | 用途 |
| --- | --- |
| `HERMES_YAOYAO_IMAGE` | 远程镜像可设为 `samienluo/yaoyao:v0.4.67` 或 `samienluo/yaoyao:latest`；未设置时使用本地构建名称 |
| `HERMES_YAOYAO_UPSTREAM` | Hermes 上游地址，默认 `http://host.docker.internal:9119` |
| `HERMES_YAOYAO_BIND_ADDRESS` | Web 的宿主机发布地址，默认 `127.0.0.1`；局域网访问可设为 `0.0.0.0` |
| `HERMES_YAOYAO_PUBLISHED_PORT` | 宿主机 Web 端口，默认 `15300` |
| `HERMES_YAOYAO_ALLOWED_HOSTS` | 使用域名访问时填写对应域名，多个值用英文逗号分隔 |
| `HERMES_YAOYAO_CHAT_CACHE_MODE` | 普通聊天缓存策略，默认 `prefer-local` |

Docker Desktop 可通过 `host.docker.internal` 访问宿主机。Linux 上 Compose 将该名称映射到宿主机网关；Hermes 需要监听容器可访问的宿主机地址。远程 Hermes 直接填写其可访问地址。

使用远程镜像时，在 `docker.env` 设置上述镜像标签后执行：

```sh
docker compose --env-file docker.env config --quiet
docker compose --env-file docker.env pull web
docker compose --env-file docker.env up -d --no-build web
docker compose --env-file docker.env ps
```

从本地源码构建时执行：

```sh
docker compose --env-file docker.env config --quiet
docker compose --env-file docker.env up -d --build
docker compose --env-file docker.env ps
```

默认打开 `http://127.0.0.1:15300`。局域网设备使用宿主机 IP 和发布端口访问。首次打开页面创建管理员账号，再到系统设置配置 Hermes 连接凭据。通过域名提供公网访问时，在反向代理上配置 HTTPS，并将域名加入允许列表。

## 映射 Hermes 目录以安装工具桥

可额外加载 `compose.hermes-bridge.yaml`，让“设置 → Hermes 连接 → 工具桥插件”直接检查、安装和修复共享目录中的插件。这个可选文件适用于普通 Web、标准共享桌面和 Cursor 共享桌面三种 Compose 配置。

在 `docker.env` 中填写 **上游 Hermes 实际使用的数据目录** 的宿主机绝对路径。该目录应包含 `config.yaml`，命名 Profile 位于其中的 `profiles/`：

```dotenv
# Linux 示例；macOS 可填写 /Users/你的用户名/.hermes。
HERMES_YAOYAO_HERMES_DIR=/srv/hermes-data
```

普通 Web 使用：

```sh
docker compose --env-file docker.env -f compose.yaml -f compose.hermes-bridge.yaml config --quiet
docker compose --env-file docker.env -f compose.yaml -f compose.hermes-bridge.yaml up -d --build web
```

若使用共享桌面，将上面的第一个 `-f compose.yaml` 换成 `-f compose.desktops.yaml` 或 `-f compose.desktops.cursor.yaml`，保留第二个映射文件。

- 宿主目录以读写方式挂载到容器 `/hermes`，必须已存在；路径写错时不会自动创建一个空 Hermes 目录。
- 选择与 `HERMES_YAOYAO_UPSTREAM` 对应实例相同的数据目录。远程主机的目录需要先以共享存储等方式提供给 Docker 宿主机。
- Web 仍使用非 root 用户，默认 UID/GID 为 `1000:1000`。映射目录需要允许该用户读取配置，并写入 `config.yaml`、`plugins/`、`profiles/` 和 `backups/`。权限不匹配时应在宿主机配置对应用户或 ACL；Web 页面会报告读取或安装失败。
- 镜像自带 Linux Python 3 和 PyYAML。安装器只使用容器 `/usr/bin/python3`，宿主机的 `venv` 和 Hermes 程序不会被执行。
- 安装前备份插件与配置，先安装默认 Profile 的后台入口，再处理命名 Profile。安装后在 Hermes 所在节点重启服务，再在 Web 点击“重新检查”。
- 映射不会赋予 Web 管理 Docker 或 Hermes 进程的能力；既有 Compose 桌面数量、隔离设置及生命周期继续按原配置管理。

此功能需要包含本次改动的新镜像；旧的远程镜像标签不会因添加目录映射而自动获得安装功能。可按上述命令从当前源码构建。

自定义部署可使用以下容器环境变量：

| 配置 | 用途 |
| --- | --- |
| `HERMES_YAOYAO_BRIDGE_MOUNTED=1` | 明确允许通过映射目录安装工具桥 |
| `HERMES_YAOYAO_BRIDGE_HOME=/hermes` | 容器内实际挂载路径，必须是绝对路径 |
| `HERMES_YAOYAO_BRIDGE_PYTHON=/usr/bin/python3` | 容器自身的 Python 路径 |

仅设置目录但没有开启 `BRIDGE_MOUNTED` 时，外部 Hermes 仍只提供状态检查，不开放目录安装。

## 验证

以下命令使用默认发布端口；修改端口后同步调整 URL：

```sh
curl --fail http://127.0.0.1:15300/healthz
curl --fail http://127.0.0.1:15300/readyz
docker compose --env-file docker.env logs --tail=100 web
```

`healthz` 检查 Web 服务，`readyz` 检查 Hermes 上游。若上游不可达，检查 `HERMES_YAOYAO_UPSTREAM`、Hermes 监听地址及网络连通性；若需要认证，在 Web 系统设置中保存连接凭据。

登录后创建会话、收发消息、上传并下载附件，验证实际使用流程。

## 随 Web 一起部署固定共享桌面

`samienluo/yaoyao` 是 Web 服务镜像；共享桌面使用独立的桌面镜像。

使用配套的 **单个 `compose.desktops.yaml`** 部署文件，同时创建 Web 和共享桌面容器。默认示例为两台桌面；不是在 Web 页面里临时创建虚拟机。

```sh
cp docker.env.example docker.env
# 配置 Web 发布地址、端口和已有 Hermes 的 9119 地址。
docker compose --env-file docker.env -f compose.desktops.yaml up -d --build
docker compose --env-file docker.env -f compose.desktops.yaml ps
```

- Compose 创建几台，页面就显示几台；没有数量修改、镜像准备、创建、删除或重建按钮。
- Agent 聊天右上角 **电脑 → 此 Agent 使用的电脑**，选择已有的“共享桌面 1 / 共享桌面 2”等目标。多个 Agent 可以连接同一台共享桌面，复用文件和浏览器资料。
- 桌面连接使用专用 Unix socket 数据卷。Web 容器不挂载宿主 Docker socket，桌面也不发布 VNC、HTTP 或控制端口。
- 每台桌面的工作文件放在独立的 `desktop-*-workspace` 命名卷内。Compose 桌面统一使用 `/home/cua/workspace`，不会更改基础 Profile 的工作目录配置。
- 示例桌面使用 `network_mode: none`，默认没有桌面外网。网络、资源额度、镜像版本和服务数量均由部署者在 Compose 中管理；本机 App 的动态虚拟机模式保持原有方式。

如部署前要调整数量、名称或镜像，编辑 `deploy/compose-desktops.json`，保留已有桌面 ID，重新生成配套文件：

```sh
node scripts/generate-desktop-compose.mjs
node scripts/generate-desktop-compose.mjs --check
docker compose --env-file docker.env -f compose.desktops.yaml up -d --build
```

生成器会把 Web 连接清单、桌面服务和数据卷同步写入同一个 Compose 文件。运行中不能通过 Web API 扩容。不要用 `down --volumes` 更新部署，否则会删除工作文件。

### Cursor Universal 可选配置

新部署可直接选择仓库中的 **`compose.desktops.cursor.yaml`**，同时启动 Web 和一台“Cursor 开发桌面”。这是完整部署文件，单独使用；与 `compose.yaml`、`compose.desktops.yaml` 三选一，不要叠加启动。电脑环境是共享宿主内核的 Linux 桌面容器。

| 项目 | 配置 |
| --- | --- |
| 上游基础镜像 | `public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest` |
| 构建固定版本 | `sha256:858b6df5d0aeffd5db0e20c81553e98f84b07e9c700a13fcd1febac0e8c54830` |
| 兼容镜像 | `yaoyao-desktop:cursor`，通过 `deploy/computer/Dockerfile.cursor` 在本地构建 |
| 已发布兼容镜像 | `samienluo/yaoyao-desktop:v0.4.12-cursor-amd` |
| 架构 | `linux/amd64`；ARM64 宿主需要 Docker 的 amd64 模拟支持 |
| 桌面资源 | 2 CPU、4 GB 内存、512 MB 共享内存、512 个进程 |
| 持久工作目录 | `desktop-cursor-workspace` 卷 → `/home/cua/workspace`，含浏览器资料 |
| Web 连接 | `desktop-cursor-ipc` 卷中的私有 Unix socket，Web 只读挂载 |
| 桌面网络 | 默认 `network_mode: none`，不发布任何桌面端口 |

上游标签会变化，Dockerfile 固定已适配的 digest，加入 CUA 驱动、浏览器启动器和夭夭私有桥接协议。因此不能把上游原始镜像直接填到 `YAOYAO_CURSOR_DESKTOP_IMAGE`；该变量只用于指定构建后的兼容镜像名称。

首次配置（已有 `docker.env` 时直接编辑）：

```sh
cp -n docker.env.example docker.env
```

`docker.env` 的相关配置示例：

```dotenv
HERMES_YAOYAO_IMAGE=yaoyao:local
HERMES_YAOYAO_UPSTREAM=http://host.docker.internal:9119
HERMES_YAOYAO_BIND_ADDRESS=127.0.0.1
HERMES_YAOYAO_PUBLISHED_PORT=15300
YAOYAO_CURSOR_DESKTOP_IMAGE=yaoyao-desktop:cursor
```

使用本次源码构建 Web 与桌面镜像，然后启动：

```sh
docker compose --env-file docker.env -f compose.desktops.cursor.yaml config --quiet
docker compose --env-file docker.env -f compose.desktops.cursor.yaml build web desktop-cursor
docker compose --env-file docker.env -f compose.desktops.cursor.yaml up -d --no-build
docker compose --env-file docker.env -f compose.desktops.cursor.yaml ps
curl --fail http://127.0.0.1:15300/healthz
```

使用 Docker Hub 发布镜像时，在 `docker.env` 设置：

```dotenv
HERMES_YAOYAO_IMAGE=samienluo/yaoyao:v0.4.67
YAOYAO_CURSOR_DESKTOP_IMAGE=samienluo/yaoyao-desktop:v0.4.12-cursor-amd
```

直接拉取并启动，无需本地编译：

```sh
docker compose --env-file docker.env -f compose.desktops.cursor.yaml pull web desktop-cursor
docker compose --env-file docker.env -f compose.desktops.cursor.yaml up -d --no-build
```

Web 镜像自动匹配 AMD64 / ARM64；Cursor 桌面为 AMD64。已有标准桌面仍沿用其镜像配置。

随后按下方“[Hermes 执行连接](#hermes-执行连接)”注册或连接执行节点，再在 Agent 聊天的 **电脑 → 此 Agent 使用的电脑** 中选择“Cursor 开发桌面”。

需要浏览外网或下载依赖时，创建 `compose.desktops.network.yaml`：

```yaml
services:
  desktop-cursor:
    network_mode: bridge
```

之后启动、查看和停止均带上两个文件：

```sh
docker compose --env-file docker.env -f compose.desktops.cursor.yaml -f compose.desktops.network.yaml up -d --no-build
```

`bridge` 允许桌面通过宿主 Docker 网络出站，也可能访问宿主及局域网；它不提供本机动态桌面的受控外网代理策略。仅在部署网络允许时启用，并通过宿主防火墙管理访问范围。桌面仍不映射 VNC 或控制端口。网络模式语义见 [Docker Compose 服务配置](https://docs.docker.com/reference/compose-file/services/#network_mode)。

调整这套配置的桌面数量或名称时，编辑 `deploy/compose-desktops.cursor.json`，然后运行 `node scripts/generate-desktop-compose.mjs`；生成器同时更新两套部署文件，`--check` 同时检查它们。已有标准桌面的部署若只想切换一台镜像，应按下一节保留原有 ID、service 和工作卷。

### 同时部署两种镜像

在 `deploy/compose-desktops.json` 的每个桌面条目增加 `imageKey`：`standard` 为现有标准桌面（不填写时的默认值），`cursor` 为 Cursor Universal 兼容桌面。例如保留已有 ID 和 service，将第二台配置为：

```json
{"id":"eba5caaf-744e-4f27-bcdd-1f1f35d05a42","service":"desktop-2","name":"Cursor 开发桌面","imageKey":"cursor"}
```

然后运行上述生成和部署命令。生成器为 Cursor 桌面指定 `Dockerfile.cursor` 和 `platform: linux/amd64`；镜像名可通过 `YAOYAO_CURSOR_DESKTOP_IMAGE` 设置，标准桌面继续使用 `YAOYAO_DESKTOP_IMAGE`。两种变量应指向对应的夭夭兼容镜像，不能将上游原始 Cursor 镜像直接作为运行镜像。

聊天电脑面板显示每台桌面的镜像名称，机器人通过选择已有桌面来选择环境。不同桌面各自使用独立数据卷，可同时使用不同镜像；共享同一桌面的成员只能使用该桌面的一个镜像。改变现有条目的镜像会在下次 Compose 部署时重建该实例，请先结束使用它的任务，保留原有 ID、service 和数据卷。

### Hermes 执行连接

Compose 管理桌面，Hermes 执行连接负责模型运行和工具调用。沿用已有执行节点；新部署可在 **设置 → 本地虚拟机 → 打开执行节点设置** 下载程序和注册配置。此部署生成的配置自动带 `managedBy: compose`，执行节点不再创建桌面，也不需要安装 Docker。

执行节点只需已有 Hermes 和 Node.js 24+。默认 Hermes 路径可留空；自定义安装填写绝对路径。把下载的程序和 `runner.json` 放在运行 Hermes 的电脑：

```sh
mkdir -p yaoyao-runner
tar -xzf yaoyao-runner.tar.gz -C yaoyao-runner
chmod 600 runner.json
node yaoyao-runner/runner.mjs --config /完整路径/runner.json
```

整份程序目录须保留。节点配置包含私有凭据，不要提交到仓库。运行中的任务或接管操作仍有独占授权；交还后其他成员才能操作。取消无法确认结束的命令时，会重置对应桌面服务来终止旧程序，数量与数据卷保持不变。

只需要 Web 服务、继续使用既有外部动态桌面的部署仍可使用 `compose.yaml`；三种部署文件任选其一，不要让两套 Web 同时写同一数据卷。

验收截图：[Docker Web 的 Agent 桌面](screenshots/compose-desktops/agent-desktop.png)。验收使用独立数据和测试模型服务，桌面与容器连接是真实运行。

## 数据与备份

Compose 使用 `yaoyao-data` 命名卷，挂载到 `/home/node/.yaoyao`。账号、SQLite 数据库、聊天缓存、文件及密钥随数据卷持久保存。固定桌面部署还必须备份每台桌面的 `desktop-*-workspace` 卷；`desktop-*-ipc` 卷只是连接通道。

备份时先停止 Web，然后复制完整数据目录，再启动服务：

```sh
mkdir -p backups
docker compose --env-file docker.env stop web
docker compose --env-file docker.env cp web:/home/node/.yaoyao/. ./backups/
docker compose --env-file docker.env start web
```

为每次备份使用独立目录，并保留文件权限。恢复时将完整备份放回数据卷，确认容器内 `node` 用户可以读写后再启动服务。

## 升级与停止

使用远程镜像时，更新 `docker.env` 中的固定版本标签，或继续使用 `latest`，然后拉取并重新创建 Web 容器：

```sh
docker compose --env-file docker.env pull web
docker compose --env-file docker.env up -d --no-build web
docker compose --env-file docker.env ps
```

更新仓库源码后重新构建和启动：

```sh
docker compose --env-file docker.env up -d --build
docker compose --env-file docker.env ps
```

新容器继续使用已有的命名卷。升级前完成备份，并按发布说明更新配套客户端。

```sh
docker compose --env-file docker.env down
```

上述停止命令保留数据卷；`down --volumes` 会删除数据，应仅在明确清空部署时使用。
