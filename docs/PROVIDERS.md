# Provider development

The provider contract is API v2 and is still evolving with the core. Providers perform external I/O and normalize results; follow-up rules, event states, episode matching, and write claims remain in `backend/core/`.

## Loading a provider

Set `plugins.modules` in `config/config.yaml`, or `DRAMA_WARDEN_PLUGINS` in the process environment, to a list or comma-separated list of npm package names or ESM module paths. A module may export a plugin directly as its default export, or export a factory as `default.create(context)`. The runtime validates the manifest and capability map before the server accepts requests. Invalid plugins stop startup. Plugins execute inside the application process; only load trusted code.

External plugins declare settings in `manifest.configSchema`. The loader reads each declared field from `DRAMA_WARDEN_PLUGIN_<PLUGIN_ID>_<FIELD_KEY>`, uppercasing names and converting hyphens and camel-case boundaries to underscores (for example, `example-metadata` plus `apiKey` becomes `DRAMA_WARDEN_PLUGIN_EXAMPLE_METADATA_API_KEY`). It passes the validated string values to the factory as `context.config`. Required fields must be set; `url` fields must use HTTP or HTTPS; undeclared variables under that plugin prefix stop startup. The factory manifest and returned plugin must agree on each field's key, type, and required flag. Plugins that use settings must export a `create(context)` factory. Values come from the process environment, are not persisted or returned by the API, and must never be logged. A direct plugin export remains suitable for plugins that need no injected settings.

This configuration routing does not isolate secrets. Plugins run in the same Node.js process and can read `process.env`, other loaded modules, and files available to the application user. Treat every loaded plugin as trusted with access to all application credentials; use separate processes or containers when providers need different trust boundaries.

The SDK's `PluginContext` fields are optional because factory, capability, lifecycle, and event callbacks receive different context. Capability calls may include a `source`, `correlationId`, and numeric application-local `showId` or `storageId`; `onEvent()` receives the subscribing plugin's `pluginId`. Show and storage IDs are local database identifiers, not provider identities. Factory context can include `config` and a `logger` supplied by the host.

