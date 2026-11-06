# Rust backend migration

The long-term application backend is Rust. The Vue frontend remains unchanged during the backend migration and continues to use the same-origin HTTP API. The current Node.js server remains available on the `main` branch until the Rust implementation reaches API and data compatibility; it is not the target for importing a production database or enabling follow-up writes.

## Boundaries

- Keep public HTTP routes and JSON shapes compatible with `docs/API.md` so the existing panel and CLI can switch without a frontend rewrite.
- Move follow-up planning, event transitions, write claims, database access, authentication, scheduling, and recovery into Rust.
- Define plugins through a versioned JSON protocol over supervised child processes. The protocol must not depend on Rust ABI, Node.js modules, or vendor-specific types. A plugin declares its manifest and capabilities, then receives bounded requests and returns normalized JSON results and stable error codes.
- Keep credentials in the host's private environment/configuration and pass only the plugin's allowlisted configuration to its process. Never include credentials in manifests, API responses, or audit records.
- Store plugin enabled/order state, runtime settings, events, write claims, assets, and audit data in the application database. Keep explicit SQLite and MySQL migrations; do not point both applications at the same live schema during migration.
- Continue serving the built Vue assets from the Rust HTTP service after parity is reached.

## Migration order

1. Add the Rust workspace, configuration loading, SQLite/MySQL connection setup, migrations, Axum HTTP service, Bearer authentication, health route, and language-neutral plugin protocol.
2. Port repositories and read-only APIs for shows, seasons, episodes, assets, plugin state, runtime settings, events, and audit records. Verify response compatibility with the existing Vue panel and CLI.
3. Port metadata/resource/storage capabilities and plugin lifecycle supervision. Keep existing provider code isolated behind the external protocol until each provider has a Rust implementation or an independently packaged plugin executable.
4. Port follow-up planning and preview, then the write-claim state machine, selected-file verification, processing, and uncertain-write recovery. Preserve the rule that ambiguous writes never retry automatically.
5. Port subtitles, scheduling, MCP bridge, backup/restore, and optional providers; update Docker and CI to build the Rust service and Vue assets.
6. Import a protected database backup into a separate Rust database, reconcile row counts and representative records, and verify provider authorization separately. Run the Rust instance on a spare port with all automatic writes disabled.
7. Switch the production port only after API, recovery, provider, and data checks pass. Keep the original database and Docker state available for rollback until the new instance is accepted.

## Current milestone

This branch starts the Rust service and protocol foundation. It does not yet implement all API routes or business workflows and must not receive the production database or credentials. The isolated preview deployment continues to use the Node.js image until a later Rust image is built and explicitly deployed.
