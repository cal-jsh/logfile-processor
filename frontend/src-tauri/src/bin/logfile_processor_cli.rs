//! `logfile_processor_cli`: the console companion of the viewer exe.
//!
//! Same arguments as the viewer. A terminal waits for a console program (it does not
//! for the GUI-subsystem viewer), so filtering on the command line and in scripts gets
//! its output and exit code in order. Without a filter it starts the viewer.

fn main() {
    std::process::exit(logfile_processor_desktop_lib::cli_main())
}
