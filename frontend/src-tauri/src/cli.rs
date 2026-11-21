//! Command line of the desktop exe and of its console companion.
//!
//! The same arguments arrive whether the exe is started from a terminal or a file is
//! dropped onto its icon (or a shortcut to it) in Explorer: Windows then passes the
//! dropped paths as arguments. So both go through `parse` and `check_file`.
//!
//! The viewer exe is a GUI-subsystem program with no console of its own. To print
//! `--help` or an error, it attaches to the console of the terminal that started it,
//! if there is one. Started from Explorer there is none, so errors are shown in the
//! window instead. A terminal does not wait for a GUI program, though, so filtering on
//! the command line is meant for `logfile_processor_cli.exe` (`src/bin`), a console
//! program that takes the same arguments and starts the viewer when there is nothing
//! to filter.
//!
//! On Linux a desktop launcher or file manager ("Open with") starts the viewer with
//! the files as arguments (`Exec=... %F` in `linux/logfile-processor.desktop`), and the viewer writes to the terminal it was started
//! from, if any. With no terminal (stderr not a tty) errors go to the window, as
//! with Explorer on Windows.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Name of the console companion, as typed in a terminal.
pub const CLI_EXE: &str = "logfile_processor_cli";
/// Name of the viewer exe next to it (as built by cargo, then as installed).
#[cfg(windows)]
pub const GUI_EXES: [&str; 2] = ["logfile_processor_desktop.exe", "Logfile Processor.exe"];
/// Name of the viewer next to it (the .deb installs both under their cargo names in
/// /usr/bin).
#[cfg(not(windows))]
pub const GUI_EXES: [&str; 1] = ["logfile_processor_desktop"];

/// What the command line asks for.
#[derive(Debug, PartialEq)]
pub enum Cli {
    Help,
    Version,
    /// Start the viewer, optionally with files to open (one window each).
    Open(Vec<PathBuf>),
    /// Filter one file without a window.
    Filter(FilterArgs),
}

/// A filter run on the command line. Within a kind any value matches; across kinds
/// all must (like the viewer's filter bar).
#[derive(Debug, Default, PartialEq)]
pub struct FilterArgs {
    pub file: PathBuf,
    /// The message contains one of these (case-sensitive)
    pub keywords: Vec<String>,
    /// Log levels as typed; matched case-insensitively
    pub levels: Vec<String>,
    /// Values of the domain field (`%n`)
    pub domains: Vec<String>,
    /// Other fields: `(name, value)`
    pub fields: Vec<(String, String)>,
    pub context: u64,
    /// Line format in spdlog syntax; detected when `None`
    pub pattern: Option<String>,
    /// `None` or `-`: standard output
    pub output: Option<PathBuf>,
    /// `Some(true)` CSV, `Some(false)` text, `None`: from the output file's extension
    pub csv: Option<bool>,
}

impl FilterArgs {
    /// Write to standard output.
    pub fn to_stdout(&self) -> bool {
        self.output.as_deref().is_none_or(|p| p.as_os_str() == "-")
    }

    /// Write CSV: as asked, else when the output file ends in `.csv`.
    pub fn csv(&self) -> bool {
        self.csv.unwrap_or_else(|| {
            !self.to_stdout()
                && self
                    .output
                    .as_deref()
                    .and_then(Path::extension)
                    .is_some_and(|e| e.eq_ignore_ascii_case("csv"))
        })
    }
}

/// Split a comma-separated list, dropping empty items.
fn list(v: &str) -> impl Iterator<Item = String> + '_ {
    v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// Parse the arguments after the program name.
