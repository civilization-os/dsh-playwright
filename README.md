# DeepSeek Harness Playwright

为 DeepSeek Harness 提供由文本模型驱动的本地浏览器操作能力。插件使用机器上已经安装的 Google Chrome 或 Microsoft Edge，不下载 Playwright 浏览器二进制，也不复用用户的默认浏览器 Profile。

## 安装到 DSH

需要已经安装 `dsh` CLI 和 `pnpm`。npm 包名是全局名称，不需要带 GitHub 用户名：

```sh
dsh plugin --profile web add @civilization/deepseek-harness-playwright
dsh web
```

也可以从 GitHub 安装；GitHub 地址需要组织名：

```sh
dsh plugin --profile web add github:civilization-os/dsh-playwright
dsh web
```

安装、更新或卸载 bundle 后需要重启对应的 DSH profile。已打开的 Web 页面也应刷新，以加载新的客户端代码和模型工具。

更新与卸载：

```sh
dsh plugin --profile web update @civilization/deepseek-harness-playwright
dsh plugin --profile web remove @civilization/deepseek-harness-playwright
```

只需要命令行 Agent 时可以安装到 `headless` profile：

```sh
dsh plugin --profile headless add @civilization/deepseek-harness-playwright
dsh --profile headless "打开 https://example.com 并告诉我页面标题"
```

## 核心能力

- 自动发现 Windows、macOS 和 Linux 上常见位置的 Chrome 与 Edge
- 有头或无头模式、页面尺寸和操作超时配置
- 设置页实时轮询浏览器状态，并提供隔离启动检查
- 页面、iframe、弹窗、对话框和下载事件的受控生命周期
- 每页最多 200 条网络请求记录，支持筛选、脱敏头信息和按需读取文本响应体
- 通过页面的 Playwright BrowserContext 直接请求接口，复用 Cookie、Session、Authorization 与 CSRF 鉴权
- 支持受信任环境的自签名 HTTPS 证书信任（`ignoreHTTPSErrors`）与敏感认证字段可见性/Origin 白名单配置
- 限量语义快照、候选元素、CSS 只读范围和固定 DOM 查询
- 复杂表单的标签、分组、帮助文字、必填项、输入类型和歧义推断
- 精确绑定到快照时 DOM 节点的临时元素 ref
- 由用户明确要求创建和修订的结构化站点操作手册
- 手册按任务归并版本，支持搜索、筛选、详情审阅、界面修订、版本切换和站内删除确认
- 根据当前页面、任务语义和历史成功率推荐手册，并记录执行结果
- `browser-operation` Skill 和 19 个模型工具

## 模型工具

| 工具 | 用途 |
|---|---|
| `browser_tabs` | 创建、列出、关闭和刷新（`reload`）插件管理的页面 |
| `browser_open` | 打开 HTTP(S) URL |
| `browser_viewport` | 在运行时获取或调整视窗尺寸（宽与高），支持响应式布局测试，无需重启浏览器 |
| `browser_snapshot` | 读取受限语义投影，支持落盘（`savePath`）、模糊查询（`query`）、角色筛选（`role`）、分页（`offset`/`limit`）、概览模式（`summaryOnly`）及基于 `snapshotId` 二次查询 |
| `browser_act` | 使用已有 ref 点击、填写、选择或按键，支持页面刷新后自动自愈重新绑定 |
| `browser_visual_act` | 基于坐标 `(x, y)` 触发点击、双击、右键、悬停、拖拽、文本输入、按键或滚轮，支持像素、0-1、0-1000、百分比坐标 |
| `browser_visual_screenshot` | 专为视觉模型 (VLM) 优化的视口截图，支持叠加坐标网格 (Grid)、Set-of-Marks (SoM) 编号标签及直接输出 base64 |
| `browser_visual_click` | AI 视觉模型端到端定位与点击模块，支持通过自然语言描述、VLM 识别、SoM 编号或 DOM 视觉矩形直接点击目标 |
| `browser_wait` | 等待可见文字、页面 URL、网络空闲（`networkIdle`）或特定接口响应（`networkUrl`） |
| `browser_screenshot` | 在 DOM 语义不足时截取当前视口 |
| `browser_query` | 通过固定操作读取唯一 CSS 范围的文字、数量、状态、值或安全属性 |
| `browser_network` | 列出、筛选、查看请求详情（含头与 postData）或响应体，支持 downloadPath 落盘 |
| `browser_request` | 支持独立/页面上下文调用 API、复用网络请求、文件上传及二进制自动下载存盘 |
| `browser_route` | 拦截、Mock 接口响应或阻断不必要的静态资源（图片/字体/统计等）以加速加载 |
| `browser_cookies` | 查看、注入或清空浏览器 Cookie（受 Origin 白名单与脱敏策略保护） |
| `browser_runbook_list` | 按站点路径和任务查找已启用的操作手册 |
| `browser_runbook_get` | 加载一份已启用的操作手册 |
| `browser_runbook_save` | 在用户明确要求后创建或修订操作手册草稿 |
| `browser_runbook_report` | 记录一次手册执行成功或失败，改进后续排序 |

