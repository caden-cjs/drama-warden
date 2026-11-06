CREATE TABLE IF NOT EXISTS plugin_call_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  plugin_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  capability VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source VARCHAR(128) NOT NULL,
  correlation_id VARCHAR(255) NULL,
  ok TINYINT(1) NOT NULL,
  error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  duration_ms BIGINT UNSIGNED NOT NULL,
  called_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_plugin_call_log_called (called_at DESC, id DESC),
  KEY idx_plugin_call_log_correlation (correlation_id, id DESC),
  CONSTRAINT chk_plugin_call_log_ok CHECK (ok IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
