# 非默认 Profile 工具目录与超时诊断

## 已确认的问题

工具桥 `/bind` 的 HTTP 工作线程没有会话的 Profile 上下文。重建原生工具目录时，Hermes 按当前 home 选择插件注册表和缓存，导致非默认 Profile 的本轮工具已经注册、绑定也返回成功，但模型收到的目录没有这些工具。

工具桥 1.2.4 在目录重建期间使用绑定记录中的 `profile_home`，并在成功或异常后恢复原上下文。这也覆盖目录刷新及子代理继承。各轮工具仍按原有授权过滤，不扩大权限。

HTTP 超时报错现在区分读取配置、检查工具桥、绑定工具桥等阶段，并在请求中有合法 Profile 名称时显示它。请求时限和错误码保持原有行为；报错不包含完整请求、令牌或其他查询参数。

## 验证

- Python 工具桥及安装器测试：18 项通过。新增的 Profile 选择和异常恢复测试在修复前均失败。
- `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/server/upstream.test.ts tests/server/upstreamServiceSession.test.ts tests/server/workspaceTeamTools.test.ts tests/server/hermesBridge.test.ts --maxWorkers=4`：52 项通过。
- `npx tsc --noEmit -p tsconfig.server.json`：通过。
- 隔离的真实 Hermes Dashboard（本地源码提交 `e6f5ce2`）：临时 home 中创建 `default` 和 `yaoer`，分别安装工具桥，使用本地模拟模型及工具回调。通过真实 HTTP、WebSocket 创建会话、绑定工具桥、提交消息、解绑。修复前只有 `default` 的模型请求包含 `yaoyao_fixture_ping_*`；修复后两者均包含，且都完成文字回复。未使用用户的真实 Profile、模型凭据或历史会话。

## 仍需核查

用户截图中的 `Unable to reach Hermes: request timed out` 在以上隔离环境中未复现。工具目录问题已确认并修复，但不能据此认定线上超时根因相同；仍需实际服务器的失败请求及 Hermes 日志。

运行中的服务器需更新工具桥并重启 Hermes Dashboard 才能加载 1.2.4。本次只修改仓库，未部署或重启用户服务。
