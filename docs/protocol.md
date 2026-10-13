# Chrome Bridge protocol

Version `1`. Text frames only; binary frames are rejected with close code `1003`. One JSON object per
frame. The maximum message is 2 MiB, enforced by the server.

## Connection sequence

```
Extension                                     Bridge server
    |  POST <path>/session  { token }  ---------->|
    |  <-- 200 + Set-Cookie: dsh_bridge_session   |
    |                                             |
    |  GET <path>  Upgrade: websocket             |
    |      Cookie: dsh_bridge_session=...  ------>|
    |  <-- 101 Switching Protocols                |
    |                                             |
    |  <-- { "type": "challenge", nonce }         |
    |  { "type": "hello", nonce, token }  ------->|
    |  <-- { "type": "ready", peerId, methods }   |
    |                                             |
    |  <-- { "type": "request", requestId, ... }  |
    |  { "type": "response", requestId, ok } ---->|
```

The token is presented **twice** on purpose. The HTTP exchange is where a durable credential is
converted into a short-lived session; the `hello` frame then proves the token to the socket itself.
A stolen URL alone is useless, and the token never appears in a URL, an access log, or browser
history.

Rejection is explicit:

| Condition | Result |
| --- | --- |
| No valid session cookie | HTTP `401` on the upgrade, no protocol traffic |
| Origin not in `allowedOrigins` | HTTP `403` on the upgrade |
| No `hello` within 10 s | close `1000` / reason `BRIDGE_UNAUTHENTICATED` |
| Wrong nonce | close `1000` / reason `BRIDGE_UNAUTHENTICATED` |
| Bad or expired token | close `1000` / reason `BRIDGE_UNAUTHORIZED` |
| Same session reconnects | older socket closes with `BRIDGE_REPLACED` |

## Messages

### Server → extension

`challenge` — sent once, immediately after the upgrade.

```json
{ "type": "challenge", "protocol": 1, "nonce": "<base64url>", "authTimeoutMs": 10000,
  "methods": ["bridge.status", "bridge.ping", "browser.tabs", "browser.open",
              "browser.snapshot", "browser.act", "browser.wait"] }
```

`ready` — authentication succeeded.

```json
{ "type": "ready", "protocol": 1, "peerId": "bridge-1a2b3c4d", "methods": ["..."],
  "maxMessageBytes": 2097152 }
```

`request` — one operation.

```json
{ "type": "request", "requestId": "req-001", "method": "browser.snapshot",
  "params": { "pageId": "active", "mode": "form", "limit": 80 } }
```

`cancel` — the server is no longer waiting for `requestId`. The extension must stop work and must not
send a response.

### Extension → server

`hello` — answers the challenge.

```json
{ "type": "hello", "nonce": "<echoed>", "token": "<pairing token>",
  "label": "Work laptop", "extensionVersion": "0.1.0" }
```

`response` — success or failure. Exactly one per `requestId`.

```json
{ "type": "response", "requestId": "req-001", "ok": true,
  "result": { "url": "https://example.com/", "title": "Example", "elements": [] } }
```

```json
{ "type": "response", "requestId": "req-001", "ok": false,
  "error": { "code": "ELEMENT_NOT_FOUND",
             "message": "The requested element reference is not known to this page." } }
```

`event` — non-authoritative progress and keepalive.

```json
{ "type": "event", "event": "heartbeat", "data": { "at": 1730000000000 } }
```

The server **never** accepts `request` from a peer. A peer that sends one is closed with
`BRIDGE_PROTOCOL_ERROR`.

## Methods

### `bridge.ping`

Liveness probe. The server sends it before the first extension-backed tool call of a task, and again
whenever the previous successful probe is older than a few seconds, so a socket that was never closed
cannot be mistaken for a working extension.

- params: none
- result: `{ "pong": true, "at": <epoch ms> }`

### `bridge.status`

- result: `{ status, detail, bridgeUrl, peerId, connectedAt, pending, protocol }`

### `browser.tabs`

- params: `{ action: "list" | "new" | "close", pageId? }`
- result: `{ pages: [{ id, url, title, active }], created?, closed? }`

`id` is `tab-<chromeTabId>`. `url` is reduced to origin + pathname. Internal Chrome pages
(`chrome://`, `chrome-extension://`, `about:`) are omitted.

### `browser.open`

- params: `{ url, pageId? }`
- result: `{ pageId, url, title }`

Only `http:` and `https:` URLs without embedded credentials are accepted.

### `browser.snapshot`

- params: `{ pageId?, mode?: "interactive" | "form", limit?: number, includeCandidates?: boolean, tabId? }`
- result:

```json
{
  "snapshotId": "cs-1a2b3c4d",
  "pageId": "tab-11", "tabId": 11, "url": "https://example.com/checkout", "title": "Checkout",
  "mode": "form", "isActiveTab": true, "frames": [],
  "headings": ["Checkout"], "forms": [{ "name": "Shipping", "fieldCount": 3 }],
  "elements": [
    { "ref": "c-1a2b3c4d", "role": "textbox", "name": "Email address", "nameSource": "label",
      "disabled": false, "valueState": "has-value",
      "fieldContext": { "inferredLabel": "Email address", "labelSource": "label",
                        "confidence": "high", "required": true, "inputType": "email",
                        "autocomplete": "email", "fieldName": "email", "group": "Shipping" } }
  ],
  "totalInteractive": 12, "candidateCount": 4, "returned": 12, "truncated": false
}
```

`ref` is valid only in the tab and document that produced it. `limit` is clamped to 1–200.

`fieldContext` evidence:

| Field | Meaning |
| --- | --- |
| `inferredLabel` | The resolved label. Absent when no defensible evidence exists. |
| `labelSource` | `aria-label`, `aria-labelledby`, `label`, `value`, `placeholder`, `title`, `table-cell`, `table-header`, `preceding-content`, `nearby-left`, `nearby-above`, `content`. |
| `confidence` | `high`, `medium`, `low`, `ambiguous`. |
| `labelCandidates` | Up to three alternatives, present when the result is ambiguous. |
| `labelHintGeneric` | Internal marker; not returned. Generic hints are reported as `labelSource: "generic-hint"` with no label. |
| `fieldNameRepeated` | `true` when more than one control in the projection shares the `name`. |
| `group`, `helpText`, `required`, `inputType`, `autocomplete`, `fieldName`, `options` | Additional structural evidence. |

### `browser.act`

- params: `{ ref, action: "click" | "fill" | "select" | "press", value?, pageId?, tabId? }`
- result: `{ ok: true, action, url, title, navigated, ...detail }`

`fill` and `select` require `value`. `select` matches an option by value, then visible text, then
label. `press` accepts named keys (`Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Arrow*`,
`Home`, `End`, `Space`) or a single printable character.

### `browser.wait`

- params: `{ text?, url?, timeoutMs?, pageId?, tabId? }`
- result: `{ matchedText, matchedUrl, url, title }`

At least one of `text` or `url` is required. `url` is treated as a regular expression, falling back
to a substring match if the pattern is invalid. `timeoutMs` is clamped to 30 s.

## Error codes

| Code | Meaning | What the agent should do |
| --- | --- | --- |
| `ELEMENT_NOT_FOUND` | Ref unknown or expired. | Take a new snapshot. |
| `ELEMENT_STALE` | Node removed, replaced, renamed, hidden, or in another tab. | Take a new snapshot. |
| `ELEMENT_AMBIGUOUS` | Field identity is not resolved. | Narrow the snapshot, or ask the user. |
| `ELEMENT_NOT_EDITABLE` | Target does not accept text. | Re-read the snapshot. |
| `ELEMENT_NOT_SELECT` | Target is not a `<select>`. | Re-read the snapshot. |
| `TAB_NOT_FOUND` | The tab no longer exists. | Re-list tabs. |
| `TAB_UNAVAILABLE` | The page agent did not respond in that tab. | Reload the tab. |
| `PAGE_UNSUPPORTED` | Not an HTTP(S) page. | Use another tab. |
| `PERMISSION_DENIED` | The extension has no access to that page. | The user grants access in the popup. |
| `INVALID_PARAMS` | Malformed request. | Fix the call. |
| `TIMEOUT` | The page never reached the requested state. | Inspect the page. |
| `INTERNAL` | The extension failed. | Report it. |

Bridge-level codes raised by the server: `BRIDGE_OFFLINE`, `BRIDGE_TIMEOUT`, `BRIDGE_ABORTED`,
`BRIDGE_UNAUTHORIZED`, `BRIDGE_UNAUTHENTICATED`, `BRIDGE_METHOD_NOT_ALLOWED`, `BRIDGE_AMBIGUOUS`,
`BRIDGE_BUSY`, `BRIDGE_REPLACED`, `BRIDGE_PROTOCOL_ERROR`, `BRIDGE_REMOTE_ERROR`.

## Limits

| Limit | Value |
| --- | --- |
| Message size | 2 MiB (`1009` when exceeded) |
| Authenticate within | 10 s |
| Default request timeout | 30 s (`chromeBridge.requestTimeoutMs`) |
| Outstanding requests per peer | 64 |
| Snapshot elements | 200 |
| Refs per document | 500 |
| Ref TTL | 10 minutes |
| Concurrent page work per socket | 32 |
| Session lifetime | 12 hours |
