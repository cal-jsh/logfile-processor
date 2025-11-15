use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize)]
pub struct LogSummary {
    pub total_lines: usize,
    pub levels: HashMap<String, usize>,
    pub unique_domains: Vec<String>,
}
