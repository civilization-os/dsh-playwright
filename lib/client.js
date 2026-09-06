window.__ModuleLoader__.load({id:"deepseek-harness-playwright",factory:(require)=>{
var module={exports:{}};var exports=module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// src/client/controller.js
var BrowserController = class {
  state = { configured: { browser: "auto", headless: false, timeoutMs: 1e4, width: 1280, height: 800 }, browsers: [], selected: "", launch: "unchecked", activePages: 0, runbooks: [], loading: true, saving: false, error: "" };
  listeners = /* @__PURE__ */ new Set();
  lifetime = new AbortController();
  requestId = 0;
  constructor(call) {
    this.call = call;
  }
  getSnapshot = () => this.state;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  publish(patch) {
    if (this.lifetime.signal.aborted) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  async request(endpoint, args = {}) {
    if (endpoint === "status" && this.state.saving) return false;
    const requestId = ++this.requestId;
    const saving = endpoint !== "status";
    this.publish({ loading: !saving, saving, error: "" });
    try {
      const result = await this.call(endpoint, args, this.lifetime.signal);
      if (requestId !== this.requestId) return false;
      if (!result.ok) {
        this.publish({ loading: false, saving: false, error: "failed" });
        return false;
      }
      this.publish({ ...result.value, loading: false, saving: false });
      return true;
    } catch {
      if (requestId === this.requestId) this.publish({ loading: false, saving: false, error: "failed" });
      return false;
    }
  }
  dispose() {
    this.lifetime.abort();
    this.listeners.clear();
  }
};

// src/client/locales.js
var zh = {
  nav: "\u6D4F\u89C8\u5668\u81EA\u52A8\u5316",
  title: "Playwright \u6D4F\u89C8\u5668",
  intro: "\u4F7F\u7528\u672C\u673A Chrome \u6216 Edge\uFF0C\u8BA9 Agent \u5B89\u5168\u5730\u64CD\u4F5C\u7F51\u9875\u3002",
  browser: "\u9996\u9009\u6D4F\u89C8\u5668",
  auto: "\u81EA\u52A8\uFF08\u4F18\u5148 Chrome\uFF09",
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
  mode: "\u8FD0\u884C\u6A21\u5F0F",
  headed: "\u6709\u5934\u6A21\u5F0F",
  headless: "\u65E0\u5934\u6A21\u5F0F",
  timeout: "\u64CD\u4F5C\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09",
  viewport: "\u9875\u9762\u5C3A\u5BF8",
  save: "\u4FDD\u5B58\u8BBE\u7F6E",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  probe: "\u8FD0\u884C\u68C0\u67E5",
  probing: "\u68C0\u67E5\u4E2D\u2026",
  checks: "\u8FD0\u884C\u68C0\u67E5",
  found: "\u5DF2\u53D1\u73B0",
  missing: "\u672A\u53D1\u73B0",
  launch_unchecked: "\u5C1A\u672A\u542F\u52A8\u68C0\u67E5",
  launch_available: "\u542F\u52A8\u6B63\u5E38",
  launch_failed: "\u542F\u52A8\u5931\u8D25",
  launch_missing: "\u6CA1\u6709\u53EF\u7528\u6D4F\u89C8\u5668",
  selected: "\u5F53\u524D\u9009\u62E9",
  activePages: "\u6D3B\u52A8\u9875\u9762",
  tools: "\u6A21\u578B\u5DE5\u5177",
  toolsReady: "10 \u4E2A\u5DE5\u5177\u5DF2\u6CE8\u518C",
  profile: "\u6D4F\u89C8\u5668\u4F7F\u7528\u72EC\u7ACB\u6570\u636E\u76EE\u5F55\uFF0C\u4E0D\u4F1A\u8BFB\u53D6\u4F60\u7684\u65E5\u5E38 Chrome Profile\u3002",
  failed: "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u6D4F\u89C8\u5668\u5B89\u88C5\u548C\u670D\u52A1\u7AEF\u65E5\u5FD7\u3002",
  runbooks: "\u64CD\u4F5C\u624B\u518C",
  runbooksIntro: "\u7BA1\u7406\u7528\u6237\u660E\u786E\u8981\u6C42\u4FDD\u5B58\u7684\u7AD9\u70B9\u8BF4\u660E\u548C\u6D4F\u89C8\u5668\u6D41\u7A0B\u3002",
  runbooksEmpty: "\u8FD8\u6CA1\u6709\u64CD\u4F5C\u624B\u518C\u3002\u53EF\u4EE5\u8981\u6C42\u6A21\u578B\u4FDD\u5B58\u6587\u5B57\u6D41\u7A0B\u6216\u5DF2\u5B8C\u6210\u7684\u6D4F\u89C8\u5668\u8FC7\u7A0B\u3002",
  runbooksNote: "\u65B0\u624B\u518C\u9ED8\u8BA4\u4FDD\u5B58\u4E3A\u8349\u7A3F\uFF0C\u542F\u7528\u540E\u6A21\u578B\u624D\u80FD\u68C0\u7D22\u3002",
  version: "\u7248\u672C",
  steps: "\u6B65",
  enable: "\u542F\u7528",
  disable: "\u505C\u7528",
  delete: "\u5220\u9664"
};
var en = {
  nav: "Browser automation",
  title: "Playwright browser",
  intro: "Use local Chrome or Edge for safe Agent browser operation.",
  browser: "Preferred browser",
  auto: "Auto (prefer Chrome)",
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
  mode: "Run mode",
  headed: "Headed",
  headless: "Headless",
  timeout: "Action timeout (ms)",
  viewport: "Viewport",
  save: "Save settings",
  saving: "Saving\u2026",
  probe: "Run checks",
  probing: "Checking\u2026",
  checks: "Runtime checks",
  found: "Found",
  missing: "Not found",
  launch_unchecked: "Launch not checked",
  launch_available: "Launch succeeded",
  launch_failed: "Launch failed",
  launch_missing: "No browser available",
  selected: "Selected",
  activePages: "Active pages",
  tools: "Model tools",
  toolsReady: "10 tools registered",
  profile: "The browser uses an isolated data directory and does not read your everyday Chrome profile.",
  failed: "Operation failed. Check the browser installation and server logs.",
  runbooks: "Operation manuals",
  runbooksIntro: "Manage site guidance and browser procedures saved at the user\u2019s explicit request.",
  runbooksEmpty: "No operation manuals yet. Ask the model to save written guidance or a completed browser procedure.",
  runbooksNote: "New manuals are drafts. Enable one before the model can find it.",
  version: "Version",
  steps: "steps",
  enable: "Enable",
  disable: "Disable",
  delete: "Delete"
};

// src/client/styles.css
var styles_default = ".dsh-pw{max-width:840px;padding:4px 0 28px;color:var(--dsw-alias-label-primary);font:inherit}.dsh-pw header{display:flex;align-items:center;justify-content:space-between;gap:16px}.dsh-pw h2{margin:0 0 7px;font-size:22px;letter-spacing:-.4px}.dsh-pw h3{margin:0;font-size:15px}.dsh-pw p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.55}.dsh-pw button{padding:8px 13px;border:1px solid var(--dsw-alias-border-l4);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:13px;cursor:pointer}.dsh-pw button:disabled{opacity:.5;cursor:default}.dsh-pw-card{margin-top:18px;overflow:hidden;border:1px solid var(--dsw-alias-border-l4);border-radius:15px;background:var(--dsw-alias-bg-layer-2)}.dsh-pw-card>header{padding:16px 18px;border-bottom:1px solid var(--dsw-alias-border-l4)}.dsh-pw-form{display:grid;grid-template-columns:1fr 1fr;gap:15px;padding:18px}.dsh-pw label{display:flex;flex-direction:column;gap:7px;color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-pw select,.dsh-pw input{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}.dsh-pw-mode{display:flex;gap:7px}.dsh-pw-mode button{flex:1}.dsh-pw-mode button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}.dsh-pw-actions{display:flex;justify-content:flex-end;gap:8px;grid-column:1/-1}.dsh-pw-checks{display:grid;grid-template-columns:1fr 1fr;gap:0}.dsh-pw-check{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 18px;border-bottom:1px solid var(--dsw-alias-border-l4)}.dsh-pw-check:nth-child(odd){border-right:1px solid var(--dsw-alias-border-l4)}.dsh-pw-check strong{font-size:13px}.dsh-pw-check span{max-width:62%;overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:right}.dsh-pw-dot{display:inline-block;width:7px;height:7px;margin-right:8px;border-radius:50%;background:#858585}.dsh-pw-dot-ok{background:#38a169;box-shadow:0 0 0 3px color-mix(in srgb,#38a169 18%,transparent)}.dsh-pw-note{padding:14px 18px!important;border-top:0}.dsh-pw-error{margin-top:12px!important;color:#e98282!important}.dsh-pw-count{min-width:24px;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}.dsh-pw-empty{padding:22px 18px!important;text-align:center}.dsh-pw-runbook{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l4)}.dsh-pw-runbook strong{font-size:13px}.dsh-pw-runbook p{margin-top:4px;font-size:11px}.dsh-pw-runbook-instructions{display:-webkit-box;max-width:620px;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:var(--dsw-alias-label-secondary)!important}.dsh-pw-runbook-actions{display:flex;flex:0 0 auto;gap:7px}.dsh-pw-runbook-actions button:last-child{color:#e98282}@media(max-width:600px){.dsh-pw header{align-items:flex-start;flex-direction:column}.dsh-pw-form,.dsh-pw-checks{grid-template-columns:1fr}.dsh-pw-check:nth-child(odd){border-right:0}.dsh-pw-actions{flex-wrap:wrap}.dsh-pw-runbook{align-items:flex-start;flex-direction:column}}\n";

// src/client/index.jsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots", "locale", "connection"];
var namespace = "settings.playwright-browser";
function apply(ctx) {
  const controller = new BrowserController((endpoint, args, signal) => ctx.connection.rpc.call("/playwright-browser", endpoint, args, signal));
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }));
  ctx.effect(() => () => controller.dispose());
  ctx.effect(() => {
    const style = document.createElement("style");
    style.textContent = styles_default;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.on("connection/reset", () => {
    void controller.request("status");
  });
  const t = ctx.locale.bind(namespace);
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "playwright-browser",
    order: 18,
    label: () => t("nav"),
    locale: namespace,
    inject: () => ({ hooks: { browser: controller }, request: (endpoint, args) => controller.request(endpoint, args) })
  }, BrowserSettings));
}
function BrowserSettings({ t, useBrowser, request }) {
  const state = useBrowser((value) => value);
  const [draft, setDraft] = (0, import_react.useState)(state.configured);
  const dirty = (0, import_react.useRef)(false);
  const edit = (patch) => {
    dirty.current = true;
    setDraft((value) => ({ ...value, ...patch }));
  };
  const save = async () => {
    if (await request("save", draft)) dirty.current = false;
  };
  (0, import_react.useEffect)(() => {
    if (!dirty.current) setDraft(state.configured);
  }, [state.configured]);
  (0, import_react.useEffect)(() => {
    void request("status");
    const timer = setInterval(() => {
      void request("status");
    }, 3e3);
    return () => clearInterval(timer);
  }, [request]);
  const found = (id) => state.browsers.some((item) => item.id === id);
  const browserPath = (id) => state.browsers.find((item) => item.id === id)?.path;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-pw", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: t("title") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("intro") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: state.saving, onClick: () => request("probe"), children: t(state.saving ? "probing" : "probe") })
    ] }),
    state.error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-pw-error", role: "alert", children: t("failed") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-pw-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("header", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t("browser") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-pw-form", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
          t("browser"),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { value: draft.browser, onChange: (event) => edit({ browser: event.target.value }), children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "auto", children: t("auto") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "chrome", children: t("chrome") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "msedge", children: t("msedge") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
          t("mode"),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-pw-mode", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", "aria-pressed": !draft.headless, onClick: () => edit({ headless: false }), children: t("headed") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", "aria-pressed": draft.headless, onClick: () => edit({ headless: true }), children: t("headless") })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
          t("timeout"),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "number", min: "1000", max: "120000", value: draft.timeoutMs, onChange: (event) => edit({ timeoutMs: Number(event.target.value) }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
          t("viewport"),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-pw-mode", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { "aria-label": "width", type: "number", value: draft.width, onChange: (event) => edit({ width: Number(event.target.value) }) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { "aria-label": "height", type: "number", value: draft.height, onChange: (event) => edit({ height: Number(event.target.value) }) })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-pw-actions", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: state.saving, onClick: save, children: t(state.saving ? "saving" : "save") }) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-pw-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("header", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t("checks") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-pw-checks", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { label: t("chrome"), ok: found("chrome"), value: browserPath("chrome") || t("missing") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { label: t("msedge"), ok: found("msedge"), value: browserPath("msedge") || t("missing") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { label: t("selected"), ok: Boolean(state.selected), value: state.selected ? t(state.selected) : t("missing") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { label: t("checks"), ok: state.launch === "available", value: t(`launch_${state.launch}`) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { label: t("tools"), ok: true, value: t("toolsReady") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { label: t("activePages"), ok: true, value: String(state.activePages) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-pw-note", children: t("profile") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-pw-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t("runbooks") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("runbooksIntro") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-pw-count", children: state.runbooks.length })
      ] }),
      !state.runbooks.length && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-pw-empty", children: t("runbooksEmpty") }),
      state.runbooks.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { className: "dsh-pw-runbook", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: item.name }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
            item.origin,
            item.path,
            " \xB7 ",
            t("version"),
            " ",
            item.version,
            " \xB7 ",
            item.stepCount,
            " ",
            t("steps")
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: item.task }),
          item.instructionsPreview && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-pw-runbook-instructions", children: item.instructionsPreview })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-pw-runbook-actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => request("runbook-enable", { id: item.id, enabled: !item.enabled }), children: t(item.enabled ? "disable" : "enable") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => request("runbook-delete", { id: item.id }), children: t("delete") })
        ] })
      ] }, item.id)),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-pw-note", children: t("runbooksNote") })
    ] })
  ] });
}
function Check({ label, ok, value }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-pw-check", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("strong", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { className: `dsh-pw-dot${ok ? " dsh-pw-dot-ok" : ""}` }),
      label
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: value })
  ] });
}

return module.exports;}});
