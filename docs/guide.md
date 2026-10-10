# DSH Chrome Bridge 实战使用与部署运维指南

本文档提供 DSH Chrome Bridge 的全流程安装、配置、公网部署、真机联调与故障排查指导。

---

## 一、架构工作流概述

```
[DSH Agent (远程 Linux)]
       │
       ▼ (内部派发)
[ChromeBridgeServer (端口 8765)]
       ▲
       │ WSS / WS 反向长连接 (带 Token 鉴权)
       │
[本地 Chrome 扩展 (用户电脑)]
       │
       ▼ (Tab 调度)
[当前活动网页 DOM (复用已登录会话)]
```

- **核心优势**：用户电脑无需公网 IP，无需路由器配置内网穿透或开放入站端口。本地扩展主动连接远程 DSH 服务。
- **双模支持**：随时可回滚至原本的独立 Playwright 浏览器模式。

---

## 二、扩展端安装与打包指引（用户电脑）

### 1. 方式 A：直接加载本地源码（推荐开发使用）
1. 打开本地 Google Chrome 浏览器。
2. 在地址栏输入 `chrome://extensions/` 并回车。
3. 在页面右上角打开 **“开发者模式”**（Developer mode）开关。
4. 点击左上角的 **“加载已解压的扩展程序”**（Load unpacked）。
5. 在弹出的文件选择器中，选中插件仓库根目录下的 `extension` 文件夹（例如 `D:\project\dsh-plugins\dsh-playwright\extension`）。
6. 点击确认，Chrome 扩展列表中将出现 **DSH Chrome Bridge**。

### 2. 方式 B：使用 Release ZIP 发布包
如果在其他没有源码的电脑上安装：
1. 在仓库根目录运行打包命令：
   ```sh
   pnpm package:ext
   ```
   打包脚本将生成 `dist/dsh-chrome-bridge-extension.zip`。
2. **⚠️ 关键注意**：由于该扩展为开发者模式分发，**不能直接将 ZIP 文件拖入 Chrome 窗口安装**（Chrome 会拦截非商店打包扩展）。
3. **正确安装步骤**：
   - 将下载的 ZIP 压缩包解压到一个固定目录（例如 `C:\Users\username\dsh-chrome-bridge`）。
   - 打开 `chrome://extensions/`，点击 **“加载已解压的扩展程序”**。
   - 选择解压出来的目录即可。

---

## 三、服务端配置与远程部署指引（DSH 服务器）

### 1. DSH 配置项说明
在 DSH 的数据目录（默认为 `~/.dsh/playwright/settings.json`，或通过 DSH Web 设置界面）中增加以下配置：

```json
{
  "backend": "extension",
  "bridgePort": 8765,
  "bridgeToken": "your_secure_random_token_123"
}
```

| 配置字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `backend` | string | `"playwright"` | `"extension"` 启用 Chrome 扩展桥接模式；`"playwright"` 保持原有独立浏览器模式 |
| `bridgePort` | number | `8765` | WebSocket Bridge 监听端口 |
| `bridgeToken` | string | `""` | 客户端连接认证 Token，强烈建议生产环境配置强随机字符串 |

### 2. 公网 Nginx WSS 反向代理配置（生产环境强烈推荐）

当 DSH 部署在公网远程 Linux 服务器时，直接暴露未加密的明文 WebSocket（`ws://`）存在安全风险，且部分网络环境会拦截非标准端口。推荐使用现有域名的 Nginx 统一代理并启用 TLS（WSS）：

在 Nginx 的 HTTPS `server` 块中增加如下配置：

```nginx
# 将 /chrome-bridge 路径反向代理给 DSH Bridge WebSocket 服务
location /chrome-bridge {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;

    # 保持 WebSocket 长连接，避免超时断开
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    # 传递真实客户端 IP
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

配置生效后，本地 Chrome 扩展即可使用加密通道连接：
```
wss://your-dsh-domain.com/chrome-bridge
```

---

## 四、配对与联调验证步骤

1. **服务端检查**：启动 DSH 服务，确认 `bridgePort`（如 8765）处于监听状态。
2. **扩展配置**：
   - 点击 Chrome 工具栏拼图图标，固定 **DSH Chrome Bridge**。
   - 点击扩展图标打开 Popup 窗口：
     - **Bridge 服务地址**：
       - 本地同一台电脑：`ws://127.0.0.1:8765`
       - 远程服务器公网：`wss://your-dsh-domain.com/chrome-bridge`
     - **鉴权 Token**：填入服务器上配置的 `bridgeToken`。
   - 点击 **“连接”** 按钮。
   - 看到徽标变为绿色的 **“已连接”**，且下方显示当前活动的网页 URL，代表握手成功！
3. **Agent 执行测试**：
   - 在 DSH Agent 中发送指令，例如：
     > “请获取当前打开页面的快照，告诉我页面标题和主要输入框。”
   - DSH 将调用 `browser_snapshot`，在用户的 Chrome 中执行语义分析并返回结构化数据。
   - 进一步要求 DSH 填写表单或点击按钮，Agent 将通过 `browser_act` 实时在你的 Chrome 中操作。

---

## 五、常见故障排查手册（Troubleshooting FAQ）

### Q1: 扩展 Popup 始终显示“未连接”或“连接异常”？
* **检查网络连通性**：
  - 如果连接的是远程服务器 IP，请确认服务器防火墙/安全组已放行对应端口（如 8765）。
  - 如果通过域名 WSS 连接，请检查 Nginx 是否正确配置了 `proxy_set_header Upgrade` 和 `Connection "Upgrade"`。
* **检查 URL 协议头**：
  - 加密域名请使用 `wss://`；未加密测试环境使用 `ws://`。不要写成 `http://` 或 `https://`。

### Q2: 扩展连接瞬间被切断，提示 `UNAUTHORIZED` 鉴权失败？
* **原因**：服务端配置了 `bridgeToken`，但扩展 Popup 中填写的 Token 不匹配或留空。
* **解决**：检查服务端 `settings.json` 中的 `bridgeToken`，确保两端完全一致。

### Q3: Agent 报错 `ELEMENT_STALE` 或 `ELEMENT_NOT_FOUND`？
* **原因**：
  - 用户在 Agent 执行期间手动刷新了页面或点击跳转到了新页面，导致快照时分配的 `ref` 在当前 DOM 中失效。
  - 前端单页应用（SPA）动态重新渲染了该组件。
* **解决**：这是正常且受保护的生命周期行为。Agent 会捕获该错误并自动重新调用 `browser_snapshot` 刷新页面元素引用。

### Q4: 提示无法操作页面（Cannot interact with page）？
* **原因**：当前活动的标签页是 Chrome 系统内置页面（例如 `chrome://extensions/`、`chrome://newtab/`、`chrome://settings/` 等）。
* **解决**：Chrome 严格禁止任何扩展注入脚本到 `chrome://` 协议页面。请在 Chrome 中切换到普通的外部网页（`http://` 或 `https://`）再执行操作。

### Q5: 如何彻底回滚到原有的独立 Playwright 模式？
* **解决**：无需修改代码，只需在 DSH 的 `settings.json` 中将 `"backend"` 设置为 `"playwright"`（或删除该字段），重启 DSH 即可。
