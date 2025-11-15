// local
use crate::api::{upload, filter};
use crate::model::filter::{FilterRequest, FilteredLogResponse};
use crate::model::log_summary::LogSummary;
// utoipa
use utoipa::OpenApi;


#[derive(OpenApi)]
#[openapi(
    paths(
        upload::upload_handler,
        filter::filter_handler
    ),
    components(
        schemas(LogSummary, FilterRequest, FilteredLogResponse)
    ),
    info(
        title = "Logfile Processor API",
        version = "1.0"
    )
)]
pub struct ApiDoc;