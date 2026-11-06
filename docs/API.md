# HTTP API

The API is intentionally small while the follow-up core is being migrated.

The production server also serves the Vue management panel from `/`. The panel uses the same-origin API and stores the entered Bearer token in the current browser's localStorage. During development, run `npm run dev`; Vite proxies `/api` to the backend on port 8080.

The panel's update history is derived from `GET /api/events` and shows terminal workflow event states. Plugin capability calls have a separate metadata-only audit log exposed by `GET /api/plugin-calls`.

The `npm run cli -- ...` command provides a panel-free client for the same API. It supports metadata search, show creation and linking, storage setup and scanning, read-only automation scans, resource search, follow-up preview/queue, and event listing/processing. Metadata candidates still require explicit selection. Share URLs are read from stdin with `--share-url-stdin`; event processing requires `--confirm-write` because it may write media. The CLI does not bypass API authentication or the follow-up state machine.

## Authentication

Every route except `GET /api/health` requires:

```http
Authorization: Bearer <API_ACCESS_TOKEN>
```

Set `API_ACCESS_TOKEN` in the private environment before using application routes. Requests without a configured token are rejected. JSON request bodies are limited to 256 KiB.

Plugin management routes use the same Bearer token as every other protected route. There is no separate read-only or plugin-admin role.

`PUT /api/plugins/:id` accepts `{ "enabled": true }` or `{ "enabled": false }`. The enabled state and plugin order are saved under the `plugins` key in `application_setting`. When enabling a disabled plugin, the server initializes it before saving and making it available to business calls. If initialization or persistence fails, it stays disabled and the server calls the plugin's `reset()` hook to clean up; a cleanup failure is returned as `PLUGIN_CLEANUP_FAILED`. When disabling, the server first persists the disabled state, rejects new capability calls, waits for active calls to finish, then calls `reset()`. If cleanup fails, the plugin stays disabled and the API returns `PLUGIN_RESET_FAILED`; if persistence fails, it stays enabled and cleanup is not run.

`POST /api/plugins/:id/move` accepts `{ "direction": "up" }` or `{ "direction": "down" }` and changes order among plugins with the same `kind`. That order is used for provider fallback and other ordered plugin calls.

`POST /api/plugins/:id/monitor` returns a result such as `{ "result": { "pluginId": "tvmaze", "enabled": true, "ok": true, "configured": true } }`. A failed check may also include `authorized` and a stable `errorCode`; error codes must use uppercase letters, digits, and underscores and are replaced with `PLUGIN_ERROR` when they do not match. The route does not return plugin credentials or raw error messages.

`POST /api/plugins/:id/reset` returns `{ "pluginId": "tvmaze", "ok": true }` after active capability calls finish and the plugin's `reset()` hook completes. The host pauses new calls during reset and resumes them afterward when the plugin remains enabled. The hook's behavior is implemented by that plugin and may clear local caches, sessions, or other state. Treat plugins as trusted code and review their reset behavior before invoking it.

`GET /api/plugin-calls` lists recent provider capability calls. Optional filters are `pluginId`, `capability`, `source`, `correlationId`, and `ok=true|false`; `limit` defaults to 50 and is capped at 100, while `offset` defaults to 0. The response contains `id`, `pluginId`, `capability`, `source`, `correlationId`, `ok`, `errorCode`, `durationMs`, and `calledAt`. The database prunes to the newest 10,000 records at startup and after each 100 calls. Input, output, credentials, and raw error messages are not recorded. If an operation succeeds but its audit write fails, the plugin host returns `PLUGIN_AUDIT_FAILED` and marks that the side effect may have completed; inspect the operation's target state before retrying a write.