`browser_snapshot` 全面增强了防截断与精准查询能力：
- **全量快照自动落盘**：每次快照均自动将全量数据持久化至本地磁盘（`<home>/snapshots/s-xxxx.json`），并在返回结果中带上 `snapshotPath` 路径；亦可在调用时传入自定义 `savePath` 保存至指定目录；
- **解决 Agent 截断问题**：针对现代大模型 Agent 框架对大工具输出直接截断的问题，快照支持传入 `query`（对元素名称、字段推断标签、提示文本等进行忽略大小写的关键词模糊搜索）、`role`（按 `button`、`textbox`、`link` 等角色过滤）、`offset` 与 `limit`（分页输出，默认单次最多返回 80 项，上限 200 项）；
- **结构概览模式 (`summaryOnly: true`)**：支持仅返回页面标题、URL、结构标题（`headings`）、表单列表（`forms`）与交互元素统计总数，完全不返回冗长的 elements 列表，便于 Agent 建立全貌认知后再定向筛选；
- **已缓存快照二次查询 (`snapshotId`)**：Agent 可直接传入之前快照的 `snapshotId` 配合 `query` 或 `offset` 查询子集，无需重新执行页面 DOM 语义扫描；
- 顶层快照仍只列出直属 iframe 摘要；模型把 `frameId` 传回工具后才读取该 iframe。无原生语义但可点击的 `li`、`div` 或 `span` 可以通过 `includeCandidates: true` 加入投影。

`browser_act` 具备页面刷新引用自愈（Rebind）能力：
- 接收插件生成的 ref。ref 记录了节点结构路径、frame revision 与语义指纹；
- **页面刷新自动重绑定**：当页面发生刷新（如通过 `browser_tabs(action: "reload")` 或页面自身重新载入）且页面内容未改变时，再次使用原 ref 操作，系统会在新的 DOM 树中根据层级路径与语义特征自动重新定位并绑定新句柄，避免由于页面刷新导致元素引用失效中断任务；
- 若 DOM 节点在当前生命周期内被脚本替换为克隆节点、被移除或语义发生改变，则仍将严格拒绝执行，保证安全与语义确定性。

`browser_viewport` 提供 Playwright 原生运行时视窗大小动态调整：
- 支持 `action: "set"` 与 `action: "get"`（若传入 `width` 和 `height` 则默认执行 `set`）；
- 允许在任务执行过程中实时改变页面视口分辨率（范围 100 到 10000 像素），立即生效且无需重启浏览器；
- 可指定 `pageId` 调整单一页面，或省略 `pageId` 全局调整所有当前打开的受管页面；新打开的 Tab 也会自动继承该视窗尺寸；
- 极大便利了响应式布局测试（如手机端 375x667、平板 768x1024、宽屏 1920x1080）以及因视口过小导致元素被隐藏折叠的场景；
- **设置热更新保护**：Web 设置页修改视窗尺寸时，若浏览器正在运行，系统将通过运行时接口热更新视口，而不会直接杀死浏览器重启，保护进行中的上下文与页面状态。

