# 部署夭夭 AI

## 前提

- 源码安装需要 Node.js 24；容器安装需要 Docker Engine 或 Docker Desktop。
- 可访问的 Hermes Dashboard/Gateway（通常为 9119），支持会话创建、恢复、提示词提交、附件及审批 RPC。

## 源码安装

在仓库执行 `npm ci`、`npm run build`，然后执行 `npm start`。Web 默认监听 `127.0.0.1:15300`。

上游地址由 `HERMES_YAOYAO_UPSTREAM` 配置。远端凭据在 Web 系统设置中保存。需要环境配置时使用 `HERMES_YAOYAO_UPSTREAM_USERNAME` 和 `HERMES_YAOYAO_UPSTREAM_PASSWORD`，不要把凭据嵌入 URL。

首次打开 Web 时创建管理员账号和至少 8 位的密码。服务不会生成固定的默认账号或密码；iOS 使用 Web 账号或手机登录二维码。

## 局域网

局域网部署可设置 `HERMES_YAOYAO_HOST=0.0.0.0` 和 `HERMES_YAOYAO_ALLOW_INSECURE_LAN=1`，并在 `HERMES_YAOYAO_ALLOWED_HOSTS` 中列入访问地址。公网部署配置 TLS。

## Docker 安装

复制 `docker.env.example` 为 `docker.env`，填写容器可访问的 `HERMES_YAOYAO_UPSTREAM`，然后执行：

```sh
docker compose --env-file docker.env config --quiet
docker compose --env-file docker.env up -d --build
```

Compose 将 Web 的 15300 端口发布到宿主机，使用 `yaoyao-data` 命名卷保存 `/home/node/.yaoyao`。宿主机连接、访问配置、备份及升级见 [Docker 部署说明](docker-install.md)。

## 验收

- `/healthz` 检查 Web 自身；`/readyz` 检查 Hermes 上游。
- 登录后 `/api/app/capabilities` 声明聊天功能。
- 创建角色、发送消息、上传并下载附件、创建群聊并管理成员。
- 用同一账号在 iOS 和 Web 查看相同历史；另一账号看不到这些聊天。

## 数据和发布

备份整个 `HERMES_YAOYAO_HOME`，包含 SQLite、上传与归档文件、用户凭据和密钥。运行中的 SQLite 使用数据库备份工具，或停止 Web 后复制整个目录。

macOS 本机服务可通过系统设置中的“更新与回滚”管理版本。其他源码部署更新代码后执行 `npm ci`、`npm run build` 并重启 Web。Docker 部署更新源码后重新构建镜像并重建容器，继续使用已有数据卷。配套客户端要求见对应发布说明。
