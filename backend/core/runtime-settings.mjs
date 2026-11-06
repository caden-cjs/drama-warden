const SETTINGS_KEY = 'runtime';
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 1440;

function envBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function validateSettings(value, { partial = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('runtime settings must be an object');
  }
  const next = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === 'followupAutomationEnabled' || key === 'followupAutoProcess') {
      if (typeof field !== 'boolean') throw new TypeError(key + ' must be a boolean');
      next[key] = field;
    } else if (key === 'followupScanIntervalMinutes') {
      if (!Number.isSafeInteger(field)
          || field < MIN_INTERVAL_MINUTES
          || field > MAX_INTERVAL_MINUTES) {
        throw new TypeError(key + ' must be between 5 and 1440');
      }
      next[key] = field;
    } else {
      throw new TypeError('unsupported runtime setting: ' + key);
    }
  }
  if (!partial && Object.keys(next).length !== 3) {
    throw new TypeError('runtime settings are incomplete');
  }
  return next;
}

function parseStoredSettings(value) {
  if (value == null) return null;
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error('stored runtime settings are invalid JSON', { cause: error });
  }
  return validateSettings(parsed);
}

function settingUpsertSql(dialect) {
  if (dialect === 'mysql') {
    return 'INSERT INTO application_setting (setting_key, value_json) VALUES (?, ?) '
      + 'ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = CURRENT_TIMESTAMP(3)';
  }
  return 'INSERT INTO application_setting (setting_key, value_json) VALUES (?, ?) '
    + "ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
}

export function createRuntimeSettings({ db, env = process.env } = {}) {
  if (!db || typeof db.get !== 'function' || typeof db.run !== 'function') {
    throw new TypeError('database is required');
  }
  const defaults = validateSettings({
    followupAutomationEnabled: envBoolean(env.FOLLOWUP_AUTOMATION_ENABLED),
    followupScanIntervalMinutes: Number(env.FOLLOWUP_SCAN_INTERVAL_MINUTES || 30),
    followupAutoProcess: envBoolean(env.FOLLOWUP_AUTO_PROCESS),
  });

  async function get() {
    const row = await db.get(
      'SELECT value_json FROM application_setting WHERE setting_key = ?',
      [SETTINGS_KEY],
    );
    const stored = parseStoredSettings(row?.value_json);
    return {
      settings: stored || { ...defaults },
      defaults: { ...defaults },
      source: stored ? 'database' : 'environment',
    };
  }

  async function update(input) {
    const patch = validateSettings(input, { partial: true });
    if (Object.keys(patch).length === 0) throw new TypeError('at least one setting is required');
    return db.transaction(async (transaction) => {
      const row = await transaction.get(
        'SELECT value_json FROM application_setting WHERE setting_key = ?',
        [SETTINGS_KEY],
      );
      const stored = parseStoredSettings(row?.value_json);
      const settings = validateSettings({ ...(stored || defaults), ...patch });
      await transaction.run(settingUpsertSql(db.dialect), [SETTINGS_KEY, JSON.stringify(settings)]);
      return { settings, defaults: { ...defaults }, source: 'database' };
    });
  }

  async function reset() {
    await db.run('DELETE FROM application_setting WHERE setting_key = ?', [SETTINGS_KEY]);
    return { settings: { ...defaults }, defaults: { ...defaults }, source: 'environment' };
  }

  return Object.freeze({ get, update, reset });
}