pub fn parse<I: IntoIterator<Item = OsString>>(args: I) -> Result<Cli, String> {
    let mut files = Vec::new();
    let mut f = FilterArgs::default();
    let mut filtering = false;
    let mut only_paths = false;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let s = match arg.to_str() {
            Some(s) if !only_paths && ((s.starts_with('-') && s.len() > 1) || s == "/?") => s.to_string(),
            _ => {
                files.push(PathBuf::from(arg));
                continue;
            }
        };
        if s == "--" {
            only_paths = true;
            continue;
        }
        // `--name=value` or `--name value` / `-x value`
        let (name, inline) = match s.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n.to_string(), Some(v.to_string())),
            _ => (s.clone(), None),
        };
        let mut value = || -> Result<String, String> {
            if let Some(v) = &inline {
                return Ok(v.clone());
            }
            match args.next() {
                Some(v) => v.into_string().map_err(|_| format!("the value of {name} is not valid text")),
                None => Err(format!("{name} needs a value (see --help)")),
            }
        };
        match name.as_str() {
            "-h" | "--help" | "/?" => return Ok(Cli::Help),
            "-V" | "--version" => return Ok(Cli::Version),
            "-k" | "--keyword" => {
                let v = value()?;
                if v.trim().is_empty() {
                    return Err(format!("{name} needs a non-empty text"));
                }
                // trimmed, like the viewer's keyword chips
                f.keywords.push(v.trim().to_string());
            }
            "-l" | "--level" => f.levels.extend(list(&value()?)),
            "-d" | "--domain" => f.domains.extend(list(&value()?)),
            "-f" | "--field" => {
                let v = value()?;
                let (n, vals) = v
                    .split_once('=')
                    .filter(|(n, _)| !n.trim().is_empty())
                    .ok_or_else(|| format!("{name} takes NAME=VALUE, e.g. thread=12 (got '{v}')"))?;
                f.fields.extend(list(vals).map(|x| (n.trim().to_string(), x)));
            }
            "-C" | "--context" => {
                let v = value()?;
                f.context = v.trim().parse().map_err(|_| format!("{name} takes a number of lines (got '{v}')"))?;
            }
            "-p" | "--pattern" => f.pattern = Some(value()?),
            "-o" | "--output" => f.output = Some(PathBuf::from(value()?)),
            "--csv" => f.csv = Some(true),
            "--txt" | "--text" => f.csv = Some(false),
            "--format" => {
                f.csv = Some(match value()?.to_ascii_lowercase().as_str() {
                    "csv" => true,
                    "txt" | "text" => false,
                    other => return Err(format!("--format is txt or csv (got '{other}')")),
                })
            }
            _ => return Err(format!("unknown option '{s}' (see --help)")),
        }
        filtering = true;
    }
    if !filtering {
        return Ok(Cli::Open(files));
    }
    match files.len() {
        0 => Err("give the log file to filter (see --help)".into()),
        1 => {
            f.file = files.pop().unwrap();
            Ok(Cli::Filter(f))
        }
        _ => Err("filtering takes one log file at a time".into()),
    }
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