Plugin credentials and provider configuration remain deployment environment settings. Plugin management stores only enabled state and order, and the API does not return credentials or accept plugin secret values.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Public database health check |
| `GET` | `/api/plugins` | List registered plugins and their public contracts |
| `GET` | `/api/plugin-calls` | List recent metadata-only plugin capability audit records |
| `PUT` | `/api/plugins/:id` | Enable or disable a registered plugin |
| `POST` | `/api/plugins/:id/move` | Move a plugin up or down within its kind |
| `POST` | `/api/plugins/:id/monitor` | Run a plugin self-check |
| `POST` | `/api/plugins/:id/reset` | Run the plugin reset lifecycle hook |
| `GET` | `/api/settings/runtime` | Read follow-up scheduler settings and environment defaults |
| `PUT` | `/api/settings/runtime` | Update follow-up scheduler settings in the application database |
| `DELETE` | `/api/settings/runtime` | Remove saved scheduler settings and restore environment defaults |
| `GET` | `/api/automation/status` | Read scheduler configuration and the latest in-memory scan summary |
| `POST` | `/api/automation/scan` | Run a one-shot candidate preview across tracked TV shows |
| `GET` | `/api/metadata/search?q=...&mediaType=tv&limit=10` | Search enabled metadata providers and return linkable candidates |
| `GET` | `/api/shows` | List tracked shows |
| `POST` | `/api/shows` | Create a show |
| `GET` | `/api/shows/:id` | Read a show and its metadata identities |
| `GET` | `/api/shows/:id/metadata-identities` | List provider identities |
| `POST` | `/api/shows/:id/metadata-identities` | Link a provider identity |
| `GET` | `/api/shows/:id/storages` | List configured storage roots |
| `POST` | `/api/shows/:id/storages` | Add or update a storage root for an enabled storage plugin |
| `GET` | `/api/shows/:id/storages/:storageId/episodes` | List scanned episode assets for a storage root |
| `POST` | `/api/shows/:id/storages/:storageId/scan` | Scan a storage root and synchronize visible episode assets |
| `POST` | `/api/shows/:id/resources/search` | Search enabled resource providers and preview candidate shares |
| `POST` | `/api/shows/:id/followup/preview` | Compare a share listing with metadata and stored episodes |
| `POST` | `/api/shows/:id/followup/queue` | Create a pending event for the confirmed missing episode files |
| `GET` | `/api/events?status=pending&limit=100` | List follow-up events |
| `POST` | `/api/events` | Create a generic event (`new_ep` must use the follow-up queue) |
| `POST` | `/api/events/:id/process` | Process one pending episode follow-up event |
| `POST` | `/api/events/:id/transition` | Move a non-follow-up event through its state machine |
| `POST` | `/api/events/:id/retry` | Return a safe failed event to pending |
| `GET` | `/api/subtitles/status` | Read the subtitle worker and enabled providers |
| `GET` | `/api/subtitle-jobs?status=pending&showId=1&limit=100` | List persisted subtitle jobs |
| `POST` | `/api/shows/:id/subtitle-jobs` | Queue subtitles for one known season and episode |
| `GET` | `/api/subtitle-jobs/:id` | Read a subtitle job |
| `POST` | `/api/subtitle-jobs/:id/retry` | Retry a failed job that did not start a storage write |

All JSON responses use UTF-8. Collection responses have an `items` array; create responses wrap the changed record in `show`, `identity`, `storage`, or `event`. Event processing returns the outcome fields with a redacted `event` record.

Metadata search returns `{ "query", "mediaType", "providers", "results", "errors" }`. Each result includes its `providerId` and string `externalId`; provider status and stable error codes are returned separately. The route searches all enabled metadata providers and tolerates partial failures. If every configured provider fails, it returns HTTP 502. An empty `providers` list means no metadata provider is currently registered. To confirm a candidate, create the show and post the selected provider ID, external ID, and media type to `POST /api/shows/:id/metadata-identities`; search never creates a link automatically.

Preview and queue requests use `{ "storageId": 1, "shareUrl": "...", "shareTitle": "..." }`. Preview reads the share manifest through the selected storage plugin and compares it with metadata and stored episodes. It does not save cloud files. Queue repeats the preview, creates an event, and reserves the selected season/episode write claims.

