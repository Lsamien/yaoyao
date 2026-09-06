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

## 数据与备份

Compose 使用 `yaoyao-data` 命名卷，挂载到 `/var/lib/hermes-yaoyao`。账号、SQLite 数据库、聊天缓存、文件及密钥随数据卷持久保存。

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
