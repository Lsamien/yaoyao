# 聊天气泡外观 · 三端设计验收（2026-09-21）

## Findings

- 没有未解决的 P0/P1/P2 问题。
- 三套预设为「当前样式」「Grok Bot」「Codex」。Codex 的双方消息都保留填充气泡；Grok Bot 使用黑白灰。
- 适用范围明确为当前设备上的所有会话。设计中的范围下拉改为静态说明；本次不提供账号同步或单会话覆盖。
- 文字颜色自动选择可读前景色；不开放可能导致不可读组合的任意文字色。极端渐变增加遮罩以保持正文对比度。

## Source visual truth / normalization

- Source: `/Users/samien/git/yaoyao/docs/chat-appearance/approved-design.png`，1619 × 972 px，用户确认的桌面与移动端并排设计画板。
- 按画板内桌面/手机内容区域比较，不拉伸整张画板；忽略画板标题、留白和设备系统栏。设计不是等比例设备截图，因此只比较对应布局与控件，不宣称逐像素一致。
- 对比时将原图与实际截图放在同一工具输入中；深色和实际聊天属于补充状态，设计原图未提供其逐像素目标。

## Required fidelity surfaces

- 字体与排版：沿用产品/平台字体和原有正文层级；中文自然换行，长回复保留 Markdown 标题、列表和行内代码。
- 间距与布局：桌面左侧设置、右侧预览；移动端预览在上、控制项在下，较长内容可以滚动。颜色选择与预设均有明显选中状态。
- 颜色：Codex 浅色用户背景 #E4F3FC、蓝色正文，助手 #F1F1F1；Grok Bot 浅色用户 #090909、白字，助手浅灰。深色有独立配色；边框与尾巴、圆角可分别调节。
- 图像：未新增装饰性位图；聊天头像和图标复用项目原组件，原生端使用系统控件。截图为运行结果，未重绘。
- 文案：使用「聊天气泡」「预设样式」「自定义微调」「我的气泡」「助手气泡」；三套预设名称与用户确认一致。

## Comparison history

1. 桌面首轮发现形状项挤压底部操作区：压缩分组间距、调整操作栏，最终桌面截图可见圆角、边框、尾巴及恢复入口。
2. iOS 自动同步十六进制字段时将预设变成自定义：增加相同值短路判断，UI 测试验证 Codex 选中、切换 Grok Bot 后撤销、重启保持。
3. 检查发现 Bot 聊天使用独立渲染组件：三端同时接入普通聊天与 Bot 聊天，iOS 额外捕获实际 Bot 长回复的浅/深色截图。
4. 自定义深色气泡可能影响嵌套代码卡片：保留技术卡片自身底色/文字语义，Markdown 正文随气泡配色。浏览器代码块与 iOS 长列表复核通过。
5. 最终整理发现早期 Web 手机截图停在设置分类：重新通过「外观 → 聊天气泡」捕获实际 Grok Bot 页面，纠正验收附件。

## Remaining scope / checklist

- [x] 预设即时应用、自定义配色、圆角、边框、尾巴、撤销与恢复。
- [x] 本地持久化、损坏数据回退、深浅色适配。
- [x] 正式消息组件接入，相关自动化测试与运行截图检查。
- [ ] 真机和发布包验收未执行；本轮使用浏览器及模拟器。

## Implementation evidence / state

- `docs/chat-appearance/web-desktop-codex.jpg`：1440 × 900 px，CSS viewport 1440 × 900，1×；浅色、Codex 已选、形状项展开。
- `docs/chat-appearance/web-mobile-grok.jpg`：390 × 844 px，CSS viewport 390 × 844，1×；浅色、Grok Bot 已选、上方预览、下方控件。其余控件可滚动访问。
- `docs/chat-appearance/web-chat-dark.jpg`：794 × 866 px 的实际 Bot 消息夹具，深色 Grok Bot；标题、列表、链接及代码块可读。
- 入口夹具：`tests/fixtures/settings-design/index.html?view=bubbles`。消息夹具：`tests/fixtures/chat-appearance/index.html`，均使用正式组件和本地示例数据。
- Full-view：桌面保持左右分栏并完整展示操作项；手机保持从预览到预设到自定义的顺序，无横向溢出。
- Focused：预设卡、十六进制字段、色块、用户/助手气泡在原尺寸截图中可直接判读，无需额外裁切；实际消息截图单独验证长回复和代码块。

