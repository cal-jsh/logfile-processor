use serde::Deserialize;
use utoipa::ToSchema;

#[derive(Deserialize, ToSchema)]
pub struct CloseSessionQuery {
    /// Unique session ID for the uploaded log
    pub session_id: String,
}
