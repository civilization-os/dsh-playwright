# Chrome Bridge architecture

## Why this exists

The original plugin drives an **isolated** browser: it launches its own Chrome or Edge with its own
data directory. That is the right default for automation, but it cannot reach the session a user is
already signed in to, and it opens a second window.

The Chrome Bridge adds a second backend that drives **the user's own Chrome**, over a connection the
user's browser initiates. It is the default backend: the isolated browser is now opt-in, and it only
starts when the user asks for Playwright or the operator configures it as the default.

## Topology

```
DSH agent (remote Linux server)
  └── DSH browser tools (src/index.js)
        ├── Playwright backend  (src/browser.js)  → local Chromium process
        └── Chrome Bridge backend (src/bridge/backend.js)
              └── Chrome Bridge server (src/bridge/server.js + hub.js)
                    └── WSS  ← dialled outbound by the user's browser
                          └── Chrome Extension (extension/)
                                ├── service worker: auth, routing, tab selection
                                └── content script: snapshot + actions on one tab
                                      └── the page the user is looking at
```

The direction matters: **the browser dials the server**, so nothing on the user's machine needs an
inbound port, a tunnel, or a change to their firewall.

## Components

### Tool layer (`src/index.js`)

The existing tool names, parameters and result shapes are unchanged. The browser tools gained two
optional parameters:

| Parameter | Values | Meaning |
| --- | --- | --- |
| `backend` | `chrome-extension`, `playwright` | Override the configured backend for this one call. |
| `userRequestedPlaywright` | `true` | Required consent for a Playwright call. |

Omitted, the configured `backend` setting applies, and that default is `chrome-extension`. A call may
select `playwright` only when the operator made it the configured default or when the user explicitly
asked for Playwright in the conversation, which the model signals with `userRequestedPlaywright: true`.
The tools that only make sense against a plugin-managed browser (`browser_screenshot`, `browser_query`,
`browser_network`, `browser_request`, `browser_route`, `browser_cookies`) require the same consent and
say which capability the extension cannot serve.

Every extension-backed call runs a connection check first: the hub must be listening, exactly one
authenticated extension must be attached, and it must answer a real `bridge.ping` round trip. The
result is cached for a few seconds and invalidated on any peer change. A failure is reported with a
stable code (`BRIDGE_OFFLINE`, `BRIDGE_AMBIGUOUS`, `BRIDGE_TIMEOUT`) and never falls back to
Playwright, because starting a second browser is not a recovery the user asked for.

Two tools were added:

- `browser_bridge_status` — bridge state, health probe result, connected extensions, masked tokens.
- `browser_pairing_token` — create, list, or revoke a pairing token.

### Chrome Bridge server (`src/bridge/server.js`)

Owns the HTTP surface, the session exchange, and the hosting mode. It performs **no** browser work.

- `GET  <path>/health` — service and peer state.
- `POST <path>/session` — exchange a pairing token for a session cookie.
- `DELETE <path>/session` — revoke the caller's session.
- `GET  <path>` (WebSocket upgrade) — the bridge channel.

Hosting modes:

| Mode | What it does | When to use it |
| --- | --- | --- |
| `webServer` (default) | Registers `<path>` and its upgrade route on DSH's own HTTP server through `webServer.register` / `webServer.registerUpgrade`. **No extra port.** | Almost always. |
| `standalone` | Runs its own `node:http`/`node:https` listener on `chromeBridge.host:port`. | When a separate port or plugin-terminated TLS is required. |

### Bridge hub (`src/bridge/hub.js`)

Transport-agnostic. It owns every security and lifecycle rule, which is why it can be tested against
a fake peer:

- issues a one-time `challenge` nonce per connection;
- validates the pairing token in constant time and rejects anything else;
- keys connection ownership by **session**, so a reconnecting extension replaces its own stale
  socket while an independently paired browser stays a separate peer;
- correlates `requestId` → response, ignores responses from the wrong peer, and ignores unknown ids;
- enforces per-request timeouts, then sends `cancel` so the extension stops working;
- fails every in-flight request immediately when a peer disconnects;
- exposes a method allowlist, so arbitrary JavaScript and shell execution are not representable.

### Browser bridge transport (`src/bridge/websocket.js`)

A self-contained RFC 6455 server and client. The plugin deliberately adds **no** runtime dependency:
a DeepSeek Harness plugin must install in environments where fetching new packages is impossible, and
the framing rules are small and fully testable.

Implemented: handshake with `Sec-WebSocket-Accept` validation, masking enforcement, all three length
encodings, fragmentation, control frames, UTF-8 validation, bounded message size, and correct close
codes (`1002` protocol, `1007` invalid UTF-8, `1009` too large, `1011` internal). Not implemented:
`permessage-deflate`.

### Chrome Bridge backend (`src/bridge/backend.js`)