`fill`、`select` 和 `press` 必须显式提供 `value`。`fill` 只接受文本可编辑角色，`select` 只接受 combobox。表单推断为 `ambiguous` 时，模型必须缩小范围或询问用户，不能直接修改字段。快照不返回输入框原始内容，只返回 `has-value`、`checked`、`unchecked` 或选中项标签；确实需要读取非密码值时使用 `browser_query`。

动作可以声明 `expectedText` 或 `expectedUrl`。已经在动作前可见的 `expectedText` 不作为成功证据。结果会报告 URL 是否变化、新页面 id、自动关闭的对话框类型与文字以及下载建议文件名。对话框来自 iframe 时同样会被捕获。所有工具输出经过统一 lossless JSON 处理。

工具返回的 HTTP(S) 页面与 frame URL 只保留 origin 和 pathname，避免把查询参数中的令牌带入模型上下文。

`browser_network` 为每个页面保留最近 200 条请求。列表默认返回最新 50 条，可按资源类型、状态码和 URL 路径筛选：
- **查看请求详情与 postData**：`detail` 动作不仅返回脱敏后的请求头与响应头，更直接支持输出请求体 `postData`（默认按 `maxBodyBytes` 安全截断，便于查看表单与 JSON 提交数据）；
- **安全截断与防崩溃保护**：`body` 动作安全读取文本响应，按 `maxBodyBytes`（默认 64 KiB，上限 128 KiB）安全截断输出；若发生截断会标记 `truncated: true`，并在 `notice` 中清晰提示可通过下载获取全量内容；
- **支持 `downloadPath` 智能落盘**：支持在参数中传入 `downloadPath`，将超大报文或非文本二进制文件（如大 JSON、文档、图片、压缩包等）直接完整存入本地磁盘；支持自动规范化相对路径、目录自动命名以及根据 Content-Type 自动补全后缀名；
- **状态优雅降级**：若请求处于 `pending`、`failed` 或无响应体状态，不再抛出异常中断执行，而是返回明确的状态提示；
- **敏感安全策略**：查询参数只返回参数名，`Authorization`、Cookie、API Key 等敏感头始终脱敏。网络正文和头信息都属于不可信页面数据。

`browser_wait` 提供多种等待策略：
- **可见文本与 URL 等待**：等待页面或 iframe 中出现特定文字（`text`）或页面完成跳转（`url`）；
- **网络状态与异步请求等待**：支持通过 `networkIdle: true` 等待页面进入网络空闲状态（特别适合现代 SPA 单页应用点击操作后的异步数据加载），也支持通过 `networkUrl` 等待特定 API 接口产生网络响应，彻底避免由于接口异步加载未完成导致的 DOM 查找失败。

`browser_request` 拥有强大的 HTTP / API 调用能力：
- **独立与页面模式**：支持传入 `pageId` 与已有页面共享 Cookie，也支持省略 `pageId` 直接通过受管浏览器上下文发起无界面 API 请求；
- **请求捕获与参数合并**：传入 `browser_network` 返回的 `requestId` 时，内部自动复用原请求的鉴权头和正文，支持覆盖 method、URL、headers、query、body 或通过 `bodyPatch` 局部补丁；
- **超大报文安全截断与引导**：即使文本响应超过 1MB，也会保留按 `maxBodyBytes` 截断的文本返回模型，并提示可指定 `downloadPath` 获取全量文件；
- **JSON 与表单上传**：直接传入 JSON 对象或字面量时自动序列化并设置 `application/json`；传入 `files`（键值对映射本地文件路径）时，自动读取本地文件流组装 `multipart/form-data` 上传；
- **文件下载存盘**：支持提供 `downloadPath`，对任意需要落盘的内容或二进制文件完整保存至本地文件并返回落盘路径与字节大小；
- **安全防线**：默认严禁模型传递或窥探未经白名单许可的敏感 Token / Session，在受信任环境下可通过 Origin 白名单放行。

