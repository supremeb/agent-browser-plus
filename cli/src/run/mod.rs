//! Code mode: `agent-browser run`.
//!
//! Runs a JavaScript program in an embedded QuickJS sandbox. The script reaches
//! the browser only through `ab(...argv)`, which executes ordinary CLI commands
//! against the session daemon (the same path `batch` uses), so one invocation
//! can loop, branch, and pass data between commands instead of spending one
//! agent turn per command. The sandbox has no filesystem, network, process, or
//! module access; it is bounded by a wall-clock deadline and a memory limit.

pub mod store;

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use rquickjs::{CatchResultExt, Context, Ctx, Function, Promise, Runtime};
use serde_json::{json, Value};

use self::store::Store;

const PRELUDE: &str = include_str!("prelude.js");

/// Default wall-clock budget for one `run`.
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MEMORY_LIMIT_BYTES: usize = 256 * 1024 * 1024;
const MAX_STACK_BYTES: usize = 1024 * 1024;
const MAX_LOG_BYTES: usize = 1024 * 1024;

/// Commands that cannot be nested inside a script.
/// `confirm`/`deny` are blocked so a script can never approve an action that
/// `--confirm-actions` parked for the user.
const BLOCKED_COMMANDS: &[&str] = &[
    "run",
    "batch",
    "chat",
    "mcp",
    "dashboard",
    "install",
    "upgrade",
    "confirm",
    "deny",
];
/// Upper bound on a script budget; also keeps `Instant + timeout` from overflowing.
pub const MAX_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;

/// Executes one CLI argv and returns `{success, data, error, code, warning}`.
pub type Bridge = Box<dyn FnMut(&[String]) -> Value + 'static>;
/// Resolves `skills.load(name)` to helper source text.
pub type SkillResolver = fn(&str) -> Result<String, String>;

pub struct RunOptions {
    pub timeout: Duration,
    pub store: Store,
    pub skills: SkillResolver,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LogEntry {
    pub level: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub success: bool,
    /// JSON result of the script, `None` when it produced `undefined`.
    pub result: Option<Value>,
    pub logs: Vec<LogEntry>,
    /// Number of `ab()` commands executed.
    pub commands: usize,
    pub error: Option<String>,
    pub error_code: Option<String>,
    /// argv of the command that raised the error, when one did.
    pub error_command: Option<Vec<String>>,
}

impl RunOutcome {
    pub fn to_json(&self) -> Value {
        json!({
            "success": self.success,
            "result": self.result.clone().unwrap_or(Value::Null),
            "logs": self.logs.iter().map(|l| json!({"level": l.level, "text": l.text})).collect::<Vec<_>>(),
            "commands": self.commands,
            "error": self.error,
            "code": self.error_code,
            "command": self.error_command,
        })
    }
}

struct Shared {
    bridge: Bridge,
    logs: Vec<LogEntry>,
    log_bytes: usize,
    commands: usize,
    deadline: Instant,
    store: Store,
}

/// Wrap user code so top-level `await` and `return` work and every outcome is
/// reported as a JSON string the host can parse without touching JS objects.
fn wrap_user_code(code: &str) -> String {
    format!(
        r#"(async () => {{
  try {{
    const __ret = await (async () => {{
{code}
    }})();
    const __out = __ret === undefined && __hasResult ? __result : __ret;
    if (__out === undefined) return JSON.stringify({{ ok: true }});
    let __json;
    try {{ __json = JSON.stringify(__out); }} catch (_) {{ __json = JSON.stringify(String(__out)); }}
    return JSON.stringify({{ ok: true, value: __json === undefined ? null : JSON.parse(__json) }});
  }} catch (e) {{
    const isErr = e !== null && typeof e === "object";
    return JSON.stringify({{
      ok: false,
      message: isErr && e.message !== undefined ? String(e.message) : String(e),
      name: isErr && e.name ? String(e.name) : "Error",
      code: isErr && e.code ? String(e.code) : null,
      command: isErr && Array.isArray(e.command) ? e.command : null,
    }});
  }}
}})()"#
    )
}

fn timeout_message(timeout: Duration) -> String {
    format!(
        "Script timed out after {}ms. Split the work into smaller runs or raise --timeout.",
        timeout.as_millis()
    )
}

