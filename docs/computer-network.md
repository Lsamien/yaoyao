# 隔离电脑的公网代理

Runner 可为隔离电脑启用 `public-proxy` 网络策略。现有配置未填写策略时仍为 `none`，不会自动扩大联网权限。

电脑继续使用 `--network none`，不发布网络端口。guest 内的 HTTP 代理只监听 `127.0.0.1:3128`，通过该电脑专属的进程管道，把连接请求交给 Runner。公网 TCP 连接由 Runner 建立，HTTPS 内容保持端到端 TLS，代理不添加宿主 Cookie、模型密钥或账号凭据。

## 地址与授权边界

- 只允许公网 HTTP/HTTPS 的 80、443 端口。
- 按 [IANA IPv4 特殊用途注册表](https://www.iana.org/assignments/iana-ipv4-special-registry/) 和 [IPv6 特殊用途注册表](https://www.iana.org/assignments/iana-ipv6-special-registry/) 保守拒绝私有、回环、链路本地、共享地址、文档和转换等特殊用途范围；IPv6 只接受普通全局单播范围。
- 拒绝 Runner 本机网卡地址、含凭据的地址和不合法 authority；非常规 IPv4 写法先规范化再检查。
- 每个新连接重新解析 DNS，任何一个解析结果不符合策略则拒绝。实际连接固定到已检查的 IP，后续 DNS 变化不能替换目标。
- 建立连接前后、传输期间和周期检查都核验任务租约；创建连接时另外检查控制面授权。停止任务会关闭该电脑的代理和连接。
- 每个代理最多 16 个外部连接、256 MiB 双向流量，有队列大小和空闲超时限制。拒绝一个目标不会为它打开任何宿主 socket。

这是一项保守的公网网页能力，不是通用 VPN、SSH、内网代理或无限流量通道。关闭/移除代理设置只会失去外网连接，不会获得直接访问宿主或内网的能力。

## 客户端配置

电脑创建时设置 HTTP/HTTPS 代理环境变量，供 curl、Python 等命令使用。Runner 在 guest 内配置 Chromium/Chrome 和 Firefox 的代理策略，浏览器仍可访问自己电脑的 loopback 服务。直接连接外部地址仍受无网络命名空间限制。

Web 的执行节点配置新增“联网范围”：

- 公网网页（HTTP / HTTPS）
- 不联网

该选择保存在节点的私有配置中；Agent 的执行环境仍需选择“隔离电脑”。

## 验收

- `tests/server/publicNetwork.test.ts` 验证地址范围、非常规 IP 写法、DNS 混合结果和重绑定、本机地址、异步撤权、连接配额及真实 socket 字节传输。
- `tests/live/network.live.test.ts` 在新建的真实 Docker 电脑中验证仅存在 loopback 网卡，经代理读取 HTTPS 页面、Firefox 打开页面并产生截图、拒绝宿主地址、关闭代理后外网不可达。截图保存在 `test-results/network/browser.png`。
- 启用 `YAOYAO_WORKER_PUBLIC_NETWORK=1` 的 Worker 验收经过完整控制面与打包 Runner，再由真实 guest 访问公网。

联网仍依赖执行节点自身能连接目标公网服务。网络代理不改变电脑工具、文件和任务的归属；本轮测试只使用隔离数据与公开示例页面。
