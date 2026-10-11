// agent-browser code mode prelude.
//
// Evaluated once per `agent-browser run` before the user script. Host functions
// installed by Rust (cli/src/run/mod.rs):
//   __ab(argvJson) -> responseJson   run one CLI command against the daemon
//   __log(level, text)               capture console output
//   __store(op, key, valueJson)      session-scoped JSON store
//   __skillSource(name)              source text of skill-data/<name>/helpers.js
//   __sleep(ms)                      block for ms milliseconds
// Everything below is plain JavaScript so it stays easy to read and test.
"use strict";

class AbError extends Error {
  constructor(message, code, command) {
    super(message);
    this.name = "AbError";
    this.code = code || null;
    this.command = command || [];
  }
}

const __fmt = (value) => {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value instanceof Error) return value.stack ? `${value.name}: ${value.message}` : String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
};

const console = {
  log: (...args) => __log("log", args.map(__fmt).join(" ")),
  info: (...args) => __log("info", args.map(__fmt).join(" ")),
  warn: (...args) => __log("warn", args.map(__fmt).join(" ")),
  error: (...args) => __log("error", args.map(__fmt).join(" ")),
};
globalThis.console = console;

// Run any CLI command, e.g. ab("click", "@e3") or ab("get", "text", "#title").
// Returns the command's JSON `data`; throws AbError on failure.
function ab(...args) {
  const argv = args.flat().filter((a) => a !== undefined && a !== null).map(String);
  if (argv.length === 0) throw new AbError("ab() needs a command, e.g. ab('snapshot', '-i')", "invalid_args", argv);
  const resp = JSON.parse(__ab(JSON.stringify(argv)));
  if (!resp.success) throw new AbError(resp.error || `Command failed: ${argv.join(" ")}`, resp.code, argv);
  // Under --confirm-actions the daemon parks gated commands and answers
  // success with confirmation_required. A script must not treat that as done,
  // and it cannot approve its own action (confirm/deny are blocked in run).
  if (resp.data && resp.data.confirmation_required) {
    throw new AbError(
      `"${argv[0]}" needs user approval (${resp.data.action || "policy"}). Ask the user, then run \`agent-browser confirm ${resp.data.confirmation_id}\` outside the script.`,
      "confirmation_required",
      argv,
    );
  }
  if (resp.warning) __log("warn", `[${argv[0]}] ${resp.warning}`);
  return resp.data === undefined ? null : resp.data;
}

const __pick = (data, key) => (data && typeof data === "object" && key in data ? data[key] : data);

// ---- Navigation -------------------------------------------------------------
const open = (url) => ab("open", url);
const back = () => ab("back");
const forward = () => ab("forward");
const reload = () => ab("reload");
const url = () => __pick(ab("get", "url"), "url");
const title = () => __pick(ab("get", "title"), "title");

// ---- Reading ----------------------------------------------------------------
// snapshot({ interactive, compact, cursor, urls, depth, selector, delta, full })
// Returns { tree, refs, origin, removedRefs } for full snapshots, or the raw
// delta payload when delta is requested.
function snapshot(opts = {}) {
  const argv = ["snapshot"];
  if (opts.interactive) argv.push("-i");
  if (opts.compact) argv.push("-c");
  if (opts.cursor) argv.push("-C");
  if (opts.urls) argv.push("-u");
  if (opts.depth !== undefined) argv.push("-d", opts.depth);
  if (opts.selector) argv.push("-s", opts.selector);
  if (opts.full) argv.push("--full");
  else if (opts.delta) argv.push("--delta");
  if (opts.noRedact) argv.push("--no-redact");
  const data = ab(argv);
  if (data && typeof data.snapshot === "string") {
    return { tree: data.snapshot, refs: data.refs || {}, origin: data.origin, removedRefs: data.removedRefs || [] };
  }
  // --full / first --delta call: a full state wrapped in the delta envelope.
  if (data && data.snapshot && data.snapshot.kind === "full") {
    return {
      tree: data.snapshot.tree,
      refs: data.snapshot.refs || {},
      origin: data.origin,
      removedRefs: [],
      revision: data.snapshot.revision,
    };
  }
  return data;
}
const text = (sel) => __pick(ab("get", "text", sel), "text");
const html = (sel) => __pick(ab("get", "html", sel), "html");
const value = (sel) => __pick(ab("get", "value", sel), "value");
const attr = (sel, name) => __pick(ab("get", "attr", sel, name), "value");
const count = (sel) => __pick(ab("get", "count", sel), "count");
const isVisible = (sel) => __pick(ab("is", "visible", sel), "visible");
// Run JavaScript in the page and return its (JSON-serialisable) result.
const evalPage = (script) => __pick(ab("eval", "-b", __b64(String(script))), "result");