## Verification

- `npm run typecheck` 通过。
- `npx vitest run tests/client/chatAppearance.test.ts tests/client/settingsCenterDialog.test.ts`：23 项通过。
- 浏览器验证预设、移动端导航、深色、刷新持久化；控制台 error 日志为空。
- 测试包含存储失败、坏数据、极端渐变、用户/助手独立编辑以及普通/Bot 消息在没有新消息时即时重新渲染。

final result: passed

---

以下保留之前功能的验收记录。

# Bot 设置与我的设置 · 第 3 组设计对照

## Findings

- 当前无未解决的 P0、P1 或 P2 问题。
- P3：项目成员使用产品现有的真实头像组件，示例图中的纯色圆点与 +1 占位没有照搬。所有成员姓名可以查看。
- P3：普通聊天保留管理与基础机器人功能；Bot 模式的基础机器人配置已按后续批注移入“编辑资料”。

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

## 2026-09-15 后续批注：Bot 编辑资料与权限审批

- Bot 列表右键菜单使用带图标的“编辑资料”，打开独立双栏弹窗。资料始终绑定菜单选中的 Bot，保存不切换当前单聊。
- Bot 模式“我的设置”移除基础机器人选择器、身份与头像、模型与 Provider；普通聊天保留原入口。
- 编辑资料包含概览、身份与头像、角色与规则、模型与 Provider、记忆和权限。模型管理复用管理员界面，绑定 Bot 已保存的本地 Profile；更换来源需要先保存。远端模型仍由远端管理。
- 权限审批按 Bot 保存：询问我（默认）、自动允许、自动拒绝。只答复新出现的工具审批请求；不自动回答澄清，不追溯处理已等待的请求，不建立永久或整个会话的自动授权。
- 同一 Profile 的 Bot 策略互不影响，旧记录按询问处理，自动创建的成员不能自行获得自动允许。远端引用可以设置本地审批策略，远端资料继续只读。
- 自动审批复用现有账号、任务、会话身份校验和重复答复保护；失败保留待处理请求，重复事件不触发自动重试。
- 桌面审批页：`docs/design/bot-approval-desktop.jpg`，1280 × 720。手机概览：`docs/design/bot-profile-mobile.jpg`，390 × 844。截图是实际组件的 CUA 原始捕获。
- 手机初查发现导航最小宽度撑开内容区，已改为可收缩网格；修正后内容区 clientWidth=scrollWidth=380，侧栏宽 390，无内容横向裁切。
- 资料、模型、记忆的未保存更改均受到关闭与切换保护；手机导航支持横向滚动，内容和底部保存操作分别定位。
- 测试覆盖目标 Bot 保存、普通聊天设置保留、模型 Profile 隔离、远端审批、旧记录默认值、并发独立策略、重复请求、澄清和自动审批失败。
- 最终验证：11 个测试文件共 167 项通过；补充的基础机器人显示名回归测试通过。类型检查与桌面服务构建通过。

## 2026-09-15：聊天审批卡片 · 已选第 1 版

### Findings

- 无未解决的 P0/P1/P2 问题。审批按「允许」「拒绝」「自动允许」横排，明确区分单次答复与 Bot 长期设置。
- P3：按钮最小高度采用 44px/pt；Android 使用 Material 触控尺寸。图标采用 Tabler / SF Symbols / Material 原生库，细节存在平台差异。

### Source visual truth and evidence

- 用户选中本轮第一张实际展示的生成图：`docs/design/approval-card-reference.png`，853 × 1844，原生成文件 `exec-bf524680-3635-401c-8ab8-74eda9fd1ca4.png`。
- Web 初查：`docs/design/approval-card-web-before.jpg`；最终：`docs/design/approval-card-web.jpg`，390 × 844。
- Web 深色长说明：`docs/design/approval-card-web-dark.jpg`，320 × 844。
- iOS 初查：`docs/design/approval-card-ios-before.jpg`；最终：`docs/design/approval-card-ios.jpg`，440 × 942，来自 iPhone 17 模拟器窗口的 CUA 截图。
- 预览：`http://127.0.0.1:5173/tests/fixtures/approval-card/`；iOS Debug 场景 `workspace-approval` 使用正式 SwiftUI 组件。预览操作不写入用户数据。

### Viewport, normalization, and comparison

