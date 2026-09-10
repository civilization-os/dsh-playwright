window.__ModuleLoader__.load({id:"@civilization/deepseek-harness-playwright",factory:(require)=>{
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
  state = { configured: { browser: "auto", headless: false, timeoutMs: 1e4, width: 1280, height: 800 }, browsers: [], selected: "", launch: "unchecked", activePages: 0, runbooks: [], selectedRunbook: void 0, runbookVersions: [], loading: true, saving: false, error: "" };
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
  toolsReady: "13 \u4E2A\u5DE5\u5177\u5DF2\u6CE8\u518C",
  profile: "\u6D4F\u89C8\u5668\u4F7F\u7528\u72EC\u7ACB\u6570\u636E\u76EE\u5F55\uFF0C\u4E0D\u4F1A\u8BFB\u53D6\u4F60\u7684\u65E5\u5E38 Chrome Profile\u3002",
  failed: "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u6D4F\u89C8\u5668\u5B89\u88C5\u548C\u670D\u52A1\u7AEF\u65E5\u5FD7\u3002",
  runbooks: "\u64CD\u4F5C\u624B\u518C",
  runbooksIntro: "\u5BA1\u9605\u3001\u4FEE\u8BA2\u548C\u542F\u7528 Agent \u53EF\u590D\u7528\u7684\u7AD9\u70B9\u6D41\u7A0B\u3002",
  runbooksEmpty: "\u8FD8\u6CA1\u6709\u64CD\u4F5C\u624B\u518C\u3002\u5B8C\u6210\u4E00\u6B21\u6D41\u7A0B\u540E\uFF0C\u53EF\u4EE5\u8981\u6C42 Agent \u4FDD\u5B58\u4E3A\u624B\u518C\u3002",
  runbooksNoMatch: "\u6CA1\u6709\u7B26\u5408\u5F53\u524D\u7B5B\u9009\u6761\u4EF6\u7684\u624B\u518C\u3002",
  runbooksNote: "\u5217\u8868\u6309\u6D41\u7A0B\u5F52\u5E76\u7248\u672C\uFF1B\u542F\u7528\u67D0\u4E2A\u7248\u672C\u540E\uFF0CAgent \u624D\u80FD\u5728\u5339\u914D\u4EFB\u52A1\u4E2D\u4F7F\u7528\u3002",
  version: "\u7248\u672C",
  versions: "\u7248\u672C\u5386\u53F2",
  steps: "\u6B65\u9AA4",
  enable: "\u542F\u7528",
  enableVersion: "\u542F\u7528\u6B64\u7248\u672C",
  disable: "\u505C\u7528",
  delete: "\u5220\u9664",
  active: "\u5DF2\u542F\u7528",
  draft: "\u8349\u7A3F",
  searchRunbooks: "\u641C\u7D22\u540D\u79F0\u3001\u4EFB\u52A1\u6216\u7AD9\u70B9\u2026",
  filterRunbooks: "\u7B5B\u9009\u64CD\u4F5C\u624B\u518C",
  filter_all: "\u5168\u90E8",
  filter_active: "\u5DF2\u542F\u7528",
  filter_draft: "\u5F85\u5BA1\u9605",
  close: "\u5173\u95ED",
  edit: "\u7F16\u8F91",
  cancel: "\u53D6\u6D88",
  runbookName: "\u624B\u518C\u540D\u79F0",
  runbookTask: "\u9002\u7528\u4EFB\u52A1",
  inputs: "\u8F93\u5165\u53C2\u6570",
  preconditions: "\u524D\u7F6E\u6761\u4EF6",
  instructions: "\u6267\u884C\u8BF4\u660E",
  successCriteria: "\u6210\u529F\u6807\u51C6",
  onePerLine: "\u6BCF\u884C\u4E00\u9879",
  noRecordedSteps: "\u6B64\u7248\u672C\u53EA\u6709\u6587\u5B57\u8BF4\u660E\uFF0C\u6CA1\u6709\u5DF2\u8BB0\u5F55\u6B65\u9AA4\u3002",
  action: "\u64CD\u4F5C",
  open: "\u6253\u5F00\u9875\u9762",
  wait: "\u7B49\u5F85\u9A8C\u8BC1",
  saveRevision: "\u4FDD\u5B58\u4E3A\u65B0\u7248\u672C",
  deleteRunbook: "\u5220\u9664\u8FD9\u4E2A\u624B\u518C\u7248\u672C\uFF1F",
  deleteRunbookHint: "\u4EC5\u5220\u9664\u5F53\u524D\u7248\u672C\uFF1B\u540C\u4E00\u6D41\u7A0B\u7684\u5176\u4ED6\u7248\u672C\u4F1A\u4FDD\u7559\u3002\u6B64\u64CD\u4F5C\u65E0\u6CD5\u64A4\u9500\u3002",
  confirmDelete: "\u786E\u8BA4\u5220\u9664"
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
  toolsReady: "13 tools registered",
  profile: "The browser uses an isolated data directory and does not read your everyday Chrome profile.",
  failed: "Operation failed. Check the browser installation and server logs.",
  runbooks: "Operation manuals",
  runbooksIntro: "Review, revise, and enable reusable site workflows for the Agent.",
  runbooksEmpty: "No operation manuals yet. After completing a workflow, ask the Agent to save it.",
  runbooksNoMatch: "No manuals match the current filters.",
  runbooksNote: "Versions are grouped by workflow. Enable a version before the Agent can match it to a task.",
  version: "Version",
  versions: "Version history",
  steps: "steps",
  enable: "Enable",
  enableVersion: "Enable this version",
  disable: "Disable",
  delete: "Delete",
  active: "Enabled",
  draft: "Draft",
  searchRunbooks: "Search name, task, or site\u2026",
  filterRunbooks: "Filter operation manuals",
  filter_all: "All",
  filter_active: "Enabled",
  filter_draft: "Review",
  close: "Close",
  edit: "Edit",
  cancel: "Cancel",
  runbookName: "Manual name",
  runbookTask: "Matching task",
  inputs: "Inputs",
  preconditions: "Preconditions",
  instructions: "Instructions",
  successCriteria: "Success criteria",
  onePerLine: "One item per line",
  noRecordedSteps: "This version contains written guidance only.",
  action: "Action",
  open: "Open page",
  wait: "Wait for evidence",
  saveRevision: "Save new version",
  deleteRunbook: "Delete this manual version?",
  deleteRunbookHint: "Only this version is deleted; other versions in the workflow remain. This cannot be undone.",
  confirmDelete: "Delete version"
};

// src/client/styles.css
var styles_default = ".dsh-pw{max-width:980px;padding:4px 0 28px;color:var(--dsw-alias-label-primary);font:inherit}.dsh-pw>header,.dsh-pw header{display:flex;align-items:center;justify-content:space-between;gap:16px}.dsh-pw h2{margin:0 0 7px;font-size:22px;letter-spacing:-.4px}.dsh-pw h3,.dsh-pw h4{margin:0}.dsh-pw h3{font-size:15px}.dsh-pw h4{font-size:12px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}.dsh-pw p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.55}.dsh-pw button{padding:8px 13px;border:1px solid var(--dsw-alias-border-l4);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:13px;cursor:pointer}.dsh-pw button:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l4))}.dsh-pw button:disabled{opacity:.5;cursor:default}.dsh-pw button.is-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}.dsh-pw button.is-danger{color:#e98282}.dsh-pw-card{margin-top:18px;overflow:hidden;border:1px solid var(--dsw-alias-border-l4);border-radius:15px;background:var(--dsw-alias-bg-layer-2)}.dsh-pw-card>header{padding:16px 18px;border-bottom:1px solid var(--dsw-alias-border-l4)}.dsh-pw-form{display:grid;grid-template-columns:1fr 1fr;gap:15px;padding:18px}.dsh-pw label{display:flex;flex-direction:column;gap:7px;color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-pw select,.dsh-pw input,.dsh-pw textarea{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid var(--dsw-alias-border-l4);border-radius:8px;outline:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}.dsh-pw textarea{line-height:1.55;resize:vertical}.dsh-pw select:focus,.dsh-pw input:focus,.dsh-pw textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent)}.dsh-pw-mode{display:flex;gap:7px}.dsh-pw-mode button{flex:1}.dsh-pw-mode button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}.dsh-pw-actions{display:flex;justify-content:flex-end;gap:8px;grid-column:1/-1}.dsh-pw-checks{display:grid;grid-template-columns:1fr 1fr}.dsh-pw-check{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 18px;border-bottom:1px solid var(--dsw-alias-border-l4)}.dsh-pw-check:nth-child(odd){border-right:1px solid var(--dsw-alias-border-l4)}.dsh-pw-check strong{font-size:13px}.dsh-pw-check span{max-width:62%;overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:right}.dsh-pw-dot{display:inline-block;width:7px;height:7px;margin-right:8px;border-radius:50%;background:#858585}.dsh-pw-dot-ok{background:#38a169;box-shadow:0 0 0 3px color-mix(in srgb,#38a169 18%,transparent)}.dsh-pw-note{padding:14px 18px!important}.dsh-pw-error{margin-top:12px!important;color:#e98282!important}.dsh-pw-count{min-width:24px;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}.dsh-pw-empty{padding:34px 18px!important;text-align:center}.dsh-pw-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}\n\n.dsh-pw-library{overflow:visible}.dsh-pw-library>header{border-radius:15px 15px 0 0;background:var(--dsw-alias-bg-layer-2)}.dsh-pw-library-tools{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l4);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}.dsh-pw-search{flex:1}.dsh-pw-search input{min-width:180px}.dsh-pw-filter{display:flex;padding:3px;border:1px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.dsh-pw-filter button{padding:6px 11px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary)}.dsh-pw-filter button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 1px 4px color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent)}.dsh-pw-runbook-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:14px;background:var(--dsw-alias-bg-layer-1)}.dsh-pw-runbook{content-visibility:auto;display:flex;min-height:190px;flex-direction:column;gap:9px;padding:15px;border:1px solid var(--dsw-alias-border-l4);border-radius:13px;background:var(--dsw-alias-bg-layer-2);transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}.dsh-pw-runbook:hover,.dsh-pw-runbook:focus-within{transform:translateY(-1px);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,var(--dsw-alias-border-l4));box-shadow:0 8px 22px color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);outline:0}.dsh-pw-runbook-top,.dsh-pw-runbook-meta,.dsh-pw-section-title{display:flex;align-items:center;justify-content:space-between;gap:10px}.dsh-pw-runbook-top>span:last-child{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.dsh-pw-badge{display:inline-flex;width:max-content;padding:3px 7px;border:1px solid var(--dsw-alias-border-l4);border-radius:999px;color:var(--dsw-alias-label-tertiary);font-size:10px}.dsh-pw-badge.is-active{border-color:color-mix(in srgb,#38a169 38%,var(--dsw-alias-border-l4));background:color-mix(in srgb,#38a169 10%,transparent);color:#38a169}.dsh-pw-runbook-title{width:max-content;max-width:100%;padding:0!important;border:0!important;background:transparent!important;color:var(--dsw-alias-label-primary)!important;font-size:15px!important;font-weight:650;text-align:left}.dsh-pw-runbook-title:hover{text-decoration:underline;text-underline-offset:3px}.dsh-pw-runbook-task{color:var(--dsw-alias-label-secondary)!important}.dsh-pw-runbook-instructions{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2}.dsh-pw-runbook-meta{margin-top:auto;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);font-size:10px}.dsh-pw-runbook-actions{display:flex;justify-content:flex-end;gap:7px}.dsh-pw-runbook-actions button{padding:6px 9px;font-size:11px}.dsh-pw-runbook-actions button:last-child{color:#e98282}\n\n.dsh-pw-overlay{position:fixed;z-index:1200;inset:0;display:grid;place-items:center;padding:28px;background:color-mix(in srgb,#07101f 42%,transparent);backdrop-filter:blur(6px)}.dsh-pw-overlay.is-confirm{z-index:1210}.dsh-pw-dialog{display:flex;width:min(780px,calc(100vw - 40px));max-height:min(820px,calc(100vh - 56px));overflow:hidden;flex-direction:column;border:1px solid var(--dsw-alias-border-l4);border-radius:18px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 24px 80px rgba(0,0,0,.25)}.dsh-pw-dialog>header{padding:18px 20px;border-bottom:1px solid var(--dsw-alias-border-l4)}.dsh-pw-dialog>header>div{display:grid;gap:6px}.dsh-pw-dialog>header h3{font-size:19px}.dsh-pw-icon-button{width:36px;height:36px;padding:0!important;border:0!important;background:transparent!important;font-size:25px!important}.dsh-pw-runbook-body{display:grid;gap:20px;padding:20px;overflow:auto}.dsh-pw-runbook-body>section{display:grid;gap:8px}.dsh-pw-runbook-body ul{margin:0;padding-left:20px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.65}.dsh-pw-preserve{color:var(--dsw-alias-label-secondary)!important;white-space:pre-wrap}.dsh-pw-chips{display:flex;flex-wrap:wrap;gap:7px}.dsh-pw-chips span{padding:5px 8px;border:1px solid var(--dsw-alias-border-l4);border-radius:7px;background:var(--dsw-alias-bg-layer-1);font-size:11px}.dsh-pw-section-title>span{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-pw-steps{display:grid;gap:0;margin:0;padding:0;list-style:none;border:1px solid var(--dsw-alias-border-l4);border-radius:11px;overflow:hidden}.dsh-pw-steps li{display:grid;grid-template-columns:34px 1fr auto;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l4)}.dsh-pw-steps li:last-child{border-bottom:0}.dsh-pw-steps li>span{color:var(--dsw-alias-label-tertiary);font-size:10px;font-variant-numeric:tabular-nums}.dsh-pw-steps strong{font-size:12px;font-weight:550}.dsh-pw-steps em{color:var(--dsw-alias-label-tertiary);font-size:10px;font-style:normal}.dsh-pw-versions{display:flex;gap:7px;overflow-x:auto}.dsh-pw-versions button{display:grid;min-width:76px;gap:3px;padding:8px}.dsh-pw-versions button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}.dsh-pw-versions small{color:var(--dsw-alias-label-tertiary);font-size:9px}.dsh-pw-runbook-edit{display:grid;grid-template-columns:1fr 1fr;gap:15px;padding:20px;overflow:auto}.dsh-pw-runbook-edit .is-wide{grid-column:1/-1}.dsh-pw-dialog>footer{display:flex;align-items:center;gap:8px;padding:14px 20px;border-top:1px solid var(--dsw-alias-border-l4);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 52%,transparent)}.dsh-pw-dialog>footer>span{flex:1}.dsh-pw-confirm{width:min(430px,calc(100vw - 40px))}.dsh-pw-confirm>p{padding:20px}.dsh-pw-confirm>footer{justify-content:flex-end}\n\n@media(max-width:720px){.dsh-pw>header,.dsh-pw header{align-items:flex-start}.dsh-pw-form,.dsh-pw-checks,.dsh-pw-runbook-grid,.dsh-pw-runbook-edit{grid-template-columns:1fr}.dsh-pw-check:nth-child(odd){border-right:0}.dsh-pw-actions{flex-wrap:wrap}.dsh-pw-library-tools{align-items:stretch;flex-direction:column}.dsh-pw-filter button{flex:1}.dsh-pw-runbook-edit .is-wide{grid-column:auto}.dsh-pw-overlay{padding:10px}.dsh-pw-dialog{width:calc(100vw - 20px);max-height:calc(100vh - 20px)}}\n";

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
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RunbookWorkbench, { state, request, t })
  ] });
}
function RunbookWorkbench({ state, request, t }) {
  const [query, setQuery] = (0, import_react.useState)("");
  const deferredQuery = (0, import_react.useDeferredValue)(query);
  const [filter, setFilter] = (0, import_react.useState)("all");
  const [openId, setOpenId] = (0, import_react.useState)("");
  const [editing, setEditing] = (0, import_react.useState)(false);
  const [deleteId, setDeleteId] = (0, import_react.useState)("");
  const needle = deferredQuery.trim().toLocaleLowerCase();
  const visible = state.runbooks.filter((item) => (filter === "all" || filter === "active" && item.activeId || filter === "draft" && item.activeId !== item.id) && (!needle || `${item.name} ${item.task} ${item.origin}${item.path}`.toLocaleLowerCase().includes(needle)));
  const open = async (id) => {
    setOpenId(id);
    setEditing(false);
    if (!await request("runbook-detail", { id })) setOpenId("");
  };
  const close = () => {
    setOpenId("");
    setEditing(false);
  };
  const toggle = (event, item) => {
    event?.stopPropagation();
    const activeLatest = item.activeId === item.id;
    void request("runbook-enable", { id: activeLatest ? item.activeId : item.id, enabled: !activeLatest });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-pw-card dsh-pw-library", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t("runbooks") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("runbooksIntro") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-pw-count", children: state.runbooks.length })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-pw-library-tools", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-pw-search", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-pw-sr", children: t("searchRunbooks") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: t("searchRunbooks") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-pw-filter", "aria-label": t("filterRunbooks"), children: ["all", "active", "draft"].map((value) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", "aria-pressed": filter === value, onClick: () => setFilter(value), children: t(`filter_${value}`) }, value)) })
    ] }),
    !state.runbooks.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-pw-empty", children: t("runbooksEmpty") }) : !visible.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-pw-empty", children: t("runbooksNoMatch") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-pw-runbook-grid", children: visible.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { className: "dsh-pw-runbook", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-pw-runbook-top", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `dsh-pw-badge ${item.activeId ? "is-active" : ""}`, children: item.activeId === item.id ? t("active") : item.activeId ? `${t("active")} v${item.activeVersion}` : t("draft") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
          item.origin,
          item.path
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-pw-runbook-title", onClick: () => open(item.id), children: item.name }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-pw-runbook-task", children: item.task }),
      item.instructionsPreview ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-pw-runbook-instructions", children: item.instructionsPreview }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-pw-runbook-meta", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
          t("version"),
          " ",
          item.version,
          item.versionCount > 1 ? ` / ${item.versionCount}` : ""
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
          item.stepCount,
          " ",
          t("steps")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
          item.successCount,
          "\u2713 \xB7 ",
          item.failureCount,
          "\xD7"
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-pw-runbook-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: (event) => toggle(event, item), children: t(item.activeId === item.id ? "disable" : "enableVersion") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: (event) => {
          event.stopPropagation();
          setDeleteId(item.id);
        }, children: t("delete") })
      ] })
    ] }, item.id)) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-pw-note", children: t("runbooksNote") }),
    openId && state.selectedRunbook?.id === openId ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RunbookDetail, { item: state.selectedRunbook, versions: state.runbookVersions ?? [], busy: state.saving, editing, setEditing, request, onOpen: open, onClose: close, onDelete: setDeleteId, t }) : null,
    deleteId ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ConfirmDialog, { title: t("deleteRunbook"), body: t("deleteRunbookHint"), busy: state.saving, onCancel: () => setDeleteId(""), onConfirm: async () => {
      if (await request("runbook-delete", { id: deleteId })) {
        if (openId === deleteId) close();
        setDeleteId("");
      }
    }, t }) : null
  ] });
}
function RunbookDetail({ item, versions, busy, editing, setEditing, request, onOpen, onClose, onDelete, t }) {
  const [draft, setDraft] = (0, import_react.useState)(() => editableRunbook(item));
  (0, import_react.useEffect)(() => setDraft(editableRunbook(item)), [item.id]);
  useDialogDismiss(onClose);
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const save = async () => {
    const ok = await request("runbook-revise", {
      id: item.id,
      name: draft.name,
      task: draft.task,
      instructions: draft.instructions,
      inputs: lines(draft.inputs),
      preconditions: lines(draft.preconditions),
      successCriteria: draft.successCriteria
    });
    if (ok) onClose();
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-pw-overlay", role: "presentation", onMouseDown: (event) => {
    if (event.target === event.currentTarget) onClose();
  }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-pw-dialog dsh-pw-runbook-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "dsh-pw-runbook-title", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `dsh-pw-badge ${item.enabled ? "is-active" : ""}`, children: t(item.enabled ? "active" : "draft") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { id: "dsh-pw-runbook-title", children: item.name }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
          item.origin,
          item.path,
          " \xB7 ",
          t("version"),
          " ",
          item.version
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dsh-pw-icon-button", type: "button", onClick: onClose, "aria-label": t("close"), children: "\xD7" })
    ] }),
    editing ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-pw-runbook-edit", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        t("runbookName"),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { value: draft.name, onChange: (event) => set("name", event.target.value) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        t("runbookTask"),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { value: draft.task, onChange: (event) => set("task", event.target.value) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        t("inputs"),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { rows: "3", value: draft.inputs, onChange: (event) => set("inputs", event.target.value), placeholder: t("onePerLine") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
        t("preconditions"),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { rows: "3", value: draft.preconditions, onChange: (event) => set("preconditions", event.target.value), placeholder: t("onePerLine") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "is-wide", children: [
        t("instructions"),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { rows: "7", value: draft.instructions, onChange: (event) => set("instructions", event.target.value) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "is-wide", children: [
        t("successCriteria"),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { rows: "3", value: draft.successCriteria, onChange: (event) => set("successCriteria", event.target.value) })
      ] })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-pw-runbook-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { children: t("runbookTask") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: item.task })
      ] }),
      item.inputs.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { children: t("inputs") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-pw-chips", children: item.inputs.map((value) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: value }, value)) })
      ] }) : null,
      item.preconditions.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { children: t("preconditions") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { children: item.preconditions.map((value) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: value }, value)) })
      ] }) : null,
      item.instructions ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { children: t("instructions") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-pw-preserve", children: item.instructions })
      ] }) : null,
      item.successCriteria ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { children: t("successCriteria") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-pw-preserve", children: item.successCriteria })
      ] }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-pw-section-title", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { children: t("steps") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: item.steps.length })
        ] }),
        item.steps.length ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ol", { className: "dsh-pw-steps", children: item.steps.map((step, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RunbookStep, { step, index, t }, `${step.type}-${index}`)) }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("noRecordedSteps") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-pw-section-title", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { children: t("versions") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: versions.length })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-pw-versions", children: versions.map((version) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", "aria-pressed": version.id === item.id, onClick: () => onOpen(version.id), children: [
          "v",
          version.version,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: version.enabled ? t("active") : formatDate(version.updatedAt) })
        ] }, version.id)) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("footer", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "is-danger", onClick: () => onDelete(item.id), children: t("delete") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {}),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => setEditing(!editing), children: t(editing ? "cancel" : "edit") }),
      editing ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "is-primary", disabled: busy || !draft.name.trim() || !draft.task.trim(), onClick: save, children: t(busy ? "saving" : "saveRevision") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "is-primary", disabled: busy, onClick: () => request("runbook-enable", { id: item.id, enabled: !item.enabled }), children: t(item.enabled ? "disable" : "enableVersion") })
    ] })
  ] }) });
}
function RunbookStep({ step, index, t }) {
  const title = step.type === "act" ? `${step.action ?? t("action")} \xB7 ${step.role ?? ""} ${step.name ?? ""}` : step.type === "request" ? `${step.method ?? "GET"} ${step.path ?? ""}` : step.type === "open" ? step.url ?? t("open") : step.type === "wait" ? t("wait") : step.type;
  const detail = step.type === "request" ? [...step.queryKeys ?? [], ...step.bodyKeys ?? []].join(" \xB7 ") : step.frameUrl ?? "";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: String(index + 1).padStart(2, "0") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: title }),
      detail ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: detail }) : null
    ] }),
    step.status ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { children: step.status }) : null
  ] });
}
function ConfirmDialog({ title, body, busy, onCancel, onConfirm, t }) {
  useDialogDismiss(onCancel);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-pw-overlay is-confirm", role: "presentation", onMouseDown: (event) => {
    if (event.target === event.currentTarget) onCancel();
  }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dsh-pw-dialog dsh-pw-confirm", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "dsh-pw-confirm-title", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("header", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { id: "dsh-pw-confirm-title", children: title }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: body }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("footer", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: onCancel, children: t("cancel") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "is-danger", disabled: busy, onClick: onConfirm, children: t("confirmDelete") })
    ] })
  ] }) });
}
var editableRunbook = (item) => ({ name: item.name, task: item.task, instructions: item.instructions ?? "", inputs: (item.inputs ?? []).join("\n"), preconditions: (item.preconditions ?? []).join("\n"), successCriteria: item.successCriteria ?? "" });
var lines = (value) => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
var formatDate = (value) => new Date(value).toLocaleDateString();
function useDialogDismiss(onDismiss) {
  (0, import_react.useEffect)(() => {
    const listener = (event) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [onDismiss]);
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
