# 夭夭 Web

当前发布版本：**v0.3.28**，配套 iOS **1.3（188）**。详见 [发布说明](docs/releases/v0.3.28.md)。

夭夭 Web 为网页和 iOS 提供统一的 Agent、群聊、文件库及语音配置服务。Hermes 通过标准 9119 HTTP/WebSocket 接口执行任务；无需安装 Yaoyao 插件。

## 聊天与 Agent

- 在已有 Hermes Profile 基础上创建角色，填写名称、头像、提示词和规则。创建不会复制或修改基础 Profile。
- 每个角色只有一条连续单聊；角色可加入多个群聊。单聊与各群聊分别使用独立会话。
- 聊天列表混排角色单聊与群聊，不含默认 Profile 对话，没有独立话题列表。
- 群聊可增减成员，当前管理员不能移除。可修改群规则、管理员、协作方式和自动回复轮数；默认管理员协调、3 轮。
- 角色规则在下一次执行生效。归档角色隐藏单聊并禁止再加入群聊，但不自动移出现有群聊。
- 原生对话保留独立入口，由 Web 转发给 Hermes。
- 新聊天、事件及文件按登录用户隔离；基础 Profile 的工具、技能和既有记忆能力继续由 Hermes 管理。

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

Web 数据默认保存在 `~/.hermes-yaoyao`，可用 `HERMES_YAOYAO_HOME` 指定。备份应包含整个数据目录及加密密钥。Docker 使用 `/var/lib/hermes-yaoyao` 持久化卷，不需要 Python、Hermes 文件系统挂载或插件安装载荷。

由 Web 或 iOS 创建的普通聊天会按登录用户、Profile 和 Session ID 在 `chat-cache.sqlite3` 中登记所有权并持久化；后续续聊与列表展示以这份服务端登记为准，不再单独依赖 Hermes 的 `source` 标记。Web 的只读历史记录不进入该数据库，继续按需读取 9119。可通过 `HERMES_YAOYAO_CHAT_CACHE_MODE=upstream-only|shadow|prefer-local` 切换策略，默认 `prefer-local`。

## iOS

iOS 统一连接 Web 地址，通过设置中的手机登录二维码或账号密码登录。不能再直接填写 9119 地址；旧 15300 Web 账号和本机聊天缓存继续保留。

## 数据与升级

新体系从空数据开始，不导入旧插件的团队、话题、文件或配置。旧 Hermes 数据及已安装插件原地留存，Web 不再访问、升级或卸载它们。发布清单只记录 Web 版本，Web 自身升级功能保留。首次切换请整体替换 Web 部署并配套更新 iOS。

Kanban 仍是可选的独立功能，其插件不在本次迁移范围内。

## 开发验证

```sh
npm run typecheck
npm test
npm run build
```

新体系契约见 [聊天接口与运行模型](docs/workspace-chat.md)，安装步骤见 [部署说明](docs/agent-install.md)。

## 许可证

BSL-1.1，详见仓库 LICENSE。
