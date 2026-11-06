CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  media_type TEXT NOT NULL DEFAULT 'tv',
  finished INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0, 1)),
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS show_metadata_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL CHECK (length(trim(provider_id)) > 0),
  external_id TEXT NOT NULL CHECK (length(trim(external_id)) > 0),
  media_type TEXT NOT NULL DEFAULT 'tv',
  linked_by TEXT NOT NULL DEFAULT 'manual',
  linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (show_id, provider_id),
  UNIQUE (provider_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_show_metadata_identity_show
  ON show_metadata_identity(show_id);

CREATE TABLE IF NOT EXISTS show_season (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL CHECK (season_number >= 0),
  name TEXT,
  episode_count INTEGER CHECK (episode_count IS NULL OR episode_count >= 0),
  first_air_date TEXT,
  metadata_provider_id TEXT,
  metadata_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (show_id, season_number)
);

CREATE TABLE IF NOT EXISTS show_episode (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES show_season(id) ON DELETE CASCADE,
  episode_number INTEGER NOT NULL CHECK (episode_number > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (season_id, episode_number)
);

CREATE TABLE IF NOT EXISTS show_episode_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES show_episode(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  provider_external_id TEXT NOT NULL,
  provider_episode_id TEXT,
  name TEXT,
  overview TEXT,
  air_date TEXT,
  air_time TEXT,
  runtime INTEGER CHECK (runtime IS NULL OR runtime > 0),
  still_path TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (episode_id, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_show_episode_metadata_air_date
  ON show_episode_metadata(air_date);

CREATE TABLE IF NOT EXISTS show_storage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  root_path TEXT NOT NULL,
  local_path TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (show_id, provider_id, root_path)
);

CREATE INDEX IF NOT EXISTS idx_show_storage_show ON show_storage(show_id);

CREATE TABLE IF NOT EXISTS show_episode_asset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES show_episode(id) ON DELETE CASCADE,
  show_storage_id INTEGER NOT NULL REFERENCES show_storage(id) ON DELETE CASCADE,
  asset_key TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER CHECK (file_size IS NULL OR file_size >= 0),
  file_mtime INTEGER CHECK (file_mtime IS NULL OR file_mtime >= 0),
  quality TEXT,
  is_present INTEGER NOT NULL DEFAULT 1 CHECK (is_present IN (0, 1)),
  scan_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (show_storage_id, asset_key)
);

CREATE INDEX IF NOT EXISTS idx_show_episode_asset_episode
  ON show_episode_asset(episode_id, is_present);

CREATE INDEX IF NOT EXISTS idx_show_episode_asset_scan
  ON show_episode_asset(show_storage_id, scan_id);

CREATE TABLE IF NOT EXISTS show_episode_storage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES show_episode(id) ON DELETE CASCADE,
  show_storage_id INTEGER NOT NULL REFERENCES show_storage(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'missing' CHECK (status IN ('missing', 'present', 'conflict')),
  asset_count INTEGER NOT NULL DEFAULT 0 CHECK (asset_count >= 0),
  scanned_at TEXT,
  UNIQUE (episode_id, show_storage_id)
);

CREATE INDEX IF NOT EXISTS idx_show_episode_storage_status
  ON show_episode_storage(show_storage_id, status);

CREATE TABLE IF NOT EXISTS show_episode_write_claim (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_storage_id INTEGER NOT NULL REFERENCES show_storage(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL CHECK (season_number > 0),
  episode_number INTEGER NOT NULL CHECK (episode_number > 0),
  event_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'uncertain')),
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (show_storage_id, season_number, episode_number)
);

CREATE INDEX IF NOT EXISTS idx_show_episode_write_claim_event
  ON show_episode_write_claim(event_id);

CREATE INDEX IF NOT EXISTS idx_show_episode_write_claim_status
  ON show_episode_write_claim(status, updated_at);

CREATE TABLE IF NOT EXISTS update_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER REFERENCES shows(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'skipped', 'failed')),
  source TEXT NOT NULL DEFAULT 'manual',
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  correlation_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_update_event_status_created
  ON update_event(status, created_at);

CREATE INDEX IF NOT EXISTS idx_update_event_show_created
  ON update_event(show_id, created_at);
