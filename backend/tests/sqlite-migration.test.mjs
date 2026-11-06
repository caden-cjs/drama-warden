import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSqliteDatabase } from '../db/sqlite.mjs';

test('SQLite schema initializes and latest migration remains available after reopening', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-sqlite-'));
  const filename = path.join(directory, 'test.sqlite');
  let database;

  try {
    database = openSqliteDatabase({ filename });
    assert.equal(Number((await database.get('PRAGMA user_version')).user_version), 4);
    const firstTables = await database.all(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    for (const table of ['shows', 'show_episode', 'show_episode_write_claim', 'update_event', 'subtitle_job', 'plugin_call_log']) {
      assert.ok(firstTables.some((row) => row.name === table), `missing table ${table}`);
    }
    await database.close();

    database = openSqliteDatabase({ filename });
    assert.equal(Number((await database.get('PRAGMA user_version')).user_version), 4);
    assert.equal(Number((await database.get('SELECT COUNT(*) AS count FROM shows')).count), 0);
  } finally {
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite upgrades an existing v1 database through current schema without replacing application data', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-sqlite-v1-'));
  const filename = path.join(directory, 'legacy.sqlite');
  let database;
  try {
    const { readFileSync } = await import('node:fs');
    const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
    const { default: Database } = await import('better-sqlite3');
    const legacy = new Database(filename);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(schema);
    legacy.pragma('user_version = 1');
    legacy.prepare('INSERT INTO shows (name) VALUES (?)').run('Existing show');
    legacy.close();

    database = openSqliteDatabase({ filename });
    assert.equal(Number((await database.get('PRAGMA user_version')).user_version), 4);
    assert.equal((await database.get('SELECT name FROM shows WHERE id = 1')).name, 'Existing show');
    assert.ok(await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subtitle_job'"));
    assert.ok(await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_call_log'"));
  } finally {
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
