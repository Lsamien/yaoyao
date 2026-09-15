# Docker Hermes 目录映射验证

## 桌面包先行完成

桌面包在 Docker 修改前已生成，源码提交为 `3872bf0`，版本 `0.4.21`、macOS arm64。DMG、App 严格签名和独立 Web 服务资源校验通过；正式 App 的 25 项桌面测试通过，包括独立服务启动、重试、同版本覆盖及数据保留。签名为 Apple Development，未公证、未安装到用户应用目录。

## Docker 验证

- 本地构建镜像：`yaoyao:hermes-bridge-mount-20260915`（本次验证为 linux/arm64）。
- 使用 `tests/live/dockerHermesBridge.live.test.ts` 启动真实 Web 容器，Hermes HTTP 上游采用私有测试网络内的确定性模拟服务。
- 普通 Web、标准共享桌面和 Cursor 共享桌面三种 Compose 配置均成功合并可选映射，保留只读根文件系统、cap_drop、外部 Runner 和关闭 Hermes 自动托管等设置。
- 容器以 UID 1000 运行，自带 Python/PyYAML，在 `/hermes` 映射中检查和安装默认及命名 Profile 的插件。
- 通过管理员 HTTP 接口安装后，在宿主机临时目录确认插件文件、原始配置备份和保留的配置内容。
- 未安装默认后台入口时，命名 Profile 的无效安装请求被拒绝。
- 安装结果为“待重启”，未把复制成功误报成已加载；没有请求上游启动、停止或重启。
- 测试容器、网络、数据卷与临时目录均已清理。用户现有 Hermes 目录和运行中的部署未修改。

复现命令：

```sh
docker build -t yaoyao:hermes-bridge-mount-test .
YAOYAO_DOCKER_BRIDGE_IMAGE=yaoyao:hermes-bridge-mount-test \
  NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  NODE_OPTIONS=--no-experimental-webstorage \
  npx vitest run tests/live/dockerHermesBridge.live.test.ts
```
