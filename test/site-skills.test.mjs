// Site skill helpers (skill-data/*/helpers.js) under the real code-mode
// prelude, with stubbed host functions standing in for the browser. Checks
// that helpers load, navigate where expected, detect login walls, and that
// every mutating helper only drafts unless called with { confirm: true }.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prelude = fs.readFileSync(path.join(ROOT, "cli/src/run/prelude.js"), "utf8");

function makeEnv({ landingUrl } = {}) {
  const calls = [];
  const state = { url: "about:blank", landingUrl };
  const decode = (b64) => Buffer.from(b64, "base64").toString("utf8");
  const ctx = {
    __ab(argvJson) {
      const argv = JSON.parse(argvJson);
      const rec = { argv, script: argv[0] === "eval" ? decode(argv[2]) : null };
      calls.push(rec);
      let data = {};
      switch (argv[0]) {
        case "open":
          state.url = state.landingUrl || argv[1];
          data = { url: state.url };
          break;
        case "get":
          if (argv[1] === "url") data = { url: state.url };
          else if (argv[1] === "text") data = { text: "body text" };
          else data = {};
          break;
        case "eval": {
          const s = rec.script;
          let result = [];
          if (s.startsWith("!!(document.querySelector('[role=main] tr.zA')")) result = true;
          else if (s.includes("#new_comment_field")) result = "#new_comment_field";
          else if (s.includes("row.click()") || s.includes("b.click()")) result = true;
          else if (s.includes("fetch(u")) result = { ok: true, status: 200, text: 'a,b\n1,"x, y"\n2,"he said ""hi"""\n' };
          else if (s.includes("navigator.platform")) result = false;
          data = { result };
          break;
        }
        default:
          data = {};
      }
      return JSON.stringify({ success: true, data });
    },
    __log(level, text) {},
    __store() { return "null"; },
    __sleep() {},
    __skillSource(name) { return fs.readFileSync(path.join(ROOT, "skill-data", name, "helpers.js"), "utf8"); },
  };
  vm.createContext(ctx);
  vm.runInContext(prelude, ctx);
  return { ctx, calls, load: (name) => vm.runInContext(`skills.load(${JSON.stringify(name)})`, ctx) };
}

const opens = (calls) => calls.filter((c) => c.argv[0] === "open").map((c) => c.argv[1]);
const argvs = (calls) => calls.map((c) => c.argv.join(" "));
const check = (label, fn) => test(label, fn);
function run(skill, fn, opts) {
  const env = makeEnv(opts);
  const api = env.load(skill);
  let result, error;
  try { result = fn(api); } catch (e) { error = e; }
  return { ...env, api, result, error };
}
const isSubmit = {
  github: (a) => /^find .*--name Comment/.test(a),
  gmail: (a) => /^click .*data-tooltip\^="Send"/.test(a) || /^press (Control|Meta)\+Enter/.test(a),
  "google-workspace": (a) => /^find .*--name Save/.test(a) || /^keyboard (type|inserttext)/.test(a) || /^fill #t-name-box/.test(a),
  linkedin: (a) => /^click button\.msg-form__send-button/.test(a) || /^find .*--name Send/.test(a) || /^keyboard type .*\n/.test(a),
};

const expected = {
  github: ["repo", "listPullRequests", "listIssues", "readPullRequest", "readIssue", "searchCode", "notifications", "commentOnIssue"],
  gmail: ["inbox", "search", "readThread", "draft", "send"],
  "google-workspace": ["parseId", "docs.read", "docs.append", "sheets.readCsv", "sheets.setCell", "drive.search", "calendar.agenda", "calendar.createEvent"],
  linkedin: ["profile", "searchPeople", "feed", "messages", "draftMessage", "sendMessage", "connect"],
};
for (const [skill, names] of Object.entries(expected)) {
  check(`${skill}: loads and exports ${names.length} functions`, () => {
    const { api } = run(skill, () => null);
    for (const n of names) assert.strictEqual(typeof n.split(".").reduce((o, k) => o && o[k], api), "function", `missing ${n}`);
  });
}

