import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db/index.mjs';
import { createEpisodeRepository } from '../core/episode-repository.mjs';
import { createPluginCallRepository } from '../core/plugin-call-repository.mjs';
import { createShowRepository } from '../core/show-repository.mjs';
import { createSubtitleRepository } from '../core/subtitle-repository.mjs';

test('MySQL migrations are repeatable and repositories can write canonical show data', {
  skip: process.env.RUN_MYSQL_INTEGRATION !== '1',
}, async () => {
  const fixture = randomUUID();
  const fixtureName = 'MySQL integration migration fixture ' + fixture;
  let database;
  let showId;
  try {
    database = await openDatabase({ driver: 'mysql', env: process.env });
    const migration = await database.get(
      'SELECT version FROM drama_warden_schema_migrations ORDER BY version DESC LIMIT 1',
    );
    assert.equal(Number(migration?.version), 4);
    assert.ok(await database.get("SHOW TABLES LIKE 'subtitle_job'"));
    assert.ok(await database.get("SHOW TABLES LIKE 'plugin_call_log'"));

    const shows = createShowRepository(database);
    const episodes = createEpisodeRepository(database);
    const show = await shows.create({ name: fixtureName });
    showId = show.id;
    await shows.linkMetadataIdentity({
      showId,
      providerId: 'tvmaze',
      externalId: fixture,
    });
    await episodes.upsertSeason({
      showId,
      seasonNumber: 1,
      name: 'Season 1',
      episodeCount: 1,
      providerId: 'tvmaze',
    });
    const episode = await episodes.upsertEpisode({ showId, seasonNumber: 1, episodeNumber: 1 });
    assert.ok(Number(episode.id) > 0);
    const storage = await episodes.createStorage({
      showId,
      providerId: 'local-storage',
      rootPath: '/mysql-integration',
    });
    const subtitles = createSubtitleRepository(database);
    const job = await subtitles.create({
      showId,
      storageId: storage.id,
      seasonNumber: 1,
      episodeNumber: 1,
    });
    assert.equal((await subtitles.claimNext())?.id, job.id);
    await database.close();
    database = null;

  database = await openDatabase({ driver: 'mysql', env: process.env });
    const reloadedShow = await createShowRepository(database).getById(showId);
    assert.equal(reloadedShow?.name, fixtureName);
    assert.equal((await createSubtitleRepository(database).getById(job.id))?.status, 'processing');

    const pluginCalls = createPluginCallRepository(database, { maxRows: 100 });
    await pluginCalls.initialize();
    for (let index = 0; index < 100; index += 1) {
      await pluginCalls.record({
        pluginId: 'mysql-test',
        capability: 'search',
        source: 'mysql-integration',
        correlationId: `call-${index}`,
        ok: index !== 0,
        errorCode: index === 0 ? 'TEST_FAILURE' : null,
        durationMs: index,
      });
    }
    const calls = await pluginCalls.list({ pluginId: 'mysql-test', limit: 100 });
    assert.equal(calls.length, 100);
    assert.equal(calls[0].correlationId, 'call-99');
    assert.equal(calls.filter((call) => !call.ok).length, 1);
  } finally {
    if (database) {
      try {
        await database.run('DELETE FROM plugin_call_log WHERE plugin_id = ?', ['mysql-test']);
      } catch {
        // Preserve the migration or repository assertion as the primary error.
      }
      if (showId) {
        try {
          await database.run('DELETE FROM shows WHERE id = ?', [showId]);
        } catch {
          // Keep the assertion or migration failure as the primary error.
        }
      }
      await database.close();
    }
  }
});
