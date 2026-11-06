const SETTINGS_KEY = 'plugins';

function parseStored(value) {
  if (value == null) return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('stored plugin settings are invalid');
  }
  return parsed;
}

async function readStored(db) {
  const row = await db.get(
    'SELECT value_json FROM application_setting WHERE setting_key = ?',
    [SETTINGS_KEY],
  );
  try {
    return parseStored(row?.value_json);
  } catch (error) {
    throw new Error('stored plugin settings are invalid', { cause: error });
  }
}

function upsertSql(dialect) {
  if (dialect === 'mysql') {
    return 'INSERT INTO application_setting (setting_key, value_json) VALUES (?, ?) '
      + 'ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = CURRENT_TIMESTAMP(3)';
  }
  return 'INSERT INTO application_setting (setting_key, value_json) VALUES (?, ?) '
    + "ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
}

function pluginNotFound(id) {
  const error = new Error('plugin is not registered: ' + id);
  error.code = 'PLUGIN_NOT_REGISTERED';
  return error;
}

function safePluginErrorCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value)
    ? value
    : 'PLUGIN_ERROR';
}

async function failPluginEnable(host, id, cause, code) {
  try {
    await host.reset(id);
  } catch {
    const error = new Error('plugin cleanup failed after a failed enable operation', { cause });
    error.code = 'PLUGIN_CLEANUP_FAILED';
    throw error;
  }
  const error = new Error('plugin could not be enabled', { cause });
  error.code = code;
  throw error;
}

function failPluginDisable(host, id, cause) {
  try {
    host.setEnabled(id, false);
  } catch {
    // The persisted disabled state is authoritative when plugin cleanup fails.
  }
  const error = new Error('plugin was disabled but cleanup failed', { cause });
  error.code = 'PLUGIN_RESET_FAILED';
  throw error;
}

function serialize(service, work) {
  const task = service.queue.then(work, work);
  service.queue = task.then(() => undefined, () => undefined);
  return task;
}

export function createPluginSettings({ db, host, context = {} } = {}) {
  if (!db || typeof db.get !== 'function' || typeof db.transaction !== 'function'
      || !host || typeof host.listPlugins !== 'function'
      || typeof host.setEnabled !== 'function' || typeof host.setOrder !== 'function'
      || typeof host.state !== 'function' || typeof host.disable !== 'function') {
    throw new TypeError('database and plugin host are required');
  }
  const state = { queue: Promise.resolve() };

  async function persist(settings) {
    await db.transaction((transaction) => transaction.run(
      upsertSql(db.dialect),
      [SETTINGS_KEY, JSON.stringify(settings)],
    ));
  }

  function list() {
    return host.listPlugins({ enabledOnly: false });
  }

  async function initialize() {
    const stored = await readStored(db);
    for (const plugin of list()) {
      const saved = stored[plugin.id];
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
      if (typeof saved.enabled === 'boolean') host.setEnabled(plugin.id, saved.enabled);
      if (Number.isSafeInteger(saved.order) && saved.order >= 0 && saved.order <= 999) {
        host.setOrder(plugin.id, saved.order);
      }
    }
    return list();
  }

  async function update(id, input = {}) {
    return serialize(state, async () => {
      const plugin = list().find((item) => item.id === id);
      if (!plugin) throw pluginNotFound(id);
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('plugin settings must be an object');
      }
      const allowed = new Set(['enabled']);
      for (const key of Object.keys(input)) {
        if (!allowed.has(key)) throw new TypeError('unsupported plugin setting: ' + key);
      }
      if (Object.keys(input).length !== 1 || typeof input.enabled !== 'boolean') {
        throw new TypeError('enabled must be a boolean');
      }

      const previous = host.state(id);
      const next = { ...previous, enabled: input.enabled };
      const disabling = previous.enabled && !next.enabled;
      let initializedForEnable = false;
      if (!previous.enabled && next.enabled) {
        try {
          await host.initializePlugin(id, context, { allowDisabled: true });
          initializedForEnable = true;
        } catch (error) {
          await failPluginEnable(
            host,
            id,
            error,
            'PLUGIN_INITIALIZATION_FAILED',
          );
        }
      }
      try {
        const stored = await readStored(db);
        stored[id] = { ...(stored[id] || {}), enabled: next.enabled };
        await persist(stored);
      } catch (error) {
        if (initializedForEnable) {
          await failPluginEnable(host, id, error, 'PLUGIN_SETTINGS_SAVE_FAILED');
        }
        throw error;
      }
      if (disabling) {
        try {
          await host.disable(id);
        } catch (error) {
          failPluginDisable(host, id, error);
        }
      } else {
        host.setEnabled(id, next.enabled);
      }
      return list();
    });
  }

  async function move(id, direction) {
    return serialize(state, async () => {
      if (!['up', 'down'].includes(direction)) {
        throw new TypeError('direction must be up or down');
      }
      const current = list().find((plugin) => plugin.id === id);
      if (!current) throw pluginNotFound(id);
      const peers = list().filter((plugin) => plugin.kind === current.kind)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
      const index = peers.findIndex((plugin) => plugin.id === id);
      const targetIndex = index + (direction === 'up' ? -1 : 1);
      if (targetIndex < 0 || targetIndex >= peers.length) return list();
      const reordered = [...peers];
      const [selected] = reordered.splice(index, 1);
      reordered.splice(targetIndex, 0, selected);

      const stored = await readStored(db);
      for (const [order, plugin] of reordered.entries()) {
        stored[plugin.id] = { ...(stored[plugin.id] || {}), order };
      }
      await persist(stored);
      for (const [order, plugin] of reordered.entries()) host.setOrder(plugin.id, order);
      return list();
    });
  }

  async function monitor(id) {
    if (!list().some((plugin) => plugin.id === id)) throw pluginNotFound(id);
    const result = await host.monitor(id);
    return {
      pluginId: id,
      enabled: result.enabled === true,
      ok: result.ok === true,
      ...(typeof result.configured === 'boolean' ? { configured: result.configured } : {}),
      ...(typeof result.authorized === 'boolean' ? { authorized: result.authorized } : {}),
      ...(result.ok === true ? {} : { errorCode: safePluginErrorCode(result.errorCode) }),
    };
  }

  async function reset(id) {
    return serialize(state, async () => {
      if (!list().some((plugin) => plugin.id === id)) throw pluginNotFound(id);
      await host.reset(id);
      return { pluginId: id, ok: true };
    });
  }

  return Object.freeze({ initialize, list, update, move, monitor, reset });
}
