//! Session-scoped key/value store for code mode.
//!
//! Each `agent-browser run` gets a fresh JavaScript scope, so values that must
//! survive between runs (cursors, collected rows, ids) go through `store`. The
//! data is one JSON object per session, written atomically next to the
//! session's daemon files.

use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};

/// Upper bound on the serialized store so a runaway script cannot fill the disk.
pub const MAX_STORE_BYTES: usize = 1024 * 1024;

pub struct Store {
    path: PathBuf,
    data: Option<Map<String, Value>>,
}

impl Store {
    pub fn for_session(session: &str) -> Self {
        Self::at(crate::connection::get_socket_dir().join(format!("{}.run-store.json", session)))
    }

    pub fn at(path: PathBuf) -> Self {
        Store { path, data: None }
    }

    /// Load the store once. A missing file is an empty store. A file that is
    /// not a JSON object is moved aside to `<name>.corrupt` (so the next write
    /// cannot silently destroy it) and the store starts empty. Any other read
    /// error is surfaced instead of being mistaken for an empty store.
    fn load(&mut self) -> Result<&mut Map<String, Value>, String> {
        if self.data.is_none() {
            let parsed = match fs::read_to_string(&self.path) {
                Ok(text) => match serde_json::from_str::<Value>(&text) {
                    Ok(Value::Object(map)) => map,
                    _ => {
                        let aside = self.path.with_extension("json.corrupt");
                        let _ = fs::rename(&self.path, &aside);
                        Map::new()
                    }
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
                Err(e) => return Err(format!("read {}: {}", self.path.display(), e)),
            };
            self.data = Some(parsed);
        }
        Ok(self.data.as_mut().expect("store loaded"))
    }

    pub fn get(&mut self, key: &str) -> Result<Option<Value>, String> {
        Ok(self.load()?.get(key).cloned())
    }

    pub fn keys(&mut self) -> Result<Vec<String>, String> {
        Ok(self.load()?.keys().cloned().collect())
    }

    /// Setting `null` removes the key.
    pub fn set(&mut self, key: &str, value: Value) -> Result<(), String> {
        // Re-read before writing so a concurrent run's keys are merged rather
        // than overwritten by this run's cached copy.
        self.data = None;
        let mut next = self.load()?.clone();
        if value.is_null() {
            next.remove(key);
        } else {
            next.insert(key.to_string(), value);
        }
        self.persist(next)
    }

    pub fn delete(&mut self, key: &str) -> Result<Option<Value>, String> {
        self.data = None;
        let mut next = self.load()?.clone();
        let old = next.remove(key);
        if old.is_some() {
            self.persist(next)?;
        }
        Ok(old)
    }

    fn persist(&mut self, next: Map<String, Value>) -> Result<(), String> {
        let text = serde_json::to_string(&next).map_err(|e| e.to_string())?;
        if text.len() > MAX_STORE_BYTES {
            return Err(format!(
                "store would grow to {} bytes, over the {} byte limit",
                text.len(),
                MAX_STORE_BYTES
            ));
        }
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("create {}: {}", dir.display(), e))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, text).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
        fs::rename(&tmp, &self.path)
            .map_err(|e| format!("rename {}: {}", self.path.display(), e))?;
        self.data = Some(next);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn values_persist_across_instances() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.run-store.json");
        Store::at(path.clone()).set("k", json!({"a": 1})).unwrap();
        assert_eq!(Store::at(path).get("k").unwrap(), Some(json!({"a": 1})));
    }

    #[test]
    fn sessions_are_isolated_and_null_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = Store::at(dir.path().join("a.json"));
        let mut b = Store::at(dir.path().join("b.json"));
        a.set("k", json!(1)).unwrap();
        assert_eq!(b.get("k").unwrap(), None);
        a.set("k", Value::Null).unwrap();
        assert_eq!(a.get("k").unwrap(), None);
        a.set("x", json!(2)).unwrap();
        assert_eq!(a.delete("x").unwrap(), Some(json!(2)));
        assert!(a.keys().unwrap().is_empty());
    }

    #[test]
    fn corrupt_file_is_moved_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.json");
        fs::write(&path, "{not json").unwrap();
        let mut store = Store::at(path.clone());
        assert!(store.keys().unwrap().is_empty());
        store.set("ok", json!(true)).unwrap();
        assert_eq!(store.get("ok").unwrap(), Some(json!(true)));
        assert_eq!(
            fs::read_to_string(path.with_extension("json.corrupt")).unwrap(),
            "{not json"
        );
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn writes_from_two_runs_on_one_session_are_merged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.json");
        let mut a = Store::at(path.clone());
        let mut b = Store::at(path.clone());
        assert!(a.keys().unwrap().is_empty());
        assert!(b.keys().unwrap().is_empty());
        a.set("from_a", json!(1)).unwrap();
        b.set("from_b", json!(2)).unwrap();
        let mut keys = Store::at(path).keys().unwrap();
        keys.sort();
        assert_eq!(keys, vec!["from_a", "from_b"]);
    }

    #[test]
    fn unreadable_store_is_an_error_not_empty() {
        let dir = tempfile::tempdir().unwrap();
        // A directory at the store path cannot be read as a file.
        let path = dir.path().join("d.json");
        fs::create_dir(&path).unwrap();
        let mut store = Store::at(path);
        assert!(store.get("k").is_err());
        assert!(store.set("k", json!(1)).is_err());
    }

    #[test]
    fn oversized_write_is_rejected_and_file_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.json");
        let mut store = Store::at(path.clone());
        store.set("small", json!("v")).unwrap();
        let before = fs::read_to_string(&path).unwrap();
        let err = store
            .set("big", json!("x".repeat(MAX_STORE_BYTES + 1)))
            .unwrap_err();
        assert!(err.contains("limit"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        assert_eq!(store.get("big").unwrap(), None);
    }
}
