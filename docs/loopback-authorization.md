# 15300 到 9119 的本机授权（已停用）

Hermes 已内置在夭夭服务中（见 [内置 Hermes 迁移](embedded-hermes-migration.md)），服务端直接拉起内核进程，不再连接 9119，因此本文描述的回环令牌、服务账号和 Dashboard 托管启动都已不再使用：

- 不需要也不能再配置 9119 服务账号；夭夭自己的 Web 账号是唯一登录方式。
- 不再启动或守护本机 Hermes Dashboard；`HERMES_YAOYAO_UPSTREAM*`、`HERMES_YAOYAO_SUPERVISE_DASHBOARD` 设置后只在启动日志提示已停用。
- 15300 的用户登录、权限、CSRF、设备 scope 与 HTTP+SSE 接口保持不变。

`src/server/loopbackAuthorization.ts` 及相关单元测试暂时保留，仅供测试夹具中的模拟上游使用，生产环境不经过这条路径。
