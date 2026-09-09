# 服务器统一名称

2026-09-07。服务器名称由 Web 服务端统一保存，同一服务上的 Agent 共用。Web、iOS 和安卓均可读取；管理员可以修改，普通账号只读。名称留空时统一显示服务端主机名。

## 入口与同步

- Web：设置 → 登录与安全 → 服务器名称；侧栏账号说明同步显示名称。
- iOS：设置 → 服务器与账号 → 服务器统一名称；同一地址的已保存账号名称随之更新。原本的手机备注作为旧服务的备用备注保留。
- 安卓：设置 → 服务器统一名称；服务器账号列表缓存同步更新。

首次登录、账号切换、返回前台和打开设置时读取最新配置。Bot 模式复用现有事件响应中的名称快照，普通聊天复用 HTTP/SSE 的 `server.identity.changed` 通知。已有编辑草稿保留；如其他端先保存，当前编辑页提示冲突并提供重新载入。

## 协议与存储

`GET /api/app/server-identity` 返回 `serverId`、`name`、`displayName`、`revision`。`PUT` 接收 `name`、`expectedRevision`、`expectedServerId`，沿用身份认证、管理员权限、Origin 和 CSRF 校验。

名称去掉首尾空白，最多 100 个 UTF-16 单元，拒绝内部控制字符。客户端提交编辑开始时的版本和服务器 ID；过期版本或更换连接目标返回 409，不覆盖已有值。服务端兼容明确指定当前目标的简单调用，因此两个 expected 字段可省略；三端界面始终发送这两个字段。

数据保存在现有 `workspace.sqlite3` 的独立 `server_identity` 表中。首次初始化生成稳定 ID；名称更新在事务中完成，重启后保留。Agent 名称、服务器连接地址和远程节点配对备注沿用原配置。

## 验证

- 16 项服务端与客户端专项测试通过：持久化、恢复主机名、非法输入、过期版本、目标服务器校验、普通账号只读、编辑草稿及设置回归。
- 认证与工作区回归测试另外 56 项通过。
- Web 双窗口测试通过：一端保存，另一端无需刷新即可收到名称。
- iOS AppModel 账号隔离测试及真实设置页面测试通过：读取 Web 名称、保存 iOS 名称、重启应用后保留。
- 安卓真实设置组件、服务端读写和 Room 缓存验证通过：读取 iOS 名称、保存“家里的 Mac”、账号列表缓存更新，错误账号、地址和旧版本被忽略，普通用户组件只读。
- Web 最终读回安卓保存的“家里的 Mac”。三端构建及 Android Lint 通过。

联动验收顺序：启动 `tests/fixtures/workspace-server.ts`（18804/19124），运行 `playwright.server-name.config.ts` 的 `two clients` 用例，再运行 iOS `testUnifiedServerNamePersistsThroughSettings`、安卓 `ServerIdentitySyncTest`，最后运行 `SERVER_NAME_NATIVE_ROUNDTRIP=1 npx playwright test -c playwright.server-name.config.ts -g 'saved by Android'`。

[Web 设置截图](server-name/web-native-name-roundtrip.png)。iOS、安卓截图在各自仓库的服务器名称验收目录。均使用隔离服务及模拟器，未进行生产发布或真机安装。
