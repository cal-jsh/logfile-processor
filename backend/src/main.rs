mod api;
mod api_doc;
mod parsing;
mod model;

use axum::{Router};
use tokio::net::TcpListener;
use tracing_subscriber;
use crate::api_doc::ApiDoc;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    // Build router
    let app = Router::new()
    .merge(api::upload::router())
    .merge(api::filter::router())
    .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()));

    let listener = TcpListener::bind("0.0.0.0:8080").await.unwrap();
    println!("Listening on http://0.0.0.0:8080");

    axum::serve(listener, app).await.unwrap();
}