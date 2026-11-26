# Docker 部署夭夭 AI

## 准备

- 安装 Docker Engine 和 Compose，或 Docker Desktop。
- 不需要单独的 Hermes 服务：镜像已内置 Hermes 0.23.0 内核及其 Python 依赖。
- 获取本项目源码，在仓库目录执行后续命令。

## 已发布的远程镜像

镜像仓库：[samienluo/yaoyao](https://hub.docker.com/r/samienluo/yaoyao)。

| 标签 | 架构 |
| --- | --- |
| `v0.4.77-amd` | `linux/amd64` |
| `v0.4.77` | `linux/amd64`、`linux/arm64`，拉取时自动匹配 |
| `latest` | 最新稳定通用镜像，当前指向与 `v0.4.77` 相同的镜像 |

```sh
docker pull samienluo/yaoyao:v0.4.77
# 需要固定 AMD64 时：
docker pull samienluo/yaoyao:v0.4.77-amd
```

每次新版本发布都会更新 `latest`，旧版本标签继续保留。需要固定部署版本时使用具体版本标签。

## 配置与启动

```sh
cp docker.env.example docker.env
```

编辑 `docker.env`：

| 配置 | 用途 |
| --- | --- |
| `HERMES_YAOYAO_IMAGE` | 远程镜像可设为 `samienluo/yaoyao:v0.4.77` 或 `samienluo/yaoyao:latest`；未设置时使用本地构建名称 |
| `HERMES_YAOYAO_HERMES_DIR` | 可选，原有 Hermes 数据目录的宿主机路径，配合 `compose.hermes-import.yaml` 首次启动只读导入 |
| `HERMES_YAOYAO_BIND_ADDRESS` | Web 的宿主机发布地址，默认 `127.0.0.1`；局域网访问可设为 `0.0.0.0` |
| `HERMES_YAOYAO_PUBLISHED_PORT` | 宿主机 Web 端口，默认 `15300` |
| `HERMES_YAOYAO_ALLOWED_HOSTS` | 使用域名访问时填写对应域名，多个值用英文逗号分隔 |

内置 Hermes 的会话、Profile、模型配置和凭据都保存在 `yaoyao-data` 数据卷的 `hermes/` 目录；首次登录后在“系统设置 → 模型服务”中配置模型。

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

## 导入原有 Hermes 数据

已有 Hermes 数据目录（包含 `config.yaml`、`state.db`、`profiles/` 等）时，可在首次启动时只读导入：

```sh
# docker.env 中填写宿主机绝对路径；Linux 示例 /srv/hermes-data，macOS 示例 /Users/你的用户名/.hermes
HERMES_YAOYAO_HERMES_DIR=/srv/hermes-data
docker compose --env-file docker.env -f compose.yaml -f compose.hermes-import.yaml up -d --build web
```

- 目录以只读方式挂载到 `/import/hermes`，导入过程不会写入原目录；SQLite 数据库使用在线备份读取，原 Hermes 仍在运行时也能得到一致副本，但建议先停止原 Hermes。
- 只在 `yaoyao-data` 中的 `hermes/` 为空时导入一次；重复启动不会覆盖已有数据。导入失败时内置 Hermes 从空数据启动，原因写入日志和数据目录中的 `hermes-import-error.json`。
- 导入完成后可移除 `compose.hermes-import.yaml` 和挂载。

## 验证

以下命令使用默认发布端口；修改端口后同步调整 URL：

```sh
curl --fail http://127.0.0.1:15300/healthz
curl --fail http://127.0.0.1:15300/readyz
docker compose --env-file docker.env logs --tail=100 web
```

`healthz` 检查 Web 服务，`readyz` 检查内置 Hermes 是否可用。系统设置中的“内置 Hermes”页面显示内核状态和数据目录。

登录后创建会话、收发消息、上传并下载附件，验证实际使用流程。

## 虚拟机

Docker 版**不支持虚拟机**：设置中的“本地虚拟机”只显示说明，机器人的电脑面板不提供本地虚拟机，接口返回 `local_vm_docker_unsupported`。原来随 Web 部署固定共享桌面的 `compose.desktops.yaml` / `compose.desktops.cursor.yaml` 已删除。

需要虚拟机时，请使用 macOS App 或 npm 安装的服务端：每个开通虚拟机的账号有一台独立虚拟机，账号下每个机器人有自己的桌面，见 [本地虚拟机](local-vm.md)。

镜像通过 `YAOYAO_DEPLOYMENT=docker` 标记 Docker 部署；沿用旧 `compose.yaml` 中 `HERMES_YAOYAO_LOCAL_VM_HOST=runner` 的部署也按 Docker 版处理。从旧的固定桌面部署升级时，改用仓库中的 `compose.yaml`；旧桌面的数据卷不会被自动删除，确认不再需要后可用 `docker volume rm` 手动清理。

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
