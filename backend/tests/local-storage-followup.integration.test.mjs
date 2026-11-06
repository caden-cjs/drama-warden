import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEpisodeRepository } from '../core/episode-repository.mjs';
import { createEventRepository } from '../core/event-repository.mjs';
import { createFollowupService } from '../core/followup-service.mjs';
import { formatCanonicalEpisodeName } from '../core/media-naming.mjs';
import { createResourceDiscoveryService } from '../core/resource-discovery-service.mjs';
import { createShowRepository } from '../core/show-repository.mjs';
import { openSqliteDatabase } from '../db/sqlite.mjs';
import { createPluginHost } from '../plugins/host.mjs';
import { createLocalResourcePlugin } from '../plugins/local-resource/index.mjs';
import { createLocalStoragePlugin } from '../plugins/local-storage/index.mjs';

test('local resource discovery and SQLite follow-up archive one selected local video', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'drama-warden-local-followup-'));
  let database;

  try {
    const shareRoot = path.join(directory, 'shares');
    const storageRoot = path.join(directory, 'media');
    const releaseDirectory = path.join(shareRoot, 'release');
    await mkdir(releaseDirectory, { recursive: true });

    const sourceName = 'Fixture.Show.S01E01.1080p.WEB-DL.mkv';
    const sourceBytes = Buffer.from('local follow-up fixture video bytes');
    await writeFile(path.join(releaseDirectory, sourceName), sourceBytes);
    await writeFile(path.join(releaseDirectory, 'Fixture.Show.S01E02.1080p.WEB-DL.mkv'), 'unselected');
    await writeFile(path.join(releaseDirectory, 'notes.txt'), 'not a video');

    database = openSqliteDatabase({ filename: path.join(directory, 'catalog.sqlite') });
    const shows = createShowRepository(database);
    const episodes = createEpisodeRepository(database);
    const events = createEventRepository(database);
    const show = await shows.create({ name: 'Fixture Show' });
    const storage = await episodes.createStorage({
      showId: show.id,
      providerId: 'local-storage',
      rootPath: '/library',
    });
    await episodes.upsertSeason({
      showId: show.id,
      seasonNumber: 1,
      episodeCount: 1,
      providerId: 'fixture-metadata',
    });

    const host = createPluginHost();
    host.register(createLocalResourcePlugin({ shareRoot }));
    host.register(createLocalStoragePlugin({ storageRoot, shareRoot }));
    await host.initializePlugins();

    const followup = createFollowupService({
      shows,
      episodes,
      events,
      metadata: {
        async resolveEpisodeManifest() {
          return {
            providerId: 'fixture-metadata',
            seasonNumber: 1,
            maxEpisode: 1,
            sufficient: true,
            failures: [],
            episodes: [{ seasonNumber: 1, episodeNumber: 1, airDate: '2020-01-01' }],
          };
        },
      },
      listPlugins: host.listPlugins,
      invoke: host.invoke,
    });

    const discovery = createResourceDiscoveryService({
      shows,
      episodes,
      listPlugins: host.listPlugins,
      invoke: host.invoke,
      followup,
    });
    const discovered = await discovery.searchForShow({
      showId: show.id,
      storageId: storage.id,
    });
    assert.deepEqual(discovered.providers, [{
      providerId: 'local-resource',
      ok: true,
      resultCount: 2,
      truncated: false,
    }]);
    const eligibleCandidate = discovered.results.find((item) => item.preview.eligible);
    assert.equal(eligibleCandidate.providerId, 'local-resource');
    assert.equal(eligibleCandidate.sourceId, 'release/' + sourceName);
    assert.equal(eligibleCandidate.preview.plan.saveBatch[0].episodeNumber, 1);

    const queued = await followup.queueShare({
      showId: show.id,
      storageId: storage.id,
      shareUrl: eligibleCandidate.shareUrl,
      shareTitle: eligibleCandidate.title,
      today: '2026-11-05',
      correlationId: 'local-storage-followup-integration',
    });

    assert.equal(queued.queued, true);
    assert.deepEqual(queued.preview.plan.saveBatch.map((file) => file.episodeNumber), [1]);
    assert.equal(queued.event.status, 'pending');
    assert.deepEqual(await episodes.listWriteClaims(queued.event.id).then((claims) =>
      claims.map(({ episodeNumber, status }) => ({ episodeNumber, status }))), [
      { episodeNumber: 1, status: 'reserved' },
    ]);

    const processed = await followup.processEvent(queued.event.id);
    assert.equal(processed.ok, true);
    assert.equal(processed.event.status, 'processed');
    assert.deepEqual(processed.episodeNumbers, [1]);

    const canonicalName = formatCanonicalEpisodeName({
      showName: show.name,
      seasonNumber: 1,
      episodeNumber: 1,
      quality: '1080p',
      extension: '.mkv',
    });
    const seasonDirectory = path.join(storageRoot, 'library', 'Season 01');
    assert.deepEqual(await readdir(seasonDirectory), [canonicalName]);
    assert.deepEqual(await readFile(path.join(seasonDirectory, canonicalName)), sourceBytes);
    assert.deepEqual(await readFile(path.join(releaseDirectory, sourceName)), sourceBytes);

    const storedEpisode = (await episodes.listStorageEpisodes(storage.id))
      .find((item) => item.seasonNumber === 1 && item.episodeNumber === 1);
    assert.equal(storedEpisode.status, 'present');
    assert.equal(storedEpisode.assetCount, 1);
    const assets = await database.all(
      'SELECT relative_path, file_name, file_size, quality, is_present ' +
      'FROM show_episode_asset WHERE show_storage_id = ?',
      [storage.id],
    );
    assert.deepEqual(assets, [{
      relative_path: 'Season 01/' + canonicalName,
      file_name: canonicalName,
      file_size: sourceBytes.length,
      quality: '1080p',
      is_present: 1,
    }]);

    assert.deepEqual(await episodes.listWriteClaims(queued.event.id).then((claims) =>
      claims.map(({ episodeNumber, status }) => ({ episodeNumber, status }))), [
      { episodeNumber: 1, status: 'completed' },
    ]);
    assert.equal((await events.getById(queued.event.id)).status, 'processed');
  } finally {
    if (database) await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