`browser_route` 提供浏览器级请求拦截引擎：
- **Mock 响应**：按 URL glob 模式拦截请求并自定义返回状态码、响应头与正文；
- **资源阻断**：可按资源类型（如 `image`、`font`、`media`、`stylesheet`）或指定 URL 规则阻断加载，提升自动化抓取速度并减少噪点；
- **路由管理**：支持 `list` 查询当前已激活拦截规则或 `clear` 还原网络配置。

`browser_cookies` 提供细粒度的会话与 Cookie 管理：
- 支持 `list` 查看指定 URL/Domain 下的 Cookie（敏感凭证受 Origin 白名单脱敏保护）；
- 支持 `set` 直接向浏览器注入 Cookie（支持 `name`、`value`、`domain`、`path`、`secure`、`httpOnly` 等选项）；
- 支持 `clear` 清理会话状态，便于测试登出或清空污染环境。

## 视觉模型 (VLM) 坐标交互与多模态自动化

针对 Canvas、WebGL、复杂图表、地图、游戏、白板、验证码滑块以及缺乏无障碍语义 (DOM ref) 的网页，插件提供了专为视觉语言大模型（VLM）与 Computer-Use Agent 打造的坐标交互模块：

### 1. 坐标动作交互 (`browser_visual_act`)
- **多动作支持**：支持针对屏幕绝对或相对坐标执行 `click`（单击）、`doubleClick`（双击）、`rightClick`（右键上下文菜单）、`hover`/`move`（悬停触发下拉或 Tooltip）、`drag`（从 `(x, y)` 拖拽至 `(targetX, targetY)`）、`type`（在指定坐标聚焦并输入文本）、`press`（在指定坐标按下键盘按键如 Enter/Tab/Escape）、`scroll`（指定滚轮水平与垂直滚动量）以及 `down`/`up`（鼠标按键分步控制）；
- **跨模型坐标系自适应 (`coordinateType`)**：
  - `pixel`：标准视口物理像素坐标（如 `x: 640, y: 360`）；
  - `normalized_0_1`：0 到 1 归一化浮点坐标（如 `x: 0.5, y: 0.3`，Anthropic Computer Use / WebVoyager 格式）；
  - `normalized_1000`：0 到 1000 整数坐标系统（如 `x: 500, y: 300`，Gemini 2.0/3.8 Flash、Qwen-VL、UI-TARS 常见格式）；
  - `percent`：0 到 100 百分比坐标；
  - `auto`：智能自动推断（0-1 之间小数自动按视口放大换算，其余按像素处理）；
- **视口安全钳制与长页自动滚动 (`coordinateMode` & `autoScroll: true`)**：
  - 自动检查并约束坐标在有效索引 `[0, width - 1]` 与 `[0, height - 1]` 内，彻底消除 off-by-one 边界击空；
  - 当目标坐标超出当前可见视口（例如来自长页面的 `y: 2634`）或指定 `coordinateMode: "page"` 时，系统会自动将目标区域平滑滚动至视口中央并动态换算视口 Client 坐标再触发点击，彻底打通长页面纵深交互；
- **视觉高亮涟漪反馈 (`highlight: true`)**：点击或交互时在页面对应位置短暂渲染高对比度半透明红色涟漪与十字光标反馈动画，方便在截图、录像或人工观察中确认模型交互位置。

