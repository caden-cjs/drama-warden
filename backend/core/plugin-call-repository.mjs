const MAX_LOG_ROWS = 10_000;

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('plugin call record must be an object');
  }
  const pluginId = String(record.pluginId || '');
  const capability = String(record.capability || '');
  const source = String(record.source || '');
  const correlationId = record.correlationId == null ? null : String(record.correlationId);
  const errorCode = record.errorCode == null ? null : String(record.errorCode);
  const durationMs = Number(record.durationMs);
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(pluginId)) {
    throw new TypeError('pluginId is invalid');
  }
  if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(capability)) {
    throw new TypeError('capability is invalid');
  }
  if (!source || source.length > 128) throw new TypeError('source is invalid');
  if (correlationId != null && correlationId.length > 255) {
    throw new TypeError('correlationId is invalid');
  }
  if (typeof record.ok !== 'boolean') throw new TypeError('ok must be a boolean');
  if (errorCode != null && !/^[A-Z0-9_-]{1,64}$/i.test(errorCode)) {
    throw new TypeError('errorCode is invalid');
  }
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new TypeError('durationMs must be a nonnegative integer');
  }
  return { pluginId, capability, source, correlationId, ok: record.ok, errorCode, durationMs };
}

function buildFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new TypeError('plugin call filters must be an object');
  }
  const clauses = [];
  const parameters = [];
  for (const [key, column, maxLength] of [
    ['pluginId', 'plugin_id', 64],
    ['capability', 'capability', 64],
    ['source', 'source', 128],
    ['correlationId', 'correlation_id', 255],
  ]) {
    if (filters[key] == null || filters[key] === '') continue;
    const value = String(filters[key]);
    if (value.length > maxLength) throw new TypeError(`${key} filter is too long`);
    clauses.push(`${column} = ?`);
    parameters.push(value);
  }
  if (filters.ok != null) {
    if (typeof filters.ok !== 'boolean') throw new TypeError('ok filter must be a boolean');
    clauses.push('ok = ?');
    parameters.push(filters.ok ? 1 : 0);
  }
  const limit = filters.limit == null ? 50 : Number(filters.limit);
  const offset = filters.offset == null ? 0 : Number(filters.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('limit must be between 1 and 100');
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new TypeError('offset must be between 0 and 1000000');
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', parameters, limit, offset };
}

function trimSql(dialect) {
  if (dialect === 'mysql') {
    return 'DELETE FROM plugin_call_log WHERE id NOT IN (' +
      'SELECT id FROM (SELECT id FROM plugin_call_log ORDER BY id DESC LIMIT ?) AS recent_calls)';
  }
  return 'DELETE FROM plugin_call_log WHERE id NOT IN '
    + '(SELECT id FROM plugin_call_log ORDER BY id DESC LIMIT ?)';
}

export function createPluginCallRepository(db, { maxRows = MAX_LOG_ROWS } = {}) {
  if (!db || typeof db.get !== 'function' || typeof db.all !== 'function'
      || typeof db.run !== 'function' || typeof db.transaction !== 'function'
      || !['sqlite', 'mysql'].includes(db.dialect)) {
    throw new TypeError('database is required');
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < 100) {
    throw new TypeError('maxRows must be an integer of at least 100');
  }
  let writesSinceTrim = 0;
  let initializePromise;

  async function initialize() {
    if (!initializePromise) {
      initializePromise = db.transaction((transaction) =>
        transaction.run(trimSql(db.dialect), [maxRows]));
    }
    await initializePromise;
  }

  async function record(input) {
    await initialize();
    const value = validateRecord(input);
    return db.transaction(async (transaction) => {
      const result = await transaction.run(
        'INSERT INTO plugin_call_log ' +
        '(plugin_id, capability, source, correlation_id, ok, error_code, duration_ms) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          value.pluginId,
          value.capability,
          value.source,
          value.correlationId,
          value.ok ? 1 : 0,
          value.errorCode,
          value.durationMs,
        ],
      );
      writesSinceTrim += 1;
      if (writesSinceTrim >= 100) {
        await transaction.run(trimSql(db.dialect), [maxRows]);
        writesSinceTrim = 0;
      }
      return { id: result.lastInsertId };
    });
  }

  async function list(filters = {}) {
    const query = buildFilters(filters);
    const rows = await db.all(
      'SELECT id, plugin_id, capability, source, correlation_id, ok, error_code, ' +
      'duration_ms, called_at FROM plugin_call_log ' + query.where +
      ' ORDER BY id DESC LIMIT ? OFFSET ?',
      [...query.parameters, query.limit, query.offset],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      pluginId: row.plugin_id,
      capability: row.capability,
      source: row.source,
      correlationId: row.correlation_id,
      ok: Number(row.ok) === 1,
      errorCode: row.error_code,
      durationMs: Number(row.duration_ms),
      calledAt: row.called_at,
    }));
  }

  return Object.freeze({ initialize, record, list });
}
