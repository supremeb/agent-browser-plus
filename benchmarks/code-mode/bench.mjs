#!/usr/bin/env node
// Code mode benchmark: STEP mode (one CLI call per agent turn) vs RUN mode
// (one `agent-browser run --json` call executing a script).
//
// Usage:
//   node benchmarks/code-mode/bench.mjs [--bin <path>] [--iterations N] [--session <name>] [--json]
//
// Zero dependencies. Requires Node >= 18.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_URL = pathToFileURL(join(HERE, "fixture.html")).href;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    bin: process.env.AGENT_BROWSER_BIN || "agent-browser",
    iterations: 3,
    session: "bench-code-mode",
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === "--bin") opts.bin = next();
    else if (a === "--iterations") opts.iterations = Number(next());
    else if (a === "--session") opts.session = next();
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: node bench.mjs [--bin <path>] [--iterations N] [--session <name>] [--json]",
      );
      process.exit(0);
    } else fail(`Unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.iterations) || opts.iterations < 1) {
    fail("--iterations must be a positive integer");
  }
  return opts;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

const OPTS = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

// Runs one CLI invocation. Every call carries --session. Returns stdout text,
// byte count, exit status, and elapsed ms.
function cli(args, { input } = {}) {
  const argv = ["--session", OPTS.session, ...args];
  const start = process.hrtime.bigint();
  const res = spawnSync(OPTS.bin, argv, {
    input,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (res.error) {
    throw new Error(`failed to spawn ${OPTS.bin}: ${res.error.message}`);
  }
  const stdout = res.stdout ? res.stdout.toString("utf8") : "";
  const stderr = res.stderr ? res.stderr.toString("utf8") : "";
  return {
    args,
    stdout,
    stderr,
    bytes: res.stdout ? res.stdout.length : 0,
    status: res.status,
    ms,
  };
}

// Tracks the invocations made for one task execution.
class Recorder {
  constructor() {
    this.calls = [];
  }
  call(args, opts) {
    const r = cli(args, opts);
    this.calls.push(r);
    if (r.status !== 0) {
      const detail = (r.stderr || r.stdout).trim().split("\n").slice(0, 3).join(" | ");
      throw new Error(`\`${args.join(" ")}\` exited ${r.status}: ${detail}`);
    }
    return r.stdout;
  }
  get invocations() {
    return this.calls.length;
  }
  get bytes() {
    return this.calls.reduce((n, c) => n + c.bytes, 0);
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const FORM_NAME = "Ada Lovelace";
const FORM_EMAIL = "ada@example.com";
const EXPECTED_STATUS = `Submitted: ${FORM_NAME} <${FORM_EMAIL}>`;
const EXPECTED_ITEMS = Array.from({ length: 30 }, (_, i) => `Item ${i + 1}`);
const EXPECTED_SELECTED = "Selected: Row 17";

// Finds the ref of an element in a `snapshot -i` text tree by accessible name,
// the way an agent reads the snapshot and picks a ref.
function findRef(snapshot, role, name) {
  for (const line of snapshot.split("\n")) {
    const m = line.match(/^\s*-\s+(\S+)\s+"([^"]*)".*\[ref=(e\d+)/);
    if (m && m[1] === role && m[2].trim() === name) return `@${m[3]}`;
  }
  return null;
}

function itemsFromText(text) {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => /^Item \d+$/.test(s));
}

