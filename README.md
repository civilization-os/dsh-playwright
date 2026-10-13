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
- 默认使用用户自己的 Chrome（Chrome Bridge 扩展），调用前先校验扩展连接是否正常
- 隔离的 Playwright 浏览器改为按需：仅当用户明确要求时才使用，扩展异常时不会静默回退
- `browser-operation` Skill 和 17 个模型工具（含 2 个 Chrome Bridge 管理工具）

## 模型工具

| 工具 | 用途 |
|---|---|
| `browser_tabs` | 创建、列出和关闭插件管理的页面 |
| `browser_open` | 打开 HTTP(S) URL |
| `browser_snapshot` | 读取当前页面或指定 iframe 的受限语义投影 |
| `browser_act` | 使用已有 ref 点击、填写、选择或按键 |
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

`browser_snapshot` 默认最多返回 80 个元素，最高为 200。顶层快照只列出直属 iframe 摘要；模型把 `frameId` 传回工具后才读取该 iframe。无原生语义但可点击的 `li`、`div` 或 `span` 可以通过 `includeCandidates: true` 加入投影。也可以用唯一的 `scopeCss` 缩小范围。CSS 不能直接驱动动作，插件不向模型开放任意 JavaScript eval。

`browser_act` 只接受插件生成的 ref。ref 保存快照时的真实 ElementHandle、页面、frame revision 和语义指纹。DOM 插入相似元素不会改变目标；原节点被替换、移除、隐藏、改名或 iframe 导航后，旧 ref 会失败。ref 最多缓存 500 个并在 10 分钟后过期。

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

## Chrome Bridge：默认操作用户自己的 Chrome

Chrome Bridge 是**默认后端**：直接操作用户**已经打开**的 Chrome，复用现有登录态和标签页，不启动第二个浏览器窗口。隔离的 Playwright 浏览器改为**按需使用**——只有用户明确要求 Playwright（或隔离浏览器）时才会启动。每次调用扩展前插件都会先检查连接：Bridge 是否在监听、是否恰好有一个扩展已认证、以及它能否应答一次真实的 `bridge.ping`；检查失败会返回 `BRIDGE_OFFLINE`、`BRIDGE_AMBIGUOUS` 或 `BRIDGE_TIMEOUT`，**不会**静默切换回 Playwright。

```
DSH Agent（远程 Linux 服务器）
  → 现有浏览器工具（名称、参数、返回结构不变）
  → Chrome Bridge 服务端（复用 DSH 自带 HTTP 服务，默认不新开端口）
  → WSS ← 由用户浏览器主动外连
  → 本地 Chrome 扩展（MV3）
  → 当前标签页 DOM
```

方向很重要：**由浏览器主动连接服务器**，用户电脑不需要开放任何入站端口。

### 快速开始

```sh
# 1. 服务端：启用 Bridge 并设置外部可访问地址
#    编辑 $DSH_HOME/playwright/settings.json
#    { "chromeBridge": { "enabled": true, "publicUrl": "wss://dsh.example.com/chrome-bridge" } }
#    也可以直接在 DSH 设置页「浏览器自动化」的 Chrome Bridge 卡片里开启、填地址并保存
#    （保存后需要重启该 profile）。

# 2. 生成配对令牌（只显示一次）
dsh-chrome-bridge token create "work laptop"

# 3. 查看要粘贴到扩展里的地址
dsh-chrome-bridge url
```

### 扩展安装与连接

扩展是默认后端，**必须先装好并连接**，否则浏览器工具会直接报 `BRIDGE_OFFLINE`。完整的用户向说明（含隐私边界与故障对照表）见 [docs/extension-install.md](./docs/extension-install.md)，这里是自包含的精简版。

**第 1 步：拿到可加载的扩展目录**（三选一）

| 你的安装方式 | 可加载目录 |
|---|---|
| `dsh plugin add @civilization/deepseek-harness-playwright` 或 npm 安装 | 插件目录下的 `dist/extension/`，例如 `node_modules/@civilization/deepseek-harness-playwright/dist/extension/` |
| 克隆了本仓库 | 运行 `pnpm build:extension`，产物在 `dist/extension/`（同时在 `dist/` 生成 `dsh-chrome-bridge-<版本>.zip` 与 `.sha256` 校验文件） |
| 从他人处拿到 ZIP | 解压后使用解压出的目录 |

