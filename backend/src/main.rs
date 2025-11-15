use axum::{
    routing::post,
    extract::Multipart,
    Json,
    Router,
};
use tokio::net::TcpListener;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Serialize)]
struct LogSummary {
    total_lines: usize,
    levels: HashMap<String, usize>,
    unique_domains: Vec<String>,
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/upload", post(upload_handler));

    let addr = "0.0.0.0:8080";

    let listener = TcpListener::bind(addr).await.unwrap();
    println!("Listening on {}", addr);

    axum::serve(listener, app)
        .await
        .unwrap();
}

async fn upload_handler(mut multipart: Multipart) -> Json<LogSummary> {
    let mut contents = String::new();

    while let Some(field) = multipart.next_field().await.unwrap() {
        if field.name() == Some("file") {
            contents = field.text().await.unwrap();
        }
    }

    let regex = Regex::new(r"^\[(?P<ts>[^\]]+)\]\s\[(?P<level>[^\]]+)\]\s\[(?P<domain>[^\]]+)\]").unwrap();

    let mut total_lines = 0;
    let mut levels = HashMap::new();
    let mut domains = HashSet::new();

    for line in contents.lines() {
        total_lines += 1;
        if let Some(caps) = regex.captures(line) {
            let level = caps["level"].to_string();
            let domain = caps["domain"].to_string();

            *levels.entry(level).or_insert(0) += 1;
            domains.insert(domain);
        }
    }

    Json(LogSummary {
        total_lines,
        levels,
        unique_domains: domains.into_iter().collect(),
    })
}
