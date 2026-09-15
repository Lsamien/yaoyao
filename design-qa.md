# Bot 设置与我的设置 · 第 3 组设计对照

## Findings

- 当前无未解决的 P0、P1 或 P2 问题。
- P3：项目成员使用产品现有的真实头像组件，示例图中的纯色圆点与 +1 占位没有照搬。所有成员姓名可以查看。
- P3：保留原有管理与基础机器人功能，超出设计图显示范围的分类可在左栏滚动访问。

## Source visual truth

- 用户选择：本次 ideation 第 3 张实际输出。
- 文件：`docs/design/settings-reference.png`（1983 × 793）。
- 原图：`/Users/samien/.codex/generated_images/01a0a29b-2f08-7f51-8a4e-81b93631bf5b/exec-4ae99c1e-db43-4f23-9b67-7f9df8424943.png`。
- 图中每个弹窗约 900 × 648；两张图分别呈现 Bot 项目页和个人外观页。

## Implementation evidence

- Bot 桌面：`docs/design/settings-bot-desktop.jpg`，1280 × 720。
- 我的设置桌面：`docs/design/settings-personal-desktop.jpg`，1280 × 720。
- Bot 手机：`docs/design/settings-bot-mobile.jpg`，390 × 844。
- 我的设置手机：`docs/design/settings-personal-mobile.jpg`，390 × 844。
- 深色：`docs/design/settings-personal-dark.jpg`，1280 × 720。
- 截图来自本次 CUA 浏览器捕获，原始捕获字节从当前任务记录保存，未重绘或改写图片。
- 验证入口：`http://127.0.0.1:5173/tests/fixtures/settings-design/`，个人外观状态使用 `?view=appearance`。
- 这是测试夹具，使用正式 Vue 组件。API 在夹具内存中处理，不修改生产项目或账号。

## Viewport / normalization / state

- 桌面 CSS viewport：1280 × 720；截图同尺寸，按 1:1 CSS 像素检查。
- 实现弹窗实测：900 × 650，位置 x=190、y=35；标题栏 60px、左栏 208px。
- 源图是两个弹窗并排的设计画板。对比弹窗内容区域，排除画板边距、页面背景及 2px 高度差异；未将整张画板拉伸来比较。
- 手机 CSS viewport：390 × 844，截图同尺寸；个人设置改为分类页与详情页，Bot 三个分类横向排列。
- 主题：浅色、深色均验证。项目页为两个示例项目；源图示例数据没有写入生产。

## Comparison history

1. 初查发现 [P2] Bot 项目详情行高偏大，900 × 650 弹窗出现额外纵向滚动。
   - 调整详情行高 56px → 48px，标题下间距 16px → 12px，底部按钮间距 14px → 8px。
2. 修正后在同一个 CUA 对照输入中同时展示源图、Bot 桌面截图和个人设置桌面截图。
   - Bot 内容区 clientHeight=588、scrollHeight=588，完整显示列表和详情。
   - 整体分栏、标题位置、灰色分组、选中行、紧凑操作按钮与主题预览卡符合所选方向。
   - 正文及控件在 900px 弹窗截图中可直接阅读，重点检查了项目成员行、编辑按钮、主题卡及左侧分类，无需另做放大图。

## Required fidelity surfaces

- 字体：使用现有 Inter / SF Pro / PingFang SC 字体栈；弹窗标题和内容标题 18px，导航与详情正文 14px，辅助文本 12–13px。
- 间距与布局：两个弹窗统一 900 × 650、14px 圆角、208px 左栏；内容区 24px 内边距。项目列表与详情在桌面完整显示。
- 颜色：增加设置专用的 panel/sidebar/selected 语义色，浅色使用中性灰；深色保持可读对比，选中主题同时有边框、标记与 aria-checked。
- 图片：三张主题缩略图由 ImageGen 生成，480 × 300，使用真实 PNG 资产；图标与头像复用现有组件/图标库。
- 文案：界面使用“Bot 设置”“我的设置”；项目名称、成员和群聊均绑定实际数据，账号、权限与管理入口的作用范围保留。

## Interaction verification

- 示例项目选择后，详情正确切换。
- 编辑示例项目名称并保存，列表与详情同步更新。
- 原有用户记忆与项目记忆入口保持可用；相关组件测试通过。
- 深色/浅色切换更新选择状态与实际主题，夹具内不保存用户浏览器偏好。
- 手机个人设置 Escape 返回分类，并将焦点还给当前分类。
- 手机个人设置实测 clientWidth=scrollWidth=390，内容区域无水平溢出；Bot 手机截图无裁切或水平滚动。
- 普通账号实际预览只显示个人分类；管理员页面和虚拟机设置权限由组件测试覆盖。
- 设置内补充 Tab 首尾循环，隐藏头像文件输入不进入键盘顺序。
- 本次浏览器预览控制台未发现应用错误；预览最初缺少 CSRF 夹具响应，已补齐后完成保存验证。

## Implementation checklist

- [x] Bot 左侧分类与项目列表/详情。
- [x] 个人设置搜索、分类与主题预览。
- [x] 账号资料与安全内容分开，保留原有保存接口。
- [x] 现有权限、未保存提醒及更新锁保留。
- [x] 桌面、手机与深色视觉检查。
- [x] 34 项相关组件测试通过，类型检查通过。

final result: passed
