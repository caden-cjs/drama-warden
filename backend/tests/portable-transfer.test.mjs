import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteDatabase } from '../db/sqlite.mjs';
import { runMigrationCommand } from '../../scripts/migrate-database.mjs';
import { createPluginCallRepository } from '../core/plugin-call-repository.mjs';
import {
  exportPortableDatabase,
  importPortableDatabase,
  PORTABLE_TABLES,
} from '../db/portable-transfer.mjs';

const timestamp = '2026-11-04T01:02:03.004Z';
const shareUrl = 'https://pan.quark.cn' + '/s/abcdef';

async function seedDatabase(database) {
  await database.transaction(async (transaction) => {
    await transaction.run(
      'INSERT INTO shows (id, name, aliases_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [11, '移植样本', '["别名"]', timestamp, timestamp],
    );
    await transaction.run(
      'INSERT INTO show_metadata_identity (id, show_id, provider_id, external_id, linked_at) VALUES (?, ?, ?, ?, ?)',
      [12, 11, 'tvmaze', 'sample-11', timestamp],
    );
    await transaction.run(
      'INSERT INTO show_season (id, show_id, season_number, name, episode_count, first_air_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [13, 11, 1, '第一季', 1, '2026-10-01', timestamp, timestamp],
    );
    await transaction.run(
      'INSERT INTO show_episode (id, season_id, episode_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [14, 13, 1, timestamp, timestamp],
    );
    await transaction.run(
      'INSERT INTO show_episode_metadata (id, episode_id, provider_id, provider_external_id, name, air_date, metadata_json, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [15, 14, 'tvmaze', 'episode-14', '第一集', '2026-10-01', '{"runtime":23}', timestamp],
    );
    await transaction.run(
      'INSERT INTO show_storage (id, show_id, provider_id, root_path, local_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [16, 11, 'local-storage', '/shows/sample', null, timestamp, timestamp],
    );
    await transaction.run(
      'INSERT INTO show_episode_asset (id, episode_id, show_storage_id, asset_key, relative_path, file_name, file_size, file_mtime, quality, scan_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [17, 14, 16, 'Season 01/sample.mkv', 'Season 01/sample.mkv', 'sample.mkv', 1024, 55, '1080p', 'scan-1', timestamp, timestamp],
    );
    await transaction.run(
      'INSERT INTO show_episode_storage (id, episode_id, show_storage_id, status, asset_count, scanned_at) VALUES (?, ?, ?, ?, ?, ?)',
      [18, 14, 16, 'present', 1, timestamp],
    );
    await transaction.run(
      'INSERT INTO update_event (id, show_id, kind, status, source, payload_json, correlation_id, attempt_count, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [19, 11, 'new_ep', 'failed', 'manual', JSON.stringify({ shareUrl }), 'correlation-19', 1, '2026-11-04 01:02:03', timestamp, timestamp],
    );
    await transaction.run(
      'INSERT INTO show_episode_write_claim (id, show_storage_id, season_number, episode_number, event_id, status, claimed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [20, 16, 1, 1, 19, 'uncertain', timestamp, timestamp],
    );
    await transaction.run(
      'INSERT INTO subtitle_job (id, show_id, show_storage_id, season_number, episode_number, status, claim_token, write_started_at, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [21, 11, 16, 1, 1, 'uncertain', 'claim-21', timestamp, timestamp, timestamp, timestamp],
    );
    await transaction.run(
      'INSERT INTO application_setting (setting_key, value_json, updated_at) VALUES (?, ?, ?)',
      ['followupAutoProcess', 'false', timestamp],
    );
    await transaction.run(
      'INSERT INTO plugin_call_log (id, plugin_id, capability, source, correlation_id, ok, error_code, duration_ms, called_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [22, 'tvmaze', 'search', 'metadata-search', 'correlation-22', 1, null, 14, timestamp],
    );
  });
}

