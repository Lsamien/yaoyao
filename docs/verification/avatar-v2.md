# 头像 v2 验收

> 以下为初始 OpenMausBot 版本的历史验收记录。当前双眼样式及已更新的对照命令见 [LaoA 三端验收](laoa-avatars.md)。

参考 OpenMausBot 提交 `3a84701`，参考仓库仅作读取。Web 移植为 Vue 与独立 SVG 动画控制器；iOS 移植对应 Swift 绘制代码与数据。没有新增运行服务或图片生成能力。

## 外观

`npx playwright test -c playwright.avatar.config.ts` 运行两个隔离页面：参考 React 实现与产品 Vue 实现。默认参考仓库为相邻 `OpenMausBot`，也可指定 `OPENMAUS_REFERENCE_ROOT`。

28 个固定帧覆盖 8 个基础形状、10 个额外造型、10 个表情。只在临时参考副本中固定时钟为 0 并完成初始表情插值，逐项比较 SVG 轮廓属性、脸部锚点、眼睛路径与变换、嘴部路径与变换和纯色。

iOS 的 `DeterministicFlowsUITests/testAvatarV2CanonicalFramesAndEditor` 截取相同 28 个固定帧，并实际选择额外造型、颜色，验证重新选择基础形状清除额外造型。

本次对照通过。归一到相同尺寸后，Web 截图最大平均 RGB 差值约 0.012/255，iOS 与参考截图最大约 1.869/255；差异位于边缘抗锯齿及截图像素取整。背景透明，不附加头像底图。

## 保存、迁移与运行

- 共享编解码测试遍历形状、造型和照片裁剪；验证 v1 归一、v2 保留、隐藏照片不丢失和非法描述拒绝。
- 服务端测试重启 SQLite 存储，验证一次性迁移保留角色规则、照片和单聊快照，后续 v2 修改不被重置。
- Workspace 浏览器流程实际新建 Bot、聊天、组群、更新成员头像，并选择造型／表情／照片裁剪，保存重开后验证。
- 运行态测试覆盖成员执行与待确认；追加验证排队任务不能覆盖同一成员的活动状态，过期结果不重播。
- Web 渲染器测试验证空闲列表不安排动画帧、执行态播放、离屏／后台／减少动态效果暂停，以及照片加载失败降级。

## iOS 与 Web 的真实存储回读

使用隔离服务和合成账号，避免修改真实用户会话：

```sh
WORKSPACE_FIXTURE_PORT=18804 WORKSPACE_FIXTURE_UPSTREAM_PORT=19124 node --import tsx tests/fixtures/workspace-server.ts
# 在另一个终端执行，每次测试前重置这两个测试头像：
node scripts/seed-avatar-fixture.mjs
```

随后运行 iOS `DeterministicFlowsUITests/testAvatarV2ChangesRoundTripThroughWebStorage`。测试通过真实登录与 Bot 设置：Web 种下星星造型，iOS 改菱形；Web 种下圆形照片，iOS 改方形，保存重开后改圆角。每次用 Web API 回读，核对颜色、表情、造型／裁剪及原始图片字节未变。本次模拟器验证通过。

签名 IPA 的打包与签名检查独立于模拟器验证；本次不把模拟器结果视作实体设备安装证明。

## 回归范围与已知旧用例

本次 Web 全量单元／服务测试 506 项通过，类型检查与生产构建通过；iOS 相关单元测试 62 项通过。当前 Bot 模式完整浏览器流程、28 组头像对照与两条 iOS UI 流程通过。

通用旧浏览器套件包含过时的页面与状态断言；本次运行失败 7 条，停止后其余 30 条未执行，1 条中断，不将这次通用套件记为全量通过。当前 Bot 流程由 `playwright.workspace.config.ts` 的实际新建、设置、群聊与持久化流程验证；普通聊天与媒体另行回归。
