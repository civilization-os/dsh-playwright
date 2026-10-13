# Chrome Bridge acceptance test

The automated suite cannot load an MV3 extension into Chrome, so this checklist covers the one
thing that must be confirmed by hand: a real Chrome, a real extension, and a real connection to the
server. Every other property is covered by `pnpm test`.

Run this once after enabling the bridge, and again after any change to the extension or the bridge
protocol.

## 0. Automated prerequisite

```bash
pnpm test                 # 166 pass; cases needing a real DOM use system Chrome/Edge or a cached Playwright Chromium
pnpm build                # client bundle
pnpm build:extension      # dist/extension + zip + sha256
```

Cases that need a real DOM use a system Chrome or Edge, or a Playwright-managed Chromium already present in the environment cache. They skip only when no browser exists at all.

## 1. Preconditions

- DSH is running with `chromeBridge.enabled: true`.
- `chromeBridge.publicUrl` is the externally reachable `wss://…` address.
- A TLS reverse proxy fronts DSH for the bridge path.
- A pairing token exists: `dsh-chrome-bridge token create "acceptance"`.

Record the values:

| Item | Value |
| --- | --- |
| Bridge URL | |
| Token id | |
| Chrome version | |

## 2. Server reachability

```bash
dsh-chrome-bridge status
curl -s "$(echo <bridge-url> | sed 's|^wss|https|;s|^ws|http|')/health"
```

- [ ] `status` reports `enabled` and `reachable: yes`.
- [ ] `/health` returns `{"ok":true,...}` with `protocol: 1` and no token anywhere in the response.
- [ ] `tls` matches whether the deployment uses `wss://`.

## 3. Install

- [ ] `pnpm build:extension` prints a `sha256` value and writes `dist/dsh-chrome-bridge-0.1.0.zip.sha256`.
- [ ] `chrome://extensions` → Developer mode → **Load unpacked** → `dist/extension` loads with no error.
- [ ] The extension detail page lists exactly these permissions: `activeTab`, `scripting`, `tabs`,
      `storage`, `alarms`. There is no "Read and change all your data on all websites".
- [ ] No content script is listed as running on all sites.

## 4. Connect

- [ ] Open the popup: status is *No bridge URL configured* or a clean disconnected state (no errors).
- [ ] Paste the Bridge URL, press **Grant access**, accept the prompt.
- [ ] The granted origin shown is the **https** form of the bridge host, not `wss://`.
- [ ] Paste the token, press **Connect**.
- [ ] Badge shows `ON`; status reads *Connected to the DSH bridge.*
- [ ] `dsh-chrome-bridge status` now lists one connected extension with the label you typed.

## 5. Core operations

Open a normal page with a form (a search box and a dropdown are enough) in the tab you are viewing,
then ask the agent, or call the tools without a `backend` argument: the user's Chrome is the default
backend, and each call verifies that the extension is connected before it does any page work.

### 5.1 Active tab identity

- [ ] `browser_tabs { action: "list" }` lists `tab-<id>` entries and marks the current tab `active: true`.
- [ ] The reported URL is origin + pathname only, with **no query string**.

### 5.2 Snapshot and semantics

- [ ] `browser_snapshot { pageId: "active" }` returns `elements` with `ref` values.
- [ ] Every element carries a `ref`, and the refs are unique.
- [ ] `mode: "form"` returns `fieldContext` for form controls.
- [ ] A field with a real `<label>`/`aria-label` reports it with `confidence: "high"`.
- [ ] A field whose only hint is a generic placeholder (`请选择`, `Select`, `Enter a value`) has
      **no** `inferredLabel` — the agent must not invent a name.
- [ ] A field in a table reports the table header as its label (`labelSource: "table-cell"`).

### 5.3 Click

- [ ] `browser_act { pageId: "active", ref: <button ref>, action: "click" }` performs the click in
      your visible tab.
- [ ] The page reacts as it would to a real click (navigation, menu, submit handler).

### 5.4 Type

- [ ] `action: "fill"` puts the text in the field **and** the page's own scripts observe it
      (a live search or validation message updates).
- [ ] The agent's result reports `valueState: "has-value"`, not the typed text.

### 5.5 Select

- [ ] `action: "select"` with an option's **visible text** selects it.
- [ ] `action: "select"` with an option's **value** selects it.
- [ ] An option that does not exist returns `INVALID_PARAMS` listing the available options.

## 6. Stale references

- [ ] Take a snapshot, note a ref, then click the element, then act on that same ref again → a clear
      error (the reference is no longer valid). It must **not** silently act on another element.
- [ ] Take a snapshot, then navigate the page, then act on the old ref → `ELEMENT_STALE` mentioning
      that the page navigated.
- [ ] Take a snapshot, replace or remove the element via the page, then act → `ELEMENT_STALE`
      mentioning that the element was removed or replaced.
