import Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertDatabase } from './contract.mjs';

const CURRENT_SCHEMA_VERSION = 4;
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const schemaV2 = readFileSync(new URL('./schema-v2.sql', import.meta.url), 'utf8');
const schemaV3 = readFileSync(new URL('./schema-v3.sql', import.meta.url), 'utf8');
const schemaV4 = readFileSync(new URL('./schema-v4.sql', import.meta.url), 'utf8');

function normalizeParameters(parameters) {
  if (!Array.isArray(parameters)) throw new TypeError('query parameters must be an array');
  return parameters;
}

export function openSqliteDatabase({
  filename = process.env.SQLITE_PATH || './data/drama-warden.sqlite',
  readonly = false,
} = {}) {
  const resolvedFilename = filename === ':memory:' ? filename : resolve(filename);
  if (typeof readonly !== 'boolean') throw new TypeError('readonly must be a boolean');
  if (readonly && resolvedFilename === ':memory:') {
    throw new TypeError('read-only SQLite mode requires a database file');
  }
  if (resolvedFilename !== ':memory:') {
    if (!readonly) mkdirSync(dirname(resolvedFilename), { recursive: true });
  }

  const connection = new Database(resolvedFilename, readonly
    ? { readonly: true, fileMustExist: true }
    : undefined);
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 5000');
  if (readonly) connection.pragma('query_only = ON');
  else connection.pragma('journal_mode = WAL');

  const version = Number(connection.pragma('user_version', { simple: true }));
  if (version > CURRENT_SCHEMA_VERSION) {
    connection.close();
    throw new Error(
      'database schema version ' + version +
      ' is newer than supported version ' + CURRENT_SCHEMA_VERSION,
    );
  }

  if (readonly && version !== CURRENT_SCHEMA_VERSION) {
    connection.close();
    throw new Error(
      'read-only database schema version ' + version +
      ' must be migrated to version ' + CURRENT_SCHEMA_VERSION + ' before export',
    );
  }

  if (!readonly && version < 1) {
    try {
      const migrate = connection.transaction(() => {
        connection.exec(schema);
        connection.pragma('user_version = 1');
      });
      migrate.immediate();
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  if (!readonly && version < 2) {
    try {
      const migrate = connection.transaction(() => {
        connection.exec(schemaV2);
        connection.pragma('user_version = 2');
      });
      migrate.immediate();
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  if (!readonly && version < 3) {
    try {
      const migrate = connection.transaction(() => {
        connection.exec(schemaV3);
        connection.pragma('user_version = 3');
      });
      migrate.immediate();
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  if (!readonly && version < 4) {
    try {
      const migrate = connection.transaction(() => {
        connection.exec(schemaV4);
        connection.pragma('user_version = 4');
      });
      migrate.immediate();
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  const context = new AsyncLocalStorage();
  let queue = Promise.resolve();
  let closed = false;

  function enqueue(operation) {
    const task = queue.then(operation, operation);
    queue = task.then(() => undefined, () => undefined);
    return task;
  }

  function execute(method, sql, parameters) {
    if (closed) throw new Error('database is closed');
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL statement is required');
    const statement = connection.prepare(sql);
    const values = normalizeParameters(parameters);
    if (method === 'get') return statement.get(...values);
    if (method === 'all') return statement.all(...values);
    const result = statement.run(...values);
    return {
      changes: Number(result.changes),
      lastInsertId: result.lastInsertRowid == null ? null : Number(result.lastInsertRowid),
    };
  }

  let database;
  function query(method, sql, parameters = []) {
    if (context.getStore() === database) {
      try {
        return Promise.resolve(execute(method, sql, parameters));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return enqueue(() => execute(method, sql, parameters));
  }

  database = assertDatabase(Object.freeze({
    dialect: 'sqlite',
    get(sql, parameters = []) {
      return query('get', sql, parameters);
    },
    all(sql, parameters = []) {
      return query('all', sql, parameters);
    },
    run(sql, parameters = []) {
      return query('run', sql, parameters);
    },
    transaction(work) {
      if (typeof work !== 'function') throw new TypeError('transaction callback is required');
      if (context.getStore() === database) {
        return Promise.reject(new Error('nested database transactions are not supported'));
      }
      return enqueue(async () => {
        if (closed) throw new Error('database is closed');
        connection.exec(readonly ? 'BEGIN' : 'BEGIN IMMEDIATE');
        try {
          const result = await context.run(database, () => work(database));
          connection.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            connection.exec('ROLLBACK');
          } catch {
            // Preserve the operation error if rollback also fails.
          }
          throw error;
        }
      });
    },
    close() {
      return enqueue(() => {
        if (closed) return;
        connection.close();
        closed = true;
      });
    },
  }));

  return database;
}