// ---- Acting -----------------------------------------------------------------
const click = (sel, opts = {}) => ab("click", sel, opts.newTab ? "--new-tab" : undefined);
const dblclick = (sel) => ab("dblclick", sel);
const fill = (sel, text) => ab("fill", sel, text);
const type = (sel, text) => ab("type", sel, text);
const press = (key) => ab("press", key);
const hover = (sel) => ab("hover", sel);
const focus = (sel) => ab("focus", sel);
const select = (sel, ...values) => ab("select", sel, ...values);
const check = (sel) => ab("check", sel);
const uncheck = (sel) => ab("uncheck", sel);
const scroll = (direction = "down", px) => ab("scroll", direction, px);
const upload = (sel, ...files) => ab("upload", sel, ...files);
const screenshot = (path, opts = {}) =>
  ab("screenshot", path, opts.full ? "--full" : undefined, opts.annotate ? "--annotate" : undefined);
// find("role", "button", "click", { name: "Submit" }) mirrors `agent-browser find`.
function find(...args) {
  const last = args[args.length - 1];
  const opts = last && typeof last === "object" ? args.pop() : {};
  const argv = ["find", ...args];
  if (opts.name) argv.push("--name", opts.name);
  if (opts.exact) argv.push("--exact");
  return ab(argv);
}

