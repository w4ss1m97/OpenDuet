//! Duet desktop shell: starts the local Postgres/server/app and shows the app in a window.
use std::ffi::OsString;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

pub mod launcher;

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Reuse,
    Spawn,
}

/// True when 127.0.0.1:port accepts a connection.
pub fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

/// Reuse a service already listening on the port, never spawn a second one.
pub fn decide_spawn(port: u16) -> Decision {
    if port_open(port) {
        Decision::Reuse
    } else {
        Decision::Spawn
    }
}

/// First candidate that exists as a file.
pub fn resolve_bun(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.is_file()).cloned()
}

pub fn bun_candidates(home: &str) -> Vec<PathBuf> {
    vec![
        PathBuf::from(home).join(".bun/bin/bun"),
        PathBuf::from("/opt/homebrew/bin/bun"),
        PathBuf::from("/usr/local/bin/bun"),
    ]
}

fn repo_root_from(env: Option<OsString>, home: &str) -> PathBuf {
    match env {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => PathBuf::from(home).join("src/OpenDuet"),
    }
}

/// DUET_REPO, default $HOME/src/OpenDuet.
pub fn repo_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    repo_root_from(std::env::var_os("DUET_REPO"), &home)
}

pub fn run() {
    launcher::run();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn port_open_true_and_false() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(port_open(port));
        drop(l);
        assert!(!port_open(port));
    }

    #[test]
    fn decide_spawn_reuses_open_port() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        assert_eq!(decide_spawn(port), Decision::Reuse);
        drop(l);
        assert_eq!(decide_spawn(port), Decision::Spawn);
    }

    #[test]
    fn resolve_bun_picks_first_existing() {
        let dir = std::env::temp_dir().join(format!("duet-bun-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b, c) = (dir.join("a"), dir.join("b"), dir.join("c"));
        std::fs::write(&b, "").unwrap();
        std::fs::write(&c, "").unwrap();
        assert_eq!(resolve_bun(&[a.clone(), b.clone(), c.clone()]), Some(b));
        assert_eq!(resolve_bun(&[a]), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn repo_root_honours_duet_repo() {
        assert_eq!(repo_root_from(Some("/x/y".into()), "/h"), PathBuf::from("/x/y"));
        assert_eq!(repo_root_from(None, "/h"), PathBuf::from("/h/src/OpenDuet"));
        std::env::set_var("DUET_REPO", "/tmp/duet-test-repo");
        assert_eq!(repo_root(), PathBuf::from("/tmp/duet-test-repo"));
        std::env::remove_var("DUET_REPO");
    }
}
