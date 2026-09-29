# npm 安装服务端

适用于已有 Node.js 24 环境、希望在非 Docker 环境运行夭夭服务端的场景。macOS 与 Linux 均可。

## 安装

```sh
npm install -g @lsamien/yaoyao
```

要求 Node.js 24 或更高版本（`node -v` 确认）。安装过程约 300 个依赖包；其中 Playwright 供托管浏览器功能使用，浏览器内核不随包安装，首次使用相关功能时按提示安装。

### Windows 用户注意

`@parcel/watcher` 的原生编译提示可以忽略：它只服务于开发模式的热更新，生产服务端不经过 Vite，缺失时自动回落，不影响运行。

## 启动服务

```sh
yaoyao service install
```

- **macOS**：注册 LaunchAgent（`com.samien.hermes-yaoyao`）并立即启动，开机自启。
- **Linux**：需要 systemd 支持（尚未提供，参见下文路线）。

安装后访问 `http://127.0.0.1:15300`，首次打开自行创建管理员账号。

其他命令：

```sh
yaoyao service status     # 查看运行状态
yaoyao service stop       # 停止服务
yaoyao service start      # 重新启动
yaoyao service uninstall  # 卸载服务（数据保留）
```

## 配置

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `YAOYAO_HOME` | 数据目录 | `~/.yaoyao` |
| `HERMES_YAOYAO_PORT` | Web 端口 | `15300` |
| `HERMES_YAOYAO_UPSTREAM` | Hermes 上游地址 | `http://127.0.0.1:9119` |

LaunchAgent 安装时的环境会写入 plist；修改配置后执行 `yaoyao service stop && yaoyao service start` 生效。

## 升级

```sh
npm update -g @lsamien/yaoyao
yaoyao service stop && yaoyao service start
```

Web 界面中的「系统更新」入口面向源码/发布包安装；npm 安装的服务请直接用上述 npm 命令升级，避免两套版本并存。

## 与其他安装方式的关系

- **Docker**（[Docker 部署说明](docker-install.md)）：隔离性好，含电脑环境等全部能力，适合专用服务器。
- **源码运行**（见 [README](../README.md)）：开发与贡献场景。
- npm 安装与 Docker 安装不要共用同一个数据目录。

## 已知限制

- Linux 的 `service install`（systemd user unit）尚未实现，当前 CLI 在 Linux 上会提示不支持；临时做法：手动运行 `npm root -g` 定位包目录，用进程管理器守护 `node dist-server/server/index.js`（工作目录设为包根目录）。
- 通过 npm 安装的服务端不支持在 Web 界面内自更新（版本由 npm 管理）。
