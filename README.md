# DeepSeek Harness Playwright

为 DeepSeek Harness 提供由文本模型驱动的本地浏览器操作能力。插件优先使用机器上已安装的 Google Chrome，找不到时尝试 Microsoft Edge；托管 Chromium 作为后续可选能力，不随 npm 包安装。

## 安装到 DSH

需要已经安装 `dsh` CLI 和 `pnpm`。npm 包名在 registry 中全局唯一，不需要附加 GitHub 用户名或组织名。把插件安装到带设置页面的 `web` profile：

```sh
dsh plugin --profile web add deepseek-harness-playwright
dsh web
```

也可以直接从 GitHub 安装；此时包地址需要包含组织名：

```sh
dsh plugin --profile web add github:civilization-os/dsh-playwright
dsh web
```

打开 DSH 设置页的“浏览器自动化”，选择本机 Chrome 或 Edge，再运行检查。新会话会获得浏览器操作 Skill 和 10 个模型工具。

更新或卸载插件：

```sh
dsh plugin --profile web update deepseek-harness-playwright
dsh plugin --profile web remove deepseek-harness-playwright
```

只需命令行 Agent 时，也可以安装到 `headless` profile：

```sh
dsh plugin --profile headless add deepseek-harness-playwright
dsh --profile headless "打开 https://example.com 并告诉我页面标题"
```

## 当前版本

0.1.8 是可运行的本地预览版，已经实现：

- Windows Chrome 与 Edge 的路径发现
- 自动优先选择 Chrome
- 有头和无头模式、操作超时与页面尺寸配置
- 隔离浏览器数据目录
- 设置页浏览器状态和真实启动检查
- browser_tabs、browser_open、browser_snapshot、browser_act、browser_wait、browser_screenshot 和 browser_query
- 带语义指纹检查的临时元素引用
- 限量交互快照
- 按需展开的同源、跨域和嵌套 iframe 快照
- 运行时注册的 browser-operation Skill
- 由用户明确要求保存、在设置页启用的文字说明与浏览器轨迹操作手册
- Cordis effect 关闭浏览器进程

当前动作结果保持精简，但还没有实现完整的 sinceSnapshotId 增量比较、分区快照、域名规则和高影响操作确认。这些仍是后续版本的设计目标。

本地开发预览：

    pnpm install
    pnpm run web

默认地址为 http://127.0.0.1:3082。

把当前 checkout 安装到本机 web profile：

    dsh plugin --profile web add .

安装或更新 bundle 后重启 web profile，并刷新已打开的页面，客户端设置入口和模型工具才会使用新版本。

## 产品边界

插件由三个部分组成：

- Host 插件：发现并启动浏览器，管理 Browser、Context、Page 和元素快照的生命周期。
- 设置页面：配置浏览器与安全策略，并显示可执行的环境检查结果。
- 模型工具与 Skill：工具执行确定的浏览器操作；Skill 教模型按“观察、定位、操作、验证”的顺序使用工具。

网页内容是不可信输入。页面文字不能改变工具权限、插件配置或操作规则。

## 浏览器安装策略

npm 包只依赖 `playwright-core`，不包含浏览器二进制，也不在 `postinstall` 中下载文件。

默认发现顺序：

1. Google Chrome Stable
2. Microsoft Edge Stable
3. 用户显式配置的浏览器可执行文件
4. 可选的托管 Chromium

每次启动使用插件自己的浏览器数据目录，不复用用户的默认浏览器 Profile。设置页允许用户选择发现的浏览器和数据目录。

## 设置页面

页面分为“浏览器”“运行检查”“安全策略”三个区域。

### 浏览器

- 当前浏览器：自动、Chrome、Edge 或自定义路径
- 运行模式：有界面或无界面
- 独立数据目录
- 默认页面尺寸
- 默认操作超时
- 下载目录

### 运行检查

每项显示检查中、通过、警告或失败，以及可执行的修复动作：

- Chrome 是否发现、版本和路径
- Edge 是否发现、版本和路径
- 所选浏览器能否启动
- 独立数据目录是否可写
- 浏览器进程能否正常关闭
- DSH 浏览器工具是否已注册并对 Agent 可见
- 当前活动页面数量
- 托管 Chromium 的安装状态和磁盘占用

