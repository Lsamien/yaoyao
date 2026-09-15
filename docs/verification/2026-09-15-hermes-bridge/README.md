# 工具桥检查与安装验证

入口：设置 → Hermes 连接 → 工具桥插件，仅管理员可见。

## 覆盖内容

- 按默认及命名 Profile 检查安装版本、已加载版本和代码指纹。
- 安装、明确启用、更新、重新安装与备份位置展示。
- 默认 Profile 后台入口缺失时，阻止无效的命名 Profile 安装并给出顺序提示。
- 未安装、未启用、需更新、待重启、已就绪和无法确认状态。
- 管理员权限、CSRF、非法 Profile/路径输入、安装互斥与运行中任务检查。
- 同版本代码变化、损坏插件修复、显式启用只调整目标插件、失败恢复原配置。

## 验证方式

- `tests/server/hermesBridge.test.ts`：管理器状态、安装互斥、接口授权及错误边界。
- `tests/client/hermesBridgePanel.test.ts`：进度、目标 Profile、失败反馈、远程安装限制。
- `integrations/hermes-bots-bridge/tests/test_installer.py`：临时目录中的实际安装、只读检查、备份及回滚。
- `tests/live/profileComputer.live.test.ts`：临时 Hermes + 真实 Python 安装器；运行期间替换同版本插件包后，检查结果正确为“待重启”。同时保留原有真实 Docker、Skill 与审批链路验证。模型响应和授权文件采用测试数据。
- `playwright.hermes-bridge.config.ts`：真实设置页面 + 确定性的管理接口响应，检查安装请求、按钮禁用、状态切换、375px 窄屏、812px 横屏和暗色主题。

## 界面截图

- [桌面检查](desktop-before.png)
- [安装完成待重启](desktop-installed.png)
- [手机宽度](mobile-ready.png)
- [横屏](landscape-ready.png)
- [暗色主题](dark-ready.png)

验证使用临时环境，没有安装到用户当前运行的 Hermes，也没有重启现有服务。