### 2. 视觉模型专用截图与坐标辅助 (`browser_visual_screenshot`)
- **坐标参考网格 (`grid: true`)**：动态在页面上方绘制带刻度数值的高对比度经纬网格（支持 `pixel` 或 `normalized_1000` 标尺），坐标数值自适应暗色徽标衬底，彻底解决 VLM 模型在纯色或大留白区域估算坐标时的漂移与幻觉；
- **Set-of-Marks 视觉元素标记 (`som: true`) 与注册表持久化**：借鉴视觉提示工程标准，自动提取页面内按钮、链接、输入框等关键控件，为每个元素绘制高亮包围框并打上编号标签（`[1]`, `[2]`, `[3]`）。**标注信息会自动缓存在页面注册表中**，支持后续通过 `markId` 直接点击；
- **精准度量全页截图 (`fullPage: true`)**：完整度量长页面的全量滚动宽高（`scrollWidth`/`scrollHeight`），确保返回的元数据与保存的图片高宽严格对齐，且 SoM 标号框与网格可贯穿整页绘制；
- **Base64 行内感知 (`returnBase64: true`)**：直接返回 `data:image/png;base64,...` 数据流，方便多模态 Agent 一键摄入图片无需额外磁盘读取；
- 截图完成后自动清理注入的网格和标记层，不污染页面原始 DOM 与业务逻辑。

### 3. AI 视觉端到端语义点击 (`browser_visual_click`)
- **自然语言视觉定位**：支持直接传入目标自然语言描述（如 `description: "右上角蓝色的登录按钮"` 或 `description: "购物车图标"`）；
- **VLM 视觉大模型直连**：配置了视觉模型 API（如 OpenAI 兼容接口、GPT-4o、Qwen-VL、DeepSeek-VL 等）时，插件将自动截取带网格/标注的页面并提交给模型提取精确坐标后执行点击；
- **Set-of-Marks 编号直达与全页自愈 (`markId`)**：可直接传入标注编号（如 `markId: 1`），插件优先复用已缓存的全页标注信息。若元素位于长页面下方，自动执行向下滚动居中并精准点击；
- **智能 DOM 视觉矩形兜底 (Visual Rect Grounding)**：即使未配置外部 VLM API Key，模块也能通过**角色词后缀剥离**（如“重置按钮”自动剥离为“重置”并识别按钮角色）、**反向包含双向打分**（`query` 包含候选元素文本或反之）、**控件角色意图对齐加成**以及无障碍标签、占位符、文本模糊搜索提取元素真实物理渲染包围盒。**全页面无缝检索**：若目标元素位于折叠线深层下方，自动计算文档绝对坐标并在点击时驱动视口自动下滚居中。

## 受信任开发环境与安全调试（TLS 与凭据控制）

在本地开发、内部测试或实验室环境中，内部服务常采用自签名证书，且开发者可能需要观测或定制认证流量。插件提供了**默认关闭（Opt-in）**的安全配置：

- **信任自签名证书 (`ignoreHTTPSErrors`)**：
  - **默认值**：`false`。
  - **说明**：开启后，受管的浏览器上下文和 `browser_request` 请求工具将忽略自签名或无效 SSL 证书错误，允许正常访问内部 HTTPS 站点。
- **暴露认证敏感字段与 Origin 白名单 (`exposeAuthFields` & `trustedOrigins`)**：
  - **默认值**：`exposeAuthFields` 为 `false`，敏感字段强制脱敏为 `[redacted]`。
  - **说明**：开启后，在 `browser_network` 的详细记录与 `browser_request` 响应中将向模型暴露 `Authorization`、Cookie 等敏感字段，并允许模型显式传递鉴权头进行接口调试。
  - **Origin 白名单**：支持配置受信任源列表（如 `https://localhost:8443` 或 `https://10.0.0.1:9000`）。配置后仅对匹配的源生效；未命中白名单的站点仍将受到严格脱敏保护。
  - **⚠️ 安全注意**：将认证凭证暴露给大模型可能导致凭证进入模型上下文，请仅在受信任的开发与测试环境中按需开启。

## 页面与浏览器生命周期

浏览器 Context 使用插件独立的数据目录。并发的首次调用共享一次启动；Context 意外关闭后，下次调用会重新创建。没有页面时，省略 `pageId` 会创建一个页面；只有一个页面时可以省略；存在多个页面时必须明确提供 `pageId`。配置的超时同时应用于启动、DOM 操作和导航。

