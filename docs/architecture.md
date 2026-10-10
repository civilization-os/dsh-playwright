# DSH Chrome Bridge 架构设计说明

本文档说明 `dsh-playwright` 中 Chrome Extension Bridge 后端（`dsh-chrome-bridge`）的整体架构、分层设计、网络通信与生命周期。

## 一、背景与设计目标

在 DSH（DeepSeek Harness）的实际 Agent 场景中，自动化任务通常需要与用户日常使用的浏览器环境配合：
1. **复用用户现有 Chrome**：直接复用本地 Chrome 中已打开的标签页与已有登录态（Cookie、Session、SSO 等），无需每次启动全新的独立浏览器。
2. **跨网络拓扑穿透**：DSH 运行在远程 Linux 服务器或云端，而 Chrome 运行在用户本地电脑。扩展采用**主动向外连接远程 WebSocket 服务**的反向链路，用户本地无需开放入站端口或暴露公网 IP。
3. **双后端平滑切换**：保留原有的 Playwright 后端。用户可在配置中自由选择使用独立的 Playwright 实例，或通过 Chrome Bridge 连接本地已打开的 Chrome。原有 15 个模型工具接口结构与参数保持一致。
4. **DOM 语义分析与元素引用复用**：复用原有成熟的 DOM 语义识别规则（`snapshot.js`），保证 `aria-label`、`labels`、`placeholder`、周围文字推断与歧义消歧等算法完全一致。

---

## 二、总体架构图

```
+-----------------------------------------------------------------------+
|                         远程服务器 (Linux / 云端)                      |
|                                                                       |
|   +--------------------+       +----------------------------------+   |
|   |   DSH Agent 核心   |  ==>  |  playwright-browser 插件 (Cordis)|   |
|   +--------------------+       +-----------------+----------------+   |
|                                                  |                    |
|                                      DynamicBrowserManager            |
|                                        /                \             |
|                       [backend:playwright]        [backend:extension] |
|                                      /                    \           |
|                          BrowserManager           ChromeBridgeManager |
|                         (Playwright Core)                  |          |
|                                                            v          |
|                                                   ChromeBridgeServer  |
|                                                    (WebSocket Server) |
+------------------------------------------------------------|----------+
                                                             ^ (WSS / WS 反向连接)
                                                             | (带 Token 鉴权)
+------------------------------------------------------------|----------+
|                         用户本地电脑 (Windows / macOS)      |          |
|                                                            |          |
|   +--------------------------------------------------------+------+   |
|   |               DSH Chrome Bridge 扩展 (Manifest V3)             |   |
|   |                                                               |   |
|   |   [Popup UI]             <===>      [Service Worker]          |   |
|   |  - 输入服务地址与 Token               - 维护长连接与重连心跳     |   |
|   |  - 查看连接状态与当前页面             - 调度 Chrome Tab 消息    |   |
|   |                                               |               |   |
|   |                                               v               |   |
|   |                                        [Content Script]       |   |
|   |                                      - 执行 DOM 快照算法       |   |
|   |                                      - 维护 ref -> 节点缓存   |   |
|   |                                      - 执行滚动/点击/输入     |   |
|   |                                               |               |   |
|   |                                               v               |   |
|   |                                        [用户当前网页 DOM]      |   |
|   +---------------------------------------------------------------+   |
+-----------------------------------------------------------------------+
```

---

## 三、核心组件职责

### 1. `DynamicBrowserManager` 门面层 (`src/index.js`)
- 作为 DSH 工具与底层引擎之间的路由器。
- 读取当前配置中的 `backend` 选项（`playwright` 或 `extension`）：
  - 当为 `playwright` 时：所有操作委托给 `BrowserManager`。
  - 当为 `extension` 时：所有操作委托给 `ChromeBridgeManager`。
- 生命周期管理：在插件注销（`dispose`）时，同时优雅释放两种后端的全部资源。

### 2. `ChromeBridgeServer` 服务端 (`src/bridge/server.js`)
- 启动常驻 WebSocket 服务（默认端口 `8765`，可配置）。
- **客户端认证**：校验连接请求中的 Token（支持 URL 参数或首包握手），未认证或 Token 错误的连接立即切断（HTTP/WS 4001）。
- **请求派发与匹配**：为每个工具调用分配唯一的 `requestId`，记录超时计时器，等待扩展响应。
- **异常恢复**：当扩展断开时，立即将所有在途请求标记为 `BRIDGE_DISCONNECTED`，防止请求永久悬挂。

### 3. `ChromeBridgeManager` 适配层 (`src/bridge/manager.js`)
- 抹平底层差异，向上层暴露完全兼容 `BrowserManager` 的接口：
  - `status()`: 汇报扩展连接状态、活跃标签页数与 Token 配置。
  - `tabs()`: 列出、创建或关闭标签页。
  - `open()`: 打开指定 URL。
  - `snapshot()`: 获取受限语义快照（支持 interactive / form 模式）。
  - `act()`: 基于元素 `ref` 执行安全点击、输入、选择下拉框、回车。
  - `wait()`: 等待文本出现或 URL 变化。
  - `query()`: 读取指定 CSS 的 DOM 信息。
- 轨迹记录：记录操作序列，为操作手册（Runbooks）提供支持。

### 4. Chrome 扩展端 (`extension/`)
- **Manifest V3 规范**：遵循 Chrome 官方最新扩展标准，权限最小化申请（`activeTab`, `scripting`, `storage`, `tabs`）。
- **Service Worker** (`service-worker.js`)：
  - 维持与 Bridge 服务的 WebSocket 连接。
  - 断线指数退避自动重连，定时发送 ping 心跳保活。
  - 调度活动标签页（Active Tab），动态注入 Content Script。
- **Content Script** (`content.js`)：
  - 直接复用 `src/snapshot.js` 的核心语义算法，零差异保证表单识别准确性。
  - 维护 `ref -> Element` 内存映射池。
  - 验证元素在 DOM 中的有效性（`isConnected`）和可见性，执行安全滚动与仿真交互事件（`input`, `change`, `click`）。
- **Popup UI** (`popup.html` / `popup.js`)：
  - 提供用户友好的状态监控面板。
  - 支持配置服务器地址（支持公网 `wss://...` 与局域网 `ws://...`）及配对 Token。

---

## 四、元素生命周期与失效保护

1. **唯一标识 `ref`**：快照生成时分配稳定且匿名的 `ref`（如 `e-k3j8a9b1`），不向大模型泄露脆弱的 nth-child CSS 路径。
2. **连接性校验**：每次动作前，Content Script 校验 `element.isConnected`。如果页面发生刷新、单页路由跳出或该节点被前端框架（如 React/Vue）卸载，立即返回清晰的 `ELEMENT_STALE` 错误。
3. **过期防护**：扩展内部维护引用容量上限（1000 个）并支持随快照刷新而更新，提示 Agent 重新获取最新快照。