The [metadata provider example](../examples/plugins/metadata-provider.mjs) uses `defineMetadataPlugin()` from the separate [`@drama-warden/plugin-sdk` workspace](../packages/plugin-sdk/README.md) and returns deterministic sample data. From the repository root, set `API_ACCESS_TOKEN` as described in the [quick start](../README.md#快速启动), then load it with `DRAMA_WARDEN_PLUGINS=./examples/plugins/metadata-provider.mjs npm start` and search for `Sample Series`. It is a contract example, not a real metadata source. The SDK is version `0.1.0` and its API v2 contract is still evolving; it has not yet been published to npm. Relative paths resolve from the server's working directory; in Docker, mount plugin files into the container and use their container path. An npm plugin must already be installed in the application's `node_modules`, which generally means adding it in a derived image and lockfile. The application package remains private; the SDK is the independently publishable package.

Internal plugins should use the helpers in `backend/plugins/contract.mjs`. A metadata provider can use `defineMetadataPlugin()`; a storage provider must use `defineStoragePlugin()`. Every declared capability must map to one or more domains. Providers must not write application tables or decide event outcomes.

Subtitle providers use `defineSubtitlePlugin()` and implement `search({ query, languages, seasonNumber, episodeNumber, limit })` plus `download({ candidateId })`. Search returns candidates with stable provider-local `id`, `fileName`, `language`, and explicit season/episode numbers when available. Download returns `{ fileName, content }`, where `content` is a `Buffer` or `Uint8Array`; the core enforces format, size, ZIP, and episode-match checks. The core tries providers in plugin registration order and does not allow providers to choose storage paths or write files.

## Resource capability shapes

Resource providers implement `search({ query, aliases, mediaType, storageProvider, seasonNumber, episodeNumber, limit })` and return either an array or `{ items: [...], truncated: false }`. Each item must include a `shareUrl` (or `url`); `title` and stable provider `sourceId` are optional. `storageProvider` identifies the destination adapter, so a provider can filter candidates before the core previews them. Set `truncated: true` when the result list is incomplete. The core bounds the result count, removes duplicate share URLs, and checks each candidate through the selected storage provider's share listing and follow-up preview. Discovery does not create events or write media files. The preview can refresh local metadata and apply the existing exact-match identity linking rule. Implement providers with `defineResourcePlugin()` and map `search` to the `resource` capability domain.

The built-in `local-resource` provider indexes video paths below the configured local share root, bounded to 5,000 entries and depth 12, and refreshes the index every 60 seconds. It only matches exact normalized show/alias directory names, season-directory suffixes, or filenames with a recognizable episode suffix. Incomplete indexes are marked truncated, so scheduled automation will not queue their candidates.

## Local filesystem provider

Docker Compose enables the built-in `local-storage` storage provider and `local-resource` search provider by default through `storage.local.enabled` in `config/config.example.yaml`. They read shares from a host directory mounted read-only at `/local-shares`; storage writes media under `/app/data/media` in the persistent application volume. Set `LOCAL_STORAGE_SHARE_ROOT_HOST` to select another host source directory. Set `storage.local.enabled: false` in YAML, or `LOCAL_STORAGE_ENABLED=false` in the process environment, to disable both providers. For a non-Docker run, configure `storage.local.shareRoot` to a readable source directory.

Share links use `local-share:/<relative-path>`, where the path is relative to the configured share root. A share can point to a file or directory. Add a storage root through `POST /api/shows/:id/storages`; its `rootPath` is a POSIX path relative to the provider's configured media root, such as `/shows/example`.

The local provider refuses paths containing traversal segments and refuses symbolic links. It requires an explicit file selection for `save`, bounds directory listings, and reports when a listing was truncated. Its only removal mode is `permanent`. `clean` preserves files and directories by default; deleting child directories or nonmatching files requires explicit options.

The local provider also declares optional `writeSidecar({ videoPath, fileName, content })`. It accepts only non-empty SRT/ASS/SSA/VTT bytes up to 8 MiB, writes beside the exact video asset with exclusive-create semantics, refuses symbolic links and never replaces an existing file. This is an optional storage capability outside the shared `storageContract v2` core list. Quark and 115 do not currently implement it because their adapters do not expose local subtitle upload; a provider must explicitly implement and verify the capability before subtitle jobs can target it.

## Built-in subtitle providers and worker

OpenSubtitles is registered when `OPENSUBTITLES_API_KEY` is configured in `.env`. It uses the documented `/api/v1/subtitles` search and `/api/v1/download` flow, sends the key only to the API host, validates the temporary download host, and bounds every response. Set `subtitles.openSubtitlesUserAgent` if the account requires a specific application identification string. The Assrt HTML-search adapter is opt-in with `subtitles.assrtEnabled: true`; its website markup can change, so leave it disabled when it is unavailable.

The background worker is enabled by default and processes only explicitly queued jobs. Queue requests require one existing canonical episode and one present video asset; multiple video versions are treated as ambiguous and skipped. Jobs are unique per storage/season/episode and survive restart. Network/provider failures retry at most three times with backoff before any storage write. Each claim uses a random lease token; stale workers cannot update or write for a job reclaimed by another worker. Once `writeSidecar` is called, an unconfirmed result becomes `uncertain`; operators should inspect the target directory before taking further action. Existing matching sidecars are left untouched. Enabled providers are tried in plugin registration order.

## Built-in metadata providers

The built-in TVmaze provider is registered on every start and requires no credential. It searches TV series, reads details and seasons, and resolves each season through the TVmaze seasons and episode endpoints. Requests use a distinct User-Agent, a 12 second timeout, and a local sliding-window limit below TVmaze's published rate ceiling. The provider caches season IDs briefly between detail and episode requests; `reset()` clears that cache. Its plugin self-check requests the public `/shows/1` endpoint, so a passing result confirms the API is reachable from the application host. A failed check returns a stable metadata error code without exposing the URL or response body.

The TMDB provider is registered when `TMDB_API_KEY` is nonempty. The value is sent as the TMDB v3 `api_key` query parameter and is never returned in provider results or plugin manifests. Search supports TV and movies; details and episode manifests support TV series. Its plugin self-check requests `/configuration` with the configured key. Provider failures are reduced to stable codes such as `METADATA_TIMEOUT`, `METADATA_RATE_LIMITED`, and `METADATA_UPSTREAM_ERROR`; the self-check does not expose the key, URL, or response body.

When both providers are present, TMDB is registered first and TVmaze follows it for metadata resolution. Search queries all enabled providers and reports partial failures per provider. The authenticated `GET /api/metadata/search?q=...` endpoint returns candidates but does not link them; callers confirm one through the show's metadata identity endpoint.

## Built-in Feishu notifications

Set `FEISHU_WEBHOOK_URL` to register the optional `feishu-notification` provider. It subscribes to `workflow.event.status_changed` and sends a card for completed, skipped, or failed follow-up events. `FEISHU_WEBHOOK_SECRET` is optional and enables the Feishu bot signature. The webhook URL must use HTTPS; secrets are read only from the process environment and are not included in plugin manifests or health responses.

Notifications have an eight-second request timeout and stable error codes: `NOTIFICATION_INVALID_CONFIG`, `NOTIFICATION_NOT_CONFIGURED`, `NOTIFICATION_TIMEOUT`, `NOTIFICATION_NETWORK_ERROR`, `NOTIFICATION_HTTP_ERROR`, `NOTIFICATION_INVALID_RESPONSE`, and `NOTIFICATION_REJECTED`. The notifier does not retry a failed request because a timeout can happen after Feishu has accepted the message. Notification failures are reported in the workflow callback result and do not change the persisted follow-up event status.

## Built-in SmartStrm indexer

Set `indexer.smartstrm.baseUrl` and `indexer.smartstrm.taskName` in YAML, and `SMARTSTRM_WEBHOOK_TOKEN` in `.env`, to enable the optional indexer. The provider sends the SmartStrm webhook event `{ "event": "a_task", "task": { "name": "..." } }` after a successful media save and requires a JSON response with `success: true`. It does not log the webhook URL, token, or response body, and it does not retry a request whose outcome is uncertain. A failed or unconfirmed response keeps the follow-up event from being marked processed. Health checks send `{ "action": "ping" }` with a 15-second timeout.

The current built-in adapter targets one configured SmartStrm task. Leave the URL and task name null and the token unset to skip index refresh. For multiple SmartStrm tasks or other indexers, use an external `indexer` plugin that maps `storageId` or `path` to the provider's task model.

## Built-in cloud storage providers

Neither cloud CLI is included by default, and Compose registers a cloud provider only when its CLI path is configured. `INCLUDE_QUARK_CLI=true` includes the pinned Quark 1.0.25 archive after verifying its SHA-256; the build does not run the upstream install script or fetch a moving version. `INCLUDE_115_CLI=true` installs `115cli==0.3.4` and its transitives from a CPython 3.12 hash-locked wheel file for Linux x86_64/aarch64; its `p115cipher` dependency has a license-file conflict described in [third-party notices](../THIRD-PARTY-NOTICES.md). Review those notices before enabling either adapter, then set `storage.quark.cliPath` or `storage.pan115.cliPath` to the executable path inside the image. The bundled Quark CLI is installed at `/opt/quarkclouddrive/scripts/quark-drive.cjs`; the 115 CLI is installed at `/usr/local/bin/115cli`. Provider identifiers, CLI output formats, and file IDs stay inside these adapters.

For the bundled Quark CLI, run `docker compose exec drama-warden node /opt/quarkclouddrive/scripts/quark-drive.cjs login` and complete the official OAuth flow. The CLI state is stored under `/app/data/.quarkclouddrive` in the persistent `drama-warden-data` volume. Quark `remove(mode="recycle")` moves items into the configured `storage.quark.recycleDirectory`, whose default is `/DramaWarden-Recycle/Quark`.

For 115, after enabling `INCLUDE_115_CLI=true` and rebuilding, set `PAN115_COOKIE` in the private `.env` file. The adapter imports it lazily on its first operation; the 115 CLI then stores its credential beneath `/app/data/.115cli`. Remove the cookie from `.env` after successful authorization. The provider status never returns the cookie. 115 supports only `remove(mode="permanent")`; review that policy before configuring it as a storage location.

Share-file IDs are stable hashes of the share URL and provider file ID, so queued events remain resolvable after a process restart without returning raw provider IDs. Before saving, each adapter re-lists the share and verifies the selected IDs, paths, names, and sizes. Storage directory listings recurse when requested and mark bounded or provider-truncated results as incomplete. The 115 CLI directory listing is capped at 500 entries per directory; a directory at that limit is reported as truncated, and follow-up processing refuses the incomplete snapshot.

The providers use conservative defaults for `clean`: files and child directories are kept unless the caller explicitly sets `deleteDuplicates` or `deleteSubdirs`. A CLI operation timeout or partial write is not retried by the follow-up workflow; inspect the target directory and write claims first.

## Storage capability shapes

All actions receive `(input, context)` and return normalized objects. The current follow-up processor uses:

| Capability | Input | Expected result or behavior |
| --- | --- | --- |
| `list` | `{ path, options: { recursive } }` | `{ path, files, total, truncated }`; file paths use the provider's configured root namespace |
| `listSharedFiles` | `{ shareUrl, options? }` | `{ files, total, truncated }`; each file has stable `id`, `name`, relative `path`, `size`, and `mtime` |
| `save` | `{ shareUrl, destinationPath, selection }` | Save exactly the selected files; return `{ ok, savedCount }` |
| `mkdir` | `{ path }` | Create the directory recursively when needed |
| `move` | `{ sourcePath, destinationPath }` | `destinationPath` is the complete target path |
| `rename` | `{ path, newName }` | Change only the basename |
| `renameMany` | `{ items: [{ path, newName }] }` | Rename the listed files; report partial failure as an error |
| `remove` | `{ path, mode }` | Accept only a mode listed in `storageContract.removeModes` |
| `clean` | `{ path, mode, options }` | Apply the same explicit removal mode to selected children |
| `status` | `{}` | Return normalized provider status |
| `writeSidecar` (optional) | `{ videoPath, fileName, content }` | Create one supported subtitle beside the exact video; fail if the target already exists |

Listings used for follow-up must set `truncated: false` only when complete. Share file IDs must remain stable between queueing and processing so a queued event cannot silently switch to another file. A provider must reject unsupported removal modes instead of substituting a different behavior. `recycle` and `permanent` are distinct operations.

## Metadata capability shapes

Metadata providers implement `search({ query, mediaType, limit })`, `detail({ externalId, mediaType })`, and `episodes({ externalId, seasonNumber })`. Search/detail candidates use `id`, `externalId`, `providerId`, `mediaType`, and `name`; the cross-provider type also permits optional `originalName`, `overview`, `firstAirDate`, `year`, `status`, `language`, `genres`, `posterPath`, `backdropPath`, `voteAverage`, and `externalUrl` fields. Each provider fills the fields it can supply. Detail results may include seasons. Episode results use the canonical fields `seasonNumber`, `episodeNumber`, and `airDate`; external IDs remain strings and are paired with the provider ID. Provider failures should use stable error codes and avoid returning credentials or raw request details.

When an action or `initialize()` / `reset()` hook throws, the host records or returns only its stable error code and a generic `plugin operation failed` error. Error codes may contain 1–64 uppercase ASCII letters, digits, and underscores; missing or invalid codes become `PLUGIN_ERROR`. The host does not forward the provider's raw message or cause to API responses or startup logs. `monitor()` and `onEvent()` failures are reduced to stable error codes. Core workflow decisions use host-generated state and error context; provider error codes cannot mark an event skipped by matching a core code such as `DESTINATION_CONFLICT`.

Plugin module import and factory failures are also reduced to a generic startup message and safe error code. Do not depend on raw exception messages for diagnostics; use stable codes and the host's plugin ID/context in your own private diagnostics without logging configuration values.

The host serializes lifecycle maintenance against capability calls. `reset()` pauses new calls and waits for active calls to finish; disabling a plugin persists the disabled state, rejects new calls, drains active calls, and then runs `reset()`. Re-enabling runs `initialize()` before the plugin becomes available. A failed disable cleanup leaves the plugin disabled and reports `PLUGIN_RESET_FAILED`, so the implementation should make `reset()` safe to retry.

Before contributing a provider, document its configuration, rate limits, identity stability, failure codes, reset behavior, and any side effects. Keep credentials in environment or private runtime configuration, never in manifests or logs.
