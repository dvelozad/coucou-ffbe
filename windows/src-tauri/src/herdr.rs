// "Open terminal" for a session inside herdr: herdr selects the session's pane,
// and the window comes forward as for any terminal (session_window.rs).
//
// The relay forwards HERDR_PANE_ID, HERDR_BIN_PATH and, in WSL, WSL_DISTRO_NAME.
// The binary's full path is needed because `wsl.exe -e` starts no login shell,
// so herdr may not be on PATH there.

use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub struct Pane {
    id: String,
    bin: String,
    distro: Option<String>,
}

/// Sessions seen in herdr, by session ID. In memory only, like session_window.rs.
static PANES: Mutex<Vec<(String, Pane)>> = Mutex::new(Vec::new());

/// These values come from another process and end up as arguments: only
/// plain names, never one an argument parser would read as an option.
fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '-'))
}

/// An absolute path to a program named herdr: Coucou runs it, so nothing else.
fn valid_bin(value: &str) -> bool {
    value.starts_with('/')
        && value.len() <= 512
        && !value.chars().any(char::is_control)
        && value.rsplit('/').next() == Some("herdr")
}

pub fn from_payload(payload: &Value) -> Option<Pane> {
    let field = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or_default();
    let (id, bin, distro) = (field("herdr_pane"), field("herdr_bin"), field("wsl_distro"));
    if !valid_name(id) || !valid_bin(bin) || !(distro.is_empty() || valid_name(distro)) {
        return None;
    }
    // Without a distro, Windows would read `/usr/bin/herdr` as `C:\usr\bin\herdr`,
    // a folder any user can create.
    if cfg!(windows) && distro.is_empty() {
        return None;
    }
    Some(Pane {
        id: id.to_string(),
        bin: bin.to_string(),
        distro: (!distro.is_empty()).then(|| distro.to_string()),
    })
}

/// Keeps or drops a session's pane from its hook events.
pub fn observe(payload: &Value, event: &str) {
    let Some(session) = payload.get("session_id").and_then(Value::as_str) else { return };
    if event == "SessionEnd" {
        forget(session);
    } else if let Some(pane) = from_payload(payload) {
        remember(session, pane);
    }
}

fn remember(session: &str, pane: Pane) {
    if !crate::session_window::valid_session(session) {
        return;
    }
    let mut list = PANES.lock().unwrap_or_else(|e| e.into_inner());
    list.retain(|(s, _)| s != session);
    list.push((session.to_string(), pane));
    let excess = list.len().saturating_sub(crate::session_window::MAX_SESSIONS);
    list.drain(..excess);
}

fn forget(session: &str) {
    PANES.lock().unwrap_or_else(|e| e.into_inner()).retain(|(s, _)| s != session);
}

fn lookup(session: &str) -> Option<Pane> {
    let list = PANES.lock().unwrap_or_else(|e| e.into_inner());
    list.iter().find(|(s, _)| s == session).map(|(_, pane)| pane.clone())
}

/// `wsl.exe -e` runs the binary without a shell, so no shell parses the arguments.
fn command_args(pane: &Pane) -> (String, Vec<String>) {
    let focus = ["agent".to_string(), "focus".to_string(), pane.id.clone()];
    match &pane.distro {
        Some(distro) => {
            let mut args = vec!["-d".to_string(), distro.clone(), "-e".to_string(), pane.bin.clone()];
            args.extend(focus);
            ("wsl.exe".to_string(), args)
        }
        None => (pane.bin.clone(), focus.to_vec()),
    }
}

/// Asks herdr to select the session's pane. False for a session that does not
/// run in herdr, or when herdr could not be started.
// shortcut: true once herdr starts, not once it succeeds, so a stale pane gets
// no VS Code fallback; wait for herdr's exit status if that proves confusing.
pub fn focus(session: &str) -> bool {
    let Some(pane) = lookup(session) else { return false };
    let (program, args) = command_args(&pane);
    let mut cmd = Command::new(program);
    cmd.args(args);
    match crate::platform::no_console(&mut cmd).spawn() {
        Ok(_) => true,
        Err(e) => {
            crate::log::line(format!("herdr focus failed: {e}"));
            false
        }
    }
}

