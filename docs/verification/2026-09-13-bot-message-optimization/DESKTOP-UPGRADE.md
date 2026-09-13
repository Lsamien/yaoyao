# Bot 优化分支安装包升级修复

原测试包 `0.4.16 / c1c17c9` 复用了正式版本号。已发布的桌面包为
`0.4.16 / 9241531`，来自不同的 Git 构建历史，二者都不包含对方的提交。
`syncDecision` 因此返回 `unknown`，启动页显示“App 与 Web 的构建先后关系无法确定”。
之前只验证全新安装和保留较新 Web，没有覆盖这个历史正式包。

本次将分支版本改为 `0.4.17-bot-latency.1`，同步修改 `release.json`、
`package.json` 和锁文件。版本比较、防降级、事务备份及用户数据处理逻辑保持原实现。
修复提交为 `49971c62b324d5ee562b99da42ec79af60133489`，产物从干净提交构建。
这里只生成开发分支安装包，没有创建发布标签、发布版本或合并主线。

## 验证结果

- 原测试包对实际旧正式包返回 `unknown`，新增历史包验收入口能复现失败。
- 新包对旧正式包返回 `upgrade`；旧 App 对新服务返回 `newer`，保留新服务。
- 未来正式版 `0.4.17` 对本测试版返回 `upgrade`。
- `tests/server/desktopSync.test.ts` 的 12 项事务及版本回归测试通过。
- 成品测试使用独立临时数据目录和 LaunchAgent，先安装并启动旧正式包的完整服务，
  再启动新 App；确认服务切换到新构建且保留旧服务设置。退出后服务继续运行、
  保留较新服务、停止后重启及启动错误重试均通过，2/2 项成品测试成功。
- App 严格签名校验、运行时文件清单校验、DMG 校验通过。arm64，Apple Development
  签名，未公证。未操作用户已有服务或安装到 `/Applications`。

原始输出与校验值保存在 [results/desktop-upgrade](results/desktop-upgrade)。

## 复现命令

在本 worktree 执行以下命令。`DESKTOP_TEST_PREVIOUS_RUNTIME` 指向旧安装包内完整且
校验通过的 `Contents/Resources/runtime/web-service`；测试不会修改该目录。

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/server/desktopSync.test.ts
npm run desktop:pack -- --config.directories.output=desktop-release/bot-latency-49971c6-20260913
NODE_OPTIONS=--no-experimental-webstorage \
  DESKTOP_TEST_EXECUTABLE='/Users/samien/git/bot-message-latency/yaoyao/desktop-release/bot-latency-49971c6-20260913/mac-arm64/夭夭.app/Contents/MacOS/夭夭' \
  DESKTOP_TEST_PREVIOUS_RUNTIME='/Users/samien/git/yaoyao/desktop-release/v0.4.16/mac-arm64/夭夭.app/Contents/Resources/runtime/web-service' \
  node --test --test-concurrency=1 desktop/service-sync.test.mjs desktop/startup-feedback.test.mjs
```

省略 `DESKTOP_TEST_PREVIOUS_RUNTIME` 时继续验证全新安装。版本含预发布后缀时，
成品测试先提取基础版本再生成较新服务夹具，避免生成含 `NaN` 的版本号。
