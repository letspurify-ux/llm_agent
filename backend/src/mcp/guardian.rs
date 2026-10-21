//! Ends the stdio servers' process groups when the backend ends without
//! ending them: killed outright (SIGKILL, the out-of-memory killer, a force
//! quit) or crashed. Their input closed then, and a server that exits at
//! the end of its input ended with it; one that outlives it — a Node server
//! holding a database pool, a container, a process the server started —
//! ran on with no parent, and each restart of the backend added another
//! (three kills, three left running). Windows ends them with the job object
//! the backend holds (`JobObject`, kill on close).
//!
//! A shell of its own, the guardian, is told each group as it starts and as
//! it ends, on its input. The backend's end, however it comes, ends that
//! input: the groups it was told and not told ended are given the time a
//! closed server gets (`end_process`), then SIGTERM, as long again, and
//! killed. It is in a process group of its own and ignores the signals a
//! terminal sends, so a Ctrl+C that stops the backend leaves it to watch.

use process_wrap::tokio::ChildWrapper;
use std::{
    collections::BTreeSet,
    io::Write,
    os::{fd::AsRawFd, unix::process::CommandExt},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
};

/// The guardian: groups `+ID` and `-ID` a line on its input; at its end,
/// those left are ended.
const SCRIPT: &str = r#"trap '' HUP INT QUIT TERM
groups=' '
while IFS= read -r line; do
  case $line in
    +*) groups="$groups${line#+} " ;;
    -*) kept=' '
        for g in $groups; do [ "$g" = "${line#-}" ] || kept="$kept$g "; done
        groups=$kept ;;
  esac
done
[ "$groups" = ' ' ] && exit 0
sleep "$1"
for g in $groups; do kill -s TERM -- "-$g" 2>/dev/null; done
sleep "$1"
for g in $groups; do kill -s KILL -- "-$g" 2>/dev/null; done
exit 0
"#;

struct Guardian {
    child: Child,
    input: ChildStdin,
}

struct Watch {
    guardian: Option<Guardian>,
    /// The groups started and not yet ended, told to a guardian started anew.
    groups: BTreeSet<u32>,
    /// Said once: no guardian could be started.
    said: bool,
}

static WATCH: Mutex<Watch> = Mutex::new(Watch { guardian: None, groups: BTreeSet::new(), said: false });

/// `child`, its process group watched until it is dropped.
pub(super) fn watched(child: Box<dyn ChildWrapper>) -> Box<dyn ChildWrapper> {
    let Some(group) = child.id() else {
        return child;
    };
    let mut watch = WATCH.lock().unwrap_or_else(|p| p.into_inner());
    watch.groups.insert(group);
    watch.tell(&format!("+{group}\n"));
    drop(watch);
    Box::new(Watched { inner: Some(child), group })
}

fn forget(group: u32) {
    let mut watch = WATCH.lock().unwrap_or_else(|p| p.into_inner());
    if watch.groups.remove(&group) {
        watch.tell(&format!("-{group}\n"));
    }
}

impl Watch {
    /// Tells the guardian `line`. One that is gone, or not reading (its
    /// input full), is ended and another started, told every group.
    fn tell(&mut self, line: &str) {
        if let Some(guardian) = &mut self.guardian {
            if guardian.input.write_all(line.as_bytes()).is_ok() {
                return;
            }
            if let Some(mut gone) = self.guardian.take() {
                let _ = gone.child.kill();
                let _ = gone.child.wait();
            }
        }
        let told = start().and_then(|mut guardian| {
            let all: String = self.groups.iter().map(|group| format!("+{group}\n")).collect();
            guardian.input.write_all(all.as_bytes())?;
            Ok(guardian)
        });
        match told {
            Ok(guardian) => self.guardian = Some(guardian),
            Err(e) if !self.said => {
                self.said = true;
                eprintln!("[mcp] could not start the process that ends MCP servers left by a killed backend: {e}");
            }
            Err(_) => {}
        }
    }
}

fn start() -> std::io::Result<Guardian> {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(SCRIPT)
        .arg("llm-agent-mcp-guardian")
        .arg(super::EXIT_GRACE_SECS.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Nothing of the backend's environment (its .env's passwords) and
        // no hold on its folder: only `sleep` to find.
        .env_clear()
        .env("PATH", "/bin:/usr/bin")
        .current_dir("/")
        .process_group(0);
    // Holding another server's pipe, it would keep that server from being
    // seen to end; holding nothing of the backend's, its input ends with it.
    super::own_descriptors_only(&mut command);
    let mut child = command.spawn()?;
    let Some(input) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(std::io::Error::other("no input"));
    };
    // A guardian that stopped reading fails a write instead of holding
    // the thread that writes.
    // SAFETY: fcntl reads and sets the flags of a descriptor this owns.
    unsafe {
        let fd = input.as_raw_fd();
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            let error = std::io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    }
    Ok(Guardian { child, input })
}