// ---- Playwright-style page shim ----------------------------------------------
// Models reach for Playwright by reflex (page.goto, page.locator(...).click()).
// This maps the common subset onto the same CLI commands. A locator is
// resolved in the page to one element, tagged with a temporary attribute, and
// then driven by the real CLI command (so clicks stay real input events).
let __locSeq = 0;
function __resolve(spec) {
  if (typeof spec.css === "string" && spec.css.startsWith("@") && !spec.hasText && !spec.role && !spec.text) {
    return spec.css;
  }
  const id = `l${++__locSeq}`;
  const found = evalPage(`((spec, id) => {
    const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
    const nameOf = (el) => {
      const by = el.getAttribute("aria-labelledby");
      const labelled = by ? by.split(/\\s+/).map((i) => (document.getElementById(i) || {}).innerText || "").join(" ") : "";
      const label = el.labels && el.labels.length ? [...el.labels].map((l) => l.innerText).join(" ") : "";
      return norm(el.getAttribute("aria-label") || labelled || label || el.getAttribute("title") || el.getAttribute("placeholder") || el.innerText || el.value || el.getAttribute("alt") || "");
    };
    const matches = (val, want, exact) => want == null || (want.re ? new RegExp(want.re, want.flags).test(val) : exact ? val === want.s : val.toLowerCase().includes(want.s.toLowerCase()));
    const roleSel = { button: "button,[role=button],input[type=button],input[type=submit]", link: "a[href],[role=link]", textbox: "input:not([type]),input[type=text],input[type=email],input[type=search],input[type=password],input[type=tel],input[type=url],textarea,[role=textbox],[contenteditable=true]", checkbox: "input[type=checkbox],[role=checkbox]", radio: "input[type=radio],[role=radio]", heading: "h1,h2,h3,h4,h5,h6,[role=heading]", listitem: "li,[role=listitem]", row: "tr,[role=row]", cell: "td,th,[role=cell]", combobox: "select,[role=combobox]", option: "option,[role=option]", img: "img,[role=img]", tab: "[role=tab]", menuitem: "[role=menuitem]", dialog: "dialog,[role=dialog]" };
    let root = document;
    let els = [];
    if (spec.within) { root = document.querySelector('[data-ab-loc="' + spec.within + '"]') || document; }
    if (spec.role) els = [...root.querySelectorAll(roleSel[spec.role] || "[role=" + spec.role + "]")].filter((e) => matches(nameOf(e), spec.name, spec.exact));
    else if (spec.text) els = [...root.querySelectorAll("body *")].filter((e) => matches(norm(e.innerText || e.textContent), spec.text, spec.exact) && ![...e.children].some((c) => matches(norm(c.innerText || c.textContent), spec.text, spec.exact)));
    else els = [...root.querySelectorAll(spec.css)];
    if (spec.hasText) els = els.filter((e) => matches(norm(e.innerText || e.textContent), spec.hasText, false));
    if (spec.all) return els.map((e, i) => { e.setAttribute("data-ab-loc", id + "-" + i); return id + "-" + i; });
    const idx = spec.nth == null ? 0 : spec.nth < 0 ? els.length + spec.nth : spec.nth;
    const el = els[idx];
    if (!el) return null;
    el.setAttribute("data-ab-loc", id);
    return id;
  })(${JSON.stringify(spec)}, ${JSON.stringify(id)})`);
  if (spec.all) return found || [];
  if (!found) throw new AbError(`No element matches ${__describe(spec)}. Take a snapshot to see what is on the page.`, "not_found", []);
  return `[data-ab-loc="${found}"]`;
}
function __describe(spec) {
  return spec.role ? `role=${spec.role}${spec.name ? ` name=${JSON.stringify(spec.name.s || spec.name.re)}` : ""}` : spec.text ? `text=${JSON.stringify(spec.text.s || spec.text.re)}` : JSON.stringify(spec.css) + (spec.hasText ? ` hasText=${JSON.stringify(spec.hasText.s || spec.hasText.re)}` : "");
}
const __matcher = (v) => (v == null ? undefined : v instanceof RegExp ? { re: v.source, flags: v.flags } : { s: String(v) });
function __locator(spec) {
  const sel = () => __resolve(spec);
  const sub = (extra) => __locator({ ...extra, within: __resolve(spec).slice(14, -2) });
  return {
    click: (o = {}) => (o.clickCount === 2 ? dblclick(sel()) : click(sel())),
    dblclick: () => dblclick(sel()),
    fill: (v) => fill(sel(), v),
    type: (v) => type(sel(), v),
    pressSequentially: (v) => type(sel(), v),
    press: (k) => { focus(sel()); return press(k); },
    check: () => check(sel()),
    uncheck: () => uncheck(sel()),
    hover: () => hover(sel()),
    focus: () => focus(sel()),
    selectOption: (v) => select(sel(), ...[].concat(v)),
    innerText: () => text(sel()),
    textContent: () => text(sel()),
    inputValue: () => value(sel()),
    getAttribute: (n) => attr(sel(), n),
    isVisible: () => { try { return isVisible(sel()); } catch (_) { return false; } },
    count: () => __resolve({ ...spec, all: true }).length,
    all: () => __resolve({ ...spec, all: true }).map((id) => __locator({ css: `[data-ab-loc="${id}"]` })),
    allInnerTexts: () => __resolve({ ...spec, all: true }).map((id) => text(`[data-ab-loc="${id}"]`)),
    allTextContents: () => __resolve({ ...spec, all: true }).map((id) => text(`[data-ab-loc="${id}"]`)),
    first: () => __locator({ ...spec, nth: 0 }),
    last: () => __locator({ ...spec, nth: -1 }),
    nth: (i) => __locator({ ...spec, nth: i }),
    filter: (o = {}) => __locator({ ...spec, hasText: __matcher(o.hasText) || spec.hasText }),
    locator: (css) => sub({ css }),
    getByRole: (role, o = {}) => sub({ role, name: __matcher(o.name), exact: !!o.exact }),
    getByText: (t, o = {}) => sub({ text: __matcher(t), exact: !!o.exact }),
    waitFor: () => wait(sel()),
    scrollIntoViewIfNeeded: () => ab("scrollintoview", sel()),
    screenshot: (o = {}) => screenshot(o.path),
  };
}
const page = Object.freeze({
  goto: (u) => open(u),
  url: () => url(),
  title: () => title(),
  content: () => evalPage("document.documentElement.outerHTML"),
  reload: () => reload(),
  goBack: () => back(),
  goForward: () => forward(),
  evaluate: (fn, arg) => evalPage(typeof fn === "function" ? `(${fn.toString()})(${JSON.stringify(arg)})` : String(fn)),
  locator: (css, o = {}) => __locator({ css, hasText: __matcher(o.hasText) }),
  getByRole: (role, o = {}) => __locator({ role, name: __matcher(o.name), exact: !!o.exact }),
  getByText: (t, o = {}) => __locator({ text: __matcher(t), exact: !!o.exact }),
  getByLabel: (t) => __locator({ role: "textbox", name: __matcher(t) }),
  getByPlaceholder: (t) => __locator({ css: `[placeholder*=${JSON.stringify(String(t))}]` }),
  click: (s) => click(s),
  fill: (s, v) => fill(s, v),
  type: (s, v) => type(s, v),
  press: (s, k) => { focus(s); return press(k); },
  textContent: (s) => text(s),
  innerText: (s) => text(s),
  inputValue: (s) => value(s),
  isVisible: (s) => isVisible(s),
  waitForSelector: (s) => wait(s),
  waitForTimeout: (ms) => sleep(ms),
  waitForLoadState: (st = "load") => wait({ load: st }),
  waitForURL: (u) => wait({ url: String(u) }),
  screenshot: (o = {}) => screenshot(o.path, { full: o.fullPage }),
  keyboard: Object.freeze({ press: (k) => press(k), type: (t) => ab("keyboard", "type", t), insertText: (t) => ab("keyboard", "inserttext", t) }),
});

