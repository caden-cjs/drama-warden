const REQUIRED_METHODS = Object.freeze(['get', 'all', 'run', 'transaction', 'close']);

export function assertDatabase(database) {
  if (!database || typeof database !== 'object') {
    throw new TypeError('database adapter must be an object');
  }
  if (typeof database.dialect !== 'string' || !database.dialect.trim()) {
    throw new TypeError('database adapter must declare a dialect');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof database[method] !== 'function') {
      throw new TypeError('database adapter is missing ' + method + '()');
    }
  }
  return database;
}