function createPair() {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-portable-'));
  return {
    directory,
    source: openSqliteDatabase({ filename: path.join(directory, 'source.sqlite') }),
    target: openSqliteDatabase({ filename: path.join(directory, 'target.sqlite') }),
  };
}

test('portable database export imports the complete SQLite v4 dataset with IDs and uncertain states intact', async () => {
  const { directory, source, target } = createPair();
  try {
    await seedDatabase(source);
    const snapshot = await exportPortableDatabase(source);
    assert.equal(snapshot.sourceDriver, 'sqlite');
    assert.deepEqual(Object.keys(snapshot.tables).sort(), [...PORTABLE_TABLES].sort());
    assert.equal(snapshot.tables.update_event.rows[0].payload_json, JSON.stringify({ shareUrl }));
    assert.equal(snapshot.tables.update_event.rows[0].last_error, '2026-11-04 01:02:03');

    const counts = await importPortableDatabase(target, snapshot);
    assert.equal(counts.shows, 1);
    assert.equal(counts.show_episode_asset, 1);
    assert.equal(counts.update_event, 1);
    assert.equal(counts.subtitle_job, 1);
    assert.equal(counts.plugin_call_log, 1);

    const restored = await exportPortableDatabase(target);
    assert.deepEqual(restored.tables, snapshot.tables);
    assert.equal((await target.get('SELECT status FROM show_episode_write_claim WHERE id = ?', [20])).status, 'uncertain');
    assert.equal((await target.get('SELECT claim_token FROM subtitle_job WHERE id = ?', [21])).claim_token, 'claim-21');
  } finally {
    await source.close();
    await target.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('portable database import accepts schema v3 exports and initializes the new audit table empty', async () => {
  const { directory, source, target } = createPair();
  try {
    await seedDatabase(source);
    const snapshot = await exportPortableDatabase(source);
    snapshot.schemaVersion = 3;
    delete snapshot.tables.plugin_call_log;

    const counts = await importPortableDatabase(target, snapshot);
    assert.equal(counts.shows, 1);
    assert.equal(counts.plugin_call_log, 0);
    assert.equal(Number((await target.get('SELECT COUNT(*) AS count FROM plugin_call_log')).count), 0);
  } finally {
    await source.close();
    await target.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('plugin call records expose metadata only and retain a bounded recent history', async () => {
  const { directory, source } = createPair();
  try {
    const repository = createPluginCallRepository(source, { maxRows: 100 });
    await repository.record({
      pluginId: 'tvmaze',
      capability: 'search',
      source: 'metadata-search',
      correlationId: 'trace-1',
      ok: false,
      errorCode: 'METADATA_TIMEOUT',
      durationMs: 250,
      input: { query: 'private query' },
      result: { token: 'must-not-be-persisted' },
    });
    assert.equal((await repository.list({ ok: false }))[0].errorCode, 'METADATA_TIMEOUT');
    for (let index = 0; index < 199; index += 1) {
      await repository.record({
        pluginId: 'tvmaze',
        capability: 'detail',
        source: 'metadata-detail',
        correlationId: `trace-${index + 2}`,
        ok: true,
        durationMs: index,
      });
    }
    const rows = await repository.list({ limit: 100 });
    assert.equal(rows.length, 100);
    assert.equal(rows[0].correlationId, 'trace-200');
    assert.equal(rows.some((row) => Object.hasOwn(row, 'input') || Object.hasOwn(row, 'result')), false);
    assert.equal(Number((await source.get('SELECT COUNT(*) AS count FROM plugin_call_log')).count), 100);
  } finally {
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('plugin call retention prunes oversized imported history at startup and after reopening', async () => {
  const { directory, source, target } = createPair();
  let activeTarget = target;
  try {
    await seedDatabase(source);
    const calledAt = new Date().toISOString();
    await source.transaction(async (transaction) => {
      for (let index = 0; index < 150; index += 1) {
        await transaction.run(
          'INSERT INTO plugin_call_log (id, plugin_id, capability, source, correlation_id, ok, error_code, duration_ms, called_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [1000 + index, 'tvmaze', 'search', 'metadata-search', `import-${index}`, 1, null, 1, calledAt],
        );
      }
    });

    await importPortableDatabase(target, await exportPortableDatabase(source));
    const repository = createPluginCallRepository(target, { maxRows: 100 });
    await repository.initialize();
    assert.equal(Number((await target.get('SELECT COUNT(*) AS count FROM plugin_call_log')).count), 100);
    assert.equal((await repository.list({ limit: 100 }))[0].correlationId, 'import-149');

    await target.close();
    activeTarget = openSqliteDatabase({ filename: path.join(directory, 'target.sqlite') });
    await createPluginCallRepository(activeTarget, { maxRows: 100 }).initialize();
    assert.equal(Number((await activeTarget.get('SELECT COUNT(*) AS count FROM plugin_call_log')).count), 100);
  } finally {
    await source.close();
    await activeTarget.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('portable database import refuses a populated target without modifying it', async () => {
  const { directory, source, target } = createPair();
  try {
    await seedDatabase(source);
    const snapshot = await exportPortableDatabase(source);
    await target.run('INSERT INTO shows (name) VALUES (?)', ['existing target']);

    await assert.rejects(importPortableDatabase(target, snapshot), /target database must be empty/);
    assert.equal((await target.get('SELECT name FROM shows')).name, 'existing target');
    assert.equal(Number((await target.get('SELECT COUNT(*) AS count FROM update_event')).count), 0);
  } finally {
    await source.close();
    await target.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('portable database import rejects incomplete exports before writing rows', async () => {
  const { directory, source, target } = createPair();
  try {
    await seedDatabase(source);
    const snapshot = await exportPortableDatabase(source);
    delete snapshot.tables.subtitle_job;

    await assert.rejects(importPortableDatabase(target, snapshot), /complete application schema/);
    assert.equal(Number((await target.get('SELECT COUNT(*) AS count FROM shows')).count), 0);
  } finally {
    await source.close();
    await target.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('database export CLI writes a private .backup file and refuses to overwrite it', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-export-cli-'));
  const sourcePath = path.join(directory, 'source.sqlite');
  const outputPath = path.join(directory, 'nested', 'portable.backup');
  const source = openSqliteDatabase({ filename: sourcePath });
  try {
    await seedDatabase(source);
  } finally {
    await source.close();
  }

  try {
    await runMigrationCommand(['--output', outputPath], {
      DB_DRIVER: 'sqlite',
      SQLITE_PATH: sourcePath,
    });
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    await assert.rejects(runMigrationCommand(['--output', outputPath], {
      DB_DRIVER: 'sqlite',
      SQLITE_PATH: sourcePath,
    }), /EEXIST/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('database export CLI loads .env while keeping explicit process settings', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-env-cli-'));
  const sourcePath = path.join(directory, 'source.sqlite');
  const outputPath = path.join(directory, 'local-env.backup');
  const envPath = path.join(directory, '.env');
  const source = openSqliteDatabase({ filename: sourcePath });
  try {
    await seedDatabase(source);
  } finally {
    await source.close();
  }

  try {
    writeFileSync(envPath, `DB_DRIVER=sqlite\nSQLITE_PATH=${path.join(directory, 'missing.sqlite')}\n`);
    const cliPath = fileURLToPath(new URL('../../scripts/migrate-database.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cliPath, '--output', outputPath], {
      cwd: directory,
      env: { PATH: process.env.PATH, SQLITE_PATH: sourcePath },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Database export written/);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite export refuses a missing source instead of creating an empty database', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-missing-source-'));
  const missingSource = path.join(directory, 'does-not-exist.sqlite');
  const outputPath = path.join(directory, 'empty.backup');
  try {
    await assert.rejects(runMigrationCommand(['--output', outputPath], {
      DB_DRIVER: 'sqlite',
      SQLITE_PATH: missingSource,
    }));
    assert.equal((await import('node:fs')).existsSync(missingSource), false);
    assert.equal((await import('node:fs')).existsSync(outputPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