/// The help text: `--help` of both exes, and the "Command line" dialog in the viewer.
pub fn usage() -> String {
    format!(
        r#"Logfile Processor {version}
Open log files in the viewer, or filter one on the command line.

Usage:
  {cli} [FILE]...                Open each file in its own viewer window
  {cli} FILE [OPTIONS]           Filter FILE without a window

Filters (a line must pass every kind given, and match any one value of each):
  -k, --keyword TEXT         Message contains TEXT (case-sensitive). Repeat for more.
  -l, --level LEVEL,...      Log level, e.g. error,critical (any case; warn and
                             warning are the same)
  -d, --domain NAME,...      Domain (logger name, %n in the pattern), exact value,
                             e.g. net.http
  -f, --field NAME=VALUE,... Any other field of the line format, e.g. thread=12
  -C, --context N            Also write N lines before and after each match

Output:
  -o, --output FILE          Write to FILE instead of the terminal ('-': the terminal)
      --csv                  CSV: line number, a column per field, Matched, Context,
                             and the whole line. Default when FILE ends in .csv
      --txt                  The original lines as text. Default otherwise
  -p, --pattern PATTERN      Line format in spdlog syntax instead of detecting it,
                             e.g. "[%Y-%m-%d %H:%M:%S.%e] [%l] [%n] %v"

  -h, --help                 Print this help
  -V, --version              Print the version
  --                         Treat every following argument as a file

Any filter or output option filters without a window. The rows are the same as
the viewer shows and exports for that filter; with -o FILE a summary goes to the
terminal. The file is read in place and streamed, so size is no problem.

Examples:
  Errors and criticals of two domains, 3 lines around each, in the terminal:
    {cli} app.log -l error,critical -d net.http,net.tcp -C 3

  Lines mentioning timeout or refused, as CSV:
    {cli} app.log -k timeout -k refused -o timeouts.csv

  Warnings of thread 12 that mention a disk, through another command:
    {cli} app.log -l warn -f thread=12 | Select-String disk

The viewer exe takes the same arguments, but a terminal does not wait for it,
so use {cli} from a terminal or a script.

Exit codes: 0 ok (also when nothing matched), 1 file missing, unreadable or not
writable, 2 bad option, pattern or field.
"#,
        version = env!("CARGO_PKG_VERSION"),
        cli = CLI_EXE,
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

/// Elsewhere output goes wherever the process was started from; it counts as a
/// terminal when stderr is one (a desktop launcher gives none or a log file).
#[cfg(not(windows))]
pub fn attach_parent_console() -> bool {
    use std::io::IsTerminal;
    std::io::stderr().is_terminal()
}

/// Stop child processes from inheriting our standard handles. Windows hands every
/// inheritable handle to a child, so a viewer started from `cmd | other` would keep
/// that pipe open, and the shell waiting for it, until the window closes.
#[cfg(windows)]
pub fn keep_std_handles_private() {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(which: u32) -> *mut core::ffi::c_void;
        fn SetHandleInformation(handle: *mut core::ffi::c_void, mask: u32, flags: u32) -> i32;
    }
    const HANDLE_FLAG_INHERIT: u32 = 1;
    // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE
    for which in [-10i32 as u32, -11i32 as u32, -12i32 as u32] {
        // SAFETY: plain Win32 calls; an invalid or null handle only makes the call fail.
        unsafe {
            let h = GetStdHandle(which);
            if !h.is_null() && h as isize != -1 {
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

#[cfg(not(windows))]
pub fn keep_std_handles_private() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Result<Cli, String> {
        parse(args.iter().map(OsString::from))
    }

    fn filter(args: &[&str]) -> FilterArgs {
        match p(args) {
            Ok(Cli::Filter(f)) => f,
            other => panic!("not a filter: {other:?}"),
        }
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
    fn parses_filters() {
        let f = filter(&[
            "a.log", "-k", " time out ", "--keyword=a,b", "-l", "error, CRITICAL", "--level", "warn",
            "-d", "net,core", "-f", "thread=12,13", "-C", "3", "-o", "x.csv",
        ]);
        assert_eq!(f.file, PathBuf::from("a.log"));
        assert_eq!(f.keywords, ["time out", "a,b"]); // keywords are not split
        assert_eq!(f.levels, ["error", "CRITICAL", "warn"]);
        assert_eq!(f.domains, ["net", "core"]);
        assert_eq!(f.fields, [("thread".into(), "12".into()), ("thread".into(), "13".into())]);
        assert_eq!(f.context, 3);
        assert!(f.csv() && !f.to_stdout());

        // options may come before the file, and any one of them means "no window"
        let f = filter(&["--csv", "a.log"]);
        assert!(f.csv() && f.to_stdout());
        let f = filter(&["a.log", "-o", "-"]);
        assert!(!f.csv() && f.to_stdout());
        let f = filter(&["a.log", "-o", "out.CSV", "--txt"]);
        assert!(!f.csv());
        assert!(filter(&["a.log", "--format", "csv"]).csv());
    }

    #[test]
    fn rejects_bad_filters() {
        assert!(p(&["-l", "error"]).unwrap_err().contains("give the log file"));
        assert!(p(&["a.log", "b.log", "-k", "x"]).unwrap_err().contains("one log file"));
        assert!(p(&["a.log", "-C", "many"]).unwrap_err().contains("number"));
        assert!(p(&["a.log", "-f", "thread"]).unwrap_err().contains("NAME=VALUE"));
        assert!(p(&["a.log", "-k"]).unwrap_err().contains("needs a value"));
        assert!(p(&["a.log", "-k", " "]).is_err());
        assert!(p(&["a.log", "--format", "xml"]).is_err());
    }

    #[test]
    fn checks_files() {
        assert!(check_file(Path::new("does-not-exist.log")).unwrap_err().starts_with("File not found"));
        assert!(check_file(Path::new(".")).unwrap_err().contains("is a folder"));
        let ok = check_file(Path::new("Cargo.toml")).unwrap();
        assert!(ok.is_absolute());
    }
}
