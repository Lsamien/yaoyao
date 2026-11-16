# 部署夭夭 AI

## 前提

- 源码安装需要 Node.js 24；容器安装需要 Docker Engine 或 Docker Desktop。
- 不需要单独的 Hermes 服务：Hermes 0.23.0 已内置。源码部署运行 `npm run kernel:setup`（npm 安装运行 `yaoyao setup`）准备 Python 3.11 依赖。

## 源码安装

在仓库执行 `npm ci`、`npm run build`，然后执行 `npm start`。Web 默认监听 `127.0.0.1:15300`。

模型供应商、默认模型和凭据在 Web 的“我的设置 → 管理 → 模型服务”中配置，保存在数据目录的 `hermes/` 下。首次启动会只读导入原有 `~/.hermes`。

首次打开 Web 时创建管理员账号和至少 8 位的密码。服务不会生成固定的默认账号或密码；iOS 使用 Web 账号或手机登录二维码。

## 局域网

局域网部署可设置 `HERMES_YAOYAO_HOST=0.0.0.0` 和 `HERMES_YAOYAO_ALLOW_INSECURE_LAN=1`，并在 `HERMES_YAOYAO_ALLOWED_HOSTS` 中列入访问地址。公网部署配置 TLS。

## Docker 安装

复制 `docker.env.example` 为 `docker.env`，按需填写发布地址（导入原有数据见 [Docker 部署说明](docker-install.md#导入原有-hermes-数据)），然后执行：

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
