//! `GET /version`: the backend's crate version, for bug reports.

use axum::{routing::get, Json, Router};
use serde::Serialize;

#[derive(Serialize)]
pub struct VersionInfo {
    /// `CARGO_PKG_VERSION` of the backend crate
    pub version: &'static str,
}

pub fn router() -> Router {
    Router::new().route("/version", get(get_version))
}

async fn get_version() -> Json<VersionInfo> {
    Json(VersionInfo {
        version: env!("CARGO_PKG_VERSION"),
    })
}
