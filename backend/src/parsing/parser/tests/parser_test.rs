use super::super::*;
use std::collections::{HashMap, HashSet};

fn sample_log() -> String {
    let lines = vec![
        "[2025-11-23 10:00:00] [INFO] [core] Starting process",
        "[2025-11-23 10:00:01] [DEBUG] [network] Connection established",
        "[2025-11-23 10:00:02] [WARN] [core] Unexpected value encountered",
        "[2025-11-23 10:00:03] [ERROR] [data_acq] Data processing failed",
    ];
    lines.join("\n")
}

#[test]
fn test_parse_no_filters_returns_all_lines() {
    let log = sample_log();

    let summary = parse_log(&log, None, None);

    assert_eq!(summary.total_lines, 4);

    let mut expected_levels = HashMap::new();
    expected_levels.insert("INFO".to_string(), 1usize);
    expected_levels.insert("DEBUG".to_string(), 1usize);
    expected_levels.insert("WARN".to_string(), 1usize);
    expected_levels.insert("ERROR".to_string(), 1usize);

    assert_eq!(summary.levels, expected_levels);

    let domains_set: HashSet<_> = summary.unique_domains.into_iter().collect();
    let expected_domains: HashSet<String> = ["core", "network", "data_acq"].iter().map(|s| s.to_string()).collect();
    assert_eq!(domains_set, expected_domains);
}

#[test]
fn test_parse_all_filtered_returns_zero() {
    let log = sample_log();

    // filter by a level that does not exist in the sample
    let level_filter = vec!["TRACE".to_string()];
    let summary = parse_log(&log, None, Some(&level_filter));

    assert_eq!(summary.total_lines, 0);
    assert!(summary.levels.is_empty());
    assert!(summary.unique_domains.is_empty());
}

#[test]
fn test_parse_some_filtered_returns_subset() {
    let log = sample_log();

    // keep only INFO and WARN
    let keep_levels = vec!["INFO".to_string(), "WARN".to_string()];
    let summary = parse_log(&log, None, Some(&keep_levels));

    assert_eq!(summary.total_lines, 2);

    let mut expected_levels = HashMap::new();
    expected_levels.insert("INFO".to_string(), 1usize);
    expected_levels.insert("WARN".to_string(), 1usize);
    assert_eq!(summary.levels, expected_levels);

    let domains_set: HashSet<_> = summary.unique_domains.into_iter().collect();
    // both INFO and WARN in sample are from 'core'
    let expected_domains: HashSet<String> = ["core"].iter().map(|s| s.to_string()).collect();
    assert_eq!(domains_set, expected_domains);
}
