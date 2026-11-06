import { openSqliteDatabase } from './sqlite.mjs';
import { assertDatabase } from './contract.mjs';

export async function openDatabase({
  driver = process.env.DB_DRIVER || 'sqlite',
  ...options
} = {}) {
  const normalizedDriver = String(driver).trim().toLowerCase();
  if (normalizedDriver === 'sqlite') return assertDatabase(openSqliteDatabase(options));
  if (normalizedDriver === 'mysql') {
    let mysqlModule;
    try {
      mysqlModule = await import('./mysql.mjs');
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /mysql2/.test(String(error.message))) {
        const missingDriver = new Error(
          'the optional mysql2 package is required when DB_DRIVER=mysql; install optional dependencies',
          { cause: error },
        );
        missingDriver.code = 'MYSQL_DRIVER_DEPENDENCY_MISSING';
        throw missingDriver;
      }
      throw error;
    }
    return assertDatabase(await mysqlModule.openMySqlDatabase(options));
  }
  throw new Error('unsupported database driver: ' + normalizedDriver);
}