设置页每 3 秒刷新一次运行状态。刷新结果不会覆盖用户正在编辑的配置，较旧的请求结果也不会覆盖较新的请求。保存前先验证全部配置；无效配置不会关闭正在运行的浏览器。

## 表单和 iframe

当输入框缺少可访问名称时，使用 `browser_snapshot` 的 `mode: "form"`。插件先读取 `aria-labelledby`、`aria-label`、关联 `label` 和 placeholder，再结合当前表单区域的 `fieldset/legend`、表格行列、前置内容、输入框左侧和上方文字推断含义。结果通过 `fieldContext` 返回证据来源与置信度。

Canvas、图片文字、远程桌面和完全脱离 DOM 的控件不能靠这些规则可靠理解。此时模型应使用截图能力或请用户确认。

iframe 按层展开。每个摘要包含 `frameId`、名称、去除查询参数的 URL、交互数量、候选数量和子 frame 数量。ref 自动绑定所属 frame；同源和跨域 iframe 使用相同流程。

## 操作手册

插件不会自动生成操作手册。只有用户明确提出“保存这次流程”“生成操作手册”或类似要求时，模型才可调用 `browser_runbook_save`。手册可以包含适用任务、输入参数、前置条件、执行说明、成功标准和当前不含表单值的浏览轨迹。页面交互无法完成而改用 `browser_request` 时，轨迹只记录 method、路径、字段名和状态码，不记录请求值或鉴权信息。新手册和新修订默认是停用草稿，用户在设置页启用后模型才能检索。

设置页只展示每条流程的最新版本，并标记当前启用版本；可以搜索名称、任务或站点，筛选已启用与待审阅手册，打开详情查看全部结构化内容和版本历史。编辑会创建新版本，不会覆盖旧版本；删除使用 DSH 风格的站内确认框，并在删除中间版本时保持剩余版本链完整。

模型检索同时匹配 origin、路径和任务语义。`/admin/users` 手册可用于 `/admin/users/42`，不会出现在 `/checkout`；中文任务会按短语相关度排序。提供 `pageId` 时插件直接读取当前受管页面 URL。匹配项再结合路径精确度、历史成功率和更新时间排序；执行后模型应调用 `browser_runbook_report` 报告结果。修订使用 `previousId`，同一修订链最多启用一个版本。存储限制为 200 份手册、每份 100 个轨迹步骤和 2 MiB 文件；写入串行化并保留上一份有效备份，避免并发丢失和单次文件损坏。

操作手册不保存临时 ref、密码、令牌、输入内容、截图正文或完整页面快照。

## Harness / Cordis 版本兼容

当前版本在 DeepSeek Harness **0.2.2-rc.1** 与 Cordis **4.0.5** 上验证：`pnpm test`（62 项测试全部通过）与 `pnpm build` 通过，并用真实 Cordis 上下文执行了一次 `apply()`——16 个模型工具全部通过 0.2.1 的 `defineTool` schema 编译，`browser-operation` Skill、`/playwright-browser` 的 RPC 通道与前缀路由均注册成功。逐项核对过的公开接口：`tools.register`、`skills.register`、`webServer.register(kind: 'prefix')`、服务端 `connection.rpc.handle`、浏览器端 `connection.rpc.call`、`slots.inject/register('settings.section')`、`locale.register/bind`、`connection/reset`。

- `peerDependencies` 声明下界（`@deepseek-ai/cordis: ^4.0.2`，`@deepseek-ai/dsh-tools: >=0.1.5-rc.2`），原生支持 DSH 0.2.2-rc.1 及后续更新。

## 本地开发

```sh
pnpm install
pnpm test
pnpm build
pnpm run web
```

本地预览默认地址为 `http://127.0.0.1:3082`。把当前 checkout 安装到本机 web profile：

```sh
dsh plugin --profile web add .
dsh web
```

`prepack` 会在 npm 打包前重新构建客户端，避免发布旧的 `lib/client.js`。发布工作流在 Ubuntu 和 Windows 上运行测试与构建，全部通过后才发布 npm 包。
