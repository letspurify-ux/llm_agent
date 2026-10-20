//! The log launcher that started the server (start.sh's
//! scripts/logged-process.cjs), which names itself in `APP_LAUNCHER_PID`.
//! The launcher passes on a stop and ends with the server; killed outright
//! (SIGKILL: a force quit, the out-of-memory killer), it left the server
//! running on, orphaned — holding the port, its DB connections and its MCP
//! servers — while stop.sh, which signals the launcher, found nothing to
//! stop and start.sh then found the port taken. A server started otherwise
//! (`nohup`, a shell of its own) is not told, and outlives what started it.

/// The variable the launcher names itself in.
pub const LAUNCHER_PID: &str = "APP_LAUNCHER_PID";

/// Resolves once the launcher that started this server has ended (at once
/// if it already has); never, for a server started without one. The wait is
/// told by the system (kqueue, a pidfd), not polled.
pub async fn gone() {
    let Some(pid) = std::env::var(LAUNCHER_PID).ok().and_then(|v| v.trim().parse::<u32>().ok()) else {
        return std::future::pending().await;
    };
    #[cfg(unix)]
    {
        // SAFETY: getppid only reads this process's parent.
        let parent = unsafe { libc::getppid() } as u32;
        if parent != pid {
            if alive(pid) {
                // Another process's ID (the variable inherited past the
                // launcher's own child): not the one to follow.
                eprintln!("[launcher] {LAUNCHER_PID}={pid} is not this server's parent ({parent}); not followed");
                return std::future::pending().await;
            }
            eprintln!("[launcher] the log launcher (PID {pid}) ended before the server started — stopping");
            return;
        }
        let (told, ended) = tokio::sync::oneshot::channel();
        // A thread of its own, not a blocking task: the runtime's shutdown
        // waits for those, and this one waits as long as the launcher runs.
        let spawned = std::thread::Builder::new()
            .name("launcher-watch".into())
            .spawn(move || {
                let _ = told.send(wait_exit(pid, || still_parent(pid)));
            });
        if let Err(e) = spawned {
            eprintln!("[launcher] could not follow the log launcher (PID {pid}): {e}");
            return std::future::pending().await;
        }
        match ended.await {
            Ok(Ok(())) => eprintln!("[launcher] the log launcher (PID {pid}) ended — stopping"),
            Ok(Err(e)) => {
                eprintln!("[launcher] could not follow the log launcher (PID {pid}): {e}");
                std::future::pending::<()>().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        std::future::pending::<()>().await;
    }
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Whether the launcher is still this server's parent: checked once the
/// wait is set up, as the launcher may have ended (and its ID been taken by
/// another process) just before.
#[cfg(unix)]
fn still_parent(pid: u32) -> bool {
    // SAFETY: getppid only reads this process's parent.
    unsafe { libc::getppid() as u32 == pid }
}

/// Blocks until process `pid` ends, or returns once the wait is set up if
/// `watched` then says it is no longer the process meant.
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly"))]
fn wait_exit(pid: u32, watched: impl Fn() -> bool) -> std::io::Result<()> {
    use std::io::Error;
    // SAFETY: a kqueue of our own, closed below; the events are plain
    // structs filled by kevent.
    unsafe {
        let queue = libc::kqueue();
        if queue < 0 {
            return Err(Error::last_os_error());
        }
        let result = (|| {
            let mut change: libc::kevent = std::mem::zeroed();
            change.ident = pid as libc::uintptr_t;
            change.filter = libc::EVFILT_PROC;
            change.flags = libc::EV_ADD | libc::EV_ONESHOT;
            change.fflags = libc::NOTE_EXIT;
            while libc::kevent(queue, &change, 1, std::ptr::null_mut(), 0, std::ptr::null()) < 0 {
                let error = Error::last_os_error();
                match error.raw_os_error() {
                    Some(libc::EINTR) => continue,
                    Some(libc::ESRCH) => return Ok(()),
                    _ => return Err(error),
                }
            }
            if !watched() {
                return Ok(());
            }
            loop {
                let mut event: libc::kevent = std::mem::zeroed();
                let n = libc::kevent(queue, std::ptr::null(), 0, &mut event, 1, std::ptr::null());
                if n > 0 {
                    return Ok(());
                }
                let error = Error::last_os_error();
                if n < 0 && error.raw_os_error() != Some(libc::EINTR) {
                    return Err(error);
                }
            }
        })();
        libc::close(queue);
        result
    }
}

/// Blocks until process `pid` ends, or returns once the wait is set up if
/// `watched` then says it is no longer the process meant.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn wait_exit(pid: u32, watched: impl Fn() -> bool) -> std::io::Result<()> {
    use std::io::Error;
    // SAFETY: a pidfd of our own, closed below; poll reads one pollfd.
    unsafe {
        let fd = libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) as libc::c_int;
        if fd < 0 {
            let error = Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ESRCH) => Ok(()),
                // Before Linux 5.3: asked once a second instead.
                Some(libc::ENOSYS) => {
                    poll_exit(watched);
                    Ok(())
                }
                _ => Err(error),
            };
        }
        let result = if watched() {
            loop {
                let mut wanted = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
                if libc::poll(&mut wanted, 1, -1) >= 0 {
                    break Ok(());
                }
                let error = Error::last_os_error();
                if error.raw_os_error() != Some(libc::EINTR) {
                    break Err(error);
                }
            }
        } else {
            Ok(())
        };
        libc::close(fd);
        result
    }
}

/// Blocks until `watched` says process `pid` is gone.
#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "netbsd", target_os = "openbsd", target_os = "dragonfly", target_os = "linux", target_os = "android"))
))]
fn wait_exit(_pid: u32, watched: impl Fn() -> bool) -> std::io::Result<()> {
    poll_exit(watched);
    Ok(())
}

/// Asks once a second, where the system cannot tell.
#[cfg(unix)]
#[allow(dead_code)]
fn poll_exit(watched: impl Fn() -> bool) {
    while watched() {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn the_end_of_a_process_is_told() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        let (told, ended) = std::sync::mpsc::channel();
        std::thread::spawn(move || told.send(wait_exit(pid, || true)).unwrap());
        assert!(ended.recv_timeout(std::time::Duration::from_millis(300)).is_err(), "told before it ended");
        child.kill().unwrap();
        let result = ended.recv_timeout(std::time::Duration::from_secs(5)).expect("its end was not told");
        assert!(result.is_ok(), "{result:?}");
        child.wait().unwrap();
        // One already gone is told at once.
        assert!(wait_exit(pid, || true).is_ok());
    }
}
