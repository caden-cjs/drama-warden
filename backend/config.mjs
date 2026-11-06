import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const DEFAULT_CONFIG_PATH = 'config/config.yaml';
const EXAMPLE_CONFIG_PATH = 'config/config.example.yaml';
const MAX_CONFIG_BYTES = 64 * 1024;

const CONFIG_SHAPE = Object.freeze({
  server: Object.freeze({
    timeZone: 'string',
  }),
  database: Object.freeze({
    driver: Object.freeze(['sqlite', 'mysql']),
    sqlitePath: 'string',
    mysql: Object.freeze({
      host: 'string',
      port: Object.freeze([1, 65535]),
      database: 'string',
      user: 'string',
      connectionLimit: Object.freeze([1, 100]),
      connectAttempts: Object.freeze([1, 120]),
      connectDelayMs: Object.freeze([0, 10000]),
      connectTimeoutMs: Object.freeze([100, 60000]),
    }),
  }),
  storage: Object.freeze({
    local: Object.freeze({
      enabled: 'boolean',
      root: 'string',
      shareRoot: 'string',
    }),
    quark: Object.freeze({
      cliPath: 'optionalString',
      stateDirectory: 'string',
      recycleDirectory: 'string',
    }),
    pan115: Object.freeze({
      cliPath: 'optionalString',
      minIntervalMs: Object.freeze([0, 60000]),
      wafCooldownMs: Object.freeze([0, 3600000]),
    }),
  }),
  indexer: Object.freeze({
    smartstrm: Object.freeze({
      baseUrl: 'optionalString',
      taskName: 'optionalString',
    }),
  }),
  subtitles: Object.freeze({
    workerEnabled: 'boolean',
    assrtEnabled: 'boolean',
    openSubtitlesUserAgent: 'string',
  }),
  automation: Object.freeze({
    enabled: 'boolean',
    scanIntervalMinutes: Object.freeze([5, 1440]),
    autoProcess: 'boolean',
  }),
  plugins: Object.freeze({
    modules: 'stringList',
  }),
});

function configError(message) {
  return new TypeError('invalid Drama Warden configuration: ' + message);
}

function validateMapping(value, shape, path = 'config', seen = new WeakSet(), depth = 0) {
  if (depth > 8) throw configError(path + ' is nested too deeply');
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw configError(path + ' must be a mapping');
  }
  if (seen.has(value)) throw configError(path + ' must not use recursive or shared YAML aliases');
  seen.add(value);

  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(shape, key)) throw configError(path + '.' + key + ' is not supported');
    const expected = shape[key];
    const actual = value[key];
    const fieldPath = path + '.' + key;
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      validateMapping(actual, expected, fieldPath, seen, depth + 1);
      continue;
    }
    if (expected === 'string' || expected === 'optionalString') {
      if (expected === 'optionalString' && actual === null) continue;
      if (typeof actual !== 'string' || actual.length > 4096 || actual.includes('\0')) {
        throw configError(fieldPath + ' must be a string');
      }
      if (expected === 'string' && !actual.trim()) {
        throw configError(fieldPath + ' must not be empty');
      }
      continue;
    }
    if (expected === 'boolean') {
      if (typeof actual !== 'boolean') throw configError(fieldPath + ' must be true or false');
      continue;
    }
    if (expected === 'stringList') {
      if (!Array.isArray(actual) || actual.length > 100
          || actual.some((item) => typeof item !== 'string' || !item.trim()
            || item.length > 500 || item.includes(',') || item.includes('\0'))
          || new Set(actual).size !== actual.length) {
        throw configError(fieldPath + ' must be a list of up to 100 plugin specifiers');
      }
      continue;
    }
    if (Array.isArray(expected) && expected.length === 2 && expected.every(Number.isSafeInteger)) {
      if (!Number.isSafeInteger(actual) || actual < expected[0] || actual > expected[1]) {
        throw configError(fieldPath + ' is outside its supported range');
      }
      continue;
    }
    if (Array.isArray(expected)) {
      if (typeof actual !== 'string' || !expected.includes(actual)) {
        throw configError(fieldPath + ' must be one of: ' + expected.join(', '));
      }
      continue;
    }
    throw configError(fieldPath + ' has an invalid schema');
  }
}

function assignEnvironment(env, name, value) {
  if (value === undefined) return;
  if (env[name] != null && String(env[name]).trim() !== '') return;
  env[name] = Array.isArray(value) ? value.join(',') : String(value ?? '');
}

