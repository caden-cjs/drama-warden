CREATE TABLE IF NOT EXISTS plugin_call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 2 AND 64),
  capability TEXT NOT NULL CHECK (length(capability) BETWEEN 1 AND 64),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 128),
  correlation_id TEXT CHECK (correlation_id IS NULL OR length(correlation_id) <= 255),
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 64),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  called_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_plugin_call_log_called
  ON plugin_call_log(called_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_plugin_call_log_correlation
  ON plugin_call_log(correlation_id, id DESC);