“重新检查”执行一次隔离的启动与关闭探测，不访问外部网站。

### 安全策略

- 允许访问的域名与拒绝的域名
- 是否允许下载和上传
- 是否允许剪贴板
- 提交、发送、删除、购买等操作的确认策略
- 是否允许持久登录状态

## 模型工具

第一版保持工具数量较少，并让每次操作的前置条件明确。

| 工具 | 用途 |
|---|---|
| `browser_tabs` | 创建、列出、选择和关闭插件管理的页面 |
| `browser_open` | 在选定页面打开 URL |
| `browser_snapshot` | 建立交互索引；可按 frame、唯一 CSS 容器和候选元素缩小或扩展投影 |
| `browser_act` | 使用已有元素引用执行动作，并返回操作后的增量变化 |
| `browser_wait` | 等待 URL、文本、元素或页面加载状态 |
| `browser_screenshot` | 为缺少语义结构的页面提供视觉证据 |
| `browser_query` | 通过固定操作读取 CSS 范围内的文字、数量、状态、值或安全属性 |

`browser_act` 接受 `pageId`、唯一 `elementRef`、带判别字段的动作和可选的预期结果。执行前在 Host 内重新解析目标，验证元素仍然属于同一页面、可见、可用、语义特征一致并且唯一。页面发生无关变化不会让所有引用失效；目标本身被替换、改名或变得歧义时才返回 `stale_target`。执行后等待预期结果，并只返回 URL、焦点、对话框、可见文本和交互元素的增量变化。

CSS selector 只能作为 `browser_snapshot.scopeCss` 或 `browser_query.scopeCss` 的只读范围。快照范围必须唯一且可见，可以是容器或目标元素本身；指定范围会自动启用候选检测，并可为命中的任意 HTML 元素或自定义 Web Component 本身生成带 `scopeTarget: true` 的 ref。selector 不能直接传给 `browser_act`。所有动作仍使用 Host 生成的 ref，并执行唯一性、可见性和语义检查。插件不提供任意 JavaScript eval。

当网页把点击行为放在没有原生语义的 `li`、`div` 或 `span` 上时，模型可以设置 `includeCandidates: true`。插件会补充可见、有名称且带内联点击行为或 `cursor: pointer` 的候选元素，并用 `candidate: true` 标识。返回结果同时包含 `totalInteractive`、`returned` 和 `truncated`，因此模型能区分页面总量与本次投影数量。

### iframe

顶层快照只返回当前 frame 的交互内容和直属 iframe 摘要，不会把所有嵌套页面一次性塞进上下文。摘要包含稳定的 `frameId`、名称、去除查询参数的 URL、交互元素数量和直属子 frame 数量。模型需要 iframe 内容时，把相应 `frameId` 传给 `browser_snapshot`；嵌套 iframe 按层展开。

元素 ref 在 Host 内绑定 `pageId`、`frameId` 和 frame revision。`browser_act` 会自动进入 ref 所属的同源或跨域 frame，并在操作前重新验证 frame、元素唯一性、可见性和语义。frame 导航或分离会立即清除旧 ref；模型必须重新读取 frame 摘要。`browser_wait` 也接受可选的 `frameId`，用于等待 iframe 内文字或 URL。

## 上下文控制

Host 保存完整的页面索引，模型只看到完成当前步骤所需的投影：

- 首次打开页面默认返回可见的交互元素和少量结构标题，不返回整页正文。
- iframe 默认只返回一层摘要，模型只读取与任务相关的 frame。
- `browser_snapshot` 默认使用 `interactive` 模式；模型可按对话框、表单、导航或某个元素区域缩小范围。
- 长列表和长正文使用游标分页，并设置元素数与字符数上限。
- 工具以 `snapshotId` 记录 Host 缓存；后续调用可以请求 `sinceSnapshotId` 的增量，不重复发送未变化区域。
- `browser_act` 内部完成目标重验、等待和结果观察。成功时通常不需要模型再调用一次 snapshot。
- 动作结果返回新增、删除、改名、状态变化和焦点变化；没有相关变化时返回简短的 `no_relevant_change`。
- 页面导航、目标失效、模型需要理解新区域或用户要求阅读页面时，才重新获取对应范围的 snapshot。
- 截图默认不进入流程，仅在 Canvas、地图、远程桌面或语义信息不足时使用。

