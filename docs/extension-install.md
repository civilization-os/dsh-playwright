# Installing the DSH Chrome Bridge extension

This guide is for the person whose browser will be driven. No developer tools are needed.

The extension lets a DeepSeek Harness agent operate **the tab you are looking at** in your own
Chrome. It cannot read your other tabs on its own, and it cannot run arbitrary code.

You need two things from the DSH operator:

- a **bridge URL**, for example `wss://dsh.example.com/chrome-bridge`;
- a **pairing token**, a long random-looking string.

## 1. Get the extension folder

Either:

- receive the `dsh-chrome-bridge-<version>.zip` file and unzip it, or
- build it yourself with `pnpm build:extension` and use `dist/extension/`.

**The ZIP is not a Chrome Web Store package.** Dragging the ZIP into Chrome does not work; Chrome
will report an invalid package. Always unzip first.

## 2. Load it into Chrome

1. Open a new tab and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the **unzipped folder** — the one containing `manifest.json`.

If Chrome shows an error like *Manifest file is missing or unreadable*, you selected the ZIP or its
parent folder instead of the folder containing `manifest.json`.

## 3. Pin it

Click the puzzle-piece icon in the toolbar and pin **DSH Chrome Bridge**, so you can see the status
badge:

| Badge | Meaning |
| --- | --- |
| *(blank)* | Not connected. |
| `…` | Connecting. |
| `ON` | Connected and ready. |

## 4. Connect

1. Click the extension icon.
2. Paste the **Bridge URL**.
3. Paste the **Pairing token**.
4. Optionally give this browser a name, such as *Work laptop*. This name is what the agent sees, and
   what the server operator uses to tell browsers apart.
5. Click **Grant access** and accept the Chrome prompt. This grants access only to the bridge's own
   address — not to any website.
6. Click **Connect**.

When the status reads *Connected to the DSH bridge*, the agent can operate your current tab.

## 5. What the agent can and cannot do

While connected, the agent can:

- read the URL and title of the tab you are viewing;
- read a summary of that page's interactive elements and form fields;
- click, type into, and select options on that page.

It cannot:

- run arbitrary JavaScript;
- read files or your Chrome settings;
- act on a tab you have not opened, beyond listing operable tabs in the current window;
- read pages it has not been granted access to — those produce a clear *permission denied* error.

The agent only ever targets **the tab you are looking at**. If you switch tabs, the next request
follows your attention unless the agent names a specific tab.

## 6. Disconnecting

Click **Disconnect** in the popup. The badge clears and the agent can no longer reach your browser.
To stop entirely, remove access at `chrome://extensions` (or remove the extension).

The pairing token is kept in Chrome's session storage, which is **memory only**. Closing Chrome
forgets it; reconnecting afterwards needs the token again. That is deliberate.

## 7. If something goes wrong

| What you see | What to do |
| --- | --- |
| *Access to … has not been granted* | Click **Grant access** and accept the prompt. |
| *Refusing a non-TLS bridge address* | The URL must start with `wss://` unless it is `127.0.0.1`. Ask the operator for the correct URL. |
| *The pairing token was rejected* | The token was revoked, expired, or mistyped. Ask for a new one. |
| *The bridge connection dropped* | Check your network. The extension retries automatically with increasing delays. |
| *Disconnected: BRIDGE_REPLACED* | The same connection was re-established elsewhere. Normal after restoring a session; the newest connection wins. |
| Badge stays blank | Open the popup once to wake the extension, or click **Connect**. |
| A page says the element is missing | The page changed since the agent looked at it. It will take a fresh look. |
| Nothing works on a page | Some pages (Chrome settings, the Chrome Web Store, PDF viewers) cannot be operated. Switch to a normal web page. |

## 8. Privacy notes

- Only the bridge address you grant is reachable; the extension requests no access to other sites.
- The agent sees page structure and the labels it can prove, not the contents of form fields. It
  reports that a field *has a value*, not what the value is.
- URLs reported to the agent are reduced to origin and path — query strings are dropped, so tokens
  in URLs are not collected.
- Nothing is uploaded anywhere except to the bridge address you configured.
