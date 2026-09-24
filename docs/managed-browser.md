# 托管浏览器与虚拟机融合

托管浏览器由现有 Runner 按需启动专用 Chromium 进程，通过原来的节点鉴权、任务租约和结果通道工作。网页任务可以直接使用浏览器；需要 Linux 程序、终端或完整桌面时，继续使用现有 VM。Hermes 仍负责模型、会话和技能。

这是独立浏览器进程，不是新增 Linux 虚拟机或 Docker 浏览器服务。Web 与 macOS 电脑面板提供查看和人工接管，窄屏 Web 可用；本次没有新增 iOS/Android 原生浏览器界面，也没有替换现有 UI 技术栈。

## 启用

全局 Bot 工具开关默认关闭。节点启动时自动检查配套浏览器；检查可能短暂启动无用户资料的沙箱进程，不会自动下载或打开网页，也不改变已有虚拟机、云电脑或本机电脑设置。

1. 更新并启动节点的夭夭或 Runner。旧配置缺少 `browser` 字段、或使用空对象时默认启用检测，不需要重新导入配置。明确设置 `enabled:false` 的节点继续保持关闭；需要自定义限制时可使用：

   ```json
   {
     "browser": {
       "enabled": true,
       "maxSessions": 3,
       "idleTimeoutMs": 1800000
     }
   }
   ```

   保留现有配置其他字段，再让 Runner 加载更新后的配置。Mac App 内置节点会在配套服务更新重启后使用原加密配置；仅更新另一台客户端，不能更新服务器上的旧进程。`computers` 与 `browser` 可分别配置，单独启用浏览器不要求 VM Worker。`maxSessions` 范围 1–8，默认 3；空闲回收范围 60 秒–2 小时，默认 30 分钟。显式配置的空闲时间继续生效。

2. 管理员在 Bot 工具设置中打开“托管浏览器”。Bot 的来源与 Profile 必须在 Runner 和账号权限范围内，Hermes 本轮工具桥也必须可用。
3. Bot 首次调用打开浏览器，或用户在聊天卡片/电脑面板点击“接管浏览器”时，节点检查配套 Chromium 和沙箱启动。缺少环境时自动安装并显示阶段与当前组件的下载进度，完成后继续打开同一浏览器。单纯查看状态不会下载安装。

## 环境自动准备

浏览器二进制按需下载，不随应用包分发。开启浏览器的节点即使尚未安装 Chromium，也会声明“可准备”能力；界面区分未安装、检查中、安装中、就绪和失败，并分别说明节点未连接、版本过旧或管理员明确关闭。可点击“重新检测”刷新节点状态；此操作只检查，不下载安装。安装使用应用锁定版本的 Playwright CLI，不调用另一版本的全局命令。一次节点安装由多个已授权使用者共享；断线、关闭节点或所有安装授权失效会取消安装，不会取消其他仍有授权的使用者。

安装完成前必须通过真实的 Chromium 沙箱启动检查。Linux 缺少系统依赖时，仅在节点已经以 root 运行的情况下调用配套 `install-deps chromium`；普通账号会得到明确依赖提示，需要管理员先补齐系统依赖。安装过程不自动提权，不添加 `--no-sandbox`。生产 Runner 应以支持沙箱的非 root 账号运行。失败保留原因，由“重试并接管浏览器”明确发起下一次安装；不会无限重复下载安装。

离线预装仍可使用同一分发包内的 CLI：

```sh
# 源码部署
node node_modules/playwright/cli.js install chromium
# 独立 Runner：先复制完整 .runner-build 目录
node .runner-build/node_modules/playwright/cli.js install chromium
```

## 会话与接管

- 聊天卡片由服务端实际浏览器操作生成，保存安装状态、页面标题和去掉认证信息、查询参数及片段的地址；隐藏工具详情或刷新聊天后仍可见。点击卡片在现有电脑面板直接接管，macOS 使用现有独立控制窗口。卡片不解析模型输出中的控制地址或 HTML。普通 Bot 的页面进入空闲保留状态后，卡片仍可再次接管；接管会取得新的人工授权，不会重启已结束的模型任务。已主动关闭、回收或切换来源的会话仅保留历史信息。
- 普通 Bot 的 Chromium 会话按账号和 Bot 隔离。任务正常结束后保留同一浏览器上下文、标签页和当前页面内容；登录资料保存在 Runner 数据目录的 `managed-browser/profiles/`，即使上下文关闭也继续保留。临时助手使用临时资料，任务结束仍关闭上下文并删除临时资料。
- Bot 浏览器与本机浏览器、VM 内浏览器不共享 Cookie、页面或资料目录。一个 Bot 的资料同时只允许一个进程写入。
- 人工接管与 Agent 使用同一个 Chromium 上下文。接管先等待当前操作收束并切换控制代次；Agent 的后续浏览器调用等待交还。交还后模型获得备注，并重新读取网页。
- 人工控制凭据有效期 30 秒，由控制页面持续续期；失效后拒绝旧输入，不自动让 Agent 恢复操作。多页面查看不会使控制者的近期画面失效；输入请求按编号去重，动作完成后旧画面不可再次用于新输入。
- 普通 Bot 任务正常结束时，若没有人工正在控制，就暂停页面联网并进入空闲保留状态。人工仍在控制时继续使用同一页面；交还时有任务则交回任务，没有任务则进入空闲保留状态。空闲保留使用独立的会话授权，不延长已结束任务或旧人工凭据的权限。
- 进入空闲保留状态会更新控制代次、使旧页面引用和输入画面失效，并阻断新请求与已有网络连接。下一轮任务或新的人工接管通过授权后恢复联网。页面进程仍在，页面自身的 JavaScript 并不因此完全冻结。
- 默认空闲 30 分钟后关闭上下文。单纯查看状态、截图轮询和页面观察不会延长保留时间；主动关闭会立即回收。保留的上下文仍受节点会话数量限制。下载文件只在上下文存续期间临时保留，需要的结果应及时导出到对话附件。
- 取消仍在执行的浏览器命令时，为阻止迟到操作，Runner 可能立即关闭上下文；不承诺在途取消后还能保留页面。下次可重新打开浏览器，持久登录资料继续保留。
- 断线、撤权、节点/Profile 改变会使旧授权失效。切换执行来源时，新来源先确认关闭遗留上下文再操作；不同节点之间不自动搬运登录资料。

