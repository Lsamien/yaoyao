# 复现收发延迟验收

所有服务都必须来自本仓库的 `tests/fixtures/workspace-server.ts`，使用新建临时数据目录。以下端口只用于这些隔离实例；若被占用，先修改脚本端口，不要连接或停止现有服务。测试账号 `fixture / fixture-pass` 是夹具生成的合成账号。

## 离线复核

从 yaoyao 开发 worktree 根目录执行：

```sh
node docs/verification/2026-09-13-bot-message-optimization/scripts/analyze.mjs
NODE_OPTIONS=--no-experimental-webstorage npm exec -- tsx tests/perf/workspace-message-latency.ts /tmp/workspace-message-performance.json
```

分析脚本默认读取归档 JSON；压力脚本自行创建并清理临时 SQLite 和 loopback SSE，校验完整回复、至少 60% SSE 降幅和 10 ms 写入/编码 P95。

## 准备 Web/服务端基线与优化副本

1. 新建 `/tmp/bot-latency-acceptance/{baseline-server,optimized-server,baseline-home,optimized-home,evidence}`。
2. 用 `git archive bed10cb` 解包到 baseline-server，用开发分支最终提交解包到 optimized-server。两份副本不包含 `.git`。
3. 将开发分支的 `tests/fixtures/workspace-server.ts` 复制到两份副本：只替换相同的确定性假上游，不替换各自产品服务端逻辑。它识别 `[latency:唯一标记]`，包含 `long` 时输出 200 段，否则输出 40 片文字。
4. 两份副本安装锁文件依赖，或在本机链接到已安装的 node_modules。执行 `scripts/instrument-web.py /tmp/bot-latency-acceptance`，只给临时副本加时间探针；脚本拒绝修改 Git checkout。
5. 分别执行 `NODE_OPTIONS=--no-experimental-webstorage npm run build`，等待两个构建成功后开始测试。

在两个终端分别从相应副本启动：

```sh
WORKSPACE_FIXTURE_HOME=/tmp/bot-latency-acceptance/baseline-home WORKSPACE_FIXTURE_PORT=19351 WORKSPACE_FIXTURE_UPSTREAM_PORT=19352 ./node_modules/.bin/tsx tests/fixtures/workspace-server.ts
```

```sh
WORKSPACE_FIXTURE_HOME=/tmp/bot-latency-acceptance/optimized-home WORKSPACE_FIXTURE_PORT=19361 WORKSPACE_FIXTURE_UPSTREAM_PORT=19362 ./node_modules/.bin/tsx tests/fixtures/workspace-server.ts
```

确认日志显示临时 home 和相应端口后，从开发 worktree 启动代理，再运行 UI 验收：

```sh
node docs/verification/2026-09-13-bot-message-optimization/scripts/latency-proxy.mjs
node docs/verification/2026-09-13-bot-message-optimization/scripts/web-acceptance.mjs
```

代理监听 19371（基线）、19372（优化）、19359（夹具控制器），生成 connections.json 和网络记录。UI 脚本等待真实登录响应、使用独立浏览器上下文、唯一回复标记和完整文本断言，采集 DOM 更新时间；另外检查上翻后的快照恢复和新消息不改变阅读位置。运行期间不要并行构建或其他性能测试。

## iOS

- 从 iOS 的 `aceb477` 和开发分支最终提交分别复制 `YaoYaoAI、YaoYaoAITests、YaoYaoAIUITests、YaoYaoAI.xcodeproj、project.yml` 到上述临时目录的 `ios-baseline、ios-optimized`。
- 执行 `scripts/instrument-ios.py /tmp/bot-latency-acceptance`。探针只添加到临时副本；完整消息内容只在测试完成时记录。
- 新建专用 iPhone 17 Pro / iOS 26.5 模拟器。两份副本先编译，再顺序执行 `YaoYaoAIUITests/LaunchSmokeTests/testLatencyCurrent`。
- 本次使用 `-configuration Debug -enableCodeCoverage NO SWIFT_OPTIMIZATION_LEVEL=-O CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=GMU6W5FKQ6`。使用 ad-hoc 签名，以避免模拟器 Keychain 缺少 entitlement。
- 用 `simctl get_app_container` 定位专用模拟器的 `cn.samien.yaoyao.hermes`，复制 Documents 中的 `latency-*.jsonl`；用 `xcresulttool export attachments` 导出实际截图。

## Android

- 从 Android 的 `8ed6079` 和开发分支分别构建 Debug APK；从开发分支构建 AndroidTest APK。`WorkspaceLatencyTest` 只依赖基线已有的公开界面；未提供 latency-url 时自动跳过。
- 使用单独创建的 Pixel 5 / API 31 模拟器。同一个模拟器先装基线再装优化 APK，测试 APK相同。
- 本机 SDK 为 `/Users/samien/Library/Android/sdk`，JDK 为 `/Users/samien/.local/share/hermes-android-toolchain/jdk-17`。模拟器启动需移除 `http_proxy、https_proxy、all_proxy` 及其大写变量，防止 QEMU 启动挂起；不要修改宿主系统代理。

```sh
adb -s emulator-5582 shell am instrument -w -r -e class cn.samien.yaoyao.hermes.WorkspaceLatencyTest -e latency-url http://10.0.2.2:19371 -e latency-product baseline-android cn.samien.yaoyao.hermes.test/androidx.test.runner.AndroidJUnitRunner
```

优化 APK 改用 19372 和 `optimized-android`。实际模拟器序列号可能不同，应替换为自己创建的设备。测试会校准时钟、核对完整文字、验证长回复末尾及用户上翻后的阅读位置。

用 adb pull 收集 `/sdcard/Android/data/cn.samien.yaoyao.hermes/files/latency-evidence`。把两端 JSON 放入 evidence 后运行分析脚本，并保留 `OK (1 test)` 日志与截图。

## 清理与回退检查

- 测量完成后，向自己启动的三个前台服务发送 Ctrl-C，关闭并删除自己创建的专用模拟器。保留结果目录，不按进程名批量清理。
- 关闭新协议验证：优化后端以 `HERMES_YAOYAO_WORKSPACE_MESSAGE_PATCHES=0` 重启，确认不再协商补丁，旧日志仍可通过 reset + snapshot 恢复。
- 只有声明了新能力的客户端才启用 `format=patch-v1`；旧客户端直播仍收到完整消息。对应自动化用例在 `workspaceMessagePatch.test.ts`、`workspaceSync.test.ts`。
