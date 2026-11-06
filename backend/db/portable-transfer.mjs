const FORMAT = 'drama-warden-database-export';
const FORMAT_VERSION = 1;
const SCHEMA_VERSION = 4;
const PREVIOUS_SCHEMA_VERSION = 3;

export const PORTABLE_TABLES = Object.freeze([
  'shows',
  'show_metadata_identity',
  'show_season',
  'show_episode',
  'show_episode_metadata',
  'show_storage',
  'show_episode_asset',
  'show_episode_storage',
  'show_episode_write_claim',
  'update_event',
  'subtitle_job',
  'application_setting',
  'plugin_call_log',
]);
const VERSION_3_TABLES = Object.freeze(PORTABLE_TABLES.filter((table) => table !== 'plugin_call_log'));

const PRIMARY_KEYS = Object.freeze({
  shows: ['id'],
  show_metadata_identity: ['id'],
  show_season: ['id'],
  show_episode: ['id'],
  show_episode_metadata: ['id'],
  show_storage: ['id'],
  show_episode_asset: ['id'],
  show_episode_storage: ['id'],
  show_episode_write_claim: ['id'],
  update_event: ['id'],
  subtitle_job: ['id'],
  application_setting: ['setting_key'],
  plugin_call_log: ['id'],
});

const BINARY_MARKER = '$dramaWardenBinaryV1';
const timestampPattern = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z)?$/;
const JSON_COLUMNS = Object.freeze({
  shows: ['aliases_json'],
  show_episode_metadata: ['metadata_json'],
  update_event: ['payload_json'],
  subtitle_job: ['languages_json'],
  application_setting: ['value_json'],
});
const DATETIME_COLUMNS = Object.freeze({
  shows: ['created_at', 'updated_at'],
  show_metadata_identity: ['linked_at'],
  show_season: ['metadata_synced_at', 'created_at', 'updated_at'],
  show_episode: ['created_at', 'updated_at'],
  show_episode_metadata: ['synced_at'],
  show_storage: ['created_at', 'updated_at'],
  show_episode_asset: ['first_seen_at', 'last_seen_at'],
  show_episode_storage: ['scanned_at'],
  show_episode_write_claim: ['claimed_at', 'updated_at'],
  update_event: ['started_at', 'completed_at', 'created_at', 'updated_at'],
  subtitle_job: [
    'next_attempt_at', 'locked_until', 'write_started_at', 'created_at', 'updated_at', 'completed_at',
  ],
  application_setting: ['updated_at'],
  plugin_call_log: ['called_at'],
});

function assertSupportedDatabase(database) {
  if (!database || !['sqlite', 'mysql'].includes(database.dialect)) {
    throw new TypeError('database transfer supports only SQLite and MySQL');
  }
}

async function getSchemaVersion(database) {
  if (database.dialect === 'sqlite') {
    const row = await database.get('PRAGMA user_version');
    return Number(row?.user_version || 0);
  }
  const row = await database.get(
    'SELECT version FROM drama_warden_schema_migrations ORDER BY version DESC LIMIT 1',
  );
  return Number(row?.version || 0);
}

async function assertCurrentSchema(database) {
  const version = await getSchemaVersion(database);
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${version} is unsupported; run the application to migrate it to version ${SCHEMA_VERSION} first`,
    );
  }
}

async function getColumns(database, table) {
  if (!PORTABLE_TABLES.includes(table)) throw new TypeError('unsupported database table');
  const rows = database.dialect === 'sqlite'
    ? await database.all(`PRAGMA table_info('${table}')`)
    : await database.all(`SHOW COLUMNS FROM \`${table}\``);
  const columns = rows.map((row) => database.dialect === 'sqlite' ? row.name : row.Field);
  if (!columns.length) throw new Error(`required table is missing: ${table}`);
  return columns;
}

function normalizeTimestamp(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('invalid database timestamp');
    return value.toISOString();
  }
  if (typeof value !== 'string') return value;
  const match = timestampPattern.exec(value);
  if (!match) return value;
  const [, date, time, rawFraction = ''] = match;
  const fraction = rawFraction.padEnd(3, '0').slice(0, 3);
  const iso = `${date}T${time}.${fraction}Z`;
  if (Number.isNaN(Date.parse(iso))) throw new TypeError('invalid database timestamp');
  return iso;
}

function normalizeRow(table, row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    Buffer.isBuffer(value)
      ? { [BINARY_MARKER]: value.toString('base64') }
      : DATETIME_COLUMNS[table].includes(key) ? normalizeTimestamp(value) : value,
  ]));
}

function restoreValue(value, dialect, table, column) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== BINARY_MARKER || typeof value[BINARY_MARKER] !== 'string') {
      throw new TypeError('database export contains an unsupported object value');
    }
    const bytes = Buffer.from(value[BINARY_MARKER], 'base64');
    if (bytes.toString('base64') !== value[BINARY_MARKER]) {
      throw new TypeError('database export contains invalid binary data');
    }
    return bytes;
  }
  if (!DATETIME_COLUMNS[table].includes(column)) return value;
  const normalized = normalizeTimestamp(value);
  if (dialect === 'mysql' && typeof normalized === 'string' && timestampPattern.test(normalized)) {
    return normalized.replace('T', ' ').replace(/Z$/, '');
  }
  return normalized;
}

function quoteIdentifier(identifier) {
  if (typeof identifier !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new TypeError('unsupported database identifier');
  }
  return `\`${identifier}\``;
}