// ---- Waiting ----------------------------------------------------------------
// wait(ms) | wait("#selector") | wait({ text }) | wait({ url }) | wait({ load: "networkidle" }) | wait({ fn })
function wait(arg) {
  if (typeof arg === "number") return ab("wait", String(arg));
  if (typeof arg === "string") return ab("wait", arg);
  if (arg && arg.text) return ab("wait", "--text", arg.text);
  if (arg && arg.url) return ab("wait", "--url", arg.url);
  if (arg && arg.load) return ab("wait", "--load", arg.load);
  if (arg && arg.fn) return ab("wait", "--fn", arg.fn);
  throw new AbError("wait() expects ms, a selector, or { text | url | load | fn }", "invalid_args", ["wait"]);
}
const sleep = (ms) => __sleep(Number(ms) || 0);

// ---- Session store (persists across runs for the same --session) ------------
const store = Object.freeze({
  get: (key) => JSON.parse(__store("get", String(key), "null")),
  set: (key, val) => {
    const json = val === undefined ? "null" : JSON.stringify(val);
    if (json === undefined) throw new TypeError(`store.set("${key}"): value is not JSON-serializable`);
    __store("set", String(key), json);
    return val;
  },
  delete: (key) => JSON.parse(__store("delete", String(key), "null")),
  keys: () => JSON.parse(__store("keys", "", "null")),
});

// ---- Skills -----------------------------------------------------------------
// const gh = skills.load("github") evaluates skill-data/github/helpers.js once.
const __skillCache = Object.create(null);
const skills = Object.freeze({
  load(name) {
    if (__skillCache[name]) return __skillCache[name];
    const source = __skillSource(String(name));
    const exports = {};
    const module = { exports };
    // Helpers see the same API the user script sees, plus `exports`/`module`.
    const factory = new Function("exports", "module", "ab", "AbError", source + "\n;return module.exports;");
    const api = factory(exports, module, ab, AbError);
    __skillCache[name] = api;
    return api;
  },
});

// ---- Result -----------------------------------------------------------------
let __result;
let __hasResult = false;
function result(v) {
  __result = v;
  __hasResult = true;
  return v;
}

// Small base64 encoder for evalPage (QuickJS has no btoa).
function __b64(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63];
    out += i + 1 < bytes.length ? A[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? A[n & 63] : "=";
  }
  return out;
}
