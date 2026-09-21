# 电脑选择与桌面窗口验证

修复后，侧栏预览、打开请求、独立窗口和实际控制请求均保留同一个 backend/host。切换预览时立即清除旧截图，并忽略旧目标迟到的响应。显式选中的主机离线或消失时显示不可用，不自动接管服务器。

Electron 的窗口复用按实际电脑目标判断；更换目标先由旧窗口交还控制权，完成关闭后才接管新电脑。交还失败会保留原窗口，不接管新目标。窗口内部手动切换环境后，也同步更新用于判断窗口复用的目标。

验证命令：

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run tests/client/computerTargetSelection.test.ts tests/client/localVmImages.test.ts
npm run build
node --test desktop/computer-targets.test.mjs
```

15 项前端测试通过。真实 Electron 测试使用临时账号、模拟电脑状态和四种不同画面，覆盖服务器、客户端、Grok Bot 云端和独立虚拟机，以及窗口复用、内部切换、无效目标和交还失败。没有操作生产电脑。

截图：[客户端桌面窗口](client-desktop.png)、[390px 手机宽度的客户端预览](selected-client-mobile.png)。截图中的绿色桌面是明确标注的验证画面。

扩展执行 `tests/client/workspaceShell.test.ts` 时，菜单测试仍要求已移除的「添加远程机器人」选项；在修改前的 `a6a8eae` 源码副本上复现了相同失败，与本次桌面目标修复无关。

本次为代码与本地运行验证，尚未部署至 `10.10.1.200`。原生窗口参数传递涉及 Electron preload 和主进程，需要更新桌面客户端并重新启动；仅刷新网页不能更新原生窗口代码。