⚠️ 两个常见误区：

- **ZIP 不能直接拖进 Chrome**：它不是 Chrome Web Store 包，只能先解压再“加载已解压的扩展程序”。
- **不要直接加载仓库里的 `extension/` 源码目录**：`content.js` 是 ES module，而 Chrome 的内容脚本按经典脚本注入，必须经 `pnpm build:extension` 打包成自包含产物。

**第 2 步：加载到 Chrome**

1. 打开 `chrome://extensions`；
2. 右上角开启 **开发者模式（Developer mode）**；
3. 点 **加载已解压的扩展程序（Load unpacked）**；
4. 选择**含 `manifest.json` 的那一层目录**（即上面的 `dist/extension/`）。选错层级会报 *Manifest file is missing or unreadable*。

**第 3 步：钉住图标看状态**

点工具栏拼图图标，把 **DSH Chrome Bridge** 固定。徽标含义：空白=未连接、`…`=连接中、`ON`=已连接可用。

**第 4 步：连接**

点扩展图标 → 填入 **Bridge URL**（第 3 步 `dsh-chrome-bridge url` 的输出，如 `wss://dsh.example.com/chrome-bridge`）→ 填入**配对令牌** → 可选填一个浏览器名称（Agent 与运维据此区分浏览器）→ 点 **Grant access** 并在 Chrome 弹窗里允许（只授权 Bridge 地址本身，**不授权任何网站**）→ 点 **Connect**。状态显示 *Connected to the DSH bridge* 即可用。

**第 5 步：验证**

在会话里让 Agent 调用 `browser_bridge_status`，应看到 `healthy: true` 与你的扩展名称；或在设置页 Chrome Bridge 卡片看到 *Listening* + 探测延迟（毫秒）。

**容易踩的坑**

