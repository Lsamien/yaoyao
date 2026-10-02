# Bot 内置密码库（首期）

默认安装提供夭夭服务器本机密码保险箱：登录后在「Bot 模式 → 设置 → 密码管理」创建主密码、手动解锁，即可添加网站密码和 SSH 私钥，无需先安装独立密码库服务。每个账号独立存储，密文位于夭夭数据目录的 `credential-vault/`；单实例锁防止其他 broker 同时写入。默认锁定，重启不自动解锁。它不向 Bot 提供秘密读取、任务租约或自动登录执行。

配置 `HERMES_YAOYAO_VAULT_SOCKET` / `HERMES_YAOYAO_VAULT_TOKEN_FILE` 后，仍使用原有独立密码库服务；显式配置的服务不可用时保持离线，不切换到新的本机保险箱。独立服务可以部署在 Hermes 执行节点，并在隔离部署验收后启用受保护执行器。密码库不是 Hermes 的环境变量或工具配置。

## 密码学与存储

固定依赖 libsodium-wrappers-sumo 0.8.4（官方 npm registry，禁用安装脚本），使用其 Argon2id13 和 XChaCha20-Poly1305。每个账号独立随机 256-bit DEK；主密码经随机 128-bit salt、3 次迭代、64 MiB 内存派生 KEK，包装 DEK。每次包装、写入都使用独立随机 192-bit nonce。AAD 绑定格式版本、账号、vault ID，以及 KDF 参数或文档修订；元数据与秘密一起加密，没有同目录静态解密密钥。

格式 v1 的文件原子替换并 fsync；写入中断应留下旧或新的完整可解密版本。主密码轮换同时更换 salt 和 DEK。加密备份保留 owner 身份，只恢复到未初始化且账号身份相同的库；不能覆盖现有库。迁移必须保留账号 ID。备份可用其导出时的主密码解密，改主密码不会使旧备份失效；遗失主密码无法恢复。没有离线文件回滚检测或硬件密钥保护。

解锁 DEK 只存在 broker 内存，固定到期、锁定、关闭时清除可控字节缓冲。JS 字符串、GC、WASM、交换区和进程转储不提供安全擦除保证，必须配合操作系统隔离；不能据此称“密码永不进入内存”。UI/API 不提供读取密码或私钥明文的接口；编辑秘密是单向替换。

## 执行边界

本机保险箱复用 Web/BFF 内的加密存储与会话校验，不属于独立 OS 身份隔离。主密码和解锁后的材料会进入可信服务器进程内存；同 UID 的任意 shell、调试器或被控制的服务器进程仍可能访问它们。它提供密文落盘和管理 API 的账号/会话隔离，不能据此声称具备抵御同 UID 攻击的隔离保证。需要 Bot 自动使用真实凭据时，应配置并验收下述独立服务；本机模式不会签发任务租约，也不会执行网站、SSH 或 SFTP 操作。

同 OS 用户的 Hermes 任意 shell 可以读取同用户文件或访问进程/IPC，因此单纯子进程、0600 权限、secretref 或加密 DB 不构成隔离。真实部署前需人工批准独立 OS 身份/可信沙箱、私有 IPC、控制面访问权限以及浏览器进程/资料目录边界。Web 管理面也不能与拥有任意本机 shell 的 Hermes 共用可信身份。

正式适配器现已实现，默认仍关闭；只有经过人工审核的隔离部署、私有批准文件、实际 Hermes 进程身份检查均有效时，CLI 才声明 `protected-adapters`。批准文件是管理员对 OS/IPC/CDP/网络边界的信任声明，不是代码自动证明。未配置、过期、身份变化、撤销时锁库并中止授权，不能退回通用 fill、host_shell、环境变量或临时密钥文件。配置不会创建 OS 身份或安装服务。配置与审阅步骤见 [部署模板](../deploy/credential-vault/README.md)。

