CREATE TABLE IF NOT EXISTS subtitle_job (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  show_storage_id INTEGER NOT NULL REFERENCES show_storage(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL CHECK (season_number > 0),
  episode_number INTEGER NOT NULL CHECK (episode_number > 0),
  languages_json TEXT NOT NULL DEFAULT '["zh-CN","zh-TW"]' CHECK (json_valid(languages_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'skipped', 'failed', 'uncertain')),
  provider_id TEXT,
  output_path TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  locked_until TEXT,
  claim_token TEXT,
  write_started_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  UNIQUE (show_storage_id, season_number, episode_number)
);

CREATE INDEX IF NOT EXISTS idx_subtitle_job_queue
  ON subtitle_job(status, next_attempt_at, id);

CREATE INDEX IF NOT EXISTS idx_subtitle_job_show
  ON subtitle_job(show_id, created_at);
