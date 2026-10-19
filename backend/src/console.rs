//! Console lines that cannot take the server down. std's `eprintln!` panics
//! when its write fails, and a write fails once the reader of the backend's
//! output is gone: the launcher that logs it ended (a broken pipe), the
//! terminal it ran in was closed (an I/O error). An orphaned backend then
//! failed every question at its first log line, wrote no chat log, and lost
//! the background job that printed; one stopping after the terminal's hangup
//! panicked on its own shutdown line and never closed its MCP servers.
//! The crate's `eprintln!` (lib.rs) and the binary's lines come here.

use std::{
    fmt::Arguments,
    io::Write,
    sync::atomic::{AtomicBool, Ordering},
};

static DROP_UNWRITABLE: AtomicBool = AtomicBool::new(false);

/// From now on a line that cannot be written is dropped (the server binary
/// sets this first). Until then std's `eprintln!` writes it, which the test
/// harness captures.
pub fn drop_unwritable() {
    DROP_UNWRITABLE.store(true, Ordering::Release);
}

/// One line on stderr.
pub fn line(args: Arguments<'_>) {
    if DROP_UNWRITABLE.load(Ordering::Acquire) {
        let _ = writeln!(std::io::stderr().lock(), "{args}");
    } else {
        std::eprintln!("{args}");
    }
}

/// One line on stdout.
pub fn out_line(args: Arguments<'_>) {
    if DROP_UNWRITABLE.load(Ordering::Acquire) {
        let _ = writeln!(std::io::stdout().lock(), "{args}");
    } else {
        std::println!("{args}");
    }
}
