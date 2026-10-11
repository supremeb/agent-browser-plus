# Code mode benchmark

Compares two ways an AI agent can drive agent-browser through the same task:

- **STEP mode**: one CLI invocation per agent turn. The agent opens the page, takes a `snapshot -i` to discover refs, acts (`fill`, `click`), and reads results (`get text`). It snapshots again after every page change, the way an agent has to before it can act on fresh refs.
- **RUN mode**: a single `agent-browser run --json` invocation that executes an equivalent JavaScript script using the `ab(...)` helpers (`open`, `fill`, `click`, `text`, `evalPage`, ...) and returns the final value.

## What it measures and why

Agent wall time is dominated by model turns, not by browser commands. Every CLI invocation in STEP mode is a round trip through the model: it reads the output, decides on the next command, and emits it. This benchmark reports three numbers per task and mode:

<table>
<tr><th>Metric</th><th>Proxy for</th></tr>
<tr><td>Invocations</td><td>Agent turns (each one is a model round trip)</td></tr>
<tr><td>Stdout bytes</td><td>Tokens the model has to read</td></tr>
<tr><td>Wall ms (median over iterations)</td><td>CLI and browser execution time only</td></tr>
</table>

Per-turn model latency is NOT included in the wall time. In real agent use each STEP invocation also costs a model turn (often seconds), so real-world savings from RUN mode are larger than the wall time numbers here suggest. The invocation count is the better predictor of end-to-end time.

Both modes are checked for correctness on every iteration, and failures are reported.

## Tasks

All tasks run against `fixture.html`, a self-contained page opened via a `file://` URL (no network).

<table>
<tr><th>Task</th><th>What it does</th><th>Correctness check</th></tr>
<tr><td><code>form</code></td><td>Fill name and email, click Submit, read <code>#status</code></td><td>Status text matches the submitted values</td></tr>
<tr><td><code>paginate</code></td><td>Collect all item texts from a 3 page list (10 items per page) by clicking Next</td><td>Exactly <code>Item 1</code> through <code>Item 30</code>, in order</td></tr>
<tr><td><code>find-row</code></td><td>Find the table row containing <code>Row 17</code>, click its Select button, read <code>#selected</code></td><td><code>#selected</code> reads <code>Selected: Row 17</code></td></tr>
</table>

In STEP mode the benchmark picks refs out of the `snapshot -i` output by role and accessible name, just as an agent would, and falls back to a CSS selector only if the ref is missing.

## Running

Build the CLI, then run:

```bash
node benchmarks/code-mode/bench.mjs --bin ./cli/target/debug/agent-browser
```

Options:

<table>
<tr><th>Flag</th><th>Default</th><th>Description</th></tr>
<tr><td><code>--bin &lt;path&gt;</code></td><td><code>$AGENT_BROWSER_BIN</code> or <code>agent-browser</code> on PATH</td><td>agent-browser binary to benchmark</td></tr>
<tr><td><code>--iterations N</code></td><td><code>3</code></td><td>Runs per task and mode; wall time is the median</td></tr>
<tr><td><code>--session &lt;name&gt;</code></td><td><code>bench-code-mode</code></td><td>Session passed on every invocation; closed at the end</td></tr>
<tr><td><code>--json</code></td><td>off</td><td>Also write <code>results.json</code> next to the script</td></tr>
</table>

The script needs Node 18 or later and has no dependencies. The first invocation (`open about:blank`) warms up the daemon and browser and is not counted. If Chrome is not in a default location, set `AGENT_BROWSER_EXECUTABLE_PATH`.

If the binary does not support `agent-browser run`, RUN mode is reported as skipped and STEP mode still runs, which is useful for validating the fixture and step sequences. The exit code is non zero only when a supported mode produces an incorrect result.

## Results

Local run on macOS arm64 with a debug build of the CLI, Chrome for Testing, and 3 iterations:

<table>
<tr><th>Task</th><th>Mode</th><th>Invocations</th><th>Stdout bytes</th><th>Wall ms (median)</th><th>Correct</th></tr>
<tr><td>form</td><td>step</td><td>6</td><td>3232</td><td>305</td><td>3/3</td></tr>
<tr><td>form</td><td>run</td><td>1</td><td>133</td><td>197</td><td>3/3</td></tr>
<tr><td>paginate</td><td>step</td><td>9</td><td>9525</td><td>167</td><td>3/3</td></tr>
<tr><td>paginate</td><td>run</td><td>1</td><td>382</td><td>62</td><td>3/3</td></tr>
<tr><td>find-row</td><td>step</td><td>4</td><td>3200</td><td>89</td><td>3/3</td></tr>
<tr><td>find-row</td><td>run</td><td>1</td><td>108</td><td>43</td><td>3/3</td></tr>
</table>

Invocations (a proxy for agent turns) dropped from 4 to 9 down to 1, output bytes (a proxy for tokens) shrank 24x to 30x, and wall time was 1.5x to 2.7x faster even before counting model latency per turn, which dominates real agent runs.