Resource search accepts `{ "storageId": 1, "query": "Show name", "limit": 10 }`; `query` defaults to the show's canonical name and `limit` is capped at 20. Enabled `resource-provider` plugins receive the query, aliases, media type, target storage provider, latest stored season/episode, and remaining result limit in configured order until the result limit is reached. Returned shares are checked with the follow-up preview and include an `eligible` result with a missing-episode plan when available. The response includes the selected share URL so the caller can submit it to the follow-up queue. Search never creates an event or saves media files; the preview can refresh local metadata and apply the existing exact-match identity linking rule. Partial provider failures are returned per provider; HTTP 502 includes provider IDs and stable error codes when every called resource provider fails. Search completeness is reported per provider; periodic automation will not queue results from a provider that reports a truncated listing.

`POST /api/automation/scan` performs the same search-and-preview operation for every unfinished TV show with enabled storage roots. It never queues or processes events. The response is capped to 100 candidate previews and 200 storage roots per run. The latest scan status is held in process memory and is reset on restart.

Periodic automation is disabled by default. First-run defaults come from `automation` in `config/config.yaml`; non-empty `FOLLOWUP_AUTOMATION_ENABLED`, `FOLLOWUP_SCAN_INTERVAL_MINUTES`, and `FOLLOWUP_AUTO_PROCESS` environment values override YAML. After a value is saved through the runtime settings API, the database value takes precedence until reset. An enabled resource provider is required to find candidates. Scheduled scans queue at most one eligible share per show/storage root. Queued events remain pending unless automatic processing is enabled; that opt-in allows scheduled scans to save media through storage plugins. Processing still uses episode write claims and marks uncertain writes for manual review. The one-shot API never performs storage writes.

The authenticated runtime-settings routes manage only `followupAutomationEnabled`, `followupScanIntervalMinutes`, and `followupAutoProcess`. Values are validated and stored in `application_setting`; they take precedence over the three environment variables until `DELETE /api/settings/runtime` removes the database override. Enabling scheduled automation immediately scans and may queue eligible candidates. Enabling automatic processing allows future scheduled runs to write selected media, so treat that switch as a media-write permission. Database credentials, API tokens, provider credentials, plugin paths, and database driver selection remain deployment environment settings and are never returned by these routes.

`PUT /api/settings/runtime` accepts a partial JSON object, for example:

```json
{
  "followupAutomationEnabled": true,
  "followupScanIntervalMinutes": 30,
  "followupAutoProcess": false
}
```

The response contains the effective `settings`, current deployment `defaults`, and a `source` value of `environment` or `database`.

`POST /api/events/:id/process` accepts no body. It processes a queued `new_ep` event by rechecking the selected provider file IDs and destination listing, saving only the selected files, checking the destination delta, organizing and canonically naming the files, synchronizing the asset catalog, optionally refreshing an enabled indexer, and then completing the event. The selected storage plugin must return complete listings with file paths rooted under the configured storage path; share file IDs must remain stable between queueing and processing. A configured notification plugin receives the terminal event after the database state is saved; notification failure does not change the event result.

The process endpoint returns HTTP 200 when it reaches a terminal event state. Inspect `ok` and `event.status` to distinguish `processed` from `failed` or `skipped`. A failure before storage writes releases unattempted claims. Once a save is attempted, a failure marks claims uncertain and ordinary retry is blocked until the destination has been inspected. No automatic retry is performed.

`POST /api/events/:id/recover` reviews a `new_ep` event left in `processing` after its worker stopped, or a `failed` event with unresolved storage claims. Every action requires `confirmNoActiveWorker: true`, an operator confirmation that no other application instance is handling the event. Send `{ "action": "complete", "confirmNoActiveWorker": true, "confirmOutputsMatch": true }` to re-list the selected season, finish safe moves/renames for uniquely matched files, synchronize assets, refresh an enabled indexer, and finalize the event. The service never calls `save` during recovery. The current event record has no pre-save directory snapshot or content hash, so filenames and sizes only identify candidates; the operator must confirm that the matching files belong to this event. If the complete selected set cannot be identified from the source/canonical names and sizes, recovery stops and leaves the event and claims unchanged for manual review.

