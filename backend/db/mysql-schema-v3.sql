CREATE TABLE IF NOT EXISTS application_setting (
  setting_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  value_json LONGTEXT NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key),
  CONSTRAINT chk_application_setting_json CHECK (JSON_VALID(value_json))
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
