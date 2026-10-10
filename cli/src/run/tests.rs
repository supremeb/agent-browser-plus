use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use serde_json::{json, Value};

use super::store::Store;
use super::*;

fn test_skills(name: &str) -> Result<String, String> {
    match name {
        "site" => Ok("module.exports = { hello: (n) => 'hi ' + n, title: () => title() };".to_string()),
        other => Err(format!("Skill '{}' not found", other)),
    }
}

struct Harness {
    calls: Rc<RefCell<Vec<Vec<String>>>>,
    _dir: tempfile::TempDir,
    store_path: std::path::PathBuf,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store_path = dir.path().join("t.run-store.json");
        Harness {
            calls: Rc::new(RefCell::new(Vec::new())),
            _dir: dir,
            store_path,
        }
    }

    fn run_with(&self, code: &str, timeout_ms: u64, respond: fn(&[String]) -> Value) -> RunOutcome {
        let calls = self.calls.clone();
        let bridge: Bridge = Box::new(move |argv: &[String]| {
            calls.borrow_mut().push(argv.to_vec());
            respond(argv)
        });
        run_script(
            code,
            bridge,
            RunOptions {
                timeout: Duration::from_millis(timeout_ms),
                store: Store::at(self.store_path.clone()),
                skills: test_skills,
            },
        )
    }

    fn run(&self, code: &str) -> RunOutcome {
        self.run_with(code, 5_000, ok_echo)
    }
}

fn ok_echo(argv: &[String]) -> Value {
    match argv.first().map(String::as_str) {
        Some("get") if argv.get(1).map(String::as_str) == Some("title") => {
            json!({"success": true, "data": {"title": "Example"}})
        }
        Some("get") if argv.get(1).map(String::as_str) == Some("text") => {
            json!({"success": true, "data": {"text": format!("text of {}", argv[2]), "origin": "x"}})
        }
        Some("snapshot") => json!({"success": true, "data": {
            "snapshot": "- button \"Go\" [ref=e1]", "origin": "https://x", "refs": {"e1": {"role": "button", "name": "Go"}}, "removedRefs": []
        }}),
        Some("eval") => json!({"success": true, "data": {"result": [1, 2, 3], "origin": "x"}}),
        Some("fail") => json!({"success": false, "error": "Tab is gone", "code": "tab_gone"}),
        _ => json!({"success": true, "data": {"argv": argv}}),
    }
}

#[test]
fn returns_value_and_captures_logs() {
    let h = Harness::new();
    let out = h.run("console.log('a', {b: 1}); return 1 + 1;");
    assert!(out.success, "{:?}", out.error);
    assert_eq!(out.result, Some(json!(2)));
    assert_eq!(out.logs[0].text, "a {\n  \"b\": 1\n}");
}

#[test]
fn result_helper_used_when_nothing_returned() {
    let h = Harness::new();
    let out = h.run("result({x: 1});");
    assert_eq!(out.result, Some(json!({"x": 1})));
    let empty = h.run("");
    assert!(empty.success);
    assert_eq!(empty.result, None);
}

#[test]
fn helpers_build_cli_argv_and_unwrap_data() {
    let h = Harness::new();
    let out = h.run(
        r##"
        await open("https://example.com");
        await click("@e1");
        await fill("#a", "b");
        const s = await snapshot({ interactive: true, selector: "main" });
        return { title: await title(), text: await text("#t"), refs: Object.keys(s.refs), evald: evalPage("[1,2,3]") };
        "##,
    );
    assert!(out.success, "{:?}", out.error);
    assert_eq!(
        out.result,
        Some(json!({"title": "Example", "text": "text of #t", "refs": ["e1"], "evald": [1, 2, 3]}))
    );
    let calls = h.calls.borrow();
    assert_eq!(calls[0], vec!["open", "https://example.com"]);
    assert_eq!(calls[1], vec!["click", "@e1"]);
    assert_eq!(calls[2], vec!["fill", "#a", "b"]);
    assert_eq!(calls[3], vec!["snapshot", "-i", "-s", "main"]);
    assert_eq!(calls[6][0..2], ["eval".to_string(), "-b".to_string()]);
    assert_eq!(out.commands, 7);
}

#[test]
fn command_errors_are_catchable_with_code() {
    let h = Harness::new();
    let out = h.run("try { ab('fail'); } catch (e) { return [e.name, e.code, e.message, e.command]; }");
    assert_eq!(out.result, Some(json!(["AbError", "tab_gone", "Tab is gone", ["fail"]])));
}

#[test]
fn uncaught_command_error_fails_the_run() {
    let h = Harness::new();
    let out = h.run("await ab('fail'); return 'unreachable';");
    assert!(!out.success);
    assert_eq!(out.error.as_deref(), Some("Tab is gone"));
    assert_eq!(out.error_code.as_deref(), Some("tab_gone"));
    assert_eq!(out.error_command, Some(vec!["fail".to_string()]));
}

#[test]
fn plain_errors_keep_their_type() {
    let h = Harness::new();
    let out = h.run("null.x;");
    assert!(!out.success);
    assert!(out.error.as_deref().unwrap().starts_with("TypeError"), "{:?}", out.error);
}

#[test]
fn syntax_errors_are_reported() {
    let h = Harness::new();
    let out = h.run("return )(;");
    assert!(!out.success);
    assert_eq!(out.error_code.as_deref(), Some("syntax_error"));
}