元素引用包含页面 id、生成号和目标语义指纹。Host 可以在 DOM 局部更新后安全地重定位同一元素，但不能仅凭相似文本替换一个已经失效的目标。

## 配套 Skill

插件附带一个按需加载的浏览器操作 Skill，规定：

1. 页面首次打开或进入未知区域时获取范围受限的 `browser_snapshot`。
2. 使用可访问名称、角色、所属区域和元素引用确认目标。
3. 调用 `browser_act` 时声明预期结果，让工具完成动作后的等待与增量观察。
4. 继续使用仍有效的元素引用和动作结果中新产生的引用，不机械地重复 snapshot。
5. 目标失效或匹配不唯一时缩小快照范围，不猜测目标。
6. 高影响操作先描述目标、作用和将提交的数据，等待权限流程放行。
7. Canvas、地图和远程桌面缺少可访问结构时才请求截图。

工具描述负责告诉模型“能做什么”，Skill 负责告诉模型“怎样可靠地组合这些工具”。即使 Skill 没有加载，工具自身仍会执行唯一性、revision、域名和权限检查。

## 可复用操作手册

插件在用户明确提出保存或更新操作手册时才生成草稿。手册可以只包含文字流程，也可以把文字流程与本次经过验证的浏览器轨迹一起保存。任务成功本身不会创建、修改或启用操作手册。操作手册属于指定站点和任务，与 browser-operation 核心 Skill 分开保存；它补充站点知识，但不会改变所有浏览任务的规则。

操作手册只记录可复用信息：

- 适用的站点 origin、路径模式和任务目标
- 文字说明中的前置条件、用户需提供的参数和判断分支
- 失败恢复方式和完成标准
- 可选轨迹中每一步所在的页面区域、元素角色和可访问名称
- 目标失效、出现歧义或页面改版时的重新观察位置

操作手册不保存临时元素引用、DOM 序号、密码、令牌、输入内容、截图正文或完整页面快照。

首次运行流程：

1. 用户明确提出“保存这次流程”“生成操作手册”或同等要求。
2. 模型整理适用站点、任务目标、前置条件、参数、分支、失败处理和完成标准。
3. 如果已经操作过页面，模型同时提交当前 pageId；Host 会附加不含表单值的已验证轨迹。没有页面轨迹时，模型使用站点 URL 创建纯文字草稿。
4. 用户在设置页审阅摘要并启用草稿。

已有手册通过 `previousId` 创建新修订。没有重新提供的名称、任务、文字说明和浏览步骤会沿用上一版，因此可以先保存纯文字说明，完成一次真实浏览器操作后再附加轨迹。修订必须属于同一个站点 origin，旧版不会被覆盖。

后续运行流程：

1. browser_open 根据 origin、路径和任务目标返回匹配的操作手册摘要。
2. 模型只在需要时加载完整操作手册。
3. Host 仍按当前页面重新解析和验证目标，不盲目回放旧步骤。
4. 手册步骤失效时回到局部 snapshot 探索；只有用户明确要求更新手册时才生成修订草稿。

设置页提供“操作手册”区域，显示名称、站点、最近成功时间、成功次数、版本、启用状态和失效次数，并支持查看、启用、停用、删除和重新学习。插件没有自动生成选项，且草稿不会自动覆盖已启用版本。

第一版提供三个工具：

| 工具 | 用途 |
|---|---|
| browser_runbook_list | 查找与当前站点和目标匹配的操作手册摘要 |
| browser_runbook_get | 按需加载一份操作手册 |
| browser_runbook_save | 响应用户的明确要求，使用文字流程和可选的当前页面轨迹生成或修订草稿 |

## 首个里程碑

- Windows 上发现 Chrome 和 Edge
- 设置页与运行检查
- 独立 Browser Context 和进程回收
- 标签页、打开、快照、点击、填写、选择和等待工具
- 缓存交互索引、语义指纹元素引用与增量页面变化
- 域名策略和高影响操作分类
- 配套 Skill
- 文字流程与可选成功轨迹组成的可复用操作手册
- 使用本地测试页面验证正常、歧义和动态更新场景
