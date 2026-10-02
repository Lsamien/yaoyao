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
yaoyao service start      # 启动服务
yaoyao service restart    # 重启服务；已停止的服务会重新启动
yaoyao service uninstall  # 卸载服务（数据保留）
yaoyao --version          # 查看已安装的 npm 包版本
```

版本查询也支持 `yaoyao version` 和 `yaoyao -v`，无需安装或启动服务。

## 配置

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `YAOYAO_HOME` | 数据目录 | `~/.yaoyao` |
| `HERMES_YAOYAO_PORT` | Web 端口 | `15300` |
| `HERMES_YAOYAO_UPSTREAM` | Hermes 上游地址 | `http://127.0.0.1:9119` |

LaunchAgent 安装时的环境会写入 plist；修改环境变量配置后，执行 `yaoyao service install` 重新写入配置并启动服务。`yaoyao service restart` 使用已保存的配置重启。

## 从界面升级

macOS 通过 `yaoyao service install` 注册的独立服务可进入「我的设置 → 更新与回滚」升级：

1. 检查 npm 仓库的新版本，点击「下载更新」。
2. 安装包通过 SHA-512 校验后暂存；当前服务继续运行。
3. 显示「重启服务器」后，由管理员点击生效。后台进程等待任务结束、停止服务，在当前 npm 安装位置覆盖程序及依赖，再启动并验证新版本。
4. 更新成功后页面自动刷新。临时安装包自动清理，不新增版本目录或回滚备份，不保留旧程序；用户数据目录保持原位。

下载状态保存在服务器，即使关闭页面也不会自动重启，重新打开设置仍可继续。重启时使用已经校验的安装包，但 npm 安装依赖仍可能需要仓库连接。远程升级默认关闭，需要显式设置 `HERMES_YAOYAO_ALLOW_REMOTE_UPDATE=1`；接口仍要求管理员登录、Origin 和 CSRF 校验。

全局 npm 安装在原来的包目录更新，也支持之前迁移到版本目录的 npm 服务就地更新；后续更新复用同一路径。`~/.local/share/hermes-yaoyao/current` 指向实际服务的包目录，界面的「当前 Web」显示运行版本。全局安装就地更新后，`yaoyao --version` 也会显示新版本；历史迁移的服务可能与全局启动器版本不同。

npm 覆盖更新不提供回滚入口，覆盖或新版本启动失败时需要修复当前安装再重启，不会自动恢复旧程序或旧数据。源码和 App 的更新机制保持各自原有规则。

首次使用需要先安装包含界面更新功能的 npm 版本。旧版本可用命令升级：

```sh
npm install -g @lsamien/yaoyao@latest
yaoyao service install
```

重复执行全局包的 `service install` 会重新指定服务入口；日常重启使用 `service restart`，后续升级使用界面。

默认 npm 安装自动使用 `npm:@lsamien/yaoyao` 发布源，检查遵循 npm 仓库配置；显式自定义的 Git 仓库继续使用 Git 更新流程。也可设置 `HERMES_YAOYAO_RELEASE_SOURCE=npm:@lsamien/yaoyao`。

## 与其他安装方式的关系

- **Docker**（[Docker 部署说明](docker-install.md)）：隔离性好，含电脑环境等全部能力，适合专用服务器。
- **源码运行**（见 [README](../README.md)）：开发与贡献场景。
- npm 安装与 Docker 安装不要共用同一个数据目录。

## 已知限制

- Linux 的 `service install`（systemd user unit）尚未实现，当前 CLI 在 Linux 上会提示不支持；临时做法：手动运行 `npm root -g` 定位包目录，用进程管理器守护 `node dist-server/server/index.js`（工作目录设为包根目录）。
- Linux 的界面内切换与重启仍需部署管理器支持；当前 npm 界面升级适用于 macOS LaunchAgent 服务。
