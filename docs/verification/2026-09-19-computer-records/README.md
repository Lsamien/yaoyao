# 同名电脑配对记录修复

电脑列表原先只显示主机名，无法区分不同的配对记录。现在显示连接状态、记录编号和配对时间，并支持刷新、按编号改名以及确认后停用指定记录。同名记录仍分别保留，避免把不同电脑误当成一台。

桌面端首次生成安装标识时存在并发覆盖：20 个并发初始化在修复前返回 20 个不同编号。改成先写完整临时文件，再原子创建安装标识，修复后全部返回同一编号；退出配对、重新创建管理器后也沿用原编号。标识损坏时明确报错，不再静默生成新设备。

验证：

- `node --test desktop/host-manager.test.mjs`：6 项通过，包括并发初始化、持久化、损坏标识及连接撤销。
- `NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/client/hostToolsPanel.test.ts tests/client/botSettingsDialog.test.ts tests/server/desktopHosts.test.ts`：14 项通过。
- `npm run typecheck`、`npm run build` 通过。
- Playwright 使用内存接口验证按编号改名、确认停用后另一条同名记录仍在，无页面异常。
- 浅色桌面、深色桌面、375px 窄屏及 812px 横屏检查；修复了窄屏分类导航撑宽内容的问题，电脑卡片及操作按钮无横向溢出，按钮高度至少 44px。

截图来自 `tests/fixtures/settings-design/index.html?view=computers` 的示例数据，编号、配对时间和连接状态均为模拟值，不能用来判断用户服务器上哪条记录需要停用。尚未读取线上两条记录的实际身份，也未修改线上配对数据。

- [桌面浅色](desktop.png)
- [桌面深色](dark.png)
- [窄屏](narrow.png)
- [横屏](landscape.png)
