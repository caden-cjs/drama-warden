import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEpisodeRepository } from '../core/episode-repository.mjs';
import { createEventRepository } from '../core/event-repository.mjs';
import { openSqliteDatabase } from '../db/sqlite.mjs';

test('event finalization commits write claims atomically with the processed status', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-event-finalization-'));
  let database;

  try {
    database = openSqliteDatabase({ filename: path.join(directory, 'test.sqlite') });
    await database.run('INSERT INTO shows (name) VALUES (?)', ['Finalization fixture']);
    const storageResult = await database.run(
      'INSERT INTO show_storage (show_id, provider_id, root_path) VALUES (?, ?, ?)',
      [1, 'local-storage', '/finalization-fixture'],
    );
    const storageId = storageResult.lastInsertId;
    const episodes = createEpisodeRepository(database);
    const events = createEventRepository(database);

    const successfulEvent = await events.create({
      showId: 1,
      kind: 'new_ep',
      payload: {},
    });
    await episodes.reserveWrites({
      storageId,
      seasonNumber: 1,
      eventId: successfulEvent.id,
      episodeNumbers: [1, 2],
    });
    await events.transition({ id: successfulEvent.id, status: 'processing' });

    const processed = await events.finalizeProcessed({
      id: successfulEvent.id,
      storageId,
      seasonNumber: 1,
      episodeNumbers: [2, 1],
    });
    assert.equal(processed.status, 'processed');
    assert.deepEqual(
      (await episodes.listWriteClaims(successfulEvent.id)).map((claim) => claim.status),
      ['completed', 'completed'],
    );

    const pendingEvent = await events.create({
      showId: 1,
      kind: 'new_ep',
      payload: {},
    });
    await episodes.reserveWrites({
      storageId,
      seasonNumber: 1,
      eventId: pendingEvent.id,
      episodeNumbers: [3],
    });

    await assert.rejects(
      events.finalizeProcessed({
        id: pendingEvent.id,
        storageId,
        seasonNumber: 1,
        episodeNumbers: [3],
      }),
      /event cannot move from pending to processed/,
    );
    assert.equal((await events.getById(pendingEvent.id)).status, 'pending');
    assert.deepEqual(
      (await episodes.listWriteClaims(pendingEvent.id)).map((claim) => claim.status),
      ['reserved'],
    );
  } finally {
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
