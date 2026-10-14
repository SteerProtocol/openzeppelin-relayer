//! # API Routes Module
//!
//! Configures HTTP routes for the relayer service API.
//!
//! ## Routes
//!
//! * `/health` - Health check endpoints
//! * `/relayers` - Relayer management endpoints
//! * `/notifications` - Notification management endpoints
//! * `/signers` - Signer management endpoints

pub mod api_keys;
pub mod docs;
pub mod health;
pub mod metrics;
pub mod network;
pub mod notification;
pub mod plugin;
pub mod relayer;
pub mod signer;

use actix_web::web;

/// Exposes only reads during maintenance. No plugin, signer, or mutation routes
/// are registered, so an API restart cannot accept new execution work.
pub fn configure_read_only_routes(cfg: &mut web::ServiceConfig) {
    cfg.configure(health::init)
        .configure(relayer::init_read_only)
        .default_service(web::route().to(maintenance_unavailable));
}

pub async fn maintenance_unavailable() -> actix_web::HttpResponse {
    actix_web::HttpResponse::ServiceUnavailable().json(serde_json::json!({
        "success": false,
        "error": "RELAYER_READ_ONLY",
        "message": "Relayer execution is held for maintenance; only read access is available"
    }))
}

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.configure(health::init)
        .configure(relayer::init)
        .configure(plugin::init)
        .configure(metrics::init)
        .configure(notification::init)
        .configure(signer::init)
        .configure(api_keys::init)
        .configure(network::init);
}
