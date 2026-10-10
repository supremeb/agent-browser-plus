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

Results to be filled from a local run.
