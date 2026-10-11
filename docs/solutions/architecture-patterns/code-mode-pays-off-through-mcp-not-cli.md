---
title: Code mode only cuts agent turns when exposed as an MCP tool with a Playwright-shaped API
date: 2026-10-10
category: architecture-patterns
module: code mode (agent-browser run)
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - Exposing a scripting or batch surface to an AI coding agent to reduce tool-call turns
  - Choosing between a CLI subcommand and an MCP tool for multi-step agent work
  - Designing the API that agents write against inside a sandbox
tags: [code-mode, mcp, claude-code, benchmark, playwright, agent-turns]
---

# Code mode only cuts agent turns when exposed as an MCP tool with a Playwright-shaped API

## Context

Code mode (`agent-browser run`, MCP `agent_browser_run`) was built so an agent can drive the browser with one JavaScript program instead of one tool call per step. A deterministic benchmark (`benchmarks/code-mode/`) showed one `run` call replacing 4 to 9 CLI invocations with 24x to 30x less output. Those numbers did not carry over to a real agent until two more things were in place.

The first real-agent round gave headless Claude Code (Sonnet) the same tasks with the stock CLI and with the fork's CLI. The fork took 6 to 13 turns while stock took 3 to 4. Transcripts showed two causes:

- Claude Code's Bash safety check rejected `agent-browser run <<'JS' ... JS` commands whose script contained braces and quotes ("Contains brace with quote character (expansion obfuscation)"). Each rejection cost a turn.
- The model wrote Playwright code by reflex (`page.goto(...)`, `page.locator('tr', { hasText }).getByRole(...)`). The sandbox only had helper functions, so the first script failed.

Stock agents also already reduce turns on their own by chaining commands with `&&` in a single Bash call.

## Guidance

1. **Expose code mode to Claude Code as an MCP tool, not only a CLI subcommand.** The script travels as a tool parameter, so no shell quoting or Bash safety check is involved. `agent_browser_run` builds a `run --json` invocation and passes the code on stdin (`run_tool_invocation` in `cli/src/mcp.rs`).
2. **Give the sandbox the API models already know.** A Playwright-style `page` object (`const page = Object.freeze(...)` in `cli/src/run/prelude.js`) maps `goto`, `locator(css, { hasText })`, `getByRole(role, { name })`, `evaluate`, `fill`, `innerText`, `count` and similar onto existing CLI commands. Locators resolve in the page to one element tagged with a temporary `data-ab-loc` attribute, and the real CLI command then acts on it, so clicks stay real input events.
3. **Measure with a real agent, not only invocation counts.** Invocation counts approximate turns, but the agent's behavior (shell chaining, safety prompts, API guesses) decides the outcome.

## Why This Matters

The second real-agent round (24 runs: 3 tasks x 2 runs x stock or fork x CLI or MCP, all correct) after both changes:

| Setup | Avg turns | Avg time (s) | Avg cost ($) |
| --- | ---: | ---: | ---: |
| Stock, MCP | 6.3 | 10.3 | 0.168 |
| Fork, MCP (`agent_browser_run`) | 3.5 | 8.5 | 0.106 |
| Stock, CLI | 3.5 | 9.8 | 0.158 |
| Fork, CLI | 3.7 | 9.4 | 0.152 |

Over MCP the fork uses 44% fewer turns and costs 37% less. Over the CLI there is no meaningful difference. Shipping code mode as a CLI-only feature, or with a bespoke API, would have looked like a win in the deterministic benchmark while delivering nothing (or a regression) to Claude Code users.

## When to Apply

- Any "batch many actions in one call" feature aimed at coding agents: a CLI subcommand helps scripts and humans, but agents in Claude Code benefit through MCP.
- Any sandbox or DSL that agents write code against: mirror the most popular library API the model has seen, even as a thin shim.
- Evaluating agent-facing tooling: run headless agents (`claude -p --output-format json`, which reports `num_turns`, `duration_ms` and `total_cost_usd`) and read the stream-json transcripts when results surprise you.

## Examples

What the model wrote on its first attempt, which now works through the shim:

```js
await page.goto(url);
await page.locator("tr", { hasText: "Row 17" }).getByRole("button", { name: /select/i }).click();
return await page.locator("#selected").innerText();
```

The CLI form that Claude Code's Bash check blocks (braces plus quotes inside a heredoc):

```bash
agent-browser --session s run <<'JS'
const r = evalPage("(() => { const t = [...document.querySelectorAll('tr')]; return t.length; })()");
JS
```

The same script sent as the `code` argument of the MCP tool `agent_browser_run` runs without any prompt.

## Related

- `benchmarks/code-mode/README.md` (deterministic and real-agent results)
- `skill-data/core/references/code-mode.md` (code mode reference, including the `page` subset)
- PR supremeb/agent-browser-plus#1