/// Run `code` to completion. Never panics on script errors; every failure is
/// reported through [`RunOutcome`].
pub fn run_script(code: &str, bridge: Bridge, options: RunOptions) -> RunOutcome {
    let timeout = options.timeout.min(Duration::from_millis(MAX_TIMEOUT_MS));
    let deadline = Instant::now() + timeout;
    let shared = Rc::new(RefCell::new(Shared {
        bridge,
        logs: Vec::new(),
        log_bytes: 0,
        commands: 0,
        deadline,
        store: options.store,
    }));
    let skills = options.skills;

    let fail = |shared: &Rc<RefCell<Shared>>, message: String, code: Option<&str>| {
        let s = shared.borrow();
        RunOutcome {
            success: false,
            result: None,
            logs: s.logs.clone(),
            commands: s.commands,
            error: Some(message),
            error_code: code.map(str::to_string),
            error_command: None,
        }
    };

    let runtime = match Runtime::new() {
        Ok(rt) => rt,
        Err(e) => return fail(&shared, format!("Failed to start JS runtime: {}", e), None),
    };
    runtime.set_memory_limit(MEMORY_LIMIT_BYTES);
    runtime.set_max_stack_size(MAX_STACK_BYTES);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = match Context::full(&runtime) {
        Ok(c) => c,
        Err(e) => return fail(&shared, format!("Failed to create JS context: {}", e), None),
    };

    let outcome: Result<String, (String, Option<&'static str>)> = context.with(|ctx| {
        install_host_functions(&ctx, &shared, skills)
            .map_err(|e| (format!("Failed to install host functions: {}", e), None))?;

        ctx.eval::<(), _>(PRELUDE)
            .catch(&ctx)
            .map_err(|e| (format!("Prelude failed: {}", e), None))?;

        let promise: Promise = match ctx.eval(wrap_user_code(code)).catch(&ctx) {
            Ok(p) => p,
            Err(e) => {
                if Instant::now() >= deadline {
                    return Err((timeout_message(timeout), Some("timeout")));
                }
                return Err((format!("SyntaxError: {}", e), Some("syntax_error")));
            }
        };

        loop {
            match promise.result::<String>() {
                Some(Ok(json)) => return Ok(json),
                Some(Err(e)) => {
                    let caught = e.to_string();
                    let message = match ctx.catch().into_exception() {
                        Some(ex) => ex.message().unwrap_or(caught),
                        None => caught,
                    };
                    if Instant::now() >= deadline {
                        return Err((timeout_message(timeout), Some("timeout")));
                    }
                    return Err((message, None));
                }
                None => {}
            }
            if Instant::now() >= deadline {
                return Err((timeout_message(timeout), Some("timeout")));
            }
            match ctx.execute_pending_job() {
                true => continue,
                false => {
                    // The job queue is empty and the script is still pending:
                    // nothing in the sandbox can ever resolve it (there are no
                    // timers or I/O), so report instead of hanging.
                    if promise.result::<String>().is_some() {
                        continue;
                    }
                    if Instant::now() >= deadline {
                        return Err((timeout_message(timeout), Some("timeout")));
                    }
                    return Err((
                        "Script is waiting on a promise that can never settle (code mode has no timers or I/O; every helper returns synchronously).".to_string(),
                        Some("never_settles"),
                    ));
                }
            }
        }
    });

    let s = shared.borrow();
    let base = RunOutcome {
        success: false,
        result: None,
        logs: s.logs.clone(),
        commands: s.commands,
        error: None,
        error_code: None,
        error_command: None,
    };
    match outcome {
        Err((message, code)) => RunOutcome {
            error: Some(message),
            error_code: code.map(str::to_string),
            ..base
        },
        Ok(json) => {
            let parsed: Value = serde_json::from_str(&json).unwrap_or(Value::Null);
            if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
                RunOutcome {
                    success: true,
                    result: parsed.get("value").cloned(),
                    ..base
                }
            } else {
                let name = parsed
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Error");
                let message = parsed
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Script failed");
                let error = if name == "AbError" || name == "Error" {
                    message.to_string()
                } else {
                    format!("{}: {}", name, message)
                };
                RunOutcome {
                    error: Some(error),
                    error_code: parsed
                        .get("code")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    error_command: parsed
                        .get("command")
                        .and_then(|c| serde_json::from_value(c.clone()).ok()),
                    ..base
                }
            }
        }
    }
}

fn throw<'js>(ctx: &Ctx<'js>, message: &str) -> rquickjs::Error {
    rquickjs::Exception::throw_message(ctx, message)
}

