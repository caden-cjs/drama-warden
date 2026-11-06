import mysql from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { assertDatabase } from './contract.mjs';

const CURRENT_SCHEMA_VERSION = 4;
const schemaV1 = readFileSync(new URL('./mysql-schema-v1.sql', import.meta.url), 'utf8');
const schemaV2 = readFileSync(new URL('./mysql-schema-v2.sql', import.meta.url), 'utf8');
const schemaV3 = readFileSync(new URL('./mysql-schema-v3.sql', import.meta.url), 'utf8');
const schemaV4 = readFileSync(new URL('./mysql-schema-v4.sql', import.meta.url), 'utf8');
const MIGRATION_TABLE = 'drama_warden_schema_migrations';

function requiredEnvironmentValue(value, field) {
  const result = String(value || '').trim();
  if (!result) throw new TypeError(field + ' is required when DB_DRIVER=mysql');
  return result;
}

function integerEnvironmentValue(value, fallback, field, minimum, maximum) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(field + ' is outside its supported range');
  }
  return number;
}

function normalizeTimestampFields(row) {
  if (!row || typeof row !== 'object') return row;
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith('_at') && typeof value === 'string') {
      row[key] = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)
        ? value.replace(' ', 'T') + 'Z'
        : value;
    }
  }
  return row;
}

function splitSqlStatements(sql) {
  return sql.split(';').map((statement) => statement.trim()).filter(Boolean);
}

async function connectWithRetry(pool, { attempts, delayMs }) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await pool.getConnection();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  const error = new Error('could not connect to the configured MySQL database', { cause: lastError });
  error.code = 'MYSQL_CONNECTION_FAILED';
  throw error;
}

async function migrate(connection) {
  const lockName = 'drama-warden-schema-migration';
  const [locks] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
  if (Number(locks[0]?.acquired) !== 1) throw new Error('could not acquire MySQL migration lock');
  try {
    await connection.query(
      'CREATE TABLE IF NOT EXISTS ' + MIGRATION_TABLE + ' (' +
      'version INT UNSIGNED NOT NULL PRIMARY KEY, ' +
      'applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)' +
      ') ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
    );
    const [rows] = await connection.execute(
      'SELECT version FROM ' + MIGRATION_TABLE + ' ORDER BY version DESC LIMIT 1',
    );
    const version = Number(rows[0]?.version || 0);
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        'database schema version ' + version +
        ' is newer than supported version ' + CURRENT_SCHEMA_VERSION,
      );
    }
    if (version === 0) {
      for (const statement of splitSqlStatements(schemaV1)) {
        await connection.query(statement);
      }
      await connection.execute(
        'INSERT INTO ' + MIGRATION_TABLE + ' (version) VALUES (?)',
        [1],
      );
    }
    if (version < 2) {
      for (const statement of splitSqlStatements(schemaV2)) {
        await connection.query(statement);
      }
      await connection.execute(
        'INSERT INTO ' + MIGRATION_TABLE + ' (version) VALUES (?)',
        [2],
      );
    }
    if (version < 3) {
      for (const statement of splitSqlStatements(schemaV3)) {
        await connection.query(statement);
      }
      await connection.execute(
        'INSERT INTO ' + MIGRATION_TABLE + ' (version) VALUES (?)',
        [3],
      );
    }
    if (version < 4) {
      for (const statement of splitSqlStatements(schemaV4)) {
        await connection.query(statement);
      }
      await connection.execute(
        'INSERT INTO ' + MIGRATION_TABLE + ' (version) VALUES (?)',
        [4],
      );
    }
  } finally {
    try {
      await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName]);
    } catch {
      // Keep migration results authoritative if lock cleanup fails.
    }
  }
}

export async function openMySqlDatabase({ env = process.env } = {}) {
  const host = requiredEnvironmentValue(env.MYSQL_HOST, 'MYSQL_HOST');
  const databaseName = requiredEnvironmentValue(env.MYSQL_DATABASE, 'MYSQL_DATABASE');
  const user = requiredEnvironmentValue(env.MYSQL_USER, 'MYSQL_USER');
  const password = requiredEnvironmentValue(env.MYSQL_PASSWORD, 'MYSQL_PASSWORD');
  const port = integerEnvironmentValue(env.MYSQL_PORT, 3306, 'MYSQL_PORT', 1, 65535);
  const connectionLimit = integerEnvironmentValue(
    env.MYSQL_CONNECTION_LIMIT,
    10,
    'MYSQL_CONNECTION_LIMIT',
    1,
    100,
  );
  const connectAttempts = integerEnvironmentValue(
    env.MYSQL_CONNECT_ATTEMPTS,
    30,
    'MYSQL_CONNECT_ATTEMPTS',
    1,
    120,
  );
  const connectDelayMs = integerEnvironmentValue(
    env.MYSQL_CONNECT_DELAY_MS,
    1000,
    'MYSQL_CONNECT_DELAY_MS',
    0,
    10000,
  );
  const connectTimeoutMs = integerEnvironmentValue(
    env.MYSQL_CONNECT_TIMEOUT_MS,
    5000,
    'MYSQL_CONNECT_TIMEOUT_MS',
    100,
    60000,
  );
  const pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database: databaseName,
    waitForConnections: true,
    connectionLimit,
    queueLimit: 0,
    connectTimeout: connectTimeoutMs,
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
    timezone: 'Z',
    charset: 'utf8mb4',
  });

  const context = new AsyncLocalStorage();
  const token = {};
  let closed = false;
  let database;

  function currentConnection() {
    const state = context.getStore();
    return state?.token === token ? state.connection : null;
  }

  async function execute(method, sql, parameters) {
    if (closed) throw new Error('database is closed');
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL statement is required');
    if (!Array.isArray(parameters)) throw new TypeError('query parameters must be an array');
    const executor = currentConnection() || pool;
    const [result] = await executor.execute(sql, parameters);
    if (method === 'get') return normalizeTimestampFields(result[0] || null);
    if (method === 'all') return result.map(normalizeTimestampFields);
    return {
      changes: Number(result.affectedRows || 0),
      lastInsertId: result.insertId == null ? null : Number(result.insertId),
    };
  }

  database = assertDatabase(Object.freeze({
    dialect: 'mysql',
    get(sql, parameters = []) {
      return execute('get', sql, parameters);
    },
    all(sql, parameters = []) {
      return execute('all', sql, parameters);
    },
    run(sql, parameters = []) {
      return execute('run', sql, parameters);
    },
    async transaction(work) {
      if (typeof work !== 'function') throw new TypeError('transaction callback is required');
      if (currentConnection()) throw new Error('nested database transactions are not supported');
      if (closed) throw new Error('database is closed');
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await context.run({ token, connection }, () => work(database));
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // Preserve the operation error if rollback also fails.
        }
        throw error;
      } finally {
        connection.release();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  }));

  try {
    const connection = await connectWithRetry(pool, {
      attempts: connectAttempts,
      delayMs: connectDelayMs,
    });
    try {
      await migrate(connection);
    } finally {
      connection.release();
    }
  } catch (error) {
    await pool.end();
    throw error;
  }

  return database;
}
