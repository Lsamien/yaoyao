# Bot 模式协作、项目与文件记忆

本功能仅用于应用的 Bot 模式。Web/Desktop、iOS 和 Android 使用相同 API，不改变普通聊天或原生 Hermes Bot，不修改基础 Profile 的全局配置。

## 使用方式

- Bot 资料中的“允许 Bot 协作”和“自动记录长期事实”默认开启。创建成员、团队和项目仍需“允许组建团队”。
- 在聊天中要求 Bot 联系同伴。`workspace_send_to_agent` 立即返回投递凭据，同伴回复稍后唤醒原 Bot；`workspace_post_to_group` 发布到自己参加的群。界面可查看请求、结果、状态，并停止整条协作。
- 新建群默认平等讨论，无需选择负责人；未点名时全体参与。普通消息一轮、讨论默认两轮，可通过发送选项或文字指定 1–12 轮，最多 8 位成员，逐轮轮换发言顺序。成员失败不阻止其他成员。
- 已有群保留原模式，空闲时可切换。需要交付时再开启“交付目标”、选择有组队权限的负责人，沿用原有任务与验收流程。
- 项目独立存在，可关联多个群；群内所有成员须先加入项目。单聊可选择当前项目，移出群不自动退出项目。

## 三层记忆

| 范围 | 谁能读取 | 自动记录规则 |
| --- | --- | --- |
| Bot | 当前 Bot，跨单聊和群聊使用 | 稳定事实、偏好、职责经验 |
| 用户 | 同一账号的 Bot | 用户明确表达的长期信息或记忆指令，引用用户原话 |
| 项目 | 当前项目成员 | 当前项目已确认的决策、约定与结果 |

共享事实按贡献 Bot 保存，Bot 只能维护自己的贡献。用户编辑的记录受保护；同主题的不同贡献保留并提示核对，不静默覆盖。界面提供来源、更新时间、修订、Markdown 导出与后台提炼状态。

暂停自动记录不会删除现有记忆。遗忘和人工修订记录旧内容与旧证据标记，防止旧提炼任务通过改写措辞恢复旧事实。遗忘记忆不会删除原聊天。

## 文件布局与备份

根目录为 `<HERMES_YAOYAO_HOME>/bot-workspace/<账号 ID>/`：

```text
agents/<Bot ID>/projects.json
agents/<Bot ID>/memory/profile.md
agents/<Bot ID>/memory/log/YYYY-MM.md
user-memory/agents/<贡献 Bot ID>/profile.md
user-memory/agents/<贡献 Bot ID>/log/YYYY-MM.md
projects/<项目 ID>/project.md
projects/<项目 ID>/groups.json
projects/<项目 ID>/memory/agents/<贡献 Bot ID>/profile.md
projects/<项目 ID>/memory/agents/<贡献 Bot ID>/log/YYYY-MM.md
```

记忆正文为 `- (YYYY-MM-DD) 事实内容`。`project.md` 使用带元数据的 Markdown，项目标识不随名称改变。每份记忆的 `.dreaming/` 包含：

- `records.json`：稳定记忆 ID、范围、贡献者、来源、类别、版本、主题及内容指纹。
- `explicit/`、`synthesized/`：明确保存与自动提炼的标记。
- `tombstones/`、`forgotten-sources.json`：遗忘和人工修订后的旧内容、旧证据屏障。
- `revisions/`：含操作人、时间及修改前后内容的 JSON 修订记录。
- `jobs/`：含来源轮次、尝试次数、状态和错误的持久提炼任务。
- `next-refresh-at`：整理时间元数据。

账号目录的 `.commands/` 保存幂等凭据，`.transactions/` 保存多文件恢复日志。服务端按账号加锁，先记录事务，再原子替换正文和元数据，提交后发布事件；启动时恢复中断事务。

项目和记忆以文件为准，数据库中的相关投影可重建。Bot 身份、聊天、目标和协作投递继续以 `workspace.sqlite3` 为准。备份应使用一致性快照，或停止服务后一起保存整个应用数据目录，包括数据库及 WAL、附件和 `bot-workspace`；执行容器不是记忆的唯一副本。

## 执行节点兼容

客户端通过能力 `bot-collaboration-v1`、`bot-discussion-v1`、`bot-file-memory-v1`、`bot-projects-v1` 显示入口。

Bot 工具使用已有会话工具桥。记忆注入要求节点明确报告 `memory_isolation: true`；无工具提炼还需 `memory_extraction: true`。本仓库的新隔离 Worker 提供两项能力，提炼使用空工具目录，不获取电脑租约、不启动虚拟机、不执行 Profile 原生记忆或后台工具。

旧节点、尚不支持隔离记忆的原生 Profile 桥，以及不支持工具绑定的远程引用保留既有聊天能力。记忆面板显示升级提示，不宣称已启用隔离或自动提炼；不会为此修改共享 Profile 或导入其他产品的记忆。

## API 与事件

接口位于 `/api/app/workspace`，使用当前登录账号：

| 接口 | 用途 |
| --- | --- |
| `GET /projects`、`POST /projects` | 项目查询、创建和按版本修改 |
| `GET /memories`、`POST /memories` | 按范围查询、搜索、创建和修改 |
| `POST /memories/forget` | 按版本遗忘 |
| `GET /memories/:id/revisions` | 修订记录 |
| `GET /memory-export` | Markdown 导出 |
| `GET /memory-jobs`、`POST /memory-jobs/:id/retry` | 提炼状态和重试 |
| `GET /collaboration`、`POST /collaboration/:id/stop` | 协作链记录和停止 |

写入使用 `requestId`，编辑使用 `expectedRevision`。旧版本修改返回冲突，客户端保留草稿。项目进入已有快照，`project.changed`、`memory.changed`、`memory.job.changed`、`collaboration.changed` 使用已有可续传事件同步。

协作链保留原会话、话题、项目、来源和回复关系，最多 8 层、32 次自动投递，并抑制重复内容及纯确认。停止后迟到结果不能重新启动旧目标。提炼按用户轮次和 Bot 去重；有异步协作时等待结果返回原话题后合并提炼，不把同伴的私人聊天全文交给其他 Bot。失败最多自动尝试三次，不阻塞聊天。

## 通信提示展示

Bot 私信使用独立的 `communication` 展示信息：方向、对方身份与头像、实际正文。新客户端在消息正文上方居中显示“发送给 / 消息来自”，字号 12、头像 16、间距 6，不加横线或边框。原始审计记录与兼容正文不重写；没有真实投递记录的普通消息不会因为包含类似措辞而被识别为 Bot 通信。

iOS 输入区不再提供“记忆与协作”文字入口，既有项目、记忆管理页面继续保留。
