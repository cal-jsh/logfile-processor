use serde::Deserialize;

#[derive(Deserialize)]
pub struct FilterRequest {
    pub log_text: String,
    pub domains: Option<Vec<String>>,
    pub levels: Option<Vec<String>>,
}
