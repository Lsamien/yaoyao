# Docker 部署夭夭 Web

## 准备

- 安装 Docker Engine 和 Compose，或 Docker Desktop。
- 准备容器可访问的 Hermes Dashboard/Gateway，通常使用 9119 端口。
- 获取本项目源码，在仓库目录执行后续命令。

## 配置与启动

```sh
cp docker.env.example docker.env
```

编辑 `docker.env`：

| 配置 | 用途 |
| --- | --- |
| `HERMES_YAOYAO_UPSTREAM` | Hermes 上游地址，默认 `http://host.docker.internal:9119` |
| `HERMES_YAOYAO_BIND_ADDRESS` | Web 的宿主机发布地址，默认 `127.0.0.1`；局域网访问可设为 `0.0.0.0` |
| `HERMES_YAOYAO_PUBLISHED_PORT` | 宿主机 Web 端口，默认 `15300` |
| `HERMES_YAOYAO_ALLOWED_HOSTS` | 使用域名访问时填写对应域名，多个值用英文逗号分隔 |
| `HERMES_YAOYAO_CHAT_CACHE_MODE` | 普通聊天缓存策略，默认 `prefer-local` |

Docker Desktop 可通过 `host.docker.internal` 访问宿主机。Linux 上 Compose 将该名称映射到宿主机网关；Hermes 需要监听容器可访问的宿主机地址。远程 Hermes 直接填写其可访问地址。

```sh
docker compose --env-file docker.env config --quiet
docker compose --env-file docker.env up -d --build
docker compose --env-file docker.env ps
```

默认打开 `http://127.0.0.1:15300`。局域网设备使用宿主机 IP 和发布端口访问。首次打开页面创建管理员账号，再到系统设置配置 Hermes 连接凭据。通过域名提供公网访问时，在反向代理上配置 HTTPS，并将域名加入允许列表。

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

如部署前要调整数量或名称，编辑 `deploy/compose-desktops.json`，保留已有桌面 ID，重新生成配套文件：

```sh
node scripts/generate-desktop-compose.mjs
node scripts/generate-desktop-compose.mjs --check
docker compose --env-file docker.env -f compose.desktops.yaml up -d --build
```

生成器会把 Web 连接清单、桌面服务和数据卷同步写入同一个 Compose 文件。运行中不能通过 Web API 扩容。不要用 `down --volumes` 更新部署，否则会删除工作文件。

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

只需要 Web 服务、继续使用既有外部动态桌面的部署仍可使用 `compose.yaml`；两种部署文件任选其一，不要让两套 Web 同时写同一数据卷。

验收截图：[Docker Web 的 Agent 桌面](screenshots/compose-desktops/agent-desktop.png)。验收使用独立数据和测试模型服务，桌面与容器连接是真实运行。

## 数据与备份

Compose 使用 `yaoyao-data` 命名卷，挂载到 `/var/lib/hermes-yaoyao`。账号、SQLite 数据库、聊天缓存、文件及密钥随数据卷持久保存。固定桌面部署还必须备份每台桌面的 `desktop-*-workspace` 卷；`desktop-*-ipc` 卷只是连接通道。

备份时先停止 Web，然后复制完整数据目录，再启动服务：

```sh
mkdir -p backups
docker compose --env-file docker.env stop web
docker compose --env-file docker.env cp web:/var/lib/hermes-yaoyao/. ./backups/
docker compose --env-file docker.env start web
```

为每次备份使用独立目录，并保留文件权限。恢复时将完整备份放回数据卷，确认容器内 `node` 用户可以读写后再启动服务。

## 升级与停止

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
