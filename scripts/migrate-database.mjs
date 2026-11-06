import { existsSync } from 'node:fs';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadConfiguration } from '../backend/config.mjs';
import { openDatabase } from '../backend/db/index.mjs';
import { exportPortableDatabase, importPortableDatabase } from '../backend/db/portable-transfer.mjs';

const usage = `Usage:
  npm run db:export -- --output backups/pre-migration.backup
  npm run db:import -- --input backups/pre-migration.backup

The active database is selected with DB_DRIVER and its normal connection settings.
The command loads .env when present; use DRAMA_WARDEN_ENV_FILE to select another file.
Export files contain application records and must be protected like a database backup.`;

function parseArguments(argumentsList) {
  const result = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (!['--output', '--input'].includes(argument)) {
      throw new TypeError(`unknown argument: ${argument}`);
    }
    const value = argumentsList[index + 1];
    if (!value || value.startsWith('--')) throw new TypeError(`${argument} requires a path`);
    const key = argument === '--output' ? 'output' : 'input';
    if (result[key]) throw new TypeError(`${argument} may only be provided once`);
    result[key] = value;
    index += 1;
  }
  if (Boolean(result.input) === Boolean(result.output)) {
    throw new TypeError('provide exactly one of --input or --output');
  }
  const selectedPath = result.output || result.input;
  if (extname(selectedPath).toLowerCase() !== '.backup') {
    throw new TypeError('database export files must use the .backup suffix so repository filters exclude them');
  }
  return result;
}

async function writePrivateExport(filename, content) {
  const outputPath = resolve(filename);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const file = await open(outputPath, 'wx', 0o600);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(outputPath).catch(() => {});
    throw error;
  }
  await file.close();
  return outputPath;
}

function countSummary(tableCounts) {
  return Object.entries(tableCounts)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${table}=${count}`)
    .join(', ') || 'no application rows';
}

function loadEnvironmentFile(env) {
  if (env !== process.env) return env;
  const filename = env.DRAMA_WARDEN_ENV_FILE || '.env';
  if (!existsSync(filename)) {
    if (env.DRAMA_WARDEN_ENV_FILE) throw new Error('configured environment file does not exist');
    return env;
  }
  process.loadEnvFile(filename);
  return process.env;
}

export async function runMigrationCommand(argumentsList = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argumentsList);
  if (options.help) {
    process.stdout.write(usage + '\n');
    return;
  }

  env = loadEnvironmentFile(env);
  loadConfiguration({ env });
  const driver = String(env.DB_DRIVER || 'sqlite').trim().toLowerCase();
  const databaseOptions = driver === 'sqlite'
    ? { driver, filename: env.SQLITE_PATH, readonly: Boolean(options.output) }
    : { driver, env };

  if (options.output) {
    const database = await openDatabase(databaseOptions);
    try {
      const snapshot = await exportPortableDatabase(database);
      const content = JSON.stringify(snapshot) + '\n';
      const outputPath = await writePrivateExport(options.output, content);
      const counts = Object.fromEntries(Object.entries(snapshot.tables).map(([table, value]) => [table, value.rowCount]));
      process.stdout.write(`Database export written to ${outputPath} (${countSummary(counts)})\n`);
    } finally {
      await database.close();
    }
    return;
  }

  const inputPath = resolve(options.input);
  const parsed = JSON.parse(await readFile(inputPath, 'utf8'));
  const database = await openDatabase(databaseOptions);
  try {
    const imported = await importPortableDatabase(database, parsed);
    process.stdout.write(`Database import verified (${countSummary(imported)})\n`);
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMigrationCommand().catch((error) => {
    process.stderr.write(`Database migration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