网站仅支持用户在专用 UI 配置的主页面标准 HTML POST 表单：固定 HTTPS origin、登录/提交/成功页路径、form id、输入 name 和成功标记，允许成功跳转也必须预先指定。每个授权使用独立无持久资料的 Playwright Chromium/context，经私有 pipe 控制，无公开 CDP、截图、DOM/请求/Cookie 工具；受保护阶段不交给 Bot 通用浏览器。跨 origin、iframe、popup、SSO、MFA、验证码、XHR 登录或不匹配表单转人工接管，不会猜测或通用 fill/JS 降级。销毁本地 Cookie/context；可配置同 origin 固定 GET 退出路径，在正常完成时执行。未配置退出或中途取消时不能保证远端会话撤销，需站点自身过期/人工核对。登录成功回执只是认证证明，本期没有提供登录后任意网站浏览/业务操作；不能将受保护 Cookie 导出给通用工具。浏览器路由检查不能代替 OS 网络策略（例如 WebRTC/后台网络），也不能代替独立身份/禁止调试。

SSH/SFTP 使用固定 `ssh2` 1.17.0，公钥认证及用户确认的 SHA256 host key，未知 host key 拒绝且不会尝试密码认证。SSH 只执行预先配置的绝对可执行文件，无参数/插值/PTY/环境/Agent forwarding/代理/端口转发，返回退出码，不返回 stdout/stderr。服务器协议内部执行方式由远端 SSH 服务决定，这不等于任意远端程序的沙箱。SFTP 只读取指定普通文件并返回有界字节数/校验，或把专用 UI 输入且加密的固定正文以 0600/exclusive-create 写到批准的绝对新路径；不覆盖已存在文件，不允许 Bot 提供正文/路径。限制为读至多 1 MiB、写至多 64 KiB，旧空正文编辑保留，不回显。没有将任意服务器上的实时文件/符号链接竞态转化为强隔离；远端目录仍必须由可信账号控制。执行断开/取消会关闭短连接，远端命令可能已执行、写入可能已部分落盘，不能自动重试或自动删除结果。明文 FTP 不支持。

开发仅使用临时目录中的 dummy 凭据和本机测试夹具。真实秘密录入、真实登录、OS 用户/权限/守护进程安装及生产切换都不属于本轮本地实现操作。

