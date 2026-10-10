# DSH Chrome Bridge 通信协议规范

本文档定义远程 DSH 服务端与本地 Chrome Extension 之间的通信协议标准。

## 一、传输层与连接方式

- **协议类型**：WebSocket (公网部署推荐 `wss://`，本地测试可用 `ws://`)。
- **连接方向**：本地 Chrome 扩展主动发起连接到远程 DSH 服务端。
- **默认地址**：`ws://<DSH_SERVER_IP>:8765` 或 `wss://<DSH_DOMAIN>/chrome-bridge`。

---

## 二、认证与连接建立（Handshake）

客户端在建立连接时必须进行身份认证：

### 方式 1：URL 查询参数（推荐）
在 WebSocket 连接串中附加 `token` 参数：
```
ws://127.0.0.1:8765/?token=your_secret_token
```

### 方式 2：握手首包（Auth Handshake）
连接成功后 5 秒内，扩展主动发送认证包：
```json
{
  "type": "auth",
  "token": "your_secret_token",
  "clientInfo": {
    "userAgent": "Mozilla/5.0 ...",
    "extensionVersion": "0.1.0"
  }
}
```

- 若服务端配置了 Token 且认证通过，服务端返回：
```json
{
  "type": "auth_ok",
  "ok": true
}
```
- 若认证失败，服务端返回错误并关闭连接（Code: `4001`）：
```json
{
  "type": "auth_error",
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication failed: Token mismatch."
  }
}
```

---

## 三、心跳保活（Heartbeat）

扩展端每 20 秒向服务端发送一次 ping：
```json
{ "type": "ping" }
```
服务端收到后应答：
```json
{ "type": "pong" }
```

---

## 四、请求与响应规范

所有操作请求均采用标准 JSON 格式。

### 1. 通用请求包（Server -> Extension）
```json
{
  "type": "request",
  "requestId": "req-9b8c7d6a",
  "method": "<METHOD_NAME>",
  "params": { ... }
}
```

### 2. 通用成功响应包（Extension -> Server）
```json
{
  "type": "response",
  "requestId": "req-9b8c7d6a",
  "ok": true,
  "result": { ... }
}
```

### 3. 通用失败响应包（Extension -> Server）
```json
{
  "type": "response",
  "requestId": "req-9b8c7d6a",
  "ok": false,
  "error": {
    "code": "<ERROR_CODE>",
    "message": "<HUMAN_READABLE_MESSAGE>",
    "details": {}
  }
}
```

---

## 五、核心 API 方法定义

### 1. `browser.tabs` (标签页管理)
**请求参数**：
```json
{
  "action": "list" | "new" | "close",
  "pageId": "12345" // 可选
}
```
**返回结果**：
```json
{
  "pages": [
    {
      "id": "12345",
      "url": "https://example.com/dashboard",
      "title": "仪表盘"
    }
  ]
}
```

### 2. `browser.open` (导航)
**请求参数**：
```json
{
  "pageId": "active",
  "url": "https://example.com/login"
}
```
**返回结果**：
```json
{
  "pageId": "12345",
  "url": "https://example.com/login",
  "title": "用户登录"
}
```

### 3. `browser.snapshot` (DOM 语义快照)
**请求参数**：
```json
{
  "pageId": "active",
  "mode": "interactive" | "form",
  "limit": 80,
  "scopeCss": "#main-content", // 可选
  "includeCandidates": false
}
```
**返回结果**：
```json
{
  "snapshotId": "s-a1b2c3d4",
  "url": "https://example.com/checkout",
  "title": "结账页面",
  "mode": "form",
  "elements": [
    {
      "ref": "e-9f8e7d6c",
      "role": "textbox",
      "name": "手机号码",
      "nameSource": "label",
      "disabled": false,
      "valueState": "has-value",
      "fieldContext": {
        "inferredLabel": "手机号码",
        "confidence": "high",
        "required": true,
        "inputType": "tel"
      }
    },
    {
      "ref": "e-1a2b3c4d",
      "role": "button",
      "name": "确认支付",
      "disabled": false
    }
  ],
  "headings": ["结账", "收货地址"],
  "forms": [{ "name": "地址表单", "fieldCount": 5 }],
  "totalInteractive": 12,
  "truncated": false
}
```

### 4. `browser.act` (页面操作)
**请求参数**：
```json
{
  "pageId": "active",
  "ref": "e-9f8e7d6c",
  "action": "fill", // "click" | "fill" | "select" | "press"
  "value": "13800000000",
  "expectedText": "验证码已发送", // 可选
  "expectedUrl": "https://example.com/verify" // 可选
}
```
**返回结果**：
```json
{
  "ok": true,
  "url": "https://example.com/checkout",
  "urlChanged": false,
  "expectedText": "验证码已发送"
}
```

### 5. `browser.wait` (等待条件)
**请求参数**：
```json
{
  "pageId": "active",
  "text": "支付成功",
  "url": "/success"
}
```

### 6. `browser.query` (DOM 只读查询)
**请求参数**：
```json
{
  "pageId": "active",
  "scopeCss": "#order-id",
  "read": "text" // "text" | "count" | "checked" | "value" | "attribute"
}
```
**返回结果**：
```json
{
  "read": "text",
  "value": "ORD-20261009-8888"
}
```

---

## 六、错误码表

| 错误代码 | 含义 | 建议处理方式 |
|---|---|---|
| `UNAUTHORIZED` | 鉴权失败，Token 错误或缺失 | 检查扩展 Popup 中填写的 Token |
| `BRIDGE_NOT_CONNECTED` | 未连接 Chrome 扩展 | 提示用户打开 Chrome 启动连接 |
| `BRIDGE_DISCONNECTED` | 扩展连接在操作执行过程中意外中断 | 检查网络连接或扩展状态后重试 |
| `BRIDGE_TIMEOUT` | 请求超时（默认 15s 未响应） | 检查页面是否无响应或死锁 |
| `ELEMENT_NOT_FOUND` | 指定的 ref 在引用池中不存在 | 提示模型重新调用 `browser_snapshot` |
| `ELEMENT_STALE` | 目标元素已从当前 DOM 树中移除 | 页面已跳转或刷新，重新获取快照 |
| `ELEMENT_DISABLED` | 目标按钮或控件处于 disabled 状态 | 不可点击，提示模型排查前置必填项 |
| `UNSUPPORTED_ACTION` | 传入了不支持的动作类型 | 检查参数是否为 click/fill/select/press |