- 对比范围是审批卡片。源图按 390/853 比例对应手机逻辑宽度；Web 为 390px、1x 捕获，卡片外宽 358px。iOS 预览内容最大宽 390pt，卡片宽 358pt；比较时排除模拟器工具栏、设备边框及系统状态栏，并以卡片宽度归一。
- 白色空白处是隔离验收场景，不作为聊天页面改版内容；真实聊天继续使用已有消息、头像、媒体和输入框。
- 最终一次比较在同一个工具结果内同时打开源图、Web 最终截图和 iOS 最终截图，直接检查卡片标题、说明、三按钮、两行辅助文字。这个区域内文字与边界清晰，不需要额外放大截图。
- 320px 深色检查：文档 scrollWidth=320，三按钮各 82px，无文字溢出；长工具说明可滚动，三个操作始终可见。浏览器控制台没有错误。

### Comparison history

1. [P2] 初版 Web 纵向间距偏大，卡片约 204px 高。收紧标题、说明和辅助文字间距，最终约 189px；维持 44px 按钮和 14px 正文。
2. [P2] 初版 iOS 标题图标偏小、拒绝按钮边界与辅助文字偏淡。改为 24pt 盾形图标，加深边框和文字；重新构建后捕获最终模拟器画面并与源图复核。

### Required fidelity surfaces

- 字体：使用原有 PingFang/SF/系统字体，标题 18、按钮与说明 14、辅助文字 13/12；按钮保持单行，长说明完整滚动显示（Web）。
- 布局：18px 圆角、14px 内边距、三列等宽按钮、6px 间隔，允许为实色主按钮，拒绝为描边按钮，自动允许为浅灰按钮。
- 颜色：Web 复用已选设置弹窗语义色，iOS 使用动态系统颜色，Android 使用 Material 前景/背景色；支持深色反转及清楚的禁用状态。
- 图片：本次卡片没有新栅格资产；盾形及圆形勾选图标来自现有图标库。设计图保留为审核依据。
- 文案：准确使用「允许」「拒绝」「自动允许」，说明「允许仅本次；自动允许后不再询问」「自动允许会同步此 Bot 的权限设置」。

### Interaction and regression checks

- 浏览器验证单次允许后仍会出现下一次审批；自动允许后，模拟下一次操作直接通过；处理中三按钮禁用。iOS 原生自动允许按钮显示相应完成反馈。
- 服务端只依据审批记录里的 agentId 更新所属 Bot；发送给 Hermes 的本次答复仍为 once。紧接着出现的请求使用新策略，同 Profile 的其他 Bot 不受影响。
- 自动允许意图和发送状态在同一事务中保存；上游答复未确认时保留该显式设置并清楚报错，不重复发送不确定请求。已完成请求的重放不会重新覆盖用户后来修改的设置。
- 审批设置单独变更保留当前有效组队授权，不恢复失效授权。普通聊天审批组件与澄清输入流程保持原有范围。
- Web 相关测试、类型检查通过；iOS 70 项 WorkspaceChat 测试通过。第一次无签名运行触发了登录测试的 Keychain entitlement 错误，使用项目正常签名后全部通过。
- Android Compose 编译、模型/网络测试和 Debug APK 构建通过；新增请求测试确认自动允许仅提交审批 ID 和 answer。Android 尚未做设备截图，手机端尚未安装新版。

final result: passed

## 2026-09-21：群聊交付目标入口收进加号菜单

### Findings

- 无未解决的 P0/P1/P2 设计差异。入口默认隐藏在「＋」中，启用后显示「交付目标 ×」，退出不清空草稿。
- 预期差异：保留现有输入框高度、字体栈和思考按钮样式；示意图中的黑色发送按钮在空草稿时沿用产品的灰色禁用状态。只调整入口位置和启用标签，不重做整个输入器。

### Source visual truth / implementation evidence

