//! Embeds the built screen (`../frontend/dist`) in the binary, so one
//! executable serves both the API and the screen (as MnemoArc does).
//!
//! A release build makes the screen first when it is missing or older than a
//! frontend source (`npm run build`, after `npm ci` when node_modules is
//! missing), so `cargo build --release` alone cannot ship a stale or empty
//! screen. Without npm the existing dist is used; with none at all the
//! release build fails. Debug builds (cargo test) only embed what is there.
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::SystemTime,
};

/// What `npm run build` reads: a change to any of these makes the screen stale.
const SOURCES: &[&str] = &["src", "index.html", "package.json", "package-lock.json", "vite.config.js", "mermaid-math-adapter.mjs"];

fn collect(root: &Path, path: &Path, output: &mut String) {
    let mut entries: Vec<_> = fs::read_dir(path).unwrap().map(|e| e.unwrap()).collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        assert!(!entry.file_type().unwrap().is_symlink(), "screen assets must not be symlinks");
        if path.is_dir() {
            collect(root, &path, output);
        } else {
            let name = path.strip_prefix(root).unwrap().to_str().unwrap().replace('\\', "/");
            output.push_str(&format!("({name:?}, include_bytes!({:?})),\n", path.to_str().unwrap()));
        }
    }
}

/// The newest modification time under `path`.
fn newest(path: &Path) -> Option<SystemTime> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_dir() {
        return meta.modified().ok();
    }
    fs::read_dir(path).ok()?.filter_map(|e| newest(&e.ok()?.path())).max()
}

fn npm(frontend: &Path, args: &[&str]) {
    let program = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let output = Command::new(program)
        .args(args)
        .current_dir(frontend)
        .output()
        .unwrap_or_else(|e| panic!("could not run {program} {}: {e}", args.join(" ")));
    assert!(
        output.status.success(),
        "{program} {} failed in frontend:\n{}{}",
        args.join(" "),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn npm_available() -> bool {
    let program = if cfg!(windows) { "npm.cmd" } else { "npm" };
    Command::new(program).arg("--version").output().is_ok_and(|o| o.status.success())
}

fn main() {
    let frontend: PathBuf = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("../frontend");
    for source in SOURCES {
        println!("cargo:rerun-if-changed=../frontend/{source}");
    }
    println!("cargo:rerun-if-changed=../frontend/dist");
    let index = frontend.join("dist/index.html");
    let release = env::var("PROFILE").unwrap() == "release";
    if release {
        let built = fs::metadata(&index).and_then(|m| m.modified()).ok();
        let stale = match built {
            None => true,
            Some(built) => SOURCES.iter().filter_map(|s| newest(&frontend.join(s))).any(|t| t > built),
        };
        if stale && npm_available() {
            if !frontend.join("node_modules").is_dir() {
                npm(&frontend, &["ci"]);
            }
            npm(&frontend, &["run", "build"]);
            println!("cargo:warning=built the screen (npm run build in frontend)");
        } else if stale && built.is_some() {
            println!("cargo:warning=frontend sources are newer than frontend/dist but npm is not installed — embedding the existing screen");
        }
        assert!(
            index.is_file(),
            "frontend/dist is missing and npm is not installed — install Node.js, or build the screen elsewhere (cd frontend && npm ci && npm run build)"
        );
    }
    let mut output = String::from("pub static ASSETS: &[(&str, &[u8])] = &[\n");
    if index.is_file() {
        let root = frontend.join("dist").canonicalize().unwrap();
        collect(&root, &root, &mut output);
    } else {
        println!("cargo:warning=screen not built (frontend/dist) — the API runs, / answers 503; a release build makes it");
    }
    output.push_str("];\n");
    let path = Path::new(&env::var("OUT_DIR").unwrap()).join("ui_assets.rs");
    // Unchanged assets leave the file alone, so rustc does not rebuild for nothing.
    if fs::read_to_string(&path).ok().as_deref() != Some(output.as_str()) {
        fs::write(path, output).unwrap();
    }
}
