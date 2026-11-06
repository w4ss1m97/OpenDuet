//! Startup sequence and child-process lifecycle (not unit-tested: needs real services).
use crate::{bun_candidates, decide_spawn, port_open, repo_root, resolve_bun, Decision};
use std::fs::{self, File};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, Url, WebviewWindow};

type Children = Arc<Mutex<Vec<Child>>>;

fn show(win: &WebviewWindow, msg: &str) {
    let js = format!(
        "document.getElementById('msg').textContent={}",
        serde_json::to_string(msg).unwrap()
    );
    let _ = win.eval(&js);
}

fn wait_for(port: u16, secs: u64) -> bool {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if port_open(port) {
            return true;
        }
        sleep(Duration::from_millis(500));
    }
    false
}

fn ensure_postgres(win: &WebviewWindow) -> bool {
    if port_open(5432) {
        return true;
    }
    show(win, "Starting Postgres…");
    let docker = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file());
    if let Some(d) = docker {
        let _ = Command::new(d)
            .args(["start", "openduet-postgres-1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    if wait_for(5432, 30) {
        return true;
    }
    show(
        win,
        "Postgres is not reachable on 127.0.0.1:5432.\nStart Docker, then run: docker start openduet-postgres-1\nand reopen Duet.",
    );
    false
}

/// Spawn in its own process group so the whole tree can be killed on exit.
fn spawn(bun: &Path, dir: &Path, args: &[&str], envs: &[(&str, &str)], log: &Path) -> std::io::Result<Child> {
    if let Some(p) = log.parent() {
        fs::create_dir_all(p)?;
    }
    let out = File::create(log)?;
    let err = out.try_clone()?;
    let mut cmd = Command::new(bun);
    cmd.args(args).current_dir(dir).stdout(out).stderr(err).process_group(0);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    cmd.spawn()
}

fn startup(win: WebviewWindow, children: Children) {
    let home = std::env::var("HOME").unwrap_or_default();
    let repo = repo_root();
    let logs = repo.join("logs");
    let (server_log, app_log) = (logs.join("duet-desktop-server.log"), logs.join("duet-desktop-app.log"));

    let Some(bun) = resolve_bun(&bun_candidates(&home)) else {
        show(&win, "bun not found in ~/.bun/bin, /opt/homebrew/bin or /usr/local/bin.");
        return;
    };
    if !ensure_postgres(&win) {
        return;
    }
    show(&win, "Starting Duet…");

    if decide_spawn(3001) == Decision::Spawn {
        match spawn(
            &bun,
            &repo.join("openbot/server"),
            &["--env-file=../.env", "src/index.ts"],
            &[("OPENDUET_COCKPIT", "1"), ("OPENBOT_HOST", "127.0.0.1,::1")],
            &server_log,
        ) {
            Ok(c) => children.lock().unwrap().push(c),
            Err(e) => return show(&win, &format!("Could not start the server: {e}")),
        }
    }
    if decide_spawn(3010) == Decision::Spawn {
        match spawn(
            &bun,
            &repo.join("openbot/app"),
            &["--env-file=../.env", "--bun", "node_modules/vite/bin/vite.js"],
            &[("OPENBOT_HOST", "127.0.0.1")],
            &app_log,
        ) {
            Ok(c) => children.lock().unwrap().push(c),
            Err(e) => return show(&win, &format!("Could not start the app: {e}")),
        }
    }

    if wait_for(3010, 90) {
        // The page is polled over HTTP too: the port can open before vite serves.
        let end = Instant::now() + Duration::from_secs(30);
        while Instant::now() < end && !http_ok() {
            sleep(Duration::from_millis(500));
        }
        let _ = win.navigate(Url::parse("http://localhost:3010/").unwrap());
    } else {
        show(
            &win,
            &format!(
                "Duet did not start within 90 s.\nLogs:\n{}\n{}",
                server_log.display(),
                app_log.display()
            ),
        );
    }
}

fn http_ok() -> bool {
    use std::io::{Read, Write};
    let Ok(mut s) = std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], 3010).into(), Duration::from_secs(2)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = s.write_all(b"GET / HTTP/1.0\r\nHost: localhost:3010\r\n\r\n");
    let mut buf = [0u8; 12];
    s.read_exact(&mut buf).is_ok() && buf.starts_with(b"HTTP/")
}

fn kill_children(children: &Children) {
    for c in children.lock().unwrap().iter_mut() {
        // Negative pid targets the whole process group created by process_group(0).
        unsafe { libc::kill(-(c.id() as i32), libc::SIGTERM) };
        let _ = c.kill();
        let _ = c.wait();
    }
    children.lock().unwrap().clear();
}

pub fn run() {
    let children: Children = Arc::new(Mutex::new(Vec::new()));
    let c2 = children.clone();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let win = app.get_webview_window("main").expect("main window");
            let c = c2.clone();
            std::thread::spawn(move || startup(win, c));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building Duet");
    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            kill_children(&children);
        }
    });
}
