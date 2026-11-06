export function currentTimestampSql(database) {
  if (database?.dialect === 'sqlite') return "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  if (database?.dialect === 'mysql') return 'UTC_TIMESTAMP(3)';
  throw new TypeError('unsupported database dialect: ' + String(database?.dialect || 'unknown'));
}

export function isMySql(database) {
  return database?.dialect === 'mysql';
}

export function assertMysqlTextLength(database, value, maximum, field) {
  if (!isMySql(database) || value == null) return;
  if (Array.from(String(value)).length > maximum) {
    throw new TypeError(field + ' exceeds the MySQL column limit of ' + maximum + ' characters');
  }
}