/// A server's process, its group watched while this lives.
#[derive(Debug)]
struct Watched {
    inner: Option<Box<dyn ChildWrapper>>,
    group: u32,
}

impl ChildWrapper for Watched {
    fn inner(&self) -> &dyn ChildWrapper {
        &**self.inner.as_ref().expect("held until dropped")
    }

    fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
        &mut **self.inner.as_mut().expect("held until dropped")
    }

    fn into_inner(mut self: Box<Self>) -> Box<dyn ChildWrapper> {
        forget(self.group);
        self.inner.take().expect("held until dropped")
    }
}

impl Drop for Watched {
    fn drop(&mut self) {
        if self.inner.is_some() {
            forget(self.group);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    /// A process group of its own, its leader reaped by a thread here.
    fn group() -> u32 {
        let mut child = Command::new("sleep").arg("600").process_group(0).spawn().unwrap();
        let pid = child.id();
        std::thread::spawn(move || child.wait());
        pid
    }

    fn gone_within(pid: u32, limit: Duration) -> bool {
        let started = Instant::now();
        while alive(pid) {
            if started.elapsed() > limit {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }

    /// At the end of its input the guardian ends the groups it was told and
    /// not told ended, and only those.
    #[test]
    fn the_guardian_ends_the_groups_left_at_its_end() {
        let (left, ended) = (group(), group());
        let mut guardian = start().unwrap();
        guardian.input.write_all(format!("+{left}\n+{ended}\n-{ended}\n").as_bytes()).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(alive(left) && alive(ended));
        drop(guardian.input);
        assert!(gone_within(left, Duration::from_secs(super::super::EXIT_GRACE_SECS + 5)), "the group left was ended");
        assert!(guardian.child.wait().unwrap().success());
        assert!(alive(ended), "a group told ended is not touched");
        // SAFETY: ends the test's own group.
        unsafe { libc::killpg(ended as libc::pid_t, libc::SIGKILL) };
    }

    /// A guardian killed, or stopped (its input full), is replaced by one
    /// told every group still running.
    #[test]
    fn a_guardian_gone_is_replaced_by_one_told_every_group() {
        let (first, second) = (group(), group());
        let mut watch = Watch { guardian: None, groups: BTreeSet::new(), said: false };
        watch.groups.insert(first);
        watch.tell(&format!("+{first}\n"));
        let killed = watch.guardian.as_ref().unwrap().child.id();
        // SAFETY: kills the test's own guardian.
        unsafe { libc::kill(killed as libc::pid_t, libc::SIGKILL) };
        assert!(gone_within(killed, Duration::from_secs(5)) || watch.guardian.as_mut().unwrap().child.try_wait().unwrap().is_some());
        watch.groups.insert(second);
        watch.tell(&format!("+{second}\n"));
        let stopped = watch.guardian.as_ref().unwrap().child.id();
        assert_ne!(stopped, killed);
        // SAFETY: stops the test's own guardian.
        unsafe { libc::kill(stopped as libc::pid_t, libc::SIGSTOP) };
        let mut told = 0;
        while watch.guardian.as_ref().unwrap().child.id() == stopped {
            watch.tell(&format!("+{first}\n"));
            told += 1;
            assert!(told < 1_000_000, "a full input was not seen");
        }
        let last = watch.guardian.take().unwrap();
        drop(last.input);
        let mut child = last.child;
        assert!(gone_within(first, Duration::from_secs(super::super::EXIT_GRACE_SECS + 5)));
        assert!(gone_within(second, Duration::from_secs(super::super::EXIT_GRACE_SECS + 5)));
        assert!(child.wait().unwrap().success());
    }

    /// A terminal's signals (Ctrl+C) do not end it.
    #[test]
    fn the_guardian_outlasts_a_terminals_signals() {
        let mut guardian = start().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        for signal in [libc::SIGINT, libc::SIGHUP, libc::SIGTERM, libc::SIGQUIT] {
            // SAFETY: signals the test's own guardian.
            unsafe { libc::kill(guardian.child.id() as libc::pid_t, signal) };
        }
        std::thread::sleep(Duration::from_millis(200));
        assert!(guardian.child.try_wait().unwrap().is_none());
        drop(guardian.input);
        assert!(guardian.child.wait().unwrap().success());
    }
}