- 源图：`/Users/samien/.codex/generated_images/01a0bf4c-963e-7eb0-a445-1ec9413c1ed0/exec-9ae39651-447d-412c-a319-91a5e892efc9.png`，1536 × 1024，桌面与 iOS 双栏概念画板。
- 本地验证：`http://127.0.0.1:5173/test-results/delivery-mode/`，直接渲染正式 `ComposerShell`；夹具不请求生产接口。
- 全景：`/Users/samien/git/yaoyao/test-results/delivery-mode/desktop-menu.png`、`desktop-active.png`，1200 × 900，CSS viewport 同尺寸、1x。
- 聚焦证据：同目录 `desktop-menu-focus.png`（776 × 258，原图 x=212/y=634）、`desktop-active-focus.png`（776 × 136，原图 x=212/y=756）。只裁剪原始截图，未重绘 UI。
- 响应式：同目录 `web-narrow-menu.png`（375 × 812）、`web-320-dark.png`（320 × 740），1x。
- 将源图与两个聚焦截图放在同一个比较输入中复核。源图不是完整应用页面；按输入器内容区比较层级、顺序、间距和文案，不将整张双栏画板拉伸成网页，也不把密度差异当作缺陷。

### Required fidelity surfaces

- 字体：沿用 Inter / SF Pro / PingFang SC 字体栈；菜单 14px、说明 12px、标签 13px。四字标签与单行说明清晰，无截断；已有思考控件字号不变。
- 布局：左下「＋」锚定上方菜单；附件、提及、分隔线、交付目标顺序一致。开启标签紧随加号，后接思考及提及。菜单宽 280px，视口约束避免越界；桌面标签 36px，窄屏 44px。
- 颜色：白色菜单、细边框、浮层阴影、浅蓝标签延续源图。新增 `--delivery-accent`：浅色 #245fc5、深色 #78a9ff，12% 底色；计算的文字对比度约 5.02:1 / 6.02:1。
- 图标/图像：复用现有 AppIcon 和 Tabler 的纸夹、加号、@、Target、关闭图标；标准图标的平台笔画差异可接受，无新增位图、模糊缩放或装饰图形。
- 文案：菜单为「添加附件」「提及成员」「交付目标」「让团队持续完成一个结果」；启用后占位「描述希望团队交付的结果…」。关闭按钮有完整无障碍标签。

### Comparison history

1. [P2] 初始强调色在浅蓝底上对比约 4.40:1。新增更深的浅色目标专用 token，复核最终 active 截图，现为约 5.02:1；深色维持浅蓝前景。
2. [P2] 极窄屏工具栏重复保留提及入口会挤压空间。窄屏隐藏重复提及按钮，保留加号菜单中的同一功能。最终 320px 深色截图无裁切：加号 x=27..71，标签 x=74..195，思考 x=198..228，发送 x=259..293。

### Interaction / implementation checklist

- [x] 菜单开启目标、关闭标签、草稿保持、附件入口与提及成员。
- [x] Escape、方向键、Home/End、Tab、外部点击与焦点恢复。
- [x] 禁用目标时保留原因；单聊与已有目标不显示创建入口。
- [x] 真实会话视图集成测试验证 goal/chat 发送模式，不改变后端交付逻辑。
- [x] 19 项相关测试通过；类型检查及完整 `npm run build` 通过；浏览器控制台无 error/warn。
- 未部署到服务器；未实际发送生产消息。iOS 原生端证据记录在移动仓库的 `design-qa.md`。

final result: passed


---

# 2026-09-21：统一系统提示为居中灰色图标和标题

## Findings

- 无未解决的 P0/P1/P2 视觉问题。任务分派、任务结果、回复中断、响应超时、子任务完成、上下文压缩、后台任务共用同一提示组件。
- 正文与系统事件分开；任务结果点击打开对应任务，其余提示点击查看完整详情。失败前已生成的正文与附件保留。
- 普通消息的气泡遵循已有外观设置；设计图的无气泡样式不覆盖用户已有设置。当前确认范围为系统提示。

## Source / evidence / normalization

- 确认图：`docs/system-notices/approved-design.png`，1619 × 971像素。合并比较：`docs/system-notices/comparison.png`，上方为源图，下方为正式 Vue 组件的实际渲染。
- 截图 `desktop.png`：1440 × 1024，CSS viewport 同尺寸、1x；`mobile.png`、`mobile-dark.png`、`ordinary.png`：390 × 844、1x。
- 源图是桌面/手机双栏概念画板，按各自消息内容区域归一比较图标、字体、水平对齐和留白，不拉伸整张画板。iOS 原生抽屉交互另见移动仓库验收记录。
- 同目录 `*-expanded.png` 保留展开详情状态。13px 标签在原尺寸移动截图可直接判断，不需要另做放大裁切；合并图用于全景对照。
- 本地入口：`http://127.0.0.1:15301/tests/fixtures/system-notices/index.html`，`?ordinary` 为普通聊天，`?dark` 为深色。使用正式消息时间线与本地示例数据。

