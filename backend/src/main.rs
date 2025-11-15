use axum::{Router};
use tokio::net::TcpListener;
use tracing_subscriber;

mod parsing;
mod api;
mod model;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let app = Router::new()
        .merge(api::upload::router())
        .merge(api::filter::router());

    let listener = TcpListener::bind("0.0.0.0:8080").await.unwrap();
    println!("Listening on http://0.0.0.0:8080");

    axum::serve(listener, app).await.unwrap();
}
