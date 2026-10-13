# Chrome Bridge: installation and deployment

## 1. Server side

### 1.1 Enable the bridge

The bridge is **off** until it is enabled, so an upgrade cannot silently expose a new endpoint.
Settings live in `$DSH_HOME/playwright/settings.json` (default `~/.dsh/playwright/settings.json`).

Minimal configuration — reuse DSH's own HTTP server, no new port:

```json
{
  "backend": "chrome-extension",
  "chromeBridge": {
    "enabled": true,
    "mode": "webServer",
    "path": "/chrome-bridge",
    "publicUrl": "wss://dsh.example.com/chrome-bridge"
  }
}
```

| Key | Default | Notes |
| --- | --- | --- |
| `enabled` | `false` | Must be `true` for the bridge to listen. |
| `mode` | `webServer` | `webServer` reuses DSH's server; `standalone` opens its own listener. |
| `path` | `/chrome-bridge` | WebSocket and HTTP path. |
| `host` | `127.0.0.1` | `standalone` bind address. |
| `port` | `0` | `standalone` port; `0` picks a free port. |
| `publicUrl` | `""` | The externally reachable `ws(s)://` URL. **Set this behind a reverse proxy.** |
| `tlsKeyFile` / `tlsCertFile` | `""` | `standalone` only; enables `wss://` directly. |
| `allowedOrigins` | `[]` | Optional exact-match `Origin` allowlist. Empty means "do not check". |
| `requestTimeoutMs` | `30000` | Per-request timeout. |

`backend` selects the default backend for browser tools: `chrome-extension` (the default, the user's
own Chrome) or `playwright` (the isolated managed browser). The plugin prefers the extension, so the
isolated browser starts only when this setting names it or when the user explicitly asks for Playwright
in the conversation — a per-call `backend: "playwright"` must then also carry
`userRequestedPlaywright: true`. Before every extension call the plugin checks that the bridge is
listening, that exactly one extension is connected, and that it answers a `bridge.ping` probe; a
failure is reported with `BRIDGE_OFFLINE`, `BRIDGE_AMBIGUOUS`, or `BRIDGE_TIMEOUT` and never falls back
to Playwright.

`enabled` stays `false` by default so an upgrade cannot silently expose a new endpoint: the extension
is the preferred backend, but the operator still opts in to the listener. Until it is enabled, browser
tools report that the bridge is disabled and tell the agent to ask the user.

The same switch lives in the DSH settings page: the **Chrome Bridge** card edits the endpoint toggle,
the path, the public URL, and the default backend, and shows the live listener state, the connected
extension, the liveness probe result, and the masked token count. Saving the card only rewrites the
settings file — mounting or moving the endpoint still needs a profile restart, and the card says so.

Restart DSH after editing, or let the profile's `patchReload` pick it up.

### 1.2 TLS

DSH does not terminate TLS itself, so in the `webServer` mode a reverse proxy must provide `wss://`.
Example nginx server block:

```nginx
server {
  listen 443 ssl http2;
  server_name dsh.example.com;

  ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

  # The DSH web UI.
  location / {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # The Chrome Bridge needs the upgrade handshake and a long read timeout.
  location /chrome-bridge {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_set_header X-Real-IP  $remote_addr;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    # A bridge message is at most 2 MiB.
    client_max_body_size 4m;
  }
}
```

Then set `chromeBridge.publicUrl` to `wss://dsh.example.com/chrome-bridge` so the extension is told
the correct address. Caddy needs no extra directives: its `reverse_proxy` handles upgrades.

Only the WebSocket path needs to be public. If DSH itself is not exposed, publish just
`/chrome-bridge`.

### 1.3 Create a pairing token

```bash
# Via the CLI (preferred: the token is printed once and never stored in chat history)
dsh-chrome-bridge token create "work laptop"

# Or through the agent
#   browser_pairing_token { "action": "create", "label": "work laptop" }
```

Manage them:

```bash
dsh-chrome-bridge status              # reachability, connected extensions, masked tokens
dsh-chrome-bridge url                 # the URL to paste into the popup
dsh-chrome-bridge token list          # ids and fingerprints, no secrets
dsh-chrome-bridge token revoke <id>   # disables the token and its existing sessions
```

Tokens are stored in `${DSH_HOME:-~/.dsh}/playwright/chrome-bridge-tokens.json` with mode `0600`.
Revoking a token also invalidates the sessions already issued from it.

### 1.4 Standalone mode

Use this only when a separate port is genuinely needed.

```json
{
  "chromeBridge": {
    "enabled": true,
    "mode": "standalone",
    "host": "127.0.0.1",
    "port": 3081,
    "tlsKeyFile": "/etc/dsh/bridge-key.pem",
    "tlsCertFile": "/etc/dsh/bridge-cert.pem",
    "publicUrl": "wss://dsh.example.com:3081/chrome-bridge"
  }
}
```

With `tlsKeyFile` and `tlsCertFile` set, the listener speaks `wss://` itself. Without them it speaks
plain `ws://` and the extension refuses any non-loopback address.

## 2. Client side

### 2.1 Build the extension

```bash
pnpm build:extension
```

This produces:

- `dist/extension/` — a **Load unpacked** directory (recommended);
- `dist/dsh-chrome-bridge-0.1.0.zip` — the same files for distribution;
- `dist/dsh-chrome-bridge-0.1.0.zip.sha256` — the archive checksum.

The ZIP is **not** a Chrome Web Store package and cannot be installed by dragging it into Chrome.
Chrome also refuses a ZIP whose top level holds several files unless a checksum accompanies it, which
is why the `.sha256` file is written beside the archive. The simplest path is to unzip and use
`dist/extension/` directly.