const TASKS = [
  {
    name: "form",
    description: "Fill name and email, submit, read #status",
    step(rec) {
      rec.call(["open", FIXTURE_URL]);
      const snap = rec.call(["snapshot", "-i"]);
      const nameRef = findRef(snap, "textbox", "Name") || "#name";
      const emailRef = findRef(snap, "textbox", "Email") || "#email";
      const submitRef = findRef(snap, "button", "Submit") || "#submit";
      rec.call(["fill", nameRef, FORM_NAME]);
      rec.call(["fill", emailRef, FORM_EMAIL]);
      rec.call(["click", submitRef]);
      return rec.call(["get", "text", "#status"]).trim();
    },
    script: [
      `open(${JSON.stringify(FIXTURE_URL)});`,
      `fill("#name", ${JSON.stringify(FORM_NAME)});`,
      `fill("#email", ${JSON.stringify(FORM_EMAIL)});`,
      `click("#submit");`,
      `return text("#status");`,
    ].join("\n"),
    verify(result) {
      const got = typeof result === "string" ? result.trim() : result;
      return got === EXPECTED_STATUS ? null : `expected ${JSON.stringify(EXPECTED_STATUS)}, got ${JSON.stringify(got)}`;
    },
  },
  {
    name: "paginate",
    description: "Collect all 30 item texts across 3 pages",
    step(rec) {
      rec.call(["open", FIXTURE_URL]);
      let snap = rec.call(["snapshot", "-i"]);
      const items = [];
      for (let page = 0; page < 3; page++) {
        items.push(...itemsFromText(rec.call(["get", "text", "#items"])));
        if (page === 2) break;
        const nextRef = findRef(snap, "button", "Next") || "#next";
        rec.call(["click", nextRef]);
        // The page changed: an agent re-snapshots before acting again.
        snap = rec.call(["snapshot", "-i"]);
      }
      return items;
    },
    script: [
      `open(${JSON.stringify(FIXTURE_URL)});`,
      `const items = [];`,
      `for (;;) {`,
      `  items.push(...evalPage("[...document.querySelectorAll('#items li')].map((li) => li.textContent)"));`,
      `  if (evalPage("document.querySelector('#next').disabled")) break;`,
      `  click("#next");`,
      `}`,
      `return items;`,
    ].join("\n"),
    verify(result) {
      if (!Array.isArray(result)) return `expected an array, got ${typeof result}`;
      if (result.length !== EXPECTED_ITEMS.length) return `expected 30 items, got ${result.length}`;
      const bad = result.findIndex((v, i) => String(v).trim() !== EXPECTED_ITEMS[i]);
      return bad === -1 ? null : `item ${bad} was ${JSON.stringify(result[bad])}`;
    },
  },
  {
    name: "find-row",
    description: "Find the row containing 'Row 17', click its Select, read #selected",
    step(rec) {
      rec.call(["open", FIXTURE_URL]);
      const snap = rec.call(["snapshot", "-i"]);
      const ref = findRef(snap, "button", "Select Row 17") || 'button[aria-label="Select Row 17"]';
      rec.call(["click", ref]);
      return rec.call(["get", "text", "#selected"]).trim();
    },
    script: [
      `open(${JSON.stringify(FIXTURE_URL)});`,
      `const idx = evalPage("[...document.querySelectorAll('#rows tr')].findIndex((tr) => tr.textContent.includes('Row 17'))");`,
      `if (idx < 0) throw new Error("Row 17 not found");`,
      `click("#rows tr:nth-child(" + (idx + 1) + ") button");`,
      `return text("#selected");`,
    ].join("\n"),
    verify(result) {
      const got = typeof result === "string" ? result.trim() : result;
      return got === EXPECTED_SELECTED ? null : `expected ${JSON.stringify(EXPECTED_SELECTED)}, got ${JSON.stringify(got)}`;
    },
  },
];

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function runStep(task) {
  const rec = new Recorder();
  const start = process.hrtime.bigint();
  let result;
  let error = null;
  try {
    result = task.step(rec);
    error = task.verify(result);
  } catch (e) {
    error = e.message;
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { invocations: rec.invocations, bytes: rec.bytes, ms, error };
}

let runUnavailable = null;

function runRun(task) {
  if (runUnavailable) {
    return { invocations: 0, bytes: 0, ms: 0, error: runUnavailable, skipped: true };
  }
  const rec = new Recorder();
  const start = process.hrtime.bigint();
  let error = null;
  try {
    const r = cli(["run", "--json", "-e", task.script]);
    rec.calls.push(r);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      parsed = null;
    }
    const unknownCommand =
      parsed && parsed.success === false && /unknown command/i.test(String(parsed.error || ""));
    if (!parsed || typeof parsed !== "object" || !("success" in parsed) || unknownCommand) {
      const detail = (r.stderr || r.stdout).trim().split("\n").slice(0, 2).join(" | ");
      runUnavailable = `\`agent-browser run\` is not available in this binary (exit ${r.status}: ${detail})`;
      error = runUnavailable;
    } else if (!parsed.success) {
      error = `run failed: ${typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error)}`;
    } else {
      error = task.verify(parsed.result);
    }
  } catch (e) {
    error = e.message;
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { invocations: rec.invocations, bytes: rec.bytes, ms, error, skipped: !!runUnavailable };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function summarize(samples) {
  const ok = samples.filter((s) => !s.error);
  const pool = ok.length ? ok : samples;
  return {
    invocations: median(pool.map((s) => s.invocations)),
    bytes: median(pool.map((s) => s.bytes)),
    ms: Math.round(median(pool.map((s) => s.ms))),
    passed: ok.length,
    total: samples.length,
    skipped: samples.some((s) => s.skipped),
    errors: [...new Set(samples.map((s) => s.error).filter(Boolean))],
  };
}

function ratio(a, b) {
  return b > 0 ? `${(a / b).toFixed(1)}x` : "n/a";
}

function main() {
  console.error(`agent-browser: ${OPTS.bin}`);
  console.error(`fixture:       ${FIXTURE_URL}`);
  console.error(`session:       ${OPTS.session}`);
  console.error(`iterations:    ${OPTS.iterations}`);

  // Warm up: start the daemon and browser so launch cost is not attributed to
  // the first measured task.
  const warm = cli(["open", "about:blank"]);
  if (warm.status !== 0) {
    fail(`warm-up failed (exit ${warm.status}): ${(warm.stderr || warm.stdout).trim()}`);
  }

  const results = [];
  try {
    for (const task of TASKS) {
      const step = [];
      const run = [];
      for (let i = 0; i < OPTS.iterations; i++) {
        step.push(runStep(task));
        run.push(runRun(task));
      }
      results.push({ task: task.name, description: task.description, step: summarize(step), run: summarize(run) });
      console.error(`  ${task.name}: done`);
    }
  } finally {
    cli(["close"]);
  }

  // Markdown table
  const lines = [];
  lines.push(
    "| Task | Mode | Invocations | Stdout bytes | Wall ms (median) | Correct |",
    "| --- | --- | ---: | ---: | ---: | --- |",
  );
  for (const r of results) {
    for (const [mode, s] of [["step", r.step], ["run", r.run]]) {
      const correct = s.skipped ? "skipped" : `${s.passed}/${s.total}`;
      const dash = s.skipped ? "n/a" : null;
      lines.push(
        `| ${r.task} | ${mode} | ${dash ?? s.invocations} | ${dash ?? s.bytes} | ${dash ?? s.ms} | ${correct} |`,
      );
    }
  }
  console.log(lines.join("\n"));

  const comparable = results.filter((r) => !r.run.skipped && r.run.passed && r.step.passed);
  if (comparable.length) {
    console.log("\n| Task | Invocations saved | Bytes ratio (step/run) | Wall time ratio (step/run) |");
    console.log("| --- | ---: | ---: | ---: |");
    for (const r of comparable) {
      console.log(
        `| ${r.task} | ${r.step.invocations - r.run.invocations} | ${ratio(r.step.bytes, r.run.bytes)} | ${ratio(r.step.ms, r.run.ms)} |`,
      );
    }
  }

  const failures = [];
  for (const r of results) {
    for (const [mode, s] of [["step", r.step], ["run", r.run]]) {
      for (const e of s.errors) failures.push(`${r.task} [${mode}]: ${e}`);
    }
  }
  if (runUnavailable) {
    console.log(`\nNote: RUN mode skipped. ${runUnavailable}`);
  }
  const realFailures = failures.filter((f) => !runUnavailable || !f.includes(runUnavailable));
  if (realFailures.length) {
    console.log("\nFailures:");
    for (const f of realFailures) console.log(`- ${f}`);
  }

  if (OPTS.json) {
    const out = join(HERE, "results.json");
    writeFileSync(
      out,
      JSON.stringify(
        {
          bin: OPTS.bin,
          iterations: OPTS.iterations,
          fixture: FIXTURE_URL,
          node: process.version,
          platform: `${process.platform}-${process.arch}`,
          date: new Date().toISOString(),
          runAvailable: !runUnavailable,
          results,
        },
        null,
        2,
      ) + "\n",
    );
    console.error(`wrote ${out}`);
  }

  process.exitCode = realFailures.length ? 1 : 0;
}

main();