To enable a retry after confirming that no selected output remains, send `{ "action": "retry_after_review", "confirmNoActiveWorker": true, "confirmNoOutput": true }`. The service requires a complete destination listing and rejects the decision if any selected or canonical filename is present. A `processing` event becomes `failed` with its reserved claims retained; a failed event's uncertain claims are reset to reserved only after this explicit review. Duplicate automation stays blocked. A later explicit `POST /api/events/:id/retry` returns it to `pending`; the next `process` call still rechecks the share and destination. Event responses include `retryable`, and the panel only offers retry when the server permits it. Recovery is rejected while this service process is actively handling the event. Run one application instance per database during recovery; stopping/restarting the application is the way to clear an abandoned in-process worker.

The event keeps the share URL server-side, and API responses redact URL, token, cookie, password, and secret fields. Event responses include a `retryable` flag derived from the event state and write claims. Create `new_ep` events through the follow-up queue and use the process/recover/retry endpoints to change their state. Generic event creation and direct transitions reject `new_ep` so they cannot bypass the storage workflow.

Storage setup uses `{ "providerId": "local-storage", "rootPath": "/shows/example" }`. The local provider maps that virtual path under `LOCAL_STORAGE_ROOT`; the source `shareUrl` uses the `local-share:/...` scheme and resolves under `LOCAL_STORAGE_SHARE_ROOT`. The local plugin requires an explicit selected-file list for saves and only declares `remove(mode="permanent")`.

Storage scan requests accept no body. A complete recursive listing synchronizes visible assets and marks previously present assets that disappeared as absent. A truncated listing records visible assets incrementally and never marks unseen assets absent. Use a scan before previewing a show's first follow-up so the planner can distinguish missing episodes from files already in storage.

Subtitle jobs use `{ "storageId": 1, "seasonNumber": 1, "episodeNumber": 3, "languages": ["zh-CN", "zh-TW"] }`. Queueing requires a known canonical episode and an enabled storage plugin that declares the optional `writeSidecar` capability. The management panel only offers episodes whose current asset catalog reports exactly one video asset. Jobs are unique per storage/season/episode, so repeated requests return the existing job. Before writing, the worker rechecks a complete destination listing and requires exactly one video asset; an incomplete listing or changed target fails without starting a subtitle write. The worker matches provider results using explicit season/episode metadata or a recognizable episode marker, tries providers in registration order, and never overwrites an existing sidecar.

Downloads are limited to 16 MiB, extracted subtitle content to 8 MiB, and accepted formats to SRT, ASS, SSA, and VTT. ZIP entries are checked for traversal paths, symlinks, encryption, unsupported compression, excessive expansion, and CRC mismatches. The output basename comes from the exact video asset. Writes are marked before calling the storage plugin; if the result cannot be confirmed, the job becomes `uncertain` and cannot be retried through the API. Failed jobs retry up to three times only while no write has started. Each claim has a lease token, so a worker whose lease expired cannot update a job after another worker reclaims it. Job API responses include a `retryable` flag; the panel only offers retry when the server confirms that no write started. The local filesystem provider implements `writeSidecar`; current Quark and 115 providers do not expose media upload through this capability, so they cannot be selected for subtitle writes.

## Event state transitions

| Current state | Allowed next state |
| --- | --- |
| `pending` | `processing`, `skipped`, `failed` |
| `processing` | `processed`, `skipped`, `failed` |
| `processed` | none |
| `skipped` | none |
| `failed` | none |

Retry applies to failed events without storage write claims, or to an interrupted event explicitly reviewed as having no output. The latter retains its reserved write claims until the event is retried, preserving the duplicate-prevention guard. Uncertain or otherwise unresolved claims block ordinary retry.

The table describes ordinary event transitions. The dedicated recovery endpoint may mark a failed follow-up `processed` only after it re-verifies every selected output, syncs assets, and receives confirmation from the configured indexer; `retry` is the only endpoint that returns a failed event to `pending`.

## Errors

Errors are returned as `{ "error": "...", "code": "..." }`. Invalid JSON and invalid input return 4xx responses. Internal errors return a generic message so SQL or provider details are not exposed to API clients.
