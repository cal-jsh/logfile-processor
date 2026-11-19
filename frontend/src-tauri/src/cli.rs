//! Command line of the desktop exe.
//!
//! The same arguments arrive whether the exe is started from a terminal or a file is
//! dropped onto its icon (or a shortcut to it) in Explorer: Windows then passes the
//! dropped paths as arguments. So both go through `parse` and `check_file`.
//!
//! The release exe is a GUI-subsystem program with no console of its own. To print
//! `--help` or an error, it attaches to the console of the terminal that started it,
//! if there is one. Started from Explorer there is none, so errors are shown in the
//! window instead.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// What the command line asks for.
#[derive(Debug, PartialEq)]
pub enum Cli {
    Help,
    Version,
    /// Start the viewer, optionally with files to open (one window each).
    Open(Vec<PathBuf>),
}

/// Parse the arguments after the program name.
pub fn parse<I: IntoIterator<Item = OsString>>(args: I) -> Result<Cli, String> {
    let mut files = Vec::new();
    let mut only_paths = false;
    for arg in args {
        if !only_paths {
            match arg.to_str() {
                Some("-h" | "--help" | "/?") => return Ok(Cli::Help),
                Some("-V" | "--version") => return Ok(Cli::Version),
                Some("--") => {
                    only_paths = true;
                    continue;
                }
                Some(s) if s.starts_with('-') && s.len() > 1 => {
                    return Err(format!("unknown option '{s}' (see --help)"));
                }
                _ => {}
            }
        }
        files.push(PathBuf::from(arg));
    }
    Ok(Cli::Open(files))
}

/// Make the path absolute and check that it is a readable file. The message is the
/// one shown to the user, in the terminal or in the window.
pub fn check_file(path: &Path) -> Result<PathBuf, String> {
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let meta = std::fs::metadata(&abs).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("File not found: {}", abs.display()),
        _ => format!("Cannot read {}: {}", abs.display(), e),
    })?;
    if meta.is_dir() {
        return Err(format!("{} is a folder, not a log file", abs.display()));
    }
    std::fs::File::open(&abs).map_err(|e| format!("Cannot read {}: {}", abs.display(), e))?;
    Ok(abs)
}

pub fn usage(exe: &str) -> String {
    format!(
        "Logfile Processor {version}
Open a log file in the desktop viewer. The file is read in place, not copied.

Usage: {exe} [OPTIONS] [FILE]...

Arguments:
  [FILE]...      Log file to open. With several files, each opens in its own window.
                 Dropping files onto the exe or a shortcut to it does the same.

Options:
  -h, --help     Print this help and exit
  -V, --version  Print the version and exit
  --             Treat every following argument as a file, even if it starts with '-'

Exit codes: 0 ok, 1 file missing or unreadable, 2 bad option.
",
        version = env!("CARGO_PKG_VERSION"),
    )
}

/// Attach to the console of the terminal that started us, so `println!` reaches it.
/// Returns false when there is none (started from Explorer or a shortcut).
#[cfg(windows)]
pub fn attach_parent_console() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
        fn GetConsoleWindow() -> *mut core::ffi::c_void;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    // SAFETY: plain Win32 calls without pointers passed in.
    unsafe {
        // Debug builds are console programs and already have one.
        !GetConsoleWindow().is_null() || AttachConsole(ATTACH_PARENT_PROCESS) != 0
    }
}

#[cfg(not(windows))]
pub fn attach_parent_console() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Result<Cli, String> {
        parse(args.iter().map(OsString::from))
    }

    #[test]
    fn parses_paths_and_flags() {
        assert_eq!(p(&[]), Ok(Cli::Open(vec![])));
        assert_eq!(p(&["a.log"]), Ok(Cli::Open(vec!["a.log".into()])));
        assert_eq!(p(&["a.log", "--help"]), Ok(Cli::Help));
        assert_eq!(p(&["/?"]), Ok(Cli::Help));
        assert_eq!(p(&["-V"]), Ok(Cli::Version));
        assert!(p(&["--line", "5"]).is_err());
        assert_eq!(p(&["--", "-odd.log"]), Ok(Cli::Open(vec!["-odd.log".into()])));
        assert_eq!(p(&["-"]), Ok(Cli::Open(vec!["-".into()])));
    }

    #[test]
    fn checks_files() {
        assert!(check_file(Path::new("does-not-exist.log")).unwrap_err().starts_with("File not found"));
        assert!(check_file(Path::new(".")).unwrap_err().contains("is a folder"));
        let ok = check_file(Path::new("Cargo.toml")).unwrap();
        assert!(ok.is_absolute());
    }
}