### 2.2 Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `dist/extension/`.
4. Pin the extension so the status badge is visible.

### 2.3 Connect

1. Click the extension icon.
2. **Bridge URL** — paste the value from `dsh-chrome-bridge url`, for example
   `wss://dsh.example.com/chrome-bridge`.
3. **Pairing token** — paste the token from `token create`.
4. Press **Grant access** and accept the prompt. The extension asks only for the bridge's own
   origin, not for all sites.
5. Press **Connect**. The badge shows `ON` and the status line reads *Connected to the DSH bridge.*

The pairing token is kept in `chrome.storage.session`, which is memory-only and cleared when Chrome
exits. Reconnecting after a restart needs the token again.

### 2.4 Permissions in plain terms

| Permission | Why |
| --- | --- |
| `activeTab` | Operate the tab the user is looking at, granted when the popup is used. |
| `scripting` | Inject the page agent into that tab. |
| `tabs` | Read tab URLs and titles, and address a tab by id. |
| `storage` | Keep the bridge URL and the session-scoped token. |
| `alarms` | Reconnect after Chrome suspends the service worker. |
| optional host access | Only the bridge origin the user grants. |

There is no `<all_urls>` host permission and no declared content script: page access comes from
`activeTab`, or from host access the user explicitly grants. A page the extension was not granted
access to produces `PERMISSION_DENIED` rather than a silent partial action.

## 3. Using it

```
"Open the checkout page in my Chrome and fill in the email field."

→ browser_bridge_status                     (optional: is the extension connected?)
→ browser_tabs      { "action": "list" }    (default backend: the user's Chrome)
→ browser_snapshot  { "pageId": "active", "mode": "form" }
→ browser_act       { "pageId": "active", "ref": "c-1a2b3c4d", "action": "fill",
                      "value": "me@example.com" }
→ browser_act       { "pageId": "active", "ref": "c-...", "action": "click" }
```

No `backend` argument is needed: the user's Chrome is the default. `pageId: "active"` (or the omitted
default) means the tab the user is looking at, and a `tab-<id>` from `browser_tabs` addresses a
specific tab.

To use the isolated Playwright browser, the user has to ask for it in the conversation; the call then
looks like this:

```
→ browser_snapshot  { "pageId": "page-1", "backend": "playwright", "userRequestedPlaywright": true }
```

Setting `"backend": "playwright"` in `settings.json` makes Playwright the default for every call and
removes the per-call consent requirement, because the operator made the choice explicitly.

## 4. Rollback

The Chrome Bridge cannot affect the Playwright path, so rollback is configuration-only:

1. Set `"backend": "playwright"` so every tool call uses the isolated browser and the extension is
   never consulted, or leave the default and rely on the per-call consent rule.
2. Optionally set `"chromeBridge": { "enabled": false }` to stop the endpoint and close all peers.
3. Optionally revoke tokens: `dsh-chrome-bridge token revoke <id>`.
4. In Chrome, press **Disconnect**, or remove the extension from `chrome://extensions`.

No files need to be restored, and no data directory changes. The Playwright backend keeps using its
own isolated profile exactly as before.

## 5. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `status` reports `reachable: no (ECONNREFUSED)` | Bridge disabled, wrong port, or the reverse proxy is not forwarding. | Check `chromeBridge.enabled`, `dsh-chrome-bridge url`, and the proxy block. |
| Popup: *Access to … has not been granted* | Host access was never granted. | Press **Grant access** and accept. |
| Popup: *Refusing a non-TLS bridge address* | A non-loopback `ws://` URL. | Use `wss://`. |
| Popup: *The pairing token was rejected* | Revoked, expired, or mistyped. | Create a new token and paste it again. |
| Close reason `BRIDGE_REPLACED` | The same session connected again (another Chrome profile or a restored tab). | Expected. The newest connection wins. |
| `[BRIDGE_OFFLINE] No Chrome extension is connected` | The extension is not connected, or Chrome was closed. | Open the popup and press **Connect**, then check `browser_bridge_status`. |
| `[BRIDGE_OFFLINE] The Chrome Bridge listener is not running` | `chromeBridge.enabled` is `false`, so the agent has no extension to talk to. | Enable the bridge, or tell the agent to ask for Playwright. |
| `[BRIDGE_TIMEOUT] The Chrome extension did not answer bridge.ping` | The socket is still open but Chrome stopped answering, or two extensions are fighting over one session. | Reconnect from the popup; check `browser_bridge_status` for the peer list. |
| `[BRIDGE_TIMEOUT]` | The page was busy, or a modal blocked it. | Inspect the page, then take a new snapshot. |
| `[ELEMENT_STALE]` | The page changed after the snapshot. | Take a new snapshot; refs are document-scoped. |
| `[ELEMENT_AMBIGUOUS]` | The field has no reliable label. | Scope the snapshot, or ask the user which field is meant. |
| `[PAGE_UNSUPPORTED]` | The active tab is `chrome://`, a PDF, or another internal page. | Switch to a normal page. |
| Nothing happens on a fresh install | The bridge is disabled, so the agent's default backend is unreachable. | Enable `chromeBridge.enabled`, or tell the agent to use Playwright for this task. |
| Badge is blank | The service worker was suspended. | Open the popup; the next alarm or popup action reconnects. |

Diagnostics:

```bash
dsh-chrome-bridge status --json     # machine-readable state
curl -s http://127.0.0.1:3080/chrome-bridge/health | jq
```

The health endpoint reports service state, protocol version, TLS mode, and connected peers. It never
reports a token.