- 配对令牌只存于 `chrome.storage.session`（**内存**），**关闭 Chrome 后需要重新粘贴令牌连接**，这是刻意设计。
- 非回环地址必须是 `wss://`，扩展拒绝明文远程连接；反向代理需转发 WebSocket 升级。
- 改了 Bridge 的开关/路径/地址后要**重启该 DSH profile**，扩展才能连上新端点。
- 连不上时先看 `browser_bridge_status` 或 `dsh-chrome-bridge status`，再对照 [故障排查](./docs/chrome-bridge.md#5-troubleshooting)。

### 使用方式

```jsonc
// 默认即用户自己的 Chrome，无需传 backend
browser_tabs      { "action": "list" }
browser_snapshot  { "pageId": "active", "mode": "form" }
browser_act       { "pageId": "active", "ref": "c-1a2b3c4d", "action": "fill", "value": "me@example.com" }

// 只有用户明确要求 Playwright / 隔离浏览器时才这样调用
browser_snapshot  { "pageId": "page-1", "backend": "playwright", "userRequestedPlaywright": true }
```

`pageId` 为 `active`（或省略）表示用户当前正在看的标签页。扩展只会操作用户明确选中的活动标签页，不会静默遍历所有标签页。

扩展未连接时，工具会直接报错并提示先调用 `browser_bridge_status` 查看状态，请让用户在扩展弹窗里按 **Connect** 后重试，而不是改用 Playwright。

### 后端选择与检查

| 参数 / 设置 | 说明 |
|---|---|
| `backend`（每次调用） | `chrome-extension`（默认）或 `playwright`。 |
| `userRequestedPlaywright`（每次调用） | 仅当用户在本轮对话里明确要求 Playwright 时置 `true`，否则 `backend: "playwright"` 会被拒绝。 |
| `settings.json` 的 `backend` | 运维显式设定默认后端；设为 `playwright` 时不再要求逐次确认。 |
| `chromeBridge.enabled` | 默认 `false`，即监听端点需要显式开启；未开启时扩展后端不可用并给出明确提示。 |

### 第一阶段支持范围

| 能力 | 状态 |
|---|---|
| 查询活动标签页 URL / 标题 | 支持 |
| 页面语义快照（复用 `src/snapshot.js`） | 支持 |
| 通过 ref 点击、输入、普通 select、按键 | 支持 |
| 过期 / 被替换 / 改名 / 隐藏 ref 的明确报错 | 支持 |
| 断线、超时、无权限的明确报错 | 支持 |
| iframe 快照、`scopeCss`、`expectedText`、网络等待 | 仍为 Playwright 专属，会返回明确错误 |
| 文件上传下载、扩展管理、跨标签编排 | 未实现 |

### 新增工具

| 工具 | 用途 |
|---|---|
| `browser_bridge_status` | 查看 Bridge 状态、连接健康探测结果、已连接扩展与脱敏令牌 |
| `browser_pairing_token` | 创建、列出或吊销配对令牌 |

### 安全要点

- 扩展必须认证。令牌不写入 URL，而是在 HTTPS 上换取短期 `HttpOnly` 会话 Cookie，并在 WebSocket 握手中用一次性 nonce 再次验证。
- 令牌在服务端以 `0600` 文件保存（POSIX；Windows 无 mode 位，只能依赖用户目录 ACL），在客户端只存于 `chrome.storage.session`（内存），列表与日志只出现掩码和指纹。
- 权限最小化：只申请 `activeTab`（+ `scripting`/`tabs`/`storage`/`alarms`），不声明内容脚本，不申请全站主机权限。未授权页面返回 `PERMISSION_DENIED`。
- 协议只暴露固定方法白名单，**不存在**任意 JavaScript 或 shell 执行的表示形式。
- 非回环地址强制 `wss://`，扩展拒绝明文远程连接。
- 断线后所有在途请求立即返回 `BRIDGE_OFFLINE`，不会继续假定浏览器可用。

### 回滚

Chrome Bridge 不影响 Playwright 路径，回滚只需要配置：把 `backend` 设为 `playwright`（隔离浏览器重新成为唯一后端，扩展不再被查询）、可选地把 `chromeBridge.enabled` 设为 `false`、吊销令牌，或在 Chrome 里断开扩展。无需还原任何文件。

### 文档

- [docs/extension-install.md](./docs/extension-install.md) — 面向使用者的扩展安装与连接说明
- [docs/chrome-bridge.md](./docs/chrome-bridge.md) — 服务端配置、反向代理与 TLS、故障排查
- [docs/architecture.md](./docs/architecture.md) — 组件、元素引用、DOM 语义复用
- [docs/protocol.md](./docs/protocol.md) — 消息格式、方法、错误码与限制
- [docs/security.md](./docs/security.md) — 威胁模型与安全设计
- [docs/acceptance-test.md](./docs/acceptance-test.md) — 需要在真实 Chrome 上手工核对的验收清单

## Harness 版本兼容

当前版本在 DeepSeek Harness **0.2.0-rc.2** 上验证：`pnpm test`（166 通过 / 0 跳过）与 `pnpm build` 通过，并用 mock Cordis 上下文真实执行了一次 `apply()`——17 个模型工具全部通过 0.2.0 的 `defineTool` schema 编译，`browser-operation` Skill、`/playwright-browser` 的 RPC 通道以及 Chrome Bridge 的 WebSocket 升级路由均注册成功。逐项核对过的公开接口：`tools.register`、`skills.register`、`webServer.register(kind: 'prefix')`、服务端 `connection.rpc.handle`、浏览器端 `connection.rpc.call`、`slots.inject/register('settings.section')`、`locale.register/bind`、`connection/reset`。

- `peerDependencies` 只声明**下界**（`@deepseek-ai/dsh-tools: >=0.1.5-rc.2`，无上界），以便跟随 Harness 的快速迭代：Harness 的插件兼容性判定用运行时版本比对这些范围。代价是不再对未来的破坏性变更做“响亮拒绝”，且**不保证前序版本**。
- 需要真实 DOM 的用例优先使用系统 Chrome / Edge，找不到时退回环境中已缓存的 Playwright Chromium（仓库本身不下载浏览器二进制），只有在完全没有浏览器时才跳过。Chrome Bridge 自带零运行时依赖的 WebSocket 实现，因此 Bridge 的传输、认证、超时与断线用例在任何环境都会执行。

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
