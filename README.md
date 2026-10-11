# agent-browser-plus

A fork of [agent-browser](https://github.com/vercel-labs/agent-browser), the browser automation CLI for AI agents created by [Vercel Labs](https://github.com/vercel-labs) (led by Chris Tate, with contributors). All of the original's features are unchanged, and it is used under the Apache-2.0 license. The full upstream documentation is in [README.upstream.md](README.upstream.md).

## Why fork

agent-browser runs one action per agent tool call, so a 10-step browser task costs the agent about 10 turns, and most of the wall-clock time goes to the model, not the browser. This fork adds a way for an agent to do a whole multi-step task in one call, plus ready-made helpers for sites people use every day.

## What it adds

- **Code mode.** `agent-browser run` (or the MCP tool `agent_browser_run`) runs one JavaScript program that can call any command, with loops, conditions, and a Playwright-style `page` API. It runs in a sandbox with a deadline and memory limit.
- **Site skills** for GitHub, Gmail, Google Workspace (Docs, Sheets, Drive, Calendar), and LinkedIn. Any helper that sends, posts, or edits only drafts unless called with `{ confirm: true }`.
- **Secret redaction.** Passwords, one-time codes, and card numbers show as `[redacted]` in snapshots by default (`--no-redact` to turn off).

## Outcomes

Benchmarked with headless Claude Code (Sonnet) against stock agent-browser 0.39.0, including stock nudged to use its existing `batch` command. Every run produced the correct answer.

| Setup | Short tasks: turns / cost | Long task: turns / cost |
| --- | --- | --- |
| Stock, MCP | 6.3 / $0.168 | 9.5 / $0.223 |
| Stock + `batch`, MCP | 4.3 / $0.149 | 4.5 / $0.186 |
| **Fork, MCP (code mode)** | **3.5 / $0.106** | **4.5 / $0.151** |
| Stock + `batch`, CLI | 3.7 / $0.274 | 4.5 / $0.177 |
| Fork, CLI | 3.7 / $0.152 | 6.5 / $0.199 |

Honest reading: most of the turn savings come from batching, which stock agent-browser already has. Code mode's added value is lower cost (about 19 to 29% below stock with `batch` over MCP, because a script returns only its result), fewer turns on short tasks, and loops or branches that `batch` cannot express. Through the CLI, `batch` did as well or better. Per-command speed is the same as upstream. Details are in [benchmarks/code-mode](benchmarks/code-mode/README.md).

## Quick start

```bash
agent-browser run <<'JS'
return skills.load("github").listPullRequests("vercel-labs/agent-browser", { limit: 5 });
JS
```

Build and install steps are the same as upstream (see [README.upstream.md](README.upstream.md)). The code mode reference is in [skill-data/core/references/code-mode.md](skill-data/core/references/code-mode.md).

## Credit

agent-browser is by Vercel Labs and its contributors: <https://github.com/vercel-labs/agent-browser>. This fork is not affiliated with or endorsed by Vercel. License: [Apache-2.0](LICENSE).