#[test]
fn infinite_loop_times_out() {
    let h = Harness::new();
    let started = std::time::Instant::now();
    let out = h.run_with("while (true) {}", 200, ok_echo);
    assert!(!out.success);
    assert_eq!(out.error_code.as_deref(), Some("timeout"));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn never_settling_promise_is_reported() {
    let h = Harness::new();
    let out = h.run("await new Promise(() => {});");
    assert!(!out.success);
    assert_eq!(out.error_code.as_deref(), Some("never_settles"));
}

#[test]
fn sandbox_has_no_host_escape_hatches() {
    let h = Harness::new();
    let out = h.run("return [typeof require, typeof process, typeof fetch, typeof std, typeof os];");
    assert_eq!(
        out.result,
        Some(json!(["undefined", "undefined", "undefined", "undefined", "undefined"]))
    );
}

#[test]
fn memory_limit_fails_cleanly() {
    let h = Harness::new();
    let out = h.run("const a = []; while (true) a.push('x'.repeat(1 << 20));");
    assert!(!out.success);
}

#[test]
fn nested_run_is_blocked() {
    let h = Harness::new();
    let out = h.run("try { ab('run', '-e', '1'); } catch (e) { return e.code; }");
    assert_eq!(out.result, Some(json!("blocked_command")));
    assert!(h.calls.borrow().is_empty());
}

#[test]
fn store_persists_between_runs() {
    let h = Harness::new();
    assert!(h.run("store.set('k', {a: 1});").success);
    let out = h.run("return [store.get('k'), store.keys(), store.get('missing')];");
    assert_eq!(out.result, Some(json!([{"a": 1}, ["k"], null])));
}

#[test]
fn skills_load_exposes_helpers_with_prelude_globals() {
    let h = Harness::new();
    let out = h.run("const s = skills.load('site'); return [s.hello('bo'), s.title(), skills.load('site') === s];");
    assert_eq!(out.result, Some(json!(["hi bo", "Example", true])));
    let missing = h.run("skills.load('nope');");
    assert!(missing.error.unwrap().contains("not found"));
}

#[test]
fn non_serializable_results_degrade_to_strings() {
    let h = Harness::new();
    let out = h.run("const a = {}; a.self = a; return a;");
    assert!(out.success);
    assert_eq!(out.result, Some(json!("[object Object]")));
}

#[test]
fn executor_thread_proxies_commands_to_caller() {
    let dir = tempfile::tempdir().unwrap();
    let mut seen = Vec::new();
    let out = run_script_with_executor(
        "return [title(), title()];".to_string(),
        Duration::from_secs(5),
        Store::at(dir.path().join("s.json")),
        test_skills,
        |argv| {
            seen.push(argv.join(" "));
            ok_echo(argv)
        },
    );
    assert_eq!(out.result, Some(json!(["Example", "Example"])));
    assert_eq!(seen, vec!["get title", "get title"]);
}

/// Resolve skills from the repository's real `skill-data/` directory.
fn repo_skills(name: &str) -> Result<String, String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../skill-data")
        .join(name)
        .join("helpers.js");
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {}", path.display(), e))
}

#[test]
fn shipped_site_skills_load_in_the_sandbox() {
    let expected: &[(&str, &[&str])] = &[
        ("github", &["listPullRequests", "listIssues", "readPullRequest", "readIssue", "commentOnIssue"]),
        ("gmail", &["inbox", "search", "readThread", "draft", "send"]),
        ("google-workspace", &["docs", "sheets", "drive", "calendar", "parseId"]),
        ("linkedin", &["profile", "searchPeople", "feed", "messages", "sendMessage", "connect"]),
    ];
    let dir = tempfile::tempdir().unwrap();
    for (name, functions) in expected {
        let code = format!(
            "const api = skills.load('{name}'); return Object.keys(api);"
        );
        let out = run_script(
            &code,
            Box::new(|argv: &[String]| json!({"success": true, "data": {"argv": argv}})),
            RunOptions {
                timeout: Duration::from_secs(5),
                store: Store::at(dir.path().join("s.json")),
                skills: repo_skills,
            },
        );
        assert!(out.success, "{name}: {:?}", out.error);
        let keys: Vec<String> = serde_json::from_value(out.result.unwrap()).unwrap();
        for f in *functions {
            assert!(keys.iter().any(|k| k == f), "{name} is missing {f}: {keys:?}");
        }
    }
}

#[test]
fn shipped_mutating_helpers_do_not_submit_without_confirm() {
    let dir = tempfile::tempdir().unwrap();
    let calls: Rc<RefCell<Vec<Vec<String>>>> = Rc::new(RefCell::new(Vec::new()));
    let seen = calls.clone();
    let out = run_script(
        r#"
        const gw = skills.load('google-workspace');
        const draft = gw.sheets.setCell('1abcDEFghijKLMNop_qrst', 'A1', 'x');
        return draft;
        "#,
        Box::new(move |argv: &[String]| {
            seen.borrow_mut().push(argv.to_vec());
            json!({"success": true, "data": {"url": "https://docs.google.com/spreadsheets/d/1abcDEF/edit", "result": null}})
        }),
        RunOptions {
            timeout: Duration::from_secs(5),
            store: Store::at(dir.path().join("s.json")),
            skills: repo_skills,
        },
    );
    assert!(out.success, "{:?}", out.error);
    assert_eq!(out.result.as_ref().and_then(|r| r.get("drafted")), Some(&json!(true)));
    for argv in calls.borrow().iter() {
        assert!(
            !matches!(argv.first().map(String::as_str), Some("type" | "press" | "fill" | "keyboard")),
            "unconfirmed setCell issued {argv:?}"
        );
    }
}
