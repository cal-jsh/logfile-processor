//! Filtering a log file on the command line, without a window.
//!
//! Uses the backend's line format detection, filter scan and export writer, so the
//! output is the same as exporting that filter from the viewer.

use crate::cli::{check_file, FilterArgs};
use logfile_processor::api::view::filter_file;
use logfile_processor::choose_format;
use logfile_processor::logfile::index::LogFile;
use logfile_processor::parsing::format::{FieldKind, LogFormat};
use logfile_processor::parsing::line_filter::LineFilter;
use std::collections::BTreeMap;
use std::io::{BufWriter, ErrorKind, Write};
use std::sync::Arc;
use std::time::Instant;

/// An error and the exit code it ends with.
struct Fail(i32, String);

/// Run the filter and return the exit code. Errors go to standard error.
pub fn run(args: &FilterArgs) -> i32 {
    match filter(args) {
        Ok(()) => 0,
        Err(Fail(code, msg)) => {
            eprintln!("error: {msg}");
            code
        }
    }
}

fn filter(args: &FilterArgs) -> Result<(), Fail> {
    let started = Instant::now();
    let path = check_file(&args.file).map_err(|e| Fail(1, e))?;
    let out_path = match args.to_stdout() {
        true => None,
        false => {
            let o = args.output.as_deref().unwrap();
            let o = std::path::absolute(o).unwrap_or_else(|_| o.to_path_buf());
            if same_file(&o, &path) {
                return Err(Fail(2, format!("the output would overwrite the log file {}", path.display())));
            }
            Some(o)
        }
    };

    let file = LogFile::open(&path).map_err(|e| Fail(1, format!("Cannot read {}: {e}", path.display())))?;
    let chosen = choose_format(&file, args.pattern.as_deref()).map_err(|e| Fail(2, e))?;
    let format = Arc::new(chosen.format);
    let line_filter = build_filter(args, &format).map_err(|e| Fail(2, e))?;

    let csv = args.csv();
    let result = match &out_path {
        None => {
            // big buffer: stdout alone flushes every line
            let mut out = BufWriter::with_capacity(1 << 20, std::io::stdout().lock());
            filter_file(&file, format.clone(), line_filter, args.context, csv, &mut out)
        }
        Some(o) => {
            let f = std::fs::File::create(o).map_err(|e| Fail(1, format!("Cannot write {}: {e}", o.display())))?;
            let mut out = BufWriter::with_capacity(1 << 20, f);
            filter_file(&file, format.clone(), line_filter, args.context, csv, &mut out)
                .and_then(|s| out.flush().map(|_| s))
        }
    };
    let stats = match result {
        Ok(s) => s,
        // the reader stopped early (`| Select-Object -First 10`): not an error
        Err(e) if e.kind() == ErrorKind::BrokenPipe => return Ok(()),
        Err(e) => {
            let target = out_path.as_ref().map_or("the output".into(), |o| o.display().to_string());
            return Err(Fail(1, format!("Cannot write {target}: {e}")));
        }
    };

    if let Some(o) = &out_path {
        let mut summary = format!(
            "{} of {} lines matched, {} rows written to {} ({}) in {:.2} s",
            stats.match_count,
            stats.line_count,
            stats.row_count,
            o.display(),
            if csv { "CSV" } else { "text" },
            started.elapsed().as_secs_f64()
        );
        if chosen.detected {
            summary.push_str(&format!("\nLine format (detected): {}", format.pattern()));
        }
        eprintln!("{summary}");
    }
    Ok(())
}