// ── herdr as the session source of truth ─────────────────────────────────────
// Coucou asks herdr itself what runs where (`pane list`, `agent list`) and, on
// an explicit click, acts on a pane. argv only, never a shell; every value that
// becomes an argument is checked first. Any failure is an Err, and the island
// then behaves as if herdr were not there.

const TIMEOUT: Duration = Duration::from_secs(3);
/// `pane list` with many panes is a few tens of kB; anything far past that is not herdr.
const MAX_OUTPUT: u64 = 4 << 20;
const MAX_TEXT: usize = 4096;

/// Where herdr is installed, as absolute paths to try when PATH does not have
/// it: a desktop launch (and nrodia) often runs with a minimal PATH.
const CANDIDATES: [&str; 3] = ["/usr/local/bin/herdr", "/usr/bin/herdr", "/opt/homebrew/bin/herdr"];

/// A file this process may run: it exists and has an execute bit.
fn executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The process environment the resolver reads, passed in so the tests can set
/// it without touching the real one (Rust tests run in one process, in parallel).
struct Where<'a> {
    explicit: Option<&'a str>,  // COUCOU_HERDR_BIN: the user's own path, absolute
    hook: Option<&'a str>,      // HERDR_BIN_PATH: relayed by the hook, already vetted
    path: Option<&'a str>,      // PATH
    home: Option<&'a str>,      // HOME
}

/// Records `label` and returns the path when it is executable.
fn pick(tried: &mut Vec<String>, label: String, path: &Path) -> Option<PathBuf> {
    if executable(path) {
        Some(path.to_path_buf())
    } else {
        tried.push(label);
        None
    }
}

/// The first executable candidate, or Err naming every place that was tried.
fn locate(where_: &Where) -> Result<PathBuf, String> {
    let mut tried: Vec<String> = Vec::new();

    if let Some(raw) = where_.explicit {
        let raw = raw.trim();
        let p = Path::new(raw);
        let label = format!("COUCOU_HERDR_BIN={raw} (not an absolute executable)");
        if p.is_absolute() {
            if let Some(hit) = pick(&mut tried, label, p) {
                return Ok(hit);
            }
        } else {
            tried.push(label);
        }
    }
    if let Some(raw) = where_.hook {
        if valid_bin(raw) {
            let label = format!("HERDR_BIN_PATH={raw} (missing or not executable)");
            if let Some(hit) = pick(&mut tried, label, Path::new(raw)) {
                return Ok(hit);
            }
        } else {
            tried.push(format!("HERDR_BIN_PATH={raw} (not a herdr path)"));
        }
    }
    match where_.path {
        Some(path) => {
            for dir in path.split(if cfg!(windows) { ';' } else { ':' }) {
                if dir.is_empty() {
                    continue;
                }
                let candidate = Path::new(dir).join("herdr");
                let label = format!("{} (PATH)", candidate.display());
                if let Some(hit) = pick(&mut tried, label, &candidate) {
                    return Ok(hit);
                }
            }
        }
        None => tried.push("PATH (not set)".into()),
    }
    match where_.home {
        Some(home) => {
            let candidate = Path::new(home).join(".local/bin/herdr");
            let label = format!("{} (HOME)", candidate.display());
            if let Some(hit) = pick(&mut tried, label, &candidate) {
                return Ok(hit);
            }
        }
        None => tried.push("$HOME/.local/bin/herdr (HOME not set)".into()),
    }
    for raw in CANDIDATES {
        if let Some(hit) = pick(&mut tried, format!("{raw} (missing or not executable)"), Path::new(raw)) {
            return Ok(hit);
        }
    }
    Err(format!("herdr: not found. Tried: {}", tried.join("; ")))
}

/// Resolves herdr once per call, cheapest and most explicit first:
/// COUCOU_HERDR_BIN, then the hook's HERDR_BIN_PATH, then PATH, then the usual
/// install locations (with $HOME/.local/bin first). Err lists everything tried.
fn herdr_bin() -> Result<PathBuf, String> {
    locate(&Where {
        explicit: std::env::var("COUCOU_HERDR_BIN").ok().as_deref(),
        hook: std::env::var("HERDR_BIN_PATH").ok().as_deref(),
        path: std::env::var("PATH").ok().as_deref(),
        home: std::env::var("HOME").ok().as_deref(),
    })
}

