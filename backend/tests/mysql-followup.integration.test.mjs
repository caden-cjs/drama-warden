import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db/index.mjs';
import { createEpisodeRepository } from '../core/episode-repository.mjs';
import { createEventRepository } from '../core/event-repository.mjs';
import { createFollowupService } from '../core/followup-service.mjs';
import { createStorageCatalogService } from '../core/storage-catalog-service.mjs';
import { createShowRepository } from '../core/show-repository.mjs';
import { detectQuality, formatCanonicalEpisodeName } from '../core/media-naming.mjs';

test('MySQL runs complete follow-up writes and preserves retry safety around uncertain results', {
  skip: process.env.RUN_MYSQL_INTEGRATION !== '1',
}, async () => {
  const fixture = randomUUID();
  const showName = 'MySQL Follow-up Fixture ' + fixture;
  const shareFiles = new Map();
  const destinationFiles = [];
  let database;
  let showId;
  let storageId;
  let failIndexer = false;
  let completeDestinationListing = true;
  let saveCount = 0;

  const sourceFile = (episodeNumber) => ({
    id: 'shared-' + fixture + '-' + episodeNumber,
    name: 'Release.' + fixture + '.S01E' + String(episodeNumber).padStart(2, '0') + '.1080p.WEB-DL.mkv',
    path: '/incoming/' + fixture + '/episode-' + episodeNumber + '.mkv',
    size: 1000 + episodeNumber,
    isDir: false,
  });

  const storagePluginId = 'mysql-test-storage';
  const indexerPluginId = 'mysql-test-indexer';

  const listPlugins = ({ domain, capability } = {}) => {
    if (domain === 'storage' && ['list', 'listSharedFiles'].includes(capability)) {
      return [{ id: storagePluginId }];
    }
    if (domain === 'indexer' && capability === 'reindex' && failIndexer) {
      return [{ id: indexerPluginId }];
    }
    return [];
  };

  const invoke = async (pluginId, { capability, input } = {}) => {
    assert.ok([storagePluginId, indexerPluginId].includes(pluginId));
    if (capability === 'listSharedFiles') {
      return { files: shareFiles.get(input.shareUrl) || [], truncated: false };
    }
    if (capability === 'list') {
      const files = destinationFiles.filter((file) =>
        file.path === input.path || file.path.startsWith(input.path.replace(/\/$/, '') + '/'));
      const complete = input.path === '/mysql-integration'
        || input.path !== '/mysql-integration/Season 01'
        || completeDestinationListing;
      return { files, truncated: !complete };
    }
    if (capability === 'mkdir') return { ok: true };
    if (capability === 'save') {
      saveCount += 1;
      for (const file of input.selection) {
        destinationFiles.push({
          id: 'saved-' + fixture + '-' + saveCount + '-' + destinationFiles.length,
          name: file.name,
          path: input.destinationPath + '/' + file.name,
          size: file.size,
          isDir: false,
        });
      }
      return { ok: true, savedCount: input.selection.length };
    }
    if (capability === 'move') {
      const file = destinationFiles.find((item) => item.path === input.sourcePath);
      if (!file) throw new Error('test provider could not find the file to move');
      file.path = input.destinationPath;
      file.name = input.destinationPath.slice(input.destinationPath.lastIndexOf('/') + 1);
      return { ok: true };
    }
    if (capability === 'renameMany') {
      for (const item of input.items) {
        const file = destinationFiles.find((candidate) => candidate.path === item.path);
        if (!file) throw new Error('test provider could not find the file to rename');
        file.name = item.newName;
        file.path = item.path.slice(0, item.path.lastIndexOf('/') + 1) + item.newName;
      }
      return { ok: true };
    }
    if (capability === 'reindex' && pluginId === indexerPluginId) return { ok: false };
    throw new Error('unexpected test provider capability: ' + capability);
  };

  try {
    database = await openDatabase({ driver: 'mysql', env: process.env });
    const migration = await database.get(
      'SELECT version FROM drama_warden_schema_migrations ORDER BY version DESC LIMIT 1',
    );
    assert.equal(Number(migration?.version), 4);

    const shows = createShowRepository(database);
    const episodes = createEpisodeRepository(database);
    const events = createEventRepository(database);
    const show = await shows.create({ name: showName });
    showId = show.id;
    await shows.linkMetadataIdentity({
      showId,
      providerId: 'tvmaze',
      externalId: fixture,
    });
    await episodes.upsertSeason({ showId, seasonNumber: 1, episodeCount: 4, providerId: 'tvmaze' });
    for (let episodeNumber = 1; episodeNumber <= 4; episodeNumber += 1) {
      await episodes.upsertEpisode({ showId, seasonNumber: 1, episodeNumber });
    }
    const storage = await episodes.createStorage({
      showId,
      providerId: storagePluginId,
      rootPath: '/mysql-integration',
    });
    storageId = storage.id;

    const catalog = createStorageCatalogService({ shows, episodes, listPlugins, invoke });
    const initialScan = await catalog.scanStorage({ showId, storageId });
    assert.equal(initialScan.completeSnapshot, true);
    assert.ok((await episodes.listStorageEpisodes(storageId))
      .every((item) => item.status === 'missing' && item.assetCount === 0));

    const metadata = {
      async resolveEpisodeManifest() {
        return {
          providerId: 'tvmaze',
          seasonNumber: 1,
          maxEpisode: 4,
          sufficient: true,
          failures: [],
          episodes: [1, 2, 3, 4].map((episodeNumber) => ({
            seasonNumber: 1,
            episodeNumber,
            airDate: '2020-01-01',
          })),
        };
      },
    };
    const followup = createFollowupService({
      shows,
      episodes,
      events,
      metadata,
      listPlugins,
      invoke,
      publishEvent: async () => [],
      now: () => new Date('2024-01-01T00:00:00.000Z'),
    });

    const queueEpisode = async (episodeNumbers) => {
      const shareUrl = 'mysql-followup://' + fixture + '/' + episodeNumbers.join('-');
      shareFiles.set(shareUrl, episodeNumbers.map(sourceFile));
      const result = await followup.queueShare({
        showId,
        storageId,
        shareUrl,
        shareTitle: 'Test release',
        today: '2024-01-01',
      });
      assert.equal(result.queued, true);
      return result.event;
    };

    const happyEvent = await queueEpisode([1, 2]);
    assert.deepEqual((await episodes.listWriteClaims(happyEvent.id)).map((claim) => claim.status), [
      'reserved', 'reserved',
    ]);
    const completed = await followup.processEvent(happyEvent.id);
    assert.equal(completed.ok, true);
    assert.equal(completed.event.status, 'processed');
    assert.deepEqual((await episodes.listWriteClaims(happyEvent.id)).map((claim) => claim.status), [
      'completed', 'completed',
    ]);

    const expectedNames = [1, 2].map((episodeNumber) => {
      const source = sourceFile(episodeNumber);
      return formatCanonicalEpisodeName({
        showName,
        seasonNumber: 1,
        episodeNumber,
        quality: detectQuality(source.name),
        extension: '.mkv',
      });
    });
    assert.deepEqual(destinationFiles.map((file) => file.name).sort(), expectedNames.sort());
    assert.ok((await episodes.listStorageEpisodes(storageId))
      .filter((item) => item.episodeNumber <= 2)
      .every((item) => item.status === 'present' && item.assetCount === 1));

    const retryableEvent = await queueEpisode([3]);
    const savesBeforeIncompleteListing = saveCount;
    completeDestinationListing = false;
    const incompleteResult = await followup.processEvent(retryableEvent.id);
    assert.equal(incompleteResult.ok, false);
    assert.equal(incompleteResult.errorCode, 'INCOMPLETE_LISTING');
    assert.equal(saveCount, savesBeforeIncompleteListing);
    assert.deepEqual(await episodes.listWriteClaims(retryableEvent.id), []);
    assert.equal((await events.retryFailed(retryableEvent.id)).status, 'pending');
    completeDestinationListing = true;
    const recovered = await followup.processEvent(retryableEvent.id);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.event.status, 'processed');

    const postArchiveScan = await catalog.scanStorage({ showId, storageId });
    assert.equal(postArchiveScan.completeSnapshot, true);
    assert.equal(postArchiveScan.visibleAssetCount, 3);
    assert.ok((await episodes.listStorageEpisodes(storageId))
      .filter((item) => item.episodeNumber <= 3)
      .every((item) => item.status === 'present' && item.assetCount === 1));

    const uncertainEvent = await queueEpisode([4]);
    failIndexer = true;
    const uncertain = await followup.processEvent(uncertainEvent.id);
    assert.equal(uncertain.ok, false);
    assert.equal(uncertain.errorCode, 'INDEXER_UNCONFIRMED');
    assert.equal(uncertain.event.status, 'failed');
    assert.deepEqual((await episodes.listWriteClaims(uncertainEvent.id)).map((claim) => claim.status), [
      'uncertain',
    ]);
    await assert.rejects(events.retryFailed(uncertainEvent.id), /storage write claims/);

    failIndexer = false;
    const savesBeforeRecovery = saveCount;
    const completedAfterReview = await followup.recoverInterruptedEvent(uncertainEvent.id, {
      action: 'complete',
      confirmNoActiveWorker: true,
      confirmOutputsMatch: true,
    });
    assert.equal(completedAfterReview.event.status, 'processed');
    assert.deepEqual((await episodes.listWriteClaims(uncertainEvent.id)).map((claim) => claim.status), [
      'completed',
    ]);
    assert.equal(saveCount, savesBeforeRecovery);

    const noOutputFile = sourceFile(5);
    const noOutputEvent = await events.create({
      showId,
      kind: 'new_ep',
      source: 'test',
      payload: {
        storageId,
        providerId: storagePluginId,
        shareUrl: 'mysql-followup://' + fixture + '/5',
        seasonNumber: 1,
        selectedFiles: [{
          ...noOutputFile,
          seasonNumber: 1,
          episodeNumber: 5,
          quality: detectQuality(noOutputFile.name),
        }],
      },
    });
    await episodes.reserveWrites({
      storageId,
      seasonNumber: 1,
      eventId: noOutputEvent.id,
      episodeNumbers: [5],
    });
    await events.transition({ id: noOutputEvent.id, status: 'processing' });
    const retryableAfterReview = await followup.recoverInterruptedEvent(noOutputEvent.id, {
      action: 'retry_after_review',
      confirmNoActiveWorker: true,
      confirmNoOutput: true,
    });
    assert.equal(retryableAfterReview.event.status, 'failed');
    assert.equal(retryableAfterReview.event.retryable, true);
    assert.deepEqual((await episodes.listWriteClaims(noOutputEvent.id)).map((claim) => claim.status), [
      'reserved',
    ]);
    assert.equal((await events.retryFailed(noOutputEvent.id)).status, 'pending');
    assert.equal(saveCount, savesBeforeRecovery);

    await database.close();
    database = null;
    database = await openDatabase({ driver: 'mysql', env: process.env });
    assert.equal((await createEventRepository(database).getById(happyEvent.id))?.status, 'processed');
    assert.equal((await createEpisodeRepository(database).listStorageEpisodes(storageId))
      .find((item) => item.episodeNumber === 4)?.status, 'present');
  } finally {
    if (database) {
      if (showId) {
        try {
          await database.run('DELETE FROM update_event WHERE show_id = ?', [showId]);
          await database.run('DELETE FROM shows WHERE id = ?', [showId]);
        } catch {
          // Preserve the assertion or migration failure as the primary error.
        }
      }
      await database.close();
    }
  }
});