// ---- Read helpers open the expected URLs -----------------------------------
const reads = [
  ["github", (g) => g.listPullRequests("o/r"), /^https:\/\/github\.com\/o\/r\/pulls\?q=is%3Apr%20is%3Aopen$/],
  ["github", (g) => g.listIssues("o/r", { state: "closed", query: "label:bug" }), /^https:\/\/github\.com\/o\/r\/issues\?q=is%3Aissue%20is%3Aclosed%20label%3Abug$/],
  ["github", (g) => g.repo("https://github.com/o/r"), /^https:\/\/github\.com\/o\/r$/],
  ["github", (g) => g.readPullRequest("o/r", 12), /^https:\/\/github\.com\/o\/r\/pull\/12$/],
  ["github", (g) => g.readIssue("o/r", 7), /^https:\/\/github\.com\/o\/r\/issues\/7$/],
  ["github", (g) => g.searchCode("foo repo:o/r"), /^https:\/\/github\.com\/search\?q=foo%20repo%3Ao%2Fr&type=code$/],
  ["github", (g) => g.notifications(), /^https:\/\/github\.com\/notifications$/],
  ["gmail", (m) => m.inbox({ limit: 5 }), /^https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox$/],
  ["gmail", (m) => m.search("from:x"), /^https:\/\/mail\.google\.com\/mail\/u\/0\/#search\/from%3Ax$/],
  ["gmail", (m) => m.readThread("Invoice"), /#search\/subject%3A\(Invoice\)$/],
  ["google-workspace", (w) => w.docs.read("https://docs.google.com/document/d/abcdefghij12345/edit"), /^https:\/\/docs\.google\.com\/document\/d\/abcdefghij12345\/edit$/],
  ["google-workspace", (w) => w.sheets.readCsv("abcdefghij12345", { gid: 3 }), /^https:\/\/docs\.google\.com\/spreadsheets\/d\/abcdefghij12345\/edit#gid=3$/],
  ["google-workspace", (w) => w.drive.search("budget"), /^https:\/\/drive\.google\.com\/drive\/search\?q=budget$/],
  ["google-workspace", (w) => w.calendar.agenda({ days: 2 }), /^https:\/\/calendar\.google\.com\/calendar\/r\/agenda$/],
  ["linkedin", (l) => l.profile("jane-doe"), /^https:\/\/www\.linkedin\.com\/in\/jane-doe\/$/],
  ["linkedin", (l) => l.searchPeople("rust engineer"), /^https:\/\/www\.linkedin\.com\/search\/results\/people\/\?keywords=rust%20engineer$/],
  ["linkedin", (l) => l.feed(), /^https:\/\/www\.linkedin\.com\/feed\/$/],
  ["linkedin", (l) => l.messages(), /^https:\/\/www\.linkedin\.com\/messaging\/$/],
];
for (const [skill, fn, re] of reads) {
  check(`${skill}: ${fn.toString().replace(/^\(\w\) => \w\./, "")} opens ${re.source.slice(0, 60)}`, () => {
    const r = run(skill, fn);
    assert.ok(opens(r.calls).some((u) => re.test(u)), `opens were ${JSON.stringify(opens(r.calls))}`);
    if (r.error) assert.strictEqual(r.error.code, "not_found", `unexpected error ${r.error.code}: ${r.error.message}`);
  });
}

check("google-workspace: sheets.readCsv fetches the export URL and parses CSV", () => {
  const r = run("google-workspace", (w) => w.sheets.readCsv("abcdefghij12345"));
  assert.ok(r.calls.some((c) => c.script && c.script.includes("/spreadsheets/d/abcdefghij12345/export?format=csv&gid=0")));
  assert.strictEqual(JSON.stringify(r.result), JSON.stringify([["a", "b"], ["1", "x, y"], ["2", 'he said "hi"']]));
});
check("google-workspace: docs.read fetches export?format=txt", () => {
  const r = run("google-workspace", (w) => w.docs.read("abcdefghij12345"));
  assert.ok(r.calls.some((c) => c.script && c.script.includes("/document/d/abcdefghij12345/export?format=txt")));
});
check("google-workspace: parseId variants", () => {
  const { api } = run("google-workspace", () => null);
  assert.strictEqual(api.parseId("https://docs.google.com/spreadsheets/d/1AbC_def-GHIjk/edit#gid=0"), "1AbC_def-GHIjk");
  assert.strictEqual(api.parseId("https://drive.google.com/open?id=1AbC_def-GHIjk"), "1AbC_def-GHIjk");
  assert.strictEqual(api.parseId("https://drive.google.com/drive/folders/1AbC_def-GHIjk"), "1AbC_def-GHIjk");
  assert.strictEqual(api.parseId("1AbC_def-GHIjk"), "1AbC_def-GHIjk");
});

// ---- Mutating helpers: no submit without confirm, submit with confirm -------
const mutations = [
  ["github", "commentOnIssue", (g, c) => g.commentOnIssue("o/r", 5, "hello", c)],
  ["gmail", "send", (m, c) => m.send({ to: "a@b.c", subject: "s", body: "b", ...c })],
  ["gmail", "draft", (m) => m.draft({ to: "a@b.c", subject: "s", body: "b" }), true],
  ["google-workspace", "docs.append", (w, c) => w.docs.append("abcdefghij12345", "more", c)],
  ["google-workspace", "sheets.setCell", (w, c) => w.sheets.setCell("abcdefghij12345", "B2", "42", c)],
  ["google-workspace", "calendar.createEvent", (w, c) => w.calendar.createEvent({ title: "Sync", start: "2026-11-02T15:00:00Z", ...c })],
  ["linkedin", "sendMessage", (l, c) => l.sendMessage("jane-doe", "hi", c)],
  ["linkedin", "draftMessage", (l) => l.draftMessage("jane-doe", "hi"), true],
  ["linkedin", "connect", (l, c) => l.connect("jane-doe", { note: "hello", ...c })],
];
for (const [skill, name, fn, draftOnly] of mutations) {
  check(`${skill}: ${name} without confirm returns a draft and issues no submit`, () => {
    const r = run(skill, (api) => fn(api, {}));
    if (r.error) throw r.error;
    const submits = argvs(r.calls).filter(isSubmit[skill]);
    assert.deepStrictEqual(submits, [], "submit-like calls issued");
    assert.ok(r.result && (r.result.drafted === true), `result: ${JSON.stringify(r.result)}`);
  });
  if (draftOnly) continue;
  check(`${skill}: ${name} with confirm issues the submit`, () => {
    const r = run(skill, (api) => fn(api, { confirm: true }));
    if (r.error) throw r.error;
    assert.ok(argvs(r.calls).some(isSubmit[skill]), `calls: ${JSON.stringify(argvs(r.calls))}`);
  });
}

check("calendar.createEvent builds eventedit URL with UTC dates", () => {
  const r = run("google-workspace", (w) => w.calendar.createEvent({ title: "Sync", start: "2026-11-02T15:00:00Z" }));
  assert.ok(opens(r.calls).includes("https://calendar.google.com/calendar/r/eventedit?text=Sync&dates=20261102T150000Z%2F20261102T160000Z"), JSON.stringify(opens(r.calls)));
});

// ---- Login walls ------------------------------------------------------------
const walls = [
  ["gmail", (m) => m.inbox(), "https://accounts.google.com/v3/signin/identifier"],
  ["google-workspace", (w) => w.drive.search("x"), "https://accounts.google.com/ServiceLogin"],
  ["github", (g) => g.notifications(), "https://github.com/login?return_to=%2Fnotifications"],
  ["linkedin", (l) => l.feed(), "https://www.linkedin.com/authwall?trk=x"],
];
for (const [skill, fn, landing] of walls) {
  check(`${skill}: login wall throws not_logged_in`, () => {
    const r = run(skill, fn, { landingUrl: landing });
    assert.ok(r.error, "expected an error");
    assert.strictEqual(r.error.name, "AbError");
    assert.strictEqual(r.error.code, "not_logged_in");
  });
}