- [ ] Rename a control's label via the page, then act → `ELEMENT_STALE` mentioning that the semantics
      changed.
- [ ] Hide the element via the page, then act → `ELEMENT_STALE` mentioning that it is hidden.

## 7. Security

- [ ] **Unauthenticated client is refused.** Without a session cookie:
      `curl -i -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" <bridge-http-url>`
      → `401`, and `dsh-chrome-bridge status` still shows no peer.
- [ ] **Bad token is refused.** `POST <bridge-url>/session` with a wrong token → `401`.
- [ ] **A page the extension was not granted access to** produces `PERMISSION_DENIED`, not a partial action.
- [ ] **Arbitrary execution is unreachable.** `curl -s <bridge-url>/health` lists methods; none match
      `eval`, `exec`, or `shell`.
- [ ] **Internal pages refused.** Switch the active tab to `chrome://settings` and snapshot →
      `PAGE_UNSUPPORTED`.
- [ ] The token does not appear in `dsh-chrome-bridge status`, `token list`, `/health`, or any log line.

## 8. Lifecycle

- [ ] **Disconnect.** Press **Disconnect**; badge clears. A `chrome-extension` tool call then returns
      `[BRIDGE_OFFLINE]` with a hint to reconnect the popup. It must fail immediately, not hang.
- [ ] **Chrome closed.** Close Chrome mid-session; a tool call returns `[BRIDGE_OFFLINE]` promptly.
- [ ] **Timeout.** Point the bridge at a page that never satisfies the wait condition:
      `browser_wait { text: "never-appears", timeoutMs: 2000 }` →
      a timeout error within roughly that budget, and the extension's status keeps working afterwards.
- [ ] **Silent socket.** Stop Chrome's service worker while the socket stays open → the next tool call
      fails fast with `[BRIDGE_TIMEOUT]` on the health probe instead of hanging for the request timeout.
- [ ] **Reconnect.** Reopen the popup, press **Connect** (re-paste the token if Chrome was restarted);
      the agent works again without restarting DSH.
- [ ] **Duplicate session.** Open the same token in a second Chrome profile → the first connection
      closes with `BRIDGE_REPLACED`, and exactly one peer remains in `status`.
- [ ] **Tab closed.** Close the operated tab; a request for it returns `TAB_NOT_FOUND`.

## 9. Backend policy and Playwright non-regression

- [ ] A tool call with no `backend` argument goes to the user's Chrome. It never launches a second
      browser window, even when the extension is disconnected.
- [ ] `browser_tabs { action: "list", backend: "playwright" }` is refused with a message naming
      `userRequestedPlaywright` while the configured default stays `chrome-extension`.
- [ ] `browser_network { pageId: "active", action: "list" }` is refused the same way: a Playwright-only
      capability must ask the user first.
- [ ] Only after the user explicitly asks for Playwright does
      `browser_open { "url": "...", "backend": "playwright", "userRequestedPlaywright": true }` launch
      the isolated browser and drive it exactly as before.
- [ ] The settings page still probes and reports the managed browser.
- [ ] The **Chrome Bridge** card shows the endpoint switch, the listener state, the connected extension,
      the probe latency, and the masked token count.
- [ ] Toggling **Enable the bridge endpoint** and saving persists `chromeBridge.enabled` (check
      `settings.json`) and the card warns that a restart is required.
- [ ] After the restart the card reads *Listening*, names the extension label, and reports a probe
      latency in milliseconds.
- [ ] Saving with **Default backend** switched persists `backend` and does not clear the bridge block,
      the TLS file paths, or the origin allowlist in `settings.json`.
- [ ] `node --test tests/*.test.js` passes; DOM-dependent cases run against system Chrome/Edge or a cached Chromium rather than skipping.

## 10. Rollback

- [ ] Set `"backend": "playwright"` → every tool call uses the isolated browser again and the extension
      is never consulted.
- [ ] Set `"chromeBridge": { "enabled": false }` (or delete the `backend` key) and restart →
      extension-backed calls report that the bridge is disabled, `dsh-chrome-bridge status` reports
      `disabled`, and no route answers `<bridge-url>/health`.
- [ ] `dsh-chrome-bridge token revoke <id>` → the revoked extension can no longer connect.
- [ ] Remove the extension at `chrome://extensions`.

## Sign-off

| Check | Result | Notes |
| --- | --- | --- |
| 2. Reachability | | |
| 4. Connect | | |
| 5.1 Tab identity | | |
| 5.2 Semantics | | |
| 5.3 Click | | |
| 5.4 Type | | |
| 5.5 Select | | |
| 6. Stale refs | | |
| 7. Security | | |
| 8. Lifecycle | | |
| 9. Backend policy | | |
| 10. Rollback | | |
