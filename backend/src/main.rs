mod api;
mod api_doc;
mod parsing;
mod model;
mod log_storage;

use axum::{Router, extract::DefaultBodyLimit};
use tower_http::cors::{Any, CorsLayer};
use tokio::net::TcpListener;
use tracing_subscriber;
use crate::api_doc::ApiDoc;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;
use tower_http::limit::RequestBodyLimitLayer;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Build router
    let app = Router::new()
    .merge(api::upload::router())
    .layer(DefaultBodyLimit::disable())
    .layer(RequestBodyLimitLayer::new(1024 * 1024 * 1024))
    .merge(api::filter::router())
    .merge(api::stream_filtered_logs::router())
    .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
    .layer(cors)
    ;

    let listener = TcpListener::bind("0.0.0.0:8080").await.unwrap();
    println!("Listening on http://0.0.0.0:8080");

    axum::serve(listener, app).await.unwrap();
}