//! cockpit-publish stops when the process that started it goes, so the
//! helper app quitting leaves no runner behind. A shell starts it in the
//! background and exits; the publisher must follow within a few wakes.
//! PATH is emptied for it, so it reaches no real cmux, claude or gh, and
//! its folders are temp ones.

#![cfg(test)]

use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

/// Whether `pid` is still running: present, and not a zombie waiting to
/// be reaped.
fn running(pid: &str) -> bool {
    let out = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", pid])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    out.status.success() && !stat.trim().is_empty() && !stat.trim().starts_with('Z')
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cockpit-publish-exit-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Starts cockpit-publish from a shell that lives a second and exits,
/// with `parent` after `--parent` (the shell's pid, `$$`) or none, and
/// returns its pid once the shell has gone.
fn orphan(name: &str, parent: bool) -> (String, PathBuf, PathBuf) {
    let root = temp(&format!("{name}-root"));
    let config = temp(&format!("{name}-config"));
    let bin = env!("CARGO_BIN_EXE_cockpit-publish");
    let flag = if parent { "--parent $$" } else { "" };
    // Its output goes nowhere, so the shell's pipe closes with the shell
    // and this read returns, whether or not the publisher is still up.
    let script =
        format!(r#""$0" --root "$1" --config "$2" {flag} >/dev/null 2>&1 & echo $!; /bin/sleep 1"#);
    let out = Command::new("/bin/sh")
        .args([
            "-c",
            &script,
            bin,
            root.to_str().unwrap(),
            config.to_str().unwrap(),
        ])
        .env("PATH", "/nonexistent")
        .output()
        .unwrap();
    assert!(out.status.success());
    let pid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert!(!pid.is_empty());
    (pid, root, config)
}

/// Waits up to five seconds for `pid` to go, then makes sure it has:
/// never leaving one behind, even when the test fails.
fn gone_soon(pid: &str) -> bool {
    let started = Instant::now();
    while running(pid) && started.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(50));
    }
    let still = running(pid);
    if still {
        let _ = Command::new("/bin/kill").arg(pid).status();
    }
    !still
}

#[test]
fn stops_when_the_parent_it_was_given_goes() {
    let (pid, root, config) = orphan("named", true);
    assert!(gone_soon(&pid), "cockpit-publish {pid} outlived its parent");
    assert!(root.join("outbox").is_dir(), "it ran: it made its folder");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&config);
}

#[test]
fn stops_when_whoever_started_it_goes() {
    // However slowly it starts (a first launch is checked by macOS), it
    // either saw the shell as its parent and follows it, or was orphaned
    // before it looked and never starts.
    let (pid, root, config) = orphan("default", false);
    assert!(gone_soon(&pid), "cockpit-publish {pid} outlived its parent");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&config);
}
