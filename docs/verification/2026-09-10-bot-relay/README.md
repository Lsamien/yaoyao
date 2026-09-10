# Bot 群聊自动收尾与防循环验收

日期：2026-09-10。只修改源码与隔离测试，没有调整远端配置、历史消息或运行服务。

## 行为

- 用户的 @ 解析保持不变；机器人回复的明确确认、感谢、等待用户指令不再派工。含新动作或含糊内容继续按原方式路由。自由协作不会把已过滤的提及重新变成自动广播。
- 两种群聊模式在同一 run 内按发言成员与目标成员检查重复交接。输入消息/复核批次结果、回复、工具结果、附件、用户交互答复参与判断；第二次相同交接只阻止对应分支，不取消其他工作。
- 只规范化普通正文的格式空白。代码、附件身份、路径、工具参数和结果保留；工具事件顶层的编号和计时元数据不算新进展。新的人工答复独立于机器事件去重。
- 指纹、抑制原因和每轮最多一次的系统提示与调度结果原子保存。旧 turn 没有指纹时，依据已保存的回复和实际派工记录推导。管理员批次复核、有限轮数和手动停止保持原行为。
- 不新增公开接口、客户端状态或数据库表。不改变结构化目标的验收状态。不限轮数仍允许持续推进；规则不进行模型语义分类或模糊相似度判定。

## 回归

以下命令成功，7 个文件、166 项通过：

```sh
npx vitest run tests/server/workspaceRelay.test.ts tests/server/workspace.test.ts tests/server/workspaceTeamTools.test.ts tests/server/taskCoordinator.test.ts tests/server/workspaceRoutes.test.ts tests/server/workspaceRemoteAgents.test.ts tests/server/workspacePairedNodes.test.ts
```

覆盖原始确认循环、两种模式的两/三成员循环、重复完成事件、分支与目标隔离、新消息与任务、新结果/工具/附件/人工答复、重启与旧记录恢复，以及既有审批、手动停止、事务回滚、远程成员和账号授权场景。

原审批隔离测试存在同毫秒跨任务排序假设，已改为先确认第一条任务实际开始，再提交第二条并验证排队和审批隔离。

`npm run typecheck` 和 `npm run build` 成功。构建仍有既有的前端 chunk 超过 500 kB 提示。

## 编译后隔离验收

```sh
npm run build
node docs/verification/2026-09-10-bot-relay/verify.mjs
```

脚本加载 `dist-server` 的实际编译代码，使用临时 SQLite 目录和回环地址的假 Hermes WebSocket 服务；不连接真实模型或现有服务，退出时清理自己的测试目录。

| 场景（均不限轮数） | 成员调用 | 重复提示 | 最终状态 | 待执行任务 |
| --- | ---: | ---: | --- | ---: |
| 管理员派工、审核、最终确认 | 3 | 0 | complete | 0 |
| 管理员模式持续返回相同派工及结果 | 5 | 1 | complete | 0 |
| 自由模式持续互相派工 | 4 | 1 | complete | 0 |

各场景结束后继续观察 250 ms，没有新增调用，聊天的活动运行标记已清除。结构化输出见 [result.json](result.json)。此验收不代表生产服务器已部署。