fn install_host_functions<'js>(
    ctx: &Ctx<'js>,
    shared: &Rc<RefCell<Shared>>,
    skills: SkillResolver,
) -> rquickjs::Result<()> {
    let globals = ctx.globals();

    let s = shared.clone();
    globals.set(
        "__ab",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, argv_json: String| -> rquickjs::Result<String> {
                let argv: Vec<String> = serde_json::from_str(&argv_json)
                    .map_err(|e| throw(&ctx, &format!("ab(): invalid arguments: {}", e)))?;
                let mut state = s.borrow_mut();
                if Instant::now() >= state.deadline {
                    return Err(throw(&ctx, "Script deadline reached"));
                }
                if let Some(flag) = argv
                    .iter()
                    .find(|a| matches!(a.as_str(), "--stdin" | "--password-stdin"))
                {
                    return Ok(json!({
                        "success": false,
                        "error": format!("`{}` reads stdin, which is not available inside a run script; pass the value as an argument (e.g. evalPage(js) or eval -b)", flag),
                        "code": "blocked_command",
                    })
                    .to_string());
                }
                if let Some(first) = argv.first() {
                    if BLOCKED_COMMANDS.contains(&first.as_str()) {
                        return Ok(json!({
                        "success": false,
                        "error": format!("`{}` cannot be called from inside a run script", first),
                        "code": "blocked_command",
                    })
                    .to_string());
                    }
                }
                state.commands += 1;
                let resp = (state.bridge)(&argv);
                Ok(resp.to_string())
            },
        )?,
    )?;

    let s = shared.clone();
    globals.set(
        "__log",
        Function::new(ctx.clone(), move |level: String, text: String| {
            let mut state = s.borrow_mut();
            if state.log_bytes >= MAX_LOG_BYTES {
                return;
            }
            state.log_bytes += text.len();
            let text = if state.log_bytes > MAX_LOG_BYTES {
                "[log output truncated: limit reached]".to_string()
            } else {
                text
            };
            state.logs.push(LogEntry { level, text });
        })?,
    )?;

    let s = shared.clone();
    globals.set(
        "__sleep",
        Function::new(ctx.clone(), move |ms: f64| {
            let deadline = s.borrow().deadline;
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wanted = Duration::from_millis(ms.clamp(0.0, 3_600_000.0) as u64);
            std::thread::sleep(wanted.min(remaining));
        })?,
    )?;

    let s = shared.clone();
    globals.set(
        "__store",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  op: String,
                  key: String,
                  value_json: String|
                  -> rquickjs::Result<String> {
                let mut state = s.borrow_mut();
                let result = match op.as_str() {
                    "get" => state.store.get(&key).map(|v| v.unwrap_or(Value::Null)),
                    "set" => {
                        let value: Value = serde_json::from_str(&value_json).unwrap_or(Value::Null);
                        state.store.set(&key, value).map(|_| Value::Null)
                    }
                    "delete" => state
                        .store
                        .delete(&key)
                        .map(|old| old.unwrap_or(Value::Null)),
                    "keys" => state.store.keys().map(|k| json!(k)),
                    other => Err(format!("unknown store op {}", other)),
                };
                match result {
                    Ok(v) => Ok(v.to_string()),
                    Err(e) => Err(throw(&ctx, &format!("store: {}", e))),
                }
            },
        )?,
    )?;

    globals.set(
        "__skillSource",
        Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, name: String| -> rquickjs::Result<String> {
                skills(&name).map_err(|e| throw(&ctx, &e))
            },
        )?,
    )?;

    Ok(())
}

enum BridgeMsg {
    Exec(Vec<String>, std::sync::mpsc::Sender<Value>),
    Done(Box<RunOutcome>),
}

/// Run `code` on a dedicated thread while `exec` (which may borrow from the
/// caller, e.g. CLI flags) executes each `ab()` command on the calling thread.
/// QuickJS closures must be `'static`, so commands are proxied over a channel
/// rather than borrowed into the JS runtime.
pub fn run_script_with_executor(
    code: String,
    timeout: Duration,
    store: Store,
    skills: SkillResolver,
    mut exec: impl FnMut(&[String]) -> Value,
) -> RunOutcome {
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<BridgeMsg>();
    let worker_tx = tx.clone();
    let spawned = std::thread::Builder::new()
        .name("agent-browser-run".to_string())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let bridge_tx = worker_tx.clone();
            let bridge: Bridge = Box::new(move |argv: &[String]| {
                let (reply_tx, reply_rx) = mpsc::channel();
                if bridge_tx
                    .send(BridgeMsg::Exec(argv.to_vec(), reply_tx))
                    .is_err()
                {
                    return json!({"success": false, "error": "command bridge closed"});
                }
                reply_rx
                    .recv()
                    .unwrap_or_else(|_| json!({"success": false, "error": "command bridge closed"}))
            });
            let outcome = run_script(
                &code,
                bridge,
                RunOptions {
                    timeout,
                    store,
                    skills,
                },
            );
            let _ = worker_tx.send(BridgeMsg::Done(Box::new(outcome)));
        });
    drop(tx);

    let handle = match spawned {
        Ok(h) => h,
        Err(e) => {
            return RunOutcome {
                success: false,
                result: None,
                logs: Vec::new(),
                commands: 0,
                error: Some(format!("Failed to start script thread: {}", e)),
                error_code: None,
                error_command: None,
            }
        }
    };

    let mut outcome = None;
    while let Ok(msg) = rx.recv() {
        match msg {
            BridgeMsg::Exec(argv, reply) => {
                let _ = reply.send(exec(&argv));
            }
            BridgeMsg::Done(o) => {
                outcome = Some(*o);
                break;
            }
        }
    }
    let _ = handle.join();
    outcome.unwrap_or(RunOutcome {
        success: false,
        result: None,
        logs: Vec::new(),
        commands: 0,
        error: Some("Script thread exited unexpectedly".to_string()),
        error_code: None,
        error_command: None,
    })
}

/// Read the script for `run` from `-e` code, a file path, or stdin.
pub fn read_script(cmd: &Value) -> Result<String, String> {
    if let Some(code) = cmd.get("code").and_then(Value::as_str) {
        return Ok(code.to_string());
    }
    if let Some(path) = cmd.get("file").and_then(Value::as_str) {
        return std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read script {}: {}", path, e));
    }
    use std::io::Read as _;
    let mut code = String::new();
    std::io::stdin()
        .read_to_string(&mut code)
        .map_err(|e| format!("Failed to read script from stdin: {}", e))?;
    Ok(code)
}

#[cfg(test)]
mod tests;
