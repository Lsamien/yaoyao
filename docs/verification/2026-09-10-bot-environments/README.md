# Bot 本机与浏览器环境验收

对照 OpenMausBot 的 `src/lib/local-computer.ts`、`server/local-computer.ts`、`server/browser-live.ts`、`src/components/BrowserPanel.tsx`：环境卡片显示连接电脑，本机显式申请系统权限；浏览器使用独立资料、标签页、地址栏、接管和交还，断线清除画面且不恢复输入权限。群聊仍只有 Inspector。

实现：

- 夭夭 Electron 提供本机截图与鼠标、键盘、拖动、滚轮输入。Web/手机通过当前账号连接的桌面端操作，展示实际主机名称。Mac 本机控制同时要求桌面账号授权、屏幕录制和辅助功能。App 菜单可以撤销授权。
- 使用 Electron 自带 Chromium 的隔离浏览器，不读取个人浏览器资料。每个机器人独立保存 cookies；临时资料在退出桌面端时清除。支持标签新建/关闭/切换、导航/前进/后退/刷新、元素 snapshot/ref、填写与点击、截图与人工输入。浏览器页面没有 Node、preload 或桌面服务凭据。
- 通过现有按任务授权的 Hermes 工具桥接入机器人；权限、来源、模式、浏览器资料、运行中断与桌面实例变化都会使旧请求失效。本机输入全局串行，浏览器按机器人资料串行；人工控制使用独立票据、代次、请求幂等、最新画面校验。过期或断线需要重新接管并交还，工具不自动重放。
- 自动模式保留已有虚拟机选择；无虚拟机时优先使用已授权且系统权限就绪的本机，再按既有云端配置选择。查看面板不会创建浏览器或唤醒云端。浏览器在显式打开或机器人第一次工具调用时建立。

验证：

- Web/Server 类型检查与构建通过；全量 Vitest 891 项通过、7 项跳过。之后的控制就绪、画面归属和交还说明修改使用专项套件复核。
- `tests/server/desktopEnvironments.test.ts` 8 项：私有传输、账号/来源、自动选择、全局本机控制、票据、旧画面、幂等、断开代次、人工接管、交还说明及运行中资料切换。与服务所有权测试共 14 项。
- `desktop/browser-environment.test.mjs` 使用真正的 Electron/Chromium，随机输入、DOM 结果、截图与标签页实测；重启 Electron 后持久 cookies 保留，其他机器人与临时资料均隔离。
- `playwright.native-environment.config.ts` 在临时 Web 数据目录启动真实 Electron 环境桥，Web 接管浏览器、导航到隔离页面、交还与重新接管通过。1280 像素桌面及 375 像素窄屏截图已检查。
- iOS Simulator 签名构建、34 项 WorkspaceChatTests、3 项界面用例通过。界面用例使用 URLProtocol fixture，验证权限状态、浏览器工具栏、接管/交还、虚拟机回归及大字体群聊 Inspector。另追加“交还后再次接管”检查。未安装到 iPhone。

边界：

- 当前本机操作支持 macOS；需要运行更新后的夭夭桌面端并完成系统授权。本次未替用户授予权限，未在用户真实桌面执行鼠标/键盘输入。Swift 输入助手已编译，实际 TCC 授权和真实桌面输入仍需授权后验收。
- 本轮验证了环境传输、浏览器真实动作与工具生命周期，未调用付费模型完成真实 Hermes 模型任务。浏览器暂不支持上传文件选择器、下载、麦克风/摄像头授权或个人 Chrome 配置接入。
- 云端 Grok Bot 登录、共享虚拟机、定时任务和 Inspector 沿用现有机制。

复现命令：

```sh
NODE_OPTIONS=--localstorage-file=/tmp/yaoyao-native-unit-localstorage npx vitest run tests/server/desktopEnvironments.test.ts tests/server/serviceInstance.test.ts --maxWorkers=2
env -u http_proxy -u https_proxy -u all_proxy -u ELECTRON_RUN_AS_NODE NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost node --test desktop/browser-environment.test.mjs
npm run desktop:build
env -u http_proxy -u https_proxy -u all_proxy -u ELECTRON_RUN_AS_NODE NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost npx playwright test -c playwright.native-environment.config.ts
```
