/// std's `eprintln!` for every module below, but one that cannot panic in
/// the server (see `console`).
macro_rules! eprintln {
    ($($arg:tt)*) => {
        $crate::console::line(format_args!($($arg)*))
    };
}

pub mod console;
pub mod config;
pub mod context;
pub mod llm;
pub mod paths;
pub mod projects;
pub mod session;
pub mod shared;
pub mod text;
pub mod tools;
pub mod mcp;
pub mod voc_tools;
mod worker;
pub mod chunk;
pub mod db;
pub mod execution;
pub mod numbers;
pub mod sql;
pub mod embedding;
pub mod oracle;
pub mod embed_sync;
pub mod search;
pub mod admin;
pub mod app;
pub mod agent;
pub mod web;
pub mod ui;