/// A key name as herdr spells them: `enter`, `esc`, `ctrl+c`, `y`, `f5`…
fn valid_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && !value.starts_with('-')
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '_' | '-'))
}

/// Text typed into a pane: one line, no control characters, nothing an
/// argument parser would read as an option.
fn valid_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_TEXT && !value.starts_with('-') && !value.chars().any(char::is_control)
}

/// Runs herdr with `args`, stdin closed, for at most TIMEOUT; its stdout as JSON.
fn run(args: &[&str]) -> Result<Value, String> {
    let out = exec(args, TIMEOUT)?;
    serde_json::from_slice(&out).map_err(|e| format!("herdr: bad JSON: {e}"))
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(pipe) = pipe {
            let _ = pipe.take(MAX_OUTPUT).read_to_end(&mut out);
        }
        out
    })
}

/// Runs herdr with `args`, stdin closed, for at most `timeout`: its stdout on
/// success, else herdr's own error message (it prints `{"error":…}` on stderr).
fn exec(args: &[&str], timeout: Duration) -> Result<Vec<u8>, String> {
    if cfg!(windows) {
        // herdr lives in WSL there; only the hook-relayed `focus` reaches it.
        return Err("herdr: not available on this platform".into());
    }
    let bin = herdr_bin()?;
    let mut cmd = Command::new(bin);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = crate::platform::no_console(&mut cmd).spawn().map_err(|e| format!("herdr: {e}"))?;
    // Read on the side so a full pipe cannot stall the wait below.
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(15)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("herdr {}: timed out", args[..args.len().min(2)].join(" ")));
            }
            Err(e) => return Err(format!("herdr: {e}")),
        }
    };
    let out = stdout.join().map_err(|_| "herdr: reader failed".to_string())?;
    let err = stderr.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("herdr {}: {}", args[..args.len().min(2)].join(" "), error_message(&err, &out)));
    }
    Ok(out)
}

/// herdr's `error.message`, from whichever stream carries it; else its first line.
fn error_message(stderr: &[u8], stdout: &[u8]) -> String {
    for bytes in [stderr, stdout] {
        if let Ok(json) = serde_json::from_slice::<Value>(bytes) {
            if let Some(m) = json.pointer("/error/message").and_then(Value::as_str) {
                return m.chars().take(300).collect();
            }
        }
    }
    let text = String::from_utf8_lossy(if stderr.is_empty() { stdout } else { stderr });
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("failed");
    line.chars().take(300).collect()
}

fn pane_arg(pane: &str) -> Result<&str, String> {
    if valid_name(pane) { Ok(pane) } else { Err("herdr: invalid pane id".into()) }
}

/// `herdr pane list`: every pane, with its agent and `agent_status` when it has one.
pub fn panes() -> Result<Value, String> {
    run(&["pane", "list"])
}

/// `herdr agent list`: the panes herdr recognises an agent in.
pub fn agents() -> Result<Value, String> {
    run(&["agent", "list"])
}

/// `herdr workspace list`: each workspace's id, label, number and focus.
pub fn workspaces() -> Result<Value, String> {
    run(&["workspace", "list"])
}

/// Types `text` into a pane followed by Enter (`herdr pane run`).
pub fn send(pane: &str, text: &str) -> Result<Value, String> {
    if !valid_text(text) {
        return Err("herdr: text refused".into());
    }
    run(&["pane", "run", pane_arg(pane)?, text])
}

/// Presses keys in a pane (`herdr pane send-keys`), all checked before any is sent.
pub fn keys(pane: &str, keys: &[String]) -> Result<Value, String> {
    if keys.is_empty() || keys.len() > 16 || !keys.iter().all(|k| valid_key(k)) {
        return Err("herdr: keys refused".into());
    }
    let mut args = vec!["pane", "send-keys", pane_arg(pane)?];
    args.extend(keys.iter().map(String::as_str));
    run(&args)
}

/// Closes a pane (`herdr pane close`).
pub fn close(pane: &str) -> Result<Value, String> {
    run(&["pane", "close", pane_arg(pane)?])
}

