# Rust backend workspace

This workspace is the foundation for the Rust backend migration described in [`docs/RUST-BACKEND-MIGRATION.md`](../docs/RUST-BACKEND-MIGRATION.md).

The Axum service currently provides a database-backed public health route, shared Bearer authentication, static Vue asset serving, and initial SQLite/MySQL application-setting tables. The frontend-facing business routes intentionally return `feature_not_migrated` until their Rust implementations are ready. Do not use this binary with production data or credentials yet.

Plugins use the language-neutral protocol types in `crates/plugin-protocol`; a supervised process host and provider migrations are subsequent steps.

Build with Rust 1.88 or newer:

```sh
cargo check --workspace
cargo run -p drama-warden-server
```

The server requires `API_ACCESS_TOKEN`. SQLite is the default and uses `SQLITE_PATH`; MySQL currently requires a SQLx `DATABASE_URL`.