Presents the same surface as `BrowserManager`, so the tool layer does not branch. It translates
`pageId` values, remembers which tab each ref belongs to, and turns bridge errors into messages a
model can act on.

It also owns the connection health check that runs before every extension-backed call: `health()`
reports and `ensureHealthy()` enforces listening state, exactly one authenticated peer, and a real
`bridge.ping` round trip, because a socket that was never closed still looks connected. A successful
probe is cached for a few seconds and keyed by peer id; a failed probe is never cached.

### Settings page (`src/web.js`, `src/client/`)

The RPC channel (`/playwright-browser`) serves the settings page. It reports the isolated-browser
status plus the bridge report from `browser_bridge_status`, so the **Chrome Bridge** card can show the
endpoint switch, the listener state, the connected extension, the probe latency, and the masked token
count. Saving merges the form fields over the stored settings and deep-merges `chromeBridge`, so keys
the card does not render (TLS files, host, port, origin allowlist, request timeout) are preserved.

### Chrome Extension (`extension/`)

Manifest V3, minimal permissions.

- **service worker** — session exchange, the WebSocket, challenge response, keepalive, reconnect
  with backoff, and routing of bridge methods to Chrome APIs or to the page agent.
- **content script** — the page agent. It reuses `src/snapshot.js` verbatim, so both backends return
  the same snapshot structure.
- **popup** — connection status, bridge URL, pairing token, connect/disconnect, and the host-access
  grant.

## Page identity and references

A tab is addressed as `tab-<chromeTabId>`; `active` and `current` mean "the tab the user is looking
at right now". The extension never touches a tab implicitly beyond that.

A `ref` is an opaque identifier bound to **one live DOM node** plus the semantic fingerprint observed
when the snapshot was taken. The registry lives in the content script, so reads and writes happen in
the same document:

| Failure | Detected by | Reported as |
| --- | --- | --- |
| Unknown or expired ref | registry lookup, 10-minute TTL | `ELEMENT_NOT_FOUND` |
| Document navigated | revision counter | `ELEMENT_STALE` |
| Node removed or replaced | `isConnected` + identity map | `ELEMENT_STALE` |
| Accessible name or role changed | fingerprint re-read before acting | `ELEMENT_STALE` |
| Element hidden | visibility check | `ELEMENT_STALE` |
| Request names a different tab | per-document tab id | `ELEMENT_STALE` |
| Field still ambiguous | snapshot confidence | `ELEMENT_AMBIGUOUS` |
| Wrong control kind | role checks | `ELEMENT_NOT_EDITABLE` / `ELEMENT_NOT_SELECT` |

The registry is bounded (500 entries) and pruned on every snapshot and insert, so a long-lived tab
cannot accumulate dead entries.

## Shared DOM semantics

`src/snapshot.js` is the single implementation of page semantics. Playwright evaluates it through
`page.evaluateHandle`; the extension bundles it into the content script. One source, two backends.

### Label confidence

Field identification distinguishes evidence strength:

- **Strong**: `aria-label`, `aria-labelledby`, an associated `<label>`, button value. Accepted
  directly, `confidence: "high"`.
- **Weak**: `placeholder`, `title`, preceding content, table cells and headers, nearby text. Scored
  and reported with the evidence source and a confidence level.
- **None**: reported as unresolved. No label is invented.

Three specific rules exist because the naive version produced wrong labels:

1. A generic hint (`请选择`, `请输入`, `Select`, `Enter a value`, …) is **never** returned as a field
   name, and never stops contextual inference. It is reported as `labelSource: "generic-hint"` with
   no `inferredLabel`.
2. A section or form heading — and the `<legend>` of the fieldset the field belongs to — names a
   **region**, not a field. A heading that is the first heading of the smallest element containing
   both itself and the field, and that fieldset legend, are excluded from label candidates. Without
   this, every field in a `<fieldset>` competes with its own legend on a sub-point margin.
3. A `<label>` names exactly one control. Its text is evidence only for the control it is associated
   with, so it is never borrowed by a neighbouring field.

Weak evidence is still reported: a specific placeholder yields `inferredLabel` with `confidence:
"low"` rather than being discarded.

## Trust boundaries

- Page content is untrusted input and is never treated as instructions.
- The page agent returns data; it does not decide what to do.
- The server cannot ask the extension to evaluate a JavaScript string, read arbitrary storage, or
  touch a tab the request did not name.
- The pairing token is a credential: `chrome.storage.session` on the client, a `0600` file on the
  server, never a URL, never a log, never in a listing.

## Deliberate limits in this phase

- Top-level frame only. Iframe snapshots and network waiting remain Playwright-only and report a
  clear error.
- `scopeCss`, `expectedText`, and `expectedUrl` are Playwright-only.
- The extension backend does not record a runbook trajectory, so a manual saved from one of its tabs
  stores the site and instructions without steps.
- No file upload/download, browser-extension management, or Chrome DevTools Protocol access.
- One tab per operation; no cross-tab orchestration.