官方说明：[libsodium.js](https://github.com/jedisct1/libsodium.js)、[Argon2id](https://doc.libsodium.org/password_hashing/default_phf)、[XChaCha20-Poly1305](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction)。

## 首期可操作范围与接入

Web 的「Bot 模式 → 设置 → 密码管理」提供创建、手动解锁 5 分钟、加密条目 CRUD、立即锁定、60 秒单任务引用授权/撤销、加密备份/同账号恢复及主密码和 DEK 轮换。解锁前不展示条目元数据，编辑不读取原秘密。关闭/隐藏管理页会清除输入、取消待返回请求并尝试锁定；网络不可达时不能保证这条锁定请求送达，因此 broker 自身仍实行固定到期。不能保证清理浏览器/OS 的内存历史，录入只应在可信用户管理页面进行。

私有协议为 `credential-vault/v1`（HTTP JSON，经 Unix socket，禁止 Origin），没有 read-secret 命令；`execute` 仅接受单次短授权与固定范围，正式 CLI 未注入执行器时明确拒绝。每次 Web 控制进程重新握手都会锁定全部库并撤销旧授权。BFF 重启不会恢复授权或重放操作。UI/API `GET /api/app/vault` 返回状态、元数据、活动任务和待授权请求；其下 POST `initialize/unlock/lock/rotate/backup/restore`，POST `entries/leases`，PUT/DELETE `entries/:id`，DELETE `leases/:id` 均沿用当前登录、精确 Origin、CSRF 和 owner 校验；管理入口仅接受 HTTPS 或本机回环 HTTP。不依赖全局「允许不安全局域网」选项。

Runner 只声明 `credential-ref-v1`，**没有** `credential-executor-v1`。授权绑定 owner、本次登录、Bot、活动 work ID、Runner ID/instance/epoch、精确 origin 或 SSH 主机/端口/host key、操作、凭据版本和到期时间。停止/取消/删除/权限变更/重连/锁定/轮换/条目改动使旧授权失效，迟到的解锁或 grant 响应不能恢复权限。旧 Runner 明确拒绝；离线/锁定时 Bot 在任务的 waiting 状态等待，最长 120 秒后返回未执行的等待结果。任务取消会释放等待并撤销授权。

Bot 工具只有 `credential_refs` 与 `credential_request`，输入严格为引用及操作，模型看不到用户名/密码/私钥/主密码/控制 token，也不能选择新的路径、正文、命令或表单。refs 返回当前任务的目标和公开的固定使用计划，不含 SFTP 正文。专用 UI 授权后，正式适配器在 broker 内实际使用秘密，返回严格白名单回执；空/额外字段/操作不匹配的正式回执均拒绝。重复工具 call ID 只收到原脱敏回执，不重复执行。缺使用计划或不支持的站点会明确返回人工接管，执行后未确认返回 `vault_operation_uncertain`，不能假称成功或转回等待后自动重试。私有 IPC 断连中止当前租约；Runner 在回执抵达前重连也返回未知结果。旧 `FixtureWebsiteLoginExecutor` 仍只是最初的专用测试夹具，生产入口不加载它。

真实 WorkspaceRuntime 工具目录/调用上下文、专用用户授权 API、私有 IPC 和正式 adapter 已通过本地 HTTPS 标准表单、SSH 公钥固定命令、SFTP 读和写协议验收。Hermes 网关和模型是 stub，broker/工具 HTTP/浏览器/SSH 协议均执行实际代码。这不是不同 OS 身份攻击验收。

## 部署前需人工完成的边界（本轮未执行）

1. 选择 Hermes 所在的同一执行节点，确认 Hermes 非 root 身份，并为 Web 管理面与 vault 分配不同于 Hermes 的非 root 可信服务身份。首期为同主机 Unix IPC；远程 Web → vault 网络通道尚未实现，不能将 Unix socket 暴露为 TCP 或经通用 Runner 转发主密码。
2. 人工审核 broker、Web 管理面、配置、socket 父目录、控制 token、库目录的 ownership、ACL、进程调试/core dump、备份访问及管理浏览器隔离。代码检查私有权限、批准时效及 Hermes PID 的实际 UID，但这些检查不是 OS 边界的完整证据；Hermes 的 shell 不得读取控制 token、管理面登录会话或访问私有 IPC。两者为同用户时直接拒绝，不自动改 OS 设置。
3. 在该可信控制身份下人工准备 0700 私有目录，以及 0600 配置和高熵控制 token 文件；token 仅用于 IPC 认证，绝不是静态解密密钥。配置结构 `{ "home": "/私有库目录", "socket": "/私有连接目录/vault.sock", "tokenFile": "/私有连接目录/control.token", "hermesUid": 12345 }` 中的 UID 是文档示例，必须填实测 UID，且不能与控制服务身份相同。不要把这些文件放入仓库或 Hermes 工作目录。
4. 经部署批准后，使用 Node >=24、生产依赖和构建输出，人工前台执行 `node dist-server/server/credentialVault/index.js --config /私有路径/vault.json`。单实例控制避免两个 broker 同时写库；启动会检查而不会创建 OS 身份/安装守护进程。Web 配置 `HERMES_YAOYAO_VAULT_SOCKET`、`HERMES_YAOYAO_VAULT_TOKEN_FILE`、`HERMES_YAOYAO_VAULT_HERMES_UID`，它们只有路径/UID。未配置外部服务时使用仅存储的本机保险箱；配置后连接失败保持离线，不自动降级。
5. 用户亲自在专用 UI 创建并解锁。上线前还需验证真实 OS/IPC 攻击边界、HTTPS 管理通道及备份恢复，不把本地同进程 dummy 测试作为隔离验收。本轮没有实际创建服务身份、控制凭据、生产密码库或录入真实秘密。

受保护执行器的部署仍需要独立安全验收：限定操作及单次提交，执行前/后检查授权，撤销中止；结果只返回脱敏状态，执行断线或取消结果不明确时禁止自动重试。浏览器填充阶段必须独占并隔离 DOM、请求、Cookie、截图、CDP 与同 UID shell；登录后的站点操作也须走受限动作/脱敏返回，不能向模型开放可读 Cookie 的通用浏览器。SSH/SFTP 要独立短连接及已确认的 host key，不能允许 shell 自选命令、任意跳板/代理、端口转发、agent forwarding、密钥导出或明文 FTP。

## 本地验证

`tests/server/credentialVaultStore.test.ts`：密文与默认锁定、AAD 篡改、fresh nonce/修订、备份和轮换写入中断。`credentialVaultBroker.test.ts`：作用域、默认拒绝、单次消费、锁定/登出/撤权/取消/重连/修改/删除/到期的在途中止、脱敏审计及 symlink 拒绝。`credentialVaultCoordinator.test.ts`：dummy Unix IPC、迟到解锁/grant、会话与任务/Runner 失效、等待取消、HTTPS/旧 Runner拒绝。`credentialVaultRoutes.test.ts` 使用真实 Web/LocalAuth 但上游为 stub，检查认证/Origin/CSRF/登出联动。`tests/client/credentialVaultPanel.test.ts`：专用输入、无 localStorage、无明文回显、编辑空值保留、关闭/隐藏时取消并锁定。Runner 现有本机夹具验证能力声明。

测试连接临时本地 HTTPS/SSH/SFTP 服务，只使用 dummy 账号；没有真实账号、跨 OS 身份穿透测试、移动端专用原生密码库 UI、端到端生产部署或真机验收。现有移动端与独立原生管理器不在首期范围。

## 首期验收记录（2026-09-30）

存储底座提交 `9092831`；UI、私有 broker/IPC、任务短授权、Runner 引用能力和工作的本地 dummy 网站登录工具链提交 `771c72c`。中间 `d1650ef` 是并行的客户端上下文统计工作，不属于密码库修改。版本保持 v0.4.77，私有密码库协议 v1，没有自行升版。

最终非 live 回归 `vitest run --exclude 'tests/live/**' --maxWorkers=2` 为 **2144 passed / 7 skipped / 0 failed**，其中密码库 6 个测试文件共 41 项通过，包括真实 WorkspaceRuntime 的 Bot 工具目录/调用、用户任务授权、私有 IPC、HTTPS dummy 实际认证、受保护页面访问及脱敏回执/调用去重。另有真实 Runner 夹具 29 项、LocalAuth 7 项通过。类型检查、Web/服务端 build、Runner build 均通过。首次默认并行全量为 2130 passed / 2 failed / 7 skipped：Kanban 无效 board 返回状态和十活动任务调度；两项隔离复验通过，降低 worker 并行度后的最终全量也通过，未放宽断言/超时。首跑失败根因尚未完全确定，不能宣称已修复产品缺陷。

日志/JSON 在本机 `/tmp/yaoyao-vault-final-vitest.log`、`/tmp/yaoyao-vault-final-vitest.json`、`/tmp/yaoyao-vault-final-typecheck.log`、`/tmp/yaoyao-vault-final-build.log`、`/tmp/yaoyao-vault-final-runner-build.log`；首次全量证据为 `/tmp/yaoyao-vault-full-vitest.json`，隔离复验为 `/tmp/yaoyao-vault-isolated-failures.log`。构建输出为 `dist/`、`dist-server/server/credentialVault/` 和 `.runner-build/runner.mjs`，只进行了构建检查，没有打新签名安装包、推送、部署、重启生产或安装到日常设备；工作区并行附件修改另行负责，未混入密码库提交。

未验证的真实边界：不同 OS 身份间的隔离与攻击验证、部署后的 HTTPS 用户管理通道、复杂网站/登录后业务操作、真实外部 SSH/SFTP 目标、移动原生 UI、真实 Hermes/模型自主调用和生产数据恢复。上游 Hermes 模型/网关为测试夹具；Web/WorkspaceRuntime、工具 HTTP 路由、vault IPC、用户授权与本地 HTTPS 认证是实际代码执行。整个开发只接触 dummy 数据，未扫描 Keychain/.env/既有秘密库或录入真实秘密。正式 adapter 的本地协议实现已完成；实际 OS/IPC/CDP/网络部署尚未批准/实施/验收，当前环境不启用真实凭据登录。

## 正式适配器本地验收（2026-09-30）

实现提交 `cf0c6f0`，以并行聊天布局提交 `5ebefde` 为基准，未覆盖或混入其修改。版本仍为 v0.4.77。正式 adapter、Web/BFF/UI 与 broker 应使用此提交或其后兼容版本；Runner 仍使用 `credential-ref-v1`，不承担秘密执行，也没有增加虚假的 executor 能力声明。旧已交付签名安装包未更新，不能据其旧管理 UI 声称本次使用计划已经可操作；本轮只编译源码输出，不打包、安装或切换线上。

默认并行全量 `vitest run --exclude 'tests/live/**'`：**2168 passed / 7 skipped / 0 failed**，其中密码库 7 文件 **65 项**全部通过。协议夹具实际运行 HTTPS 标准表单/成功页/退出页、SSH 公钥固定命令及 SFTP 读/写；Bot 流程 7 项从真实工具目录和任务授权到正式 adapter/脱敏回执，含网站/SSH/SFTP 执行中锁库撤权及 call ID 去重。另覆盖跨 origin/iframe/重定向拒绝、错误 host key 在认证前拒绝、非法密钥、有界读/指定路径、新文件排他写、无回执/泄露输出拒绝、失去私有连接/Runner 迟到回执、隔离批准撤销、专用 UI 计划编辑和固定正文密文保存。取消可能已有外部效果，测试确认未知结果和不重试，不能宣称远端回滚。

类型检查、Web/服务端 build、Runner build 均通过。源码构建 `build-info.json` 为 `cf0c6f0`、build 675、dirty=true（用户原有未跟踪 `.zcode/` 保留，代码已提交）；没有自主修改 package/release 版本。输出为 `dist/`、`dist-server/server/credentialVault/`、`.runner-build/runner.mjs`。Vite 仍报告现有大 chunk 警告；未调整警告阈值。没有 lint 脚本，不新增工具掩盖检查缺口。

历史首跑不稳定仍记录：`kanbanRoutes.test.ts / requires an explicit canonical board on every board-scoped endpoint` 在无效 board 请求期望400、收到404；`workspace.test.ts / admits ten active conversation tasks for one Agent and rejects the eleventh without stopping them` 在默认 vi.waitFor 期望10个 prompt、收到7个。两完整文件本轮按默认并行复验126项通过，随后默认并行全量也通过；原始根因尚未定位，不能称已修复。没有简单降低 worker 掩盖本轮最终结果，也没有放宽原断言/超时。新增取消测试中发现夹具未分派 execute，以及使用轮询撞上工具等待间隔；已改为正确分派和等待协议明确提交事件。

证据：`/tmp/yaoyao-vault-adapters-full.json`、`/tmp/yaoyao-vault-adapters-full.log`、`/tmp/yaoyao-vault-adapters-races.log`、`/tmp/yaoyao-vault-adapters-prior-failures.log`、`/tmp/yaoyao-vault-adapters-typecheck.log`、`/tmp/yaoyao-vault-adapters-build.log`、`/tmp/yaoyao-vault-adapters-runner-build.log`。只读/受限沙箱首跑不能绑定回环端口（EPERM），经授权放行本地测试后运行；没有真实网站/SSH 账号、OS 身份设置、守护进程安装、网络配置、推送或部署。
