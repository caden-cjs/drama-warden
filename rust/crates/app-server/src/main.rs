use std::{env, net::SocketAddr, path::Path};

use axum::{
    Router,
    extract::State,
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use sqlx::{AnyPool, any::AnyPoolOptions};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tower_http::services::ServeDir;
use tracing::{error, info};

#[derive(Clone)]
struct AppState {
    database: AnyPool,
    api_token: String,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    database: &'static str,
}

#[derive(Serialize)]
struct ApiError {
    error: &'static str,
    code: &'static str,
}

async fn health(State(state): State<AppState>) -> Response {
    match sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.database).await {
        Ok(_) => axum::Json(HealthResponse { ok: true, database: "ok" }).into_response(),
        Err(error) => {
            error!(error = %error, "database health query failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(HealthResponse { ok: false, database: "unavailable" }),
            ).into_response()
        }
    }
}

async fn auth(headers: HeaderMap, State(state): State<AppState>, request: axum::extract::Request, next: Next) -> Response {
    let Some(value) = headers.get(AUTHORIZATION).and_then(|value| value.to_str().ok()) else {
        return unauthorized();
    };
    let Some(candidate) = value.strip_prefix("Bearer ") else {
        return unauthorized();
    };
    let matches = bool::from(candidate.as_bytes().ct_eq(state.api_token.as_bytes()));
    if !matches {
        return unauthorized();
    }
    next.run(request).await
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        axum::Json(ApiError { error: "authentication required", code: "unauthorized" }),
    ).into_response()
}

async fn not_migrated() -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        axum::Json(ApiError { error: "Rust backend migration is in progress", code: "feature_not_migrated" }),
    ).into_response()
}

async fn connect_database() -> Result<AnyPool, Box<dyn std::error::Error>> {
    sqlx::any::install_default_drivers();
    let driver = env::var("DB_DRIVER").unwrap_or_else(|_| "sqlite".to_owned());
    let url = match driver.as_str() {
        "sqlite" => {
            let path = env::var("SQLITE_PATH").unwrap_or_else(|_| "./data/drama-warden.sqlite".to_owned());
            if path != ":memory:" {
                if let Some(parent) = Path::new(&path).parent() {
                    std::fs::create_dir_all(parent)?;
                }
            }
            if path.starts_with("sqlite:") {
                path
            } else if path == ":memory:" {
                "sqlite::memory:".to_owned()
            } else {
                format!("sqlite://{path}?mode=rwc")
            }
        }
        "mysql" => env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required when DB_DRIVER=mysql")?,
        _ => return Err(format!("unsupported DB_DRIVER: {driver}").into()),
    };
    let pool = AnyPoolOptions::new().max_connections(10).connect(&url).await?;
    match driver.as_str() {
        "sqlite" => {
            sqlx::query(include_str!("../../../migrations/sqlite/0001_application_settings.sql"))
                .execute(&pool).await?;
        }
        "mysql" => {
            sqlx::query(include_str!("../../../migrations/mysql/0001_application_settings.sql"))
                .execute(&pool).await?;
        }
        _ => unreachable!(),
    }
    Ok(pool)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let api_token = env::var("API_ACCESS_TOKEN").map_err(|_| "API_ACCESS_TOKEN must be configured")?;
    if api_token.trim().is_empty() {
        return Err("API_ACCESS_TOKEN must not be empty".into());
    }
    let database = connect_database().await?;
    let state = AppState { database, api_token };
    let protected = Router::new()
        .route("/api/plugins", get(not_migrated))
        .route("/api/shows", get(not_migrated))
        .route("/api/events", get(not_migrated))
        .route("/api/automation/status", get(not_migrated))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth));
    let app = Router::new()
        .route("/api/health", get(health))
        .merge(protected)
        .fallback_service(ServeDir::new("frontend/dist").append_index_html_on_directories(true))
        .with_state(state);
    let port = env::var("PORT").unwrap_or_else(|_| "8080".to_owned()).parse::<u16>()?;
    let address = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(address).await?;
    info!(address = %address, "drama-warden Rust backend listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