/// Whether two paths name the same file (the output must not replace the input).
fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The viewer's filter for these options, checked against the line format so that a
/// misspelt field is an error instead of a silent empty result.
fn build_filter(args: &FilterArgs, format: &LogFormat) -> Result<LineFilter, String> {
    let no_field = |what: &str| {
        let names: Vec<String> = format
            .fields()
            .iter()
            .filter(|f| f.kind == FieldKind::Text)
            .map(|f| f.name.clone())
            .collect();
        format!(
            "the lines of this file have no {what} field (line format: {}; other fields: {}). \
             Give the format with --pattern if it was detected wrongly",
            format.pattern(),
            if names.is_empty() { "none".into() } else { names.join(", ") }
        )
    };

    let mut fields: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if !args.domains.is_empty() {
        format.field_index("domain").ok_or_else(|| no_field("domain"))?;
        fields.entry("domain".into()).or_default().extend(args.domains.iter().cloned());
    }
    for (name, value) in &args.fields {
        // by name or by label, in any case: `thread`, `Thread`
        let def = format
            .fields()
            .iter()
            .find(|f| f.name.eq_ignore_ascii_case(name) || f.label.eq_ignore_ascii_case(name))
            .ok_or_else(|| no_field(&format!("'{name}'")))?;
        if def.kind != FieldKind::Text {
            return Err(format!(
                "--field {name} is not a filter field; use --level for the level and --keyword for the message"
            ));
        }
        fields.entry(def.name.clone()).or_default().push(value.clone());
    }

    let levels = if args.levels.is_empty() {
        None
    } else {
        format.level_field().ok_or_else(|| no_field("level"))?;
        // The filter compares exactly; files write ERROR, error or Error, and spdlog's
        // long names (warning, critical) where others use short ones (WARN, CRIT).
        const ALIASES: [(&str, &str); 3] = [("warn", "warning"), ("err", "error"), ("crit", "critical")];
        let mut v: Vec<String> = Vec::new();
        for l in &args.levels {
            let lower = l.to_ascii_lowercase();
            let mut names = vec![l.clone(), lower.clone()];
            for (a, b) in ALIASES {
                if lower == a {
                    names.push(b.into());
                } else if lower == b {
                    names.push(a.into());
                }
            }
            for n in names {
                let mut title = n.to_ascii_lowercase();
                if let Some(c) = title.get_mut(0..1) {
                    c.make_ascii_uppercase();
                }
                for x in [n.clone(), n.to_ascii_lowercase(), n.to_ascii_uppercase(), title] {
                    if !v.contains(&x) {
                        v.push(x);
                    }
                }
            }
        }
        Some(v)
    };

    Ok(LineFilter {
        levels,
        fields,
        keywords: (!args.keywords.is_empty()).then(|| args.keywords.clone()),
        time: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{parse, Cli};

    const LOG: &str = "[2026-11-20 10:00:00.001] [info] [net.http] [12] connect ok\n\
        [2026-11-20 10:00:00.002] [error] [net.http] [12] timeout, retrying\n\
        \x20   at frame\n\
        [2026-11-20 10:00:00.003] [warning] [core] [13] disk timeout\n\
        [2026-11-20 10:00:00.004] [error] [core] [12] refused\n";

    /// Run the command line against LOG and return the output text.
    fn run_cli(args: &[&str]) -> Result<String, String> {
        let dir = std::env::temp_dir().join(format!("lp-cli-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join(format!("{}.log", args.join("_").replace(|c: char| !c.is_alphanumeric(), "")));
        std::fs::write(&log, LOG).unwrap();
        let out = log.with_extension("out");
        let mut all = vec![log.to_string_lossy().into_owned(), "-o".into(), out.to_string_lossy().into_owned()];
        all.extend(args.iter().map(|s| s.to_string()));
        let Ok(Cli::Filter(f)) = parse(all.into_iter().map(Into::into)) else { panic!("not a filter") };
        let r = filter(&f).map(|_| std::fs::read_to_string(&out).unwrap()).map_err(|Fail(_, m)| m);
        let _ = std::fs::remove_file(&log);
        let _ = std::fs::remove_file(&out);
        r
    }

    #[test]
    fn filters_like_the_viewer() {
        assert_eq!(run_cli(&["-l", "ERROR"]).unwrap().lines().count(), 2);
        assert!(run_cli(&["-l", "Warn"]).unwrap().ends_with("disk timeout
"));
        assert_eq!(
            run_cli(&["-k", "timeout", "-d", "net.http"]).unwrap(),
            "[2026-11-20 10:00:00.002] [error] [net.http] [12] timeout, retrying\n"
        );
        // context brings in the stack frame
        let out = run_cli(&["-k", "retrying", "-C", "1"]).unwrap();
        assert!(out.contains("at frame") && out.contains("connect ok"));
        // all kinds combined
        let out = run_cli(&["-l", "error,warning", "-f", "Thread=12"]).unwrap();
        assert_eq!(out.lines().count(), 2);
        assert!(out.ends_with("refused\n"));
    }

    #[test]
    fn writes_csv_by_extension() {
        let dir = std::env::temp_dir().join(format!("lp-csv-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("a.log");
        std::fs::write(&log, LOG).unwrap();
        let out = dir.join("a.csv");
        let args = [log.to_str().unwrap(), "-k", "refused", "-o", out.to_str().unwrap()];
        let Ok(Cli::Filter(f)) = parse(args.iter().map(Into::into)) else { panic!() };
        assert_eq!(run(&f), 0);
        let csv = std::fs::read_to_string(&out).unwrap();
        assert!(csv.starts_with("Line,Time,Level,Domain,Thread,Matched,Context,Message\n5,"), "{csv}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unknown_fields_are_errors() {
        assert!(run_cli(&["-f", "process=1"]).unwrap_err().contains("no 'process' field"));
        assert!(run_cli(&["-f", "level=error"]).unwrap_err().contains("not a filter field"));
        assert!(run_cli(&["-p", "%v", "-l", "error"]).unwrap_err().contains("no level field"));
    }
}