## 工具与文件

工具使用独立的 `managed_browser_*` 前缀：打开、状态、DOM 快照、页面操作、附件上传、下载导出。页面操作支持导航、标签页、点击、填写、键盘、滚动和截图。普通网页先使用 DOM 快照与元素引用，确有视觉需求时再截图。

下载先取得 `downloadId`，通过 `managed_browser_export` 作为现有对话附件交付。上传使用当前账号有权访问的附件 `fileId`，模型不传宿主文件路径。单文件上限 25 MiB。

同一轮已授权 VM 时，额外提供 `managed_browser_to_vm` 与 `managed_browser_upload_vm`。复制使用现有 VM 分块文件协议、摘要校验和路径边界；默认不覆盖文件，也不挂载宿主目录。跨环境文件还受全局文件传输大小设置约束。

网页网络请求走经鉴权的公网代理，拒绝回环、私网与重新解析到私网的目的地址；既有连接也定期检查授权。当前禁用 Service Worker 和 WebSocket，因此依赖这些功能的网站可能不完整。DOM 元素快照目前针对主页面；拖拽等高级输入尚未接入。浏览器不支持通过任意 JavaScript、CDP 或宿主命令接口绕过这些边界。

## 与已有功能的兼容

- 未启用时不会给 Hermes 增加浏览器工具，也不改变原电脑后端选择；旧客户端保存工具配置会保留新增开关。
- 原 `computer_*`、`desktop_*`、`cloud_computer_*` 工具继续走自己的执行路径。浏览器不可用时不会隐式切换环境重做。
- 空闲会话保留需要 Web 和 Runner 支持对应能力。旧 Runner 不能接收未知的保留命令；升级前应按旧行为关闭上下文，不把失败伪装为已保留页面。Cookie 等持久资料不因此删除。新旧节点混用时，以实际节点能力为准。
- 共享 VM 中取消一个 holder，只取消该 holder 的命令。Container 和 Compose 均按操作编号取消进程组，其他 holder 的任务继续运行。
- 工具操作保存意图和有界回执；相同调用编号不会再次执行已提交操作。不确定结果要求先核对，不能盲目重放。
- Container 命令取消无需更换 VM 镜像；Compose 桌面需同步发布更新后的 `deploy/computer/compose_bridge.py`（含 `cancel` 协议）。升级 Compose 时先结束运行任务，再按原部署流程更新桌面镜像；不要只更新 Runner 而保留旧 bridge。
- 回退功能时关闭全局开关和 Runner 的 `browser.enabled`，保留资料目录即可。已有 VM、文件库和 Hermes 配置无需迁移。

## 验证

常规检查：

```sh
npm run typecheck
npm run build
NODE_OPTIONS=--no-experimental-webstorage npm test -- --maxWorkers=4
```

本地 Node 26 的实验性 Web Storage 会覆盖测试环境的 `localStorage`，因此全量测试使用上述选项。

macOS 桌面回归需先生成本地桌面运行包与原生 helper：

```sh
npm run desktop:build
npm run desktop:test
```

真实 Chromium 验收（先安装配套浏览器）：

```sh
YAOYAO_BROWSER_SMOKE=1 npx vitest run tests/runner/browserSmoke.test.ts tests/server/managedBrowserSmoke.test.ts
```

这两项覆盖真实页面操作、上传下载、登录资料恢复，以及 HTTP Runner 领取/准入/结果/授权检查、无 VM 浏览器握手、人工接管与交还。会话保留回归覆盖同一上下文和页面内容得以保留、空闲网络阻断、重新授权恢复、旧代次输入拒绝、只读轮询不延长空闲时间，以及临时会话和撤权后的清理。HTTP 测试使用 Hermes fixture，不代表真实模型自主选择工具的评测。macOS Chromium 和临时 Docker 命令取消已实测；Linux Chromium 沙箱与 Windows 安装仍需目标平台验证，尚无与完整 VM 的性能基准数字。

首次安装和聊天卡片验收：

```sh
YAOYAO_BROWSER_INSTALL_SMOKE=1 NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/runner/browserInstallationSmoke.test.ts --maxWorkers=1
YAOYAO_BROWSER_UI_SMOKE=1 NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/client/managedBrowserCardSmoke.test.ts --maxWorkers=1
```

首次安装测试在独立 Node 进程和全新临时浏览器缓存中实际下载，验证 missing → installing → ready，再打开浏览器截图，结束后删除临时缓存。聊天 UI 测试使用真实 Chromium、隔离服务与浏览器接口 fixture，覆盖结构卡刷新保留、准备后接管、交还、375px、暗色与横屏；该 UI fixture 不代表真实 Runner 安装测试。