export function validatePortableSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || snapshot.format !== FORMAT || snapshot.formatVersion !== FORMAT_VERSION
      || ![PREVIOUS_SCHEMA_VERSION, SCHEMA_VERSION].includes(snapshot.schemaVersion)
      || !['sqlite', 'mysql'].includes(snapshot.sourceDriver)
      || !snapshot.tables || typeof snapshot.tables !== 'object' || Array.isArray(snapshot.tables)) {
    throw new TypeError('invalid or unsupported Drama Warden database export');
  }
  const expectedTables = snapshot.schemaVersion === PREVIOUS_SCHEMA_VERSION
    ? VERSION_3_TABLES
    : PORTABLE_TABLES;
  const tableNames = Object.keys(snapshot.tables);
  if (tableNames.length !== expectedTables.length
      || expectedTables.some((table) => !Object.hasOwn(snapshot.tables, table))) {
    throw new TypeError('database export does not contain the complete application schema');
  }

  for (const table of expectedTables) {
    const section = snapshot.tables[table];
    if (!section || typeof section !== 'object' || Array.isArray(section)
        || !Array.isArray(section.columns) || !Array.isArray(section.rows)
        || !Number.isSafeInteger(section.rowCount) || section.rowCount < 0
        || section.rowCount !== section.rows.length) {
      throw new TypeError(`invalid database export table: ${table}`);
    }
    if (new Set(section.columns).size !== section.columns.length
        || section.columns.some((column) => typeof column !== 'string' || !column.trim())) {
      throw new TypeError(`invalid database export columns: ${table}`);
    }
    for (const row of section.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
          || Object.keys(row).length !== section.columns.length
          || section.columns.some((column) => !Object.hasOwn(row, column))) {
        throw new TypeError(`invalid database export row: ${table}`);
      }
      for (const column of JSON_COLUMNS[table] || []) {
        if (row[column] === null && table === 'show_episode_metadata' && column === 'metadata_json') continue;
        if (typeof row[column] !== 'string') throw new TypeError(`invalid JSON column ${table}.${column}`);
        try {
          JSON.parse(row[column]);
        } catch {
          throw new TypeError(`invalid JSON column ${table}.${column}`);
        }
      }
    }
  }
  return snapshot;
}

export async function exportPortableDatabase(database) {
  assertSupportedDatabase(database);
  return database.transaction(async (transaction) => {
    await assertCurrentSchema(transaction);
    const tables = {};
    for (const table of PORTABLE_TABLES) {
      const columns = await getColumns(transaction, table);
      const order = PRIMARY_KEYS[table].map(quoteIdentifier).join(', ');
      const rows = await transaction.all(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${order}`);
      tables[table] = {
        columns,
        rowCount: rows.length,
        rows: rows.map((row) => normalizeRow(table, row)),
      };
    }
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      sourceDriver: database.dialect,
      exportedAt: new Date().toISOString(),
      tables,
    };
  });
}

async function rowCount(database, table) {
  const result = await database.get(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
  const count = Number(result?.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`could not count rows in ${table}`);
  return count;
}

function assertMatchingColumns(table, exportedColumns, targetColumns) {
  if (exportedColumns.length !== targetColumns.length
      || exportedColumns.some((column) => !targetColumns.includes(column))) {
    throw new Error(`database export schema does not match target table ${table}`);
  }
}

export async function importPortableDatabase(database, input) {
  assertSupportedDatabase(database);
  const snapshot = validatePortableSnapshot(input);
  await assertCurrentSchema(database);

  const targetColumns = {};
  for (const table of PORTABLE_TABLES) {
    targetColumns[table] = await getColumns(database, table);
    if (snapshot.tables[table]) {
      assertMatchingColumns(table, snapshot.tables[table].columns, targetColumns[table]);
    } else if (!(snapshot.schemaVersion === PREVIOUS_SCHEMA_VERSION && table === 'plugin_call_log')) {
      throw new Error(`database export is missing required table ${table}`);
    }
  }

  return database.transaction(async (transaction) => {
    const existing = {};
    for (const table of PORTABLE_TABLES) {
      existing[table] = await rowCount(transaction, table);
    }
    const populated = PORTABLE_TABLES.filter((table) => existing[table] > 0);
    if (populated.length) {
      throw new Error(
        `target database must be empty; found existing rows in: ${populated.map((table) => `${table}=${existing[table]}`).join(', ')}`,
      );
    }

    for (const table of PORTABLE_TABLES) {
      const rows = snapshot.tables[table]?.rows || [];
      if (!rows.length) continue;
      const columns = targetColumns[table];
      const quotedColumns = columns.map(quoteIdentifier).join(', ');
      const variablesPerRow = columns.length;
      const chunkSize = Math.max(1, Math.min(100, Math.floor(900 / variablesPerRow)));
      for (let offset = 0; offset < rows.length; offset += chunkSize) {
        const batch = rows.slice(offset, offset + chunkSize);
        const rowPlaceholders = `(${columns.map(() => '?').join(', ')})`;
        const values = batch.flatMap((row) => columns.map((column) => restoreValue(row[column], database.dialect, table, column)));
        const sql = `INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES ${batch.map(() => rowPlaceholders).join(', ')}`;
        await transaction.run(sql, values);
      }
    }

    const imported = {};
    for (const table of PORTABLE_TABLES) {
      imported[table] = await rowCount(transaction, table);
      const expectedCount = snapshot.tables[table]?.rowCount || 0;
      if (imported[table] !== expectedCount) {
        throw new Error(`row count verification failed for ${table}`);
      }
    }
    return imported;
  });
}
