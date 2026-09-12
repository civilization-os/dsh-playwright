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
- `browser-operation` Skill 和 13 个模型工具

## 模型工具

| 工具 | 用途 |
|---|---|
| `browser_tabs` | 创建、列出和关闭插件管理的页面 |
| `browser_open` | 打开 HTTP(S) URL |
| `browser_snapshot` | 读取当前页面或指定 iframe 的受限语义投影 |
| `browser_act` | 使用已有 ref 点击、填写、选择或按键 |
| `browser_wait` | 等待可见文字或 URL |
| `browser_screenshot` | 在 DOM 语义不足时截取当前视口 |
| `browser_query` | 通过固定操作读取唯一 CSS 范围的文字、数量、状态、值或安全属性 |
| `browser_network` | 列出、筛选、查看或清空当前页面的网络记录，并按需读取文本响应体 |
| `browser_request` | 通过当前页面的浏览器上下文调用接口，或复用已捕获请求补全页面操作 |
| `browser_runbook_list` | 按站点路径和任务查找已启用的操作手册 |
| `browser_runbook_get` | 加载一份已启用的操作手册 |
| `browser_runbook_save` | 在用户明确要求后创建或修订操作手册草稿 |
| `browser_runbook_report` | 记录一次手册执行成功或失败，改进后续排序 |

`browser_snapshot` 默认最多返回 80 个元素，最高为 200。顶层快照只列出直属 iframe 摘要；模型把 `frameId` 传回工具后才读取该 iframe。无原生语义但可点击的 `li`、`div` 或 `span` 可以通过 `includeCandidates: true` 加入投影。也可以用唯一的 `scopeCss` 缩小范围。CSS 不能直接驱动动作，插件不向模型开放任意 JavaScript eval。

`browser_act` 只接受插件生成的 ref。ref 保存快照时的真实 ElementHandle、页面、frame revision 和语义指纹。DOM 插入相似元素不会改变目标；原节点被替换、移除、隐藏、改名或 iframe 导航后，旧 ref 会失败。ref 最多缓存 500 个并在 10 分钟后过期。

`fill`、`select` 和 `press` 必须显式提供 `value`。`fill` 只接受文本可编辑角色，`select` 只接受 combobox。表单推断为 `ambiguous` 时，模型必须缩小范围或询问用户，不能直接修改字段。快照不返回输入框原始内容，只返回 `has-value`、`checked`、`unchecked` 或选中项标签；确实需要读取非密码值时使用 `browser_query`。

动作可以声明 `expectedText` 或 `expectedUrl`。已经在动作前可见的 `expectedText` 不作为成功证据。结果会报告 URL 是否变化、新页面 id、自动关闭的对话框类型与文字以及下载建议文件名。对话框来自 iframe 时同样会被捕获。所有工具输出经过统一 lossless JSON 处理。

工具返回的 HTTP(S) 页面与 frame URL 只保留 origin 和 pathname，避免把查询参数中的令牌带入模型上下文。

`browser_network` 为每个页面保留最近 200 条请求。列表默认返回最新 50 条，可按资源类型、状态码和 URL 路径筛选；`detail` 返回请求与响应头，`body` 仅允许文本类型且输出最多 128 KiB。查询参数只返回参数名，`Authorization`、Cookie、API Key 等敏感头始终脱敏。网络正文和头信息都属于不可信页面数据。

`browser_request` 使用目标页面所属的 `BrowserContext.request`，因此请求与页面共享 Cookie，响应设置的新 Cookie 也会回到页面。传入 `browser_network` 返回的 `requestId` 时，会在插件内部复用原请求的 URL、鉴权头与正文；模型可覆盖 method、URL、普通 header、query 或 body，也可通过 `bodyPatch` 合并 JSON 业务字段并保留正文中的隐藏鉴权字段。默认情况下，认证和会话 header 不允许作为模型参数传入，也不会出现在结果中。

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
