# 配套版本与验收

主项目沿用 v0.4.77；移动端为独立版本 1.5.0（226）。具体 Git 提交、构建号、路径和 SHA-256 以每次产物目录中的清单为准。客户端安装成功不代表服务端或 Runner 已更新。

| 部分 | 运行要求 | 配套要求 |
| --- | --- | --- |
| Web/BFF | Node.js 24、持久数据目录、已有 Hermes | 本轮服务端包包含持久去重/回执、附件授权、删除清理、取消屏障和普通聊天/Bot SSE 登出修复 |
| 独立 Runner | Node.js 24、完整 Runner 目录、已有 Hermes | 与本轮 Web 一起更新；支持所属会话的 session.active_list，停止未确认时不释放控制权或复用执行 |
| Mac arm64 纯客户端 | macOS 12+、可访问 Web | 不含服务器或 Runner；旧 v0.4.76 仍使用同一协议，本轮新包采用 v0.4.77 |
| iOS | iOS 17+、移动端 1.5.0（226） | 保留已验签的 1358b49 IPA；本轮未改变移动源码。包含持久发送检查点及附件恢复 |

普通聊天协议为 `ordinary-chat-transcript-v2`、HTTP/SSE 实时协议版本为 1；Bot 使用 `patch-v1`；Runner 机器协议为 1，并绑定账号、Profile、实例和连接代次。相同协议号不保证旧 Runner 支持新增停止确认，所以独立 Runner 应配套更新。Hermes 负责模型和原生工具执行；夭夭负责权限、调度、持久记录及接入。本轮没有改变、安装插件到或重启已有 Hermes。

## 本地验证

关键服务端/Runner 回归使用隔离 SQLite、HTTP/WebSocket mock 和模拟电脑。桌面 E2E、移动单测、typecheck、构建及签名结果分别记录。

`npm run test:pair:mobile` 直接加载相邻 `yaoyao-mobile` checkout 的真实 `YaoyaoAPI`、`OrdinaryStore` 和 SQLite 缓存，通过真实本地 HTTP/SSE 对接当前 BFF；Hermes 是确定模拟。可用 `YAOYAO_MOBILE_CHECKOUT=/绝对路径` 指定移动仓库。覆盖附件成功后断线、缓存重开、BFF 重启、编码回执查询、只上传一次、只提交一次、canonical echo 和登出关闭 transcript 流。Node 夹具提供 Cookie jar，不能替代 iOS URLSession 或真机验证。

## 运行与切换

macOS arm64 Web 运行包包含 Node，先设置 `HERMES_YAOYAO_HOME` 指向持久目录、`HERMES_YAOYAO_UPSTREAM` 指向现有 Hermes，再执行包内 `./start-web.sh`。入口设置 production 和包内 UI 路径；直接运行 `server.mjs` 时还必须设置 `NODE_ENV=production` 与 `HERMES_YAOYAO_STATIC_DIR` 指向包内 `ui`。npm 分发包需在目标环境安装生产依赖后执行其 CLI，不是 Linux 自包含二进制。

独立 Runner 解包后执行 `node runner.mjs --config /私有路径/runner.json`。配置保持私有；`artifactRoots` 留空拒绝文件导出。运行包包含 Worker、工具桥和 Playwright 运行包，不包含 Chromium 二进制、Docker 镜像、模型或用户数据。浏览器和 VM 按 `runner.md`、`managed-browser.md`、`local-vm.md` 在目标环境准备。

生产切换前应确认任务空闲、备份持久数据，升级 Web 和独立 Runner 后再连接客户端，并核对实际进程/容器的版本与产物提交。私有配对配置可保留，不重新创建/撤销凭据或放宽权限。本轮构建没有执行生产切换。

## 真实环境限制

真实 Hermes 停止/工具行为、目标浏览器/VM、iOS 真机网络/音频/推送、生产 TLS 和数据迁移未在本轮执行。IPA 使用开发签名，仅能安装到配置文件登记的设备；未安装真机或上传 TestFlight。Mac 签名/公证状态以产物记录为准；未公证本地包可能受 Gatekeeper 限制。编译成功不代表这些验收已完成。