Numbers vary with hardware, build profile, and Chrome version; rerun the script to reproduce them on your machine.

## Real agent results

The numbers above count CLI invocations. To see what an agent actually does, the same three tasks were given to headless Claude Code (`claude -p --model sonnet`) in four setups, two runs each (24 runs, macOS arm64, release builds, Chrome for Testing). The stock build is upstream agent-browser 0.39.0. Every run produced the correct answer.

| Setup | Avg turns | Avg time (s) | Avg cost ($) | Correct |
| --- | ---: | ---: | ---: | --- |
| Stock, MCP tools | 6.3 | 10.3 | 0.168 | 6/6 |
| Fork, MCP tools (`agent_browser_run`) | 3.5 | 8.5 | 0.106 | 6/6 |
| Stock, CLI through Bash | 3.5 | 9.8 | 0.158 | 6/6 |
| Fork, CLI through Bash | 3.7 | 9.4 | 0.152 | 6/6 |

Per task (median of two runs):

| Task | Stock MCP turns | Fork MCP turns | Stock MCP cost | Fork MCP cost |
| --- | ---: | ---: | ---: | ---: |
| paginate | 5.0 | 3.5 | 0.163 | 0.112 |
| find-row | 6.0 | 3.0 | 0.166 | 0.089 |
| form | 8.0 | 4.0 | 0.176 | 0.117 |

What this shows:

- Over MCP, code mode cuts turns by 44%, cost by 37%, and time by 17%, because one `agent_browser_run` call replaces a chain of typed tool calls.
- Through the CLI there is no meaningful difference. Agents already chain commands with `&&` in one Bash call, and Claude Code's Bash safety check rejects heredocs that contain braces and quotes, so `run <<'JS'` scripts are often blocked before they execute. Use the MCP tool for code mode in Claude Code.
- A first round, before the Playwright-style `page` shim existed, showed the fork CLI taking 6 to 13 turns: models wrote `page.goto(...)` by reflex and failed. The shim fixed that.
- These tasks are small. Savings grow with the number of data-dependent steps (loops over results, multi-page extraction), which is where per-call agents pay one turn per step.

### Long multi-step task

A longer task with steps that depend on page data: collect all 30 items across 3 pages, click Select on rows 5, 10, 15 and 20 and record the result after each click, then fill and submit the form using the email shown in row 20. Two runs per setup (8 runs); every run was correct.

| Setup | Avg turns | Avg time (s) | Avg cost ($) |
| --- | ---: | ---: | ---: |
| Stock, CLI | 10.5 | 25.2 | 0.256 |
| Fork, CLI | 6.5 | 18.2 | 0.199 |
| Stock, MCP | 9.5 | 21.1 | 0.223 |
| Fork, MCP (`agent_browser_run`) | 4.5 | 19.0 | 0.151 |

On the longer task the fork wins through both surfaces: 53% fewer turns and 32% lower cost over MCP, and 38% fewer turns, 22% lower cost and 28% less time through the CLI. Savings grow with the number of steps that depend on page data.

### Baseline: stock agent-browser nudged to use `batch`

Stock agent-browser already has `batch` (and an `agent_browser_batch` MCP tool in the `debug` profile). To separate "batching at all" from "code mode specifically", the same tasks were run on stock with the prompt telling the agent to prefer batch (MCP started with `--tools core,debug`). Two runs per task; every run was correct.

| Setup | Short: turns | Short: cost ($) | Long: turns | Long: time (s) | Long: cost ($) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Stock, CLI | 3.5 | 0.158 | 10.5 | 25.2 | 0.256 |
| Stock + batch, CLI | 3.7 | 0.274 | 4.5 | 15.6 | 0.177 |
| Fork, CLI | 3.7 | 0.152 | 6.5 | 18.2 | 0.199 |
| Stock, MCP | 6.3 | 0.168 | 9.5 | 21.1 | 0.223 |
| Stock + batch, MCP | 4.3 | 0.149 | 4.5 | 13.9 | 0.186 |
| Fork, MCP | 3.5 | 0.106 | 4.5 | 19.0 | 0.151 |

What this changes:

- Most of the turn savings come from batching itself. With a nudge, stock `batch` reached the same 4.5 turns as code mode on the long task, and was faster. Through the CLI it beat the fork outright on the long task. Agents used semantic `find` (for example `find role button click --name "Select Row 5"`) so they did not need refs from an earlier snapshot.
- Code mode's remaining edge is cost and short tasks over MCP: 3.5 vs 4.3 turns and 29% lower cost on short tasks, and 19% lower cost on the long task, mainly because a script returns only its result instead of every command's output.
- `batch` is faster on the long task because it runs fixed sequences without the per-locator page lookups that code mode's `page` API performs.
- Code mode still matters where steps depend on page data that `find` cannot express (loops of unknown length, conditional branches, extracting and transforming data), but these benchmark tasks did not isolate that case.