## Fidelity / comparison history

- 字体：复用产品系统字体，13px 常规字重、1.6 行高；图标16px，间隔6px，支持长标题换行。
- 布局：相对整条消息时间线居中，无默认背景/边框/阴影，最小点击高度44px。细节内容仅在打开后显示，恢复左对齐。
- 颜色：浅色标签 rgb(111,111,105)，深色 rgb(160,160,154)，沿用语义 token。任务结果不再单独使用蓝色卡片。
- 图像：采用已有线性图标库，无装饰性位图、替代头像或重绘截图。
- 文案：只显示图标与短标题，去掉默认副标题、状态说明和「打开任务」操作字样；完整内容与导航可访问性标签保留。
- 首轮发现中断提示仍跟随气泡宽度偏左：移到时间线整行，最终截图及 `checks.json` 中全部提示的水平中心偏差为0px。

## Verification

- 完整 `npm run build` 与 Vue 类型检查通过；5 个相关测试文件共19项通过。
- 浏览器4组 viewport/theme/surface 检查通过：键盘展开、错误详情、部分回复保留、任务链接、无横向溢出、无页面异常。
- iOS 与 Android 同步使用灰色居中提示；iOS 按后续要求改为半屏/全屏抽屉，详情不撑开时间线。
- 未部署到服务器或安装到真机。

final result: passed


---

# 2026-09-21：正文、图片、文件按原顺序独立展示

## Findings / scope

- 无未解决的 P0/P1/P2 视觉差异。文件按照用户手机截图：浅灰、贴合内容的圆角块，左侧文件图标，文件名与灰色扩展名，下方仅显示大小。图片独立显示，不套正文气泡。
- 普通聊天与 Bot 时间线均接入。保留原有外观设置、头像、复制/引用操作、系统提示和预览入口；夹具中的 Grok 配色只是演示，不强制更改产品默认。
- 内容流保留文字 → 图片 → 文字 → 文件 → 文字的顺序；结构化附件与 Markdown 引用去重。正文中的普通链接和代码示例保留原样。

## Source / normalization / evidence

- 源图：`docs/media-qa/approved-design.png`，1577 × 997。依据用户提供的手机文件块照片修正后的确认稿。
- 运行截图：`desktop.png` 1040 × 900、`mobile.png` 390 × 844、`mobile-dark-order.png` 390 × 844、`mobile-light-order.png` 与 `mobile-ordinary.png` 375 × 812。CSS viewport 与截图同尺寸，1x。
- 对照源图及运行截图的消息内容区域，忽略概念图设备栏、画板边距和现有产品操作行；不宣称整页逐像素复刻。文件块在原尺寸截图中可直接判读。
- 本地入口：`http://127.0.0.1:15301/tests/fixtures/message-media/index.html`；`?ordinary` 普通聊天，`?order` 顺序验证，`?dark` 深色。正式 Vue 组件、本地数据，预览回调用夹具弹窗验证，不访问生产附件。

## Fidelity / comparison history

- 字体：现有产品字体，文件名16px中等字重，扩展名和12px大小使用次要灰色；未知大小不伪造。
- 布局：文件最小高度64px、圆角20px、内容间隔8px；图片圆角12px，按原比例显示，桌面最大430px宽，手机受可用宽度约束。
- 颜色：文件底色浅色 #F1F1F1、深色 #262626。首轮发现 scoped 深色选择器失效导致深色页面文件块发白，已改为主题 token，截图复核通过。
- 图像：复用现有线性图标；竹叶图是根据用户照片生成的测试素材，仅用于夹具。图片自身显示，不额外加标题框、边框或阴影。
- 文案：`bamboo-sample.txt`、`134 B`；移除文件块中多余的「预览/下载」文字，保留按钮的完整可访问名称。

## Verification

- 完整 `npm run build`（含类型检查）通过；9个相关测试文件58项通过，覆盖外观、Markdown、文件顺序、去重、普通/Bot 时间线以及系统提示回归。
- 浏览器实测375px无横向溢出：scrollWidth=375；文件块218 × 64，图片约337 × 190且加载完成。文件与图片点击均触发对应预览回调，控制台 error 为空。
- 未发布到服务器；浏览器预览和源代码已完成。

final result: passed
