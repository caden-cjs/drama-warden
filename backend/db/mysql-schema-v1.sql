CREATE TABLE IF NOT EXISTS shows (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  media_type VARCHAR(16) NOT NULL DEFAULT 'tv',
  finished TINYINT UNSIGNED NOT NULL DEFAULT 0,
  aliases_json LONGTEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT chk_shows_finished CHECK (finished IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS show_metadata_identity (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  show_id BIGINT UNSIGNED NOT NULL,
  provider_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  external_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  media_type VARCHAR(16) NOT NULL DEFAULT 'tv',
  linked_by VARCHAR(64) NOT NULL DEFAULT 'manual',
  linked_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_metadata_identity_show_provider (show_id, provider_id),
  UNIQUE KEY uq_metadata_identity_provider_external (provider_id, external_id),
  KEY idx_show_metadata_identity_show (show_id),
  CONSTRAINT fk_metadata_identity_show FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS show_season (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  show_id BIGINT UNSIGNED NOT NULL,
  season_number INT UNSIGNED NOT NULL,
  name VARCHAR(255) NULL,
  episode_count INT UNSIGNED NULL,
  first_air_date DATE NULL,
  metadata_provider_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  metadata_synced_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_show_season_number (show_id, season_number),
  CONSTRAINT chk_show_season_number CHECK (season_number >= 0),
  CONSTRAINT fk_show_season_show FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS show_episode (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  season_id BIGINT UNSIGNED NOT NULL,
  episode_number INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_show_episode_number (season_id, episode_number),
  CONSTRAINT chk_show_episode_number CHECK (episode_number > 0),
  CONSTRAINT fk_show_episode_season FOREIGN KEY (season_id) REFERENCES show_season(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS show_episode_metadata (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  episode_id BIGINT UNSIGNED NOT NULL,
  provider_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_external_id VARCHAR(255) NOT NULL,
  provider_episode_id VARCHAR(255) NULL,
  name TEXT NULL,
  overview LONGTEXT NULL,
  air_date DATE NULL,
  air_time VARCHAR(16) NULL,
  runtime INT UNSIGNED NULL,
  still_path TEXT NULL,
  metadata_json LONGTEXT NULL,
  synced_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_episode_metadata_provider (episode_id, provider_id),
  KEY idx_show_episode_metadata_air_date (air_date),
  CONSTRAINT chk_show_episode_metadata_runtime CHECK (runtime IS NULL OR runtime > 0),
  CONSTRAINT fk_show_episode_metadata_episode FOREIGN KEY (episode_id) REFERENCES show_episode(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS show_storage (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  show_id BIGINT UNSIGNED NOT NULL,
  provider_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  root_path VARCHAR(600) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  local_path VARCHAR(1024) NULL,
  enabled TINYINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_show_storage_root (show_id, provider_id, root_path),
  KEY idx_show_storage_show (show_id),
  CONSTRAINT chk_show_storage_enabled CHECK (enabled IN (0, 1)),
  CONSTRAINT fk_show_storage_show FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS show_episode_asset (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  episode_id BIGINT UNSIGNED NOT NULL,
  show_storage_id BIGINT UNSIGNED NOT NULL,
  asset_key VARCHAR(700) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  relative_path VARCHAR(2048) NOT NULL,
  file_name VARCHAR(1024) NOT NULL,
  file_size BIGINT UNSIGNED NULL,
  file_mtime BIGINT UNSIGNED NULL,
  quality VARCHAR(64) NULL,
  is_present TINYINT UNSIGNED NOT NULL DEFAULT 1,
  scan_id VARCHAR(64) NOT NULL,
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_show_episode_asset_key (show_storage_id, asset_key),
  KEY idx_show_episode_asset_episode (episode_id, is_present),
  KEY idx_show_episode_asset_scan (show_storage_id, scan_id),
  CONSTRAINT chk_show_episode_asset_present CHECK (is_present IN (0, 1)),
  CONSTRAINT fk_show_episode_asset_episode FOREIGN KEY (episode_id) REFERENCES show_episode(id) ON DELETE CASCADE,
  CONSTRAINT fk_show_episode_asset_storage FOREIGN KEY (show_storage_id) REFERENCES show_storage(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS show_episode_storage (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  episode_id BIGINT UNSIGNED NOT NULL,
  show_storage_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'missing',
  asset_count INT UNSIGNED NOT NULL DEFAULT 0,
  scanned_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_show_episode_storage (episode_id, show_storage_id),
  KEY idx_show_episode_storage_status (show_storage_id, status),
  CONSTRAINT chk_show_episode_storage_status CHECK (status IN ('missing', 'present', 'conflict')),
  CONSTRAINT chk_show_episode_storage_asset_count CHECK (asset_count >= 0),
  CONSTRAINT fk_show_episode_storage_episode FOREIGN KEY (episode_id) REFERENCES show_episode(id) ON DELETE CASCADE,
  CONSTRAINT fk_show_episode_storage_storage FOREIGN KEY (show_storage_id) REFERENCES show_storage(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS show_episode_write_claim (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  show_storage_id BIGINT UNSIGNED NOT NULL,
  season_number INT UNSIGNED NOT NULL,
  episode_number INT UNSIGNED NOT NULL,
  event_id BIGINT UNSIGNED NULL,
  status VARCHAR(16) NOT NULL,
  claimed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_show_episode_write_claim (show_storage_id, season_number, episode_number),
  KEY idx_show_episode_write_claim_event (event_id),
  KEY idx_show_episode_write_claim_status (status, updated_at),
  CONSTRAINT chk_show_episode_write_claim_status CHECK (status IN ('reserved', 'completed', 'uncertain')),
  CONSTRAINT chk_show_episode_write_claim_numbers CHECK (season_number > 0 AND episode_number > 0),
  CONSTRAINT fk_show_episode_write_claim_storage FOREIGN KEY (show_storage_id) REFERENCES show_storage(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS update_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  show_id BIGINT UNSIGNED NULL,
  kind VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  source VARCHAR(64) NOT NULL DEFAULT 'manual',
  payload_json LONGTEXT NOT NULL,
  correlation_id VARCHAR(128) NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_update_event_status_created (status, created_at),
  KEY idx_update_event_show_created (show_id, created_at),
  CONSTRAINT chk_update_event_status CHECK (status IN ('pending', 'processing', 'processed', 'skipped', 'failed')),
  CONSTRAINT chk_update_event_attempt_count CHECK (attempt_count >= 0),
  CONSTRAINT fk_update_event_show FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
