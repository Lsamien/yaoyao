# 子账号 Bot 与注册开通验证记录

日期：2026-09-21。范围：yaoyao（服务端、Web、macOS）、yaoyao-mobile、yaoyao-android。官网和云端目录未修改。

## 实现

修复四端共用的 Bot 快照被子账号允许列表拦截的问题，并补齐按方法限定的项目、记忆、协作入口。来源授权、owner 隔离、撤权停止和管理员权限边界继续由服务端控制。子账号能力声明去除管理员专属入口。

四端增加应用内子账号注册，macOS 包含独立启动页。注册不创建会话；管理员在现有用户页面分配至少一个可用本机基础机器人后开通。旧账号按已开通兼容，保留原状态和权限；普通启用不能绕过审核。

补充登录失效、权限撤回和来源不可用提示，停止权限错误后的重连；Web 明确处理离线与恢复、清理换账号时的草稿和事件连接。修复 Web 初始化丢失会话深链接和 Electron 记住登录时初始页面导航竞态。管理员登录、原生模式和电脑授权协议未变。

## 已执行验证

| 范围 | 结果 | 说明 |
| --- | --- | --- |
| 服务端 / Web Vitest 全量 | 1543 通过，27 跳过 | 192 个测试文件通过；16 个带环境条件的文件跳过。Node 26 使用 `NODE_OPTIONS=--no-experimental-webstorage`，避免其全局 localStorage 与 jsdom 冲突 |
| 新增完整中间件注册与权限测试 | 4 通过（包含于上项） | 真实账号、Cookie、Origin、CSRF；初始化限制、严格字段、用户名重复、密码校验、限流、pending 登录拒绝、禁止直接启用、可用来源审核、快照、项目、记忆读写/导出/删除、附件与跨账号访问、SSE 及禁用后旧流关闭 |
| Web 子账号端到端 | 2 通过 | 分配、首次改密、注册、等待开通、管理员审核、创建 Bot、实际应用运行器收到回复、正文呈现、离线恢复、刷新保留会话、管理员列表隔离、没有误请求管理员接口 |
| Electron 全量 | 54 通过 | 独立窗口注册、登录失败、记住登录、原有管理员电脑授权、安装/同步/重试、升级与退出流程；后续注册提示清理改动另复测 13 项登录相关测试通过 |
| iOS | 212 通过，1 跳过 | AuthAndRESTTests、WorkspaceChatTests、LaunchSmokeTests；包含匿名注册 CSRF、旧服务器提示、登录页切换、来源诊断、403 停止重连、Bot 与账号切换回归 |
| Android JVM | 65 通过 | core:network 52 项、app 13 项；包含注册 Cookie/CSRF/Origin、旧服务器拒绝、SSE 401/403、来源诊断 |
| Android 相关仪器测试 | 4 通过 | LoginScreenTest、WorkspacePermissionsTest；注册确认密码与原登录入口、Bot 权限显示和记忆配置 |
| 构建 | 通过 | Web/服务端、Electron `desktop:build`、iOS Simulator 构建及测试、Android `assembleDebug`。未生成新的签名发行包 |

Web 回复测试使用真实夭夭认证、中间件和 WorkspaceRuntime，Hermes 上游为仓库确定性协议测试服务；没有关闭 Bot 执行或替换认证来证明聊天成功。移动端协议测试使用本地 HTTP/URLProtocol 测试服务，不能视作四端真实 Hermes 联调。

## 全量界面回归的已有失败

为区分本次变化与已有问题，分别使用独立 Git worktree 复测了修改前版本，未改动用户工作区：

- Web 基线 `8470ebd`：原有 12 项 workspace 浏览器测试中 5 通过、7 失败。本次全量运行重现同样 7 项失败；涉及旧思考计时断言、身份造型入口、4 项旧流式 Markdown DOM 选择器、旧附件卡片选择器。新增子账号用例及原有子账号用例单独均通过。这里没有把全量浏览器回归标为通过。
- Android 基线 `780407c`：WorkspaceParityFlowsTest 的 7 项中 3 通过、4 失败，与修改后相同。失败项为群聊任务切换、创建空白任务、电脑说明可见性、归档恢复；测试服务响应与界面断言需要后续对齐。未改动管理员业务行为来迁就这些断言。

## 未完成的真实环境验收

本机测试 Hermes `127.0.0.1:9119` 状态接口可达，但工具桥能力接口 `/api/plugins/yaoyao-bot-bridge/capabilities?profile=default` 返回 401 Unauthorized；未取得该测试服务的有效登录会话，状态还报告 gateway stopped。

因此四端分别连接真实 Hermes 的完整消息往返、真实上游断线恢复，以及真实工具审批/停止、协作、记忆提炼、定时任务执行，仍未完成现场验收。原生三端从注册到管理员开通再到真实模型回复的完整闭环也未完成；不能用上述模拟上游或协议测试结果代替。需要可登录且工具桥已启用的测试 Hermes 环境后补验。

服务端新增兼容接口应先发布，再交付客户端更新；当前仅完成本地实现、构建与上述验证，未修改正在运行的 Hermes 配置或部署服务。

## 复现命令

```sh
# yaoyao
NODE_OPTIONS=--no-experimental-webstorage npm test
npx playwright test -c playwright.workspace.config.ts -g subaccount
npm run desktop:test
npm run desktop:build

# yaoyao-mobile：XcodeBuildMCP / Xcode
# scheme YaoYaoAI，模拟器 Yaoyao Workspace QA
# only-testing: YaoYaoAITests/AuthAndRESTTests、YaoYaoAITests/WorkspaceChatTests、YaoYaoAIUITests/LaunchSmokeTests

# yaoyao-android：配置 JDK 17 与 Android SDK 后
./gradlew :core:network:test :app:testDebugUnitTest :app:assembleDebug
python3 scripts/parity-fixture-server.py --port 18777
./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=cn.samien.yaoyao.hermes.LoginScreenTest,cn.samien.yaoyao.hermes.WorkspacePermissionsTest
```

保留工作区原有的 `.zcode/`、iOS 工程/版本配置与 IPA、Android `.DS_Store`，不纳入本次提交。
