# 工具与关于的独立页面修正

本次重新核对 OpenMausBot 的 `Sidebar.tsx`、`SidebarProfileMenu.tsx`、`App.tsx`、`PluginsPanel.tsx`、`AboutDialog.tsx` 和 `RoutineCalendarPage.tsx`，纠正上一版把三个独立功能放入设置中心的结构。

| 功能 | 参考项目的入口与承载方式 | 当前实现 |
| --- | --- | --- |
| 插件 / 已连接应用 | 工具菜单单一入口，独立大面板 | 统一为“已连接应用”，内部包含应用目录、已连接账号和 MCP |
| 自动化 | 切换主工作区，独立日程页 | `/conversations/automations`，包含 Bot 筛选、日历、任务列表、运行日志和返回聊天 |
| 关于 | 账号菜单独立对话框，不依赖设置 | 所有常规工作区的底部菜单均可打开，展示版本与帮助链接 |

设置中心中已移除插件、已连接应用、自动化和关于分类。普通聊天的 Profile 切换保留；关于和帮助在普通聊天、历史、Bot、看板和文件库的底部菜单中均可用。

## 功能与验证

- 自动化汇总接口只返回当前账号、当前有权使用的 Bot；运行日志读取实际 run 状态。日历明确展示每项任务的下次执行时间，不推测完整未来运行次数。
- 独立自动化页复用现有任务编辑器和写接口，支持选 Bot 新建、编辑、立即执行、暂停及删除；保留聊天侧栏原有定时任务面板。
- 应用连接和 MCP 的后台配置、授权、数据与工具执行保持原有逻辑。独立应用面板保留未保存更改确认；原生对话框提供焦点约束、Escape 关闭和焦点返回。
- 全量 `tests/server`、`tests/client`：126 个文件、940 项通过。类型检查和生产构建通过。
- CUA 浏览器验收：1280 px 桌面独立应用面板、自动化日历、任务编辑和运行日志；375 px 自动化页面和关于对话框。普通聊天与 Bot 模式都实际打开了独立关于，未经过设置中心。
- 独立 fixture 内创建两个 Bot 和三个计划任务，通过新页面修改其中一项并立即执行成功，再从新建入口选择另一 Bot 创建第四项任务。没有调用真实模型或修改用户现有任务。

浏览器与只读数据库核验摘要见 [browser-result.json](browser-result.json)。

复现环境：

```sh
npm run build
WORKSPACE_FIXTURE_PORT=18834 WORKSPACE_FIXTURE_UPSTREAM_PORT=19134 WORKSPACE_FIXTURE_PLUGINS=1 node --import tsx tests/fixtures/workspace-server.ts
```

本次是源码与界面结构修正；没有重写已发布的 v0.4.6 标签或附件，也未部署、重启实际使用中的服务。
