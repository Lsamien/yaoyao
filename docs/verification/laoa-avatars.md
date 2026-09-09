# LaoA 双眼头像三端验收

2026-09-07。采用 LaoA-GrokBot `527c3b5` 的双眼表达和基础轮廓；沿用 v2 配置、颜色、图片及额外造型。没有添加配饰，没有修改服务端协议或用户存量配置。

## 统一数据与尺寸

规范源为 `assets/mascot/laoa-source.json`，记录完整上游提交与保留的 OpenMausBot 造型。生成器统一转换路径、计算真实轮廓边界，并为较窄造型计算可容纳全部表情的双眼缩放。SVG、Swift 与 Kotlin 使用相同结果，各仓库可独立构建。

```sh
node scripts/generate-laoa-avatars.mjs --ios ../hermes-mobile --android ../hermes-android
node scripts/generate-laoa-avatars.mjs --check --ios ../hermes-mobile --android ../hermes-android
```

列表容器继续为 44；最大可见边从圆形原先约 36.76 增至 44，约放大 19.7%。窄、扁轮廓保持自身比例，文字起点和行距不变。静态列表不运行连续动画，运行态沿用暂停与可见性处理。iOS 为运行态画布留出绘制空间，外部布局仍为原尺寸。

## 已完成验证

- Web：头像与配置单元测试 13 项通过；类型检查及生产构建通过。
- 浏览器：53 个固定样例通过原始 SVG 路径渲染对照，覆盖 8 个基础形状、10 个额外造型、10 个可选表情和 25 套原始双眼。检查真实边界、居中、原始眼睛数据、无嘴巴和减少动态效果。
- iOS：8 项头像单元测试、固定样例/编辑 UI、深浅色列表 UI 和隔离服务回读 UI 全部通过。使用独立 iPhone 17 Pro 模拟器，无失败或跳过。
- 安卓：core:model 28 项、core:network 34 项测试通过；53 样例/深浅色、基础编辑、真实服务回读共 3 项 UI 测试通过；Debug APK 和 Lint 通过。
- 三端 53 个样例分别归一到 96×96 比较。对 Web 截图的最大平均 RGB 差值：iOS 2.0737/255、安卓 0.6831/255，主要为边缘抗锯齿与像素取整。逐项数值见 [pixel-comparison.json](laoa-avatars/pixel-comparison.json)。

## 跨端回读流程

全部使用一次性测试服务和合成账号。Web 种下星星；iOS 界面保存菱形，并将测试照片改为圆角裁剪；安卓读取该菱形，界面改为橙色云朵和开心表情；Web 再经真实登录页面及接口读回。图片字节与 iOS 设置的裁剪方式保持一致。

```sh
WORKSPACE_FIXTURE_PORT=18804 WORKSPACE_FIXTURE_UPSTREAM_PORT=19124 node --import tsx tests/fixtures/workspace-server.ts
node scripts/seed-avatar-fixture.mjs
# 随后在独立 iOS 模拟器运行 testAvatarV2ChangesRoundTripThroughWebStorage，
# 在 Android 模拟器运行 AgentAvatarRoundTripTest，再执行：
npx playwright test -c playwright.avatar-roundtrip.config.ts
# 53 个图形样例可单独验证：
npx playwright test -c playwright.avatar.config.ts
```

安卓真实回读验证同时修复了包含较大头像的 JSON 响应在主线程读取的问题；响应体读取和解析现在在 IO dispatcher 完成。安卓原生 Bot 会在列表展示后读取桌面头像资源，失败保留共享头像，并阻止旧账号/旧刷新结果回写。

## 截图与交付边界

- [Web 全部头像](laoa-avatars/web-avatar-grid.png)、[深色](laoa-avatars/web-avatar-grid-dark.png)
- [Web 实际列表](laoa-avatars/web-workspace-roundtrip.png)、[375 宽度网页](laoa-avatars/web-workspace-mobile.png)
- iOS 与安卓截图分别保存在对应仓库的头像验收文档。

本次为源码、构建和模拟器验收；未进行生产发布或真实手机安装。产品官网与桌面应用仓库未修改。
