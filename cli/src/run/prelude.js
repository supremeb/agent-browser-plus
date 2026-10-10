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
