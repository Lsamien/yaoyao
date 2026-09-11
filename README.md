# 夭夭 AI

当前 Web 与 macOS 桌面发布版本：**v0.4.9**。桌面版提供 Apple Silicon（arm64）DMG，详见 [发布说明](docs/releases/v0.4.9.md)。

夭夭 AI 为网页、iOS 和安卓提供统一的 Agent、群聊、文件库及语音配置服务。Hermes 通过标准 9119 HTTP/WebSocket 接口执行任务。

## 聊天与 Agent

- 在已有 Hermes Profile 基础上创建角色，填写名称、头像、提示词和规则。创建不会复制或修改基础 Profile。
- 每个角色只有一条连续单聊；角色可加入多个群聊。单聊与各群聊分别使用独立会话。
- 聊天列表混排角色单聊与群聊，不含默认 Profile 对话，没有独立话题列表。
- 群聊可增减成员，当前管理员不能移除。可修改群规则、管理员、协作方式和自动回复轮数；默认管理员协调、3 轮。
- 角色规则在下一次执行生效。归档角色隐藏单聊并禁止再加入群聊，但不自动移出现有群聊。
- 原生对话保留独立入口，由 Web 转发给 Hermes。
- 新聊天、事件及文件按登录用户隔离；基础 Profile 的工具、技能和既有记忆能力继续由 Hermes 管理。

Bot 模式的“工具”菜单提供“自动化”和“已连接应用”两个独立入口。“已连接应用”统一管理应用连接与 MCP；“自动化”使用独立的日历、任务列表和运行日志页面。所有模式均可从底部菜单打开独立的“关于”对话框。这些页面不属于设置中心。

## 运行

需要 Node.js 24 和可通过标准 API 访问的 Hermes 9119 服务。

```sh
npm ci
npm run build
npm start
```

默认 Web 地址为 `http://127.0.0.1:15300`，上游为 `http://127.0.0.1:9119`。首次打开 Web 时自行创建管理员账号；服务不会生成固定的默认账号或密码。远端 Hermes 的凭据可在系统设置中配置。

```sh
HERMES_YAOYAO_UPSTREAM=http://服务器:9119 npm start
```

Web 数据默认保存在 `~/.yaoyao`，可用 `YAOYAO_HOME` 指定（兼容 `HERMES_YAOYAO_HOME`）。旧默认目录 `~/.hermes-yaoyao` 会在服务空闲并停止后整体迁移至 `~/.yaoyao`，保留账号、会话、文件和密钥；两目录同时有数据时停止迁移，避免覆盖。备份应包含整个数据目录及加密密钥。

由 Web 或 iOS 创建的普通聊天会按登录用户、Profile 和 Session ID 在 `chat-cache.sqlite3` 中登记所有权并持久化；后续续聊与列表展示以这份服务端登记为准，不再单独依赖 Hermes 的 `source` 标记。Web 的只读历史记录不进入该数据库，继续按需读取 9119。可通过 `HERMES_YAOYAO_CHAT_CACHE_MODE=upstream-only|shadow|prefer-local` 切换策略，默认 `prefer-local`。

## macOS 桌面版

在 [v0.4.9 发布页](https://github.com/Lsamien/yaoyao/releases/tag/v0.4.9) 下载 `Yaoyao-0.4.9-arm64.dmg`，将“夭夭”拖到应用程序后打开。首次启动会核对并同步配套本机 Web 服务；普通退出保留后台运行，“停止后台服务并退出”可完整停止本应用管理的后台。详细说明见 [macOS App](docs/macos-app.md)。

此 DMG 使用 Apple Development 开发签名，未做 Apple 公证。

## Docker 安装

准备 Docker Engine 或 Docker Desktop，以及容器可访问的 Hermes 9119 服务。在仓库目录执行：

```sh
cp docker.env.example docker.env
# 按实际环境修改 docker.env 中的上游地址和发布地址
docker compose --env-file docker.env config --quiet
docker compose --env-file docker.env up -d --build
```

默认访问 `http://127.0.0.1:15300`。应用数据保存在 `yaoyao-data` 命名卷，容器内路径为 `/home/node/.yaoyao`。首次打开页面创建管理员账号，并在系统设置中配置 Hermes 连接。

宿主机连接、局域网访问、验证及升级步骤见 [Docker 部署说明](docs/docker-install.md)。

## iOS

iOS 统一连接 Web 地址，通过设置中的手机登录二维码或账号密码登录。不能再直接填写 9119 地址；旧 15300 Web 账号和本机聊天缓存继续保留。

## 数据与升级

Web 默认从 [GitHub Releases](https://github.com/Lsamien/yaoyao/releases) 检查稳定版本；桌面菜单“检查 App 更新…”可下载并校验 DMG 后手动安装。旧官方发布源会自动归一化为 GitHub，自定义仓库保留。详见 [GitHub 版本升级](docs/github-updates.md)。

发布版本由 `release.json` 记录。macOS 本机服务支持在系统设置中升级 Web 或回滚到上一个版本；其他源码部署更新代码、重新构建并重启服务，Docker 部署通过重新构建镜像并重建容器更新。升级前备份 Web 数据目录，客户端版本要求见对应发布说明。

## 开发验证

```sh
npm run typecheck
npm test
npm run build
```

接口契约见 [聊天接口与运行模型](docs/workspace-chat.md)，安装步骤见 [部署说明](docs/agent-install.md)。

## 许可证

Apache-2.0，详见 [LICENSE](LICENSE)。第三方组件保留各自许可与署名，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
