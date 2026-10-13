# Chrome Bridge security model

## Threat model

The bridge lets a server-side agent act inside a browser on someone else's machine. The assets that
matter are:

1. the user's authenticated sessions in their own Chrome;
2. the page content of whatever tab is operated;
3. the ability to act as the agent (making the user's browser do things);
4. the pairing credential itself.

The bridge assumes the remote server may be compromised or co-tenanted, the network is hostile, and
page content is attacker-controlled.

## 1. Identity

**The extension authenticates to the server, not the other way round.** Nothing is exposed on the
user's machine, so there is no inbound attack surface there.

Two-stage exchange:

1. `POST <path>/session` with the pairing token in a JSON body. The server answers with a
   short-lived `HttpOnly; SameSite=Strict; Path=<bridge path>` session cookie (`Secure` when TLS is
   on). The cookie holds a random 256-bit identifier; only its SHA-256 is stored server-side.
2. The WebSocket upgrade presents that cookie, and the socket then proves the token again in its
   `hello` frame against a per-connection nonce issued in `challenge`.

Why both stages:

- the **token never appears in a URL**, so it cannot leak through access logs, `Referer` headers,
  browser history, or proxy logs;
- a captured socket is useless without answering the nonce;
- a captured session cookie is scoped to one path and expires in 12 hours;
- a socket that does not authenticate within 10 seconds is closed.

Token handling:

| Property | Value |
| --- | --- |
| Entropy | 32 random bytes, base64url |
| Server storage | `chrome-bridge-tokens.json`, mode `0600` on POSIX; on Windows the user-profile ACL applies |
| Client storage | `chrome.storage.session` (memory only) |
| Comparison | constant-time |
| Listing | masked value + SHA-256 prefix only |
| Logging | never logged; `tokenId` at most |
| Revocation | per token, and it invalidates issued sessions |

Tokens are short-lived by request (`ttlHours` on `browser_pairing_token`), and expired tokens are not
accepted even if they are still on disk.

## 2. Transport

- Public deployments use `wss://` (TLS), normally terminated by a reverse proxy in front of DSH. See
  [chrome-bridge.md](./chrome-bridge.md).
- The extension **refuses** a plain `ws://` address that is not loopback, so a misconfiguration
  cannot silently downgrade a remote connection to cleartext.
- The server never accepts model-authored JavaScript or shell commands. Only the hub's method
  allowlist is reachable, and every method addresses a snapshot reference inside one named tab.
- `Origin` is checked only when `chromeBridge.allowedOrigins` is configured. It is a
  defence-in-depth signal for browser-originated traffic, **never** the authentication mechanism.
  Authentication is always the token plus the session cookie.

## 3. Browser permissions

The extension requests the minimum that works:

- `activeTab` — granted when the user opens the popup, covering exactly the tab in view;
- `scripting` — to inject the page agent into that tab;
- optional host access — only for the bridge origin the user grants.

There is **no** declared content script and **no** `<all_urls>` host permission. Consequences:

- the extension cannot read or change a page the user has not granted it access to;
- an attempt on such a page fails with `PERMISSION_DENIED` rather than partially succeeding;
- there is no background coverage of the user's browsing.

## 4. Blast radius of one request

A single bridge request can do exactly one of:

- read one tab's URL and title;
- list operable tabs in the focused window;
- navigate one tab;
- read a bounded semantic projection of one tab;
- perform one click, text entry, select, or key press on one snapshot reference;
- wait for text or a URL pattern in one tab.

It cannot: evaluate a JavaScript string, read `localStorage` or cookies wholesale, read files, open
a shell, enumerate history, act on a tab it did not name, or persist anything beyond the tab it
touched.

## 5. Page content is untrusted

- The page agent returns **data**; it never decides what to do.
- Semantic labels are evidence, not instructions. `inferredLabel` carries its source and confidence,
  and an unresolved field stays unresolved rather than being guessed.
- Actions are bounded by the reference: a `ref` addresses one live DOM node with a verified
  fingerprint. A page cannot make a ref point somewhere else without invalidating it.
- Sensitive values are not collected: the snapshot reports `valueState` (`has-value`) rather than
  field contents, and URL query strings are not returned.

## 6. Session lifecycle

| Event | Behaviour |
| --- | --- |
| User presses **Disconnect** | Socket closes cleanly; auto-reconnect is disabled. |
| Chrome closes | Socket drops. Any in-flight server request fails immediately with `BRIDGE_OFFLINE`, never a silent hang. |
| Service worker suspended | Reconnects on the next alarm or popup action, reusing the session cookie. |
| Same session reconnects | The older socket closes with `BRIDGE_REPLACED`, so a restored or duplicated tab cannot keep serving requests. |
| Token revoked | Existing sessions from that token are dropped and new upgrades are refused with `401`. |
| Tab navigates | The socket survives; every ref from the previous document fails with `ELEMENT_STALE`. |
| Tab closed | Requests for it fail with `TAB_NOT_FOUND`. |

**A dropped connection is never treated as "the browser is still there".** Every pending request is
rejected, and every later request fails until the extension reconnects.

## 7. Operational guidance

- Run `webServer` mode behind a TLS proxy; do not publish DSH's port directly.
- Set `publicUrl` explicitly so the extension is told the real external address.
- Configure `allowedOrigins` when the deployment knows its own origin.
- Give each browser its own token. The label recorded at creation is shown in
  `browser_bridge_status`, so a token can be traced to a device and revoked individually.
- Revoke a token immediately if a laptop is lost or an agent session is being torn down.
- Treat `browser_act` on submit, send, delete, purchase, or permission-changing controls as
  consequential: state the exact action and destination so the approval policy can apply.
- The health endpoint is unauthenticated but reports only protocol version, TLS mode, and peer
  metadata. It contains no credential and no page content.

## 8. Known limitations

- One pairing token identifies one browser session, not one person. Anyone who can read the token can
  connect a browser and be driven by the agent.
- The bridge does not sandbox the page. A page can still do whatever it could do for the user; the
  bridge only constrains what the *agent* can ask for.
- Extension-level compromise is out of scope: code running inside the extension can use all of its
  permissions.
- There is no per-action audit log beyond the bridge logger and the plugin's browser trajectory.