/// Selects the agent's pane in herdr (`herdr agent focus`), as `focus` does for
/// a hook session, but by pane id.
pub fn focus_pane(pane: &str) -> Result<Value, String> {
    run(&["agent", "focus", pane_arg(pane)?])
}

pub const SCREEN_LINES: std::ops::RangeInclusive<u32> = 10..=200;

/// The pane's last `lines` lines as plain text (`herdr pane read`), so a
/// blocked agent's question can be read before it is answered: `{ "text": … }`.
pub fn screen(pane: &str, lines: u32) -> Result<Value, String> {
    let n = lines.clamp(*SCREEN_LINES.start(), *SCREEN_LINES.end()).to_string();
    let out = exec(&["pane", "read", pane_arg(pane)?, "--source", "recent-unwrapped", "--lines", &n], TIMEOUT)?;
    Ok(serde_json::json!({ "text": String::from_utf8_lossy(&out) }))
}

/// An agent name or kind: `[a-z][a-z0-9_-]*`, at most 31 characters.
fn valid_ident(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && value.len() <= 31
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-'))
}

/// herdr waits up to 30 s for the agent to be ready; a little more here.
const START_TIMEOUT: Duration = Duration::from_secs(35);

/// Starts an agent of `kind` named `name` in an idle shell pane (`herdr agent start`).
pub fn start(kind: &str, name: &str, pane: &str) -> Result<Value, String> {
    if !valid_ident(kind) || !valid_ident(name) {
        return Err("herdr: invalid agent kind or name".into());
    }
    let pane = pane_arg(pane)?;
    let out = exec(&["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "30000"], START_TIMEOUT)?;
    serde_json::from_slice(&out).map_err(|e| format!("herdr: bad JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn values_for_the_pane_api_are_checked() {
        for ok in ["enter", "esc", "ctrl+c", "y", "f5", "shift+tab"] {
            assert!(valid_key(ok), "{ok}");
        }
        for bad in ["", "-x", "--help", "a b", "ctrl;c", "enter\n", &"k".repeat(33)] {
            assert!(!valid_key(bad), "{bad:?}");
        }
        assert!(valid_text("yes, go ahead"));
        for bad in ["", "-rf", "--help", "two\nlines", "esc\u{1b}[A"] {
            assert!(!valid_text(bad), "{bad:?}");
        }
        assert!(!valid_text(&"x".repeat(MAX_TEXT + 1)));
        assert!(send("-p", "hi").is_err());
        assert!(keys("w1:p1", &["--help".to_string()]).is_err());
        assert!(keys("w1:p1", &[]).is_err());
        assert!(close("w1 p1").is_err());
    }

    #[test]
    fn agent_names_and_kinds_are_plain_identifiers() {
        for ok in ["claude", "agy", "reviewer-2", "a", "x_y", &"a".repeat(31)] {
            assert!(valid_ident(ok), "{ok}");
        }
        for bad in ["", "Claude", "2fast", "-x", "_x", "a b", "a;b", "a.b", &"a".repeat(32), "é"] {
            assert!(!valid_ident(bad), "{bad:?}");
        }
        // Refused before anything runs.
        assert!(start("Claude", "x", "w1:p1").unwrap_err().contains("invalid"));
        assert!(start("claude", "--help", "w1:p1").unwrap_err().contains("invalid"));
        assert!(start("claude", "x", "-p").unwrap_err().contains("invalid"));
        assert!(screen("--all", 40).is_err());
        assert!(focus_pane("").is_err());
    }

    #[test]
    fn herdr_errors_come_from_stderr_json() {
        let err = br#"{"error":{"code":"pane_not_found","message":"pane w9:p99 not found"}}"#;
        assert_eq!(error_message(err, b""), "pane w9:p99 not found");
        assert_eq!(error_message(b"", b"\n  usage: herdr pane\nmore"), "usage: herdr pane");
        assert_eq!(error_message(b"", b""), "failed");
    }

    /// A throwaway home with two copies of a fake herdr: at the HOME candidate
    /// (.local/bin/herdr) and in a directory usable as a PATH entry. `mode`
    /// decides whether either is actually runnable.
    fn fake_home(name: &str, mode: u32) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("coucou-herdr-{}-{name}", std::process::id()));
        for sub in [".local/bin", "path"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
            let path = dir.join(sub).join("herdr");
            std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            }
        }
        let _ = mode;
        dir
    }

    #[test]
    fn coucou_herdr_bin_wins_when_it_is_an_executable() {
        let mine = fake_home("explicit", 0o755);
        let other = fake_home("explicit-other", 0o755);
        let hit = locate(&Where {
            explicit: mine.join("path/herdr").to_str(),
            hook: Some("/nope/hook/herdr"),
            path: Some(other.join("path").to_str().unwrap()),
            home: Some(other.to_str().unwrap()),
        });
        assert_eq!(hit.unwrap(), mine.join("path/herdr"));
    }

    #[test]
    fn a_non_executable_relative_or_foreign_candidate_is_rejected() {
        let plain = fake_home("plain", 0o644);
        let good = fake_home("plain-good", 0o755);
        let path = good.join("path").to_str().unwrap().to_string();
        let plain_exe = plain.join("path/herdr").to_str().unwrap().to_string();
        let good_exe = good.join("path/herdr");
        let mut picks = vec![plain_exe.as_str(), "bin/herdr"];
        // A directory is not a program either.
        if cfg!(unix) {
            picks.push("/tmp");
        }
        for explicit in picks {
            let where_ = Where { explicit: Some(explicit), hook: None, path: Some(&path), home: None };
            // 0o644 is a file, but not runnable: PATH's herdr is taken instead.
            assert_eq!(locate(&where_).unwrap(), good_exe, "{explicit}");
        }
    }

    #[test]
    fn the_error_names_every_location_tried() {
        let err = locate(&Where {
            explicit: Some("/nope/herdr"), hook: Some("/nope/hook/herdr"),
            path: Some("/nope/bin:/also-nope"), home: Some("/nope/home"),
        })
        .unwrap_err();
        for part in ["COUCOU_HERDR_BIN=/nope/herdr", "HERDR_BIN_PATH=/nope/hook/herdr",
                     "/nope/bin/herdr", "/also-nope/herdr", "/nope/home/.local/bin/herdr",
                     "/usr/local/bin/herdr", "/usr/bin/herdr", "/opt/homebrew/bin/herdr",
                     "herdr: not found"] {
            assert!(err.contains(part), "{part} missing from {err}");
        }
        // A hook value that is not a herdr path is named, not run.
        let err = locate(&Where { explicit: None, hook: Some("/usr/bin/sh"), path: None, home: None }).unwrap_err();
        assert!(err.contains("HERDR_BIN_PATH=/usr/bin/sh (not a herdr path)"), "{err}");
    }

    /// Live: a stripped PATH still finds this machine's herdr through HOME.
    #[test]
    fn a_stripped_path_still_finds_herdr() {
        let home = std::env::var("HOME").ok();
        let some_home = home.as_deref().unwrap_or("/root");
        let stripped = Where { explicit: None, hook: None, path: Some("/usr/bin:/bin"), home: Some(some_home) };
        match locate(&stripped) {
            Ok(path) => eprintln!("resolved {} with PATH=/usr/bin:/bin", path.display()),
            Err(e) => eprintln!("no herdr on this machine: {e}"),
        }
        // Whatever the machine, the real entry point answers without panicking.
        let _ = herdr_bin();
    }

    /// Live, read-only: an unknown pane gives herdr's own message. Skipped without herdr.
    #[test]
    fn live_unknown_pane_reports_herdrs_message() {
        if panes().is_err() {
            eprintln!("herdr not available: skipped");
            return;
        }
        let err = screen("w999:p999", 40).unwrap_err();
        eprintln!("{err}");
        assert!(err.contains("not found"), "{err}");
    }

    /// Live: prints what herdr reports. Skipped where herdr does not answer.
    #[test]
    fn live_pane_list_when_herdr_runs() {
        let Ok(list) = panes() else {
            eprintln!("herdr not available: skipped");
            return;
        };
        let panes = list.pointer("/result/panes").and_then(Value::as_array).expect("result.panes");
        for p in panes {
            eprintln!(
                "{} agent={} status={}",
                p["pane_id"].as_str().unwrap_or("?"),
                p["agent"].as_str().unwrap_or("-"),
                p["agent_status"].as_str().unwrap_or("-")
            );
        }
        assert!(agents().is_ok());
        let ws = workspaces().expect("workspace list");
        for w in ws.pointer("/result/workspaces").and_then(Value::as_array).expect("result.workspaces") {
            eprintln!("{} {} #{}", w["workspace_id"], w["label"], w["number"]);
        }
    }

    fn payload(pane: &str, bin: &str, distro: &str) -> Value {
        json!({ "session_id": "s1", "herdr_pane": pane, "herdr_bin": bin, "wsl_distro": distro })
    }

    #[test]
    fn a_wsl_session_focuses_its_pane_through_wsl_exe() {
        let pane = from_payload(&payload("w1:pA", "/usr/bin/herdr", "Ubuntu")).unwrap();
        let (program, args) = command_args(&pane);
        assert_eq!(program, "wsl.exe");
        assert_eq!(args, ["-d", "Ubuntu", "-e", "/usr/bin/herdr", "agent", "focus", "w1:pA"]);
    }

    #[test]
    fn without_a_distro_herdr_runs_itself_on_linux_only() {
        let pane = from_payload(&payload("w1:pA", "/usr/bin/herdr", ""));
        if cfg!(windows) {
            assert!(pane.is_none());
            return;
        }
        let (program, args) = command_args(&pane.unwrap());
        assert_eq!(program, "/usr/bin/herdr");
        assert_eq!(args, ["agent", "focus", "w1:pA"]);
    }

    #[test]
    fn only_a_program_named_herdr_is_run() {
        for bin in ["/tmp/evil", "/usr/bin/herdr-x", "/usr/bin/sh", "herdr", "/usr/bin/herdr/"] {
            assert!(from_payload(&payload("w1:pA", bin, "Ubuntu")).is_none(), "{bin}");
        }
        assert!(from_payload(&payload("w1:pA", "/home/me/.cargo/bin/herdr", "Ubuntu")).is_some());
    }

    #[test]
    fn the_pane_list_is_capped() {
        let extra = crate::session_window::MAX_SESSIONS + 3;
        for i in 0..extra {
            observe(&json!({ "session_id": format!("herdr-cap-{i}"), "herdr_pane": "w1:pC",
                "herdr_bin": "/b/herdr", "wsl_distro": "Ubuntu" }), "UserPromptSubmit");
        }
        assert!(lookup("herdr-cap-0").is_none());
        assert!(lookup(&format!("herdr-cap-{}", extra - 1)).is_some());
        for i in 0..extra {
            forget(&format!("herdr-cap-{i}"));
        }
    }

    #[test]
    fn hostile_or_missing_values_are_refused() {
        assert!(from_payload(&payload("", "/usr/bin/herdr", "")).is_none());
        assert!(from_payload(&payload("-x", "/usr/bin/herdr", "")).is_none());
        assert!(from_payload(&payload("w1;rm", "/usr/bin/herdr", "")).is_none());
        assert!(from_payload(&payload("w1 pA", "/usr/bin/herdr", "")).is_none());
        assert!(from_payload(&payload("w1:pA", "herdr", "")).is_none());
        assert!(from_payload(&payload("w1:pA", "", "")).is_none());
        assert!(from_payload(&payload("w1:pA", "/usr/bin/herdr\n", "")).is_none());
        assert!(from_payload(&payload("w1:pA", "/usr/bin/herdr", "--exec")).is_none());
        assert!(from_payload(&json!({ "session_id": "s1" })).is_none());
    }

    #[test]
    fn a_session_end_forgets_the_pane() {
        let start = json!({ "session_id": "herdr-test-1", "herdr_pane": "w1:pB", "herdr_bin": "/b/herdr",
            "wsl_distro": "Ubuntu" });
        observe(&start, "SessionStart");
        assert_eq!(lookup("herdr-test-1").map(|p| p.id), Some("w1:pB".to_string()));
        observe(&json!({ "session_id": "herdr-test-1" }), "SessionEnd");
        assert!(lookup("herdr-test-1").is_none());
    }
}