function applyConfiguration(config, env) {
  const bindings = [
    ['server', 'timeZone', 'TZ'],
    ['database', 'driver', 'DB_DRIVER'],
    ['database', 'sqlitePath', 'SQLITE_PATH'],
    ['subtitles', 'workerEnabled', 'SUBTITLE_WORKER_ENABLED'],
    ['subtitles', 'assrtEnabled', 'SUBTITLE_ASSRT_ENABLED'],
    ['subtitles', 'openSubtitlesUserAgent', 'OPENSUBTITLES_USER_AGENT'],
    ['automation', 'enabled', 'FOLLOWUP_AUTOMATION_ENABLED'],
    ['automation', 'scanIntervalMinutes', 'FOLLOWUP_SCAN_INTERVAL_MINUTES'],
    ['automation', 'autoProcess', 'FOLLOWUP_AUTO_PROCESS'],
    ['plugins', 'modules', 'DRAMA_WARDEN_PLUGINS'],
  ];
  for (const [section, key, name] of bindings) {
    assignEnvironment(env, name, config[section]?.[key]);
  }
  assignEnvironment(env, 'SMARTSTRM_BASE_URL', config.indexer?.smartstrm?.baseUrl);
  assignEnvironment(env, 'SMARTSTRM_TASK_NAME', config.indexer?.smartstrm?.taskName);

  const mysqlBindings = [
    ['host', 'MYSQL_HOST'],
    ['port', 'MYSQL_PORT'],
    ['database', 'MYSQL_DATABASE'],
    ['user', 'MYSQL_USER'],
    ['connectionLimit', 'MYSQL_CONNECTION_LIMIT'],
    ['connectAttempts', 'MYSQL_CONNECT_ATTEMPTS'],
    ['connectDelayMs', 'MYSQL_CONNECT_DELAY_MS'],
    ['connectTimeoutMs', 'MYSQL_CONNECT_TIMEOUT_MS'],
  ];
  for (const [key, name] of mysqlBindings) {
    assignEnvironment(env, name, config.database?.mysql?.[key]);
  }

  const storageBindings = [
    [config.storage?.local, 'enabled', 'LOCAL_STORAGE_ENABLED'],
    [config.storage?.local, 'root', 'LOCAL_STORAGE_ROOT'],
    [config.storage?.local, 'shareRoot', 'LOCAL_STORAGE_SHARE_ROOT'],
    [config.storage?.quark, 'cliPath', 'QUARK_CLI_PATH'],
    [config.storage?.quark, 'stateDirectory', 'QUARK_STATE_DIR'],
    [config.storage?.quark, 'recycleDirectory', 'QUARK_RECYCLE_DIR'],
    [config.storage?.pan115, 'cliPath', 'PAN115_CLI_PATH'],
    [config.storage?.pan115, 'minIntervalMs', 'PAN115_MIN_INTERVAL_MS'],
    [config.storage?.pan115, 'wafCooldownMs', 'PAN115_WAF_COOLDOWN_MS'],
  ];
  for (const [section, key, name] of storageBindings) {
    assignEnvironment(env, name, section?.[key]);
  }
}

export function loadConfiguration({ env = process.env, cwd = process.cwd() } = {}) {
  if (!env || typeof env !== 'object') throw new TypeError('environment must be an object');
  const configuredPath = String(env.DRAMA_WARDEN_CONFIG || '').trim();
  const selectedPath = resolve(cwd, configuredPath || DEFAULT_CONFIG_PATH);
  let filename = selectedPath;
  if (!existsSync(filename)) {
    if (configuredPath) throw new Error('configured Drama Warden YAML file does not exist');
    filename = resolve(cwd, EXAMPLE_CONFIG_PATH);
  }
  if (!existsSync(filename)) return { loaded: false };

  let source;
  try {
    if (statSync(filename).size > MAX_CONFIG_BYTES) {
      throw new Error('configuration file is too large');
    }
    source = readFileSync(filename, 'utf8');
  } catch {
    throw new Error('could not read the Drama Warden YAML configuration');
  }

  let config;
  try {
    config = parse(source, {
      schema: 'core',
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
  } catch {
    throw new Error('could not parse the Drama Warden YAML configuration');
  }
  if (config == null) config = {};
  validateMapping(config, CONFIG_SHAPE);
  applyConfiguration(config, env);
  return { loaded: true };
}
