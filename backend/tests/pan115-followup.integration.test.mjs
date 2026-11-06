import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEpisodeRepository } from '../core/episode-repository.mjs';
import { createEventRepository } from '../core/event-repository.mjs';
import { createFollowupService } from '../core/followup-service.mjs';
import { createMetadataService } from '../core/metadata-service.mjs';
import { formatCanonicalEpisodeName } from '../core/media-naming.mjs';
import { createShowRepository } from '../core/show-repository.mjs';
import { openSqliteDatabase } from '../db/sqlite.mjs';
import { createPluginHost } from '../plugins/host.mjs';
import { defineMetadataPlugin } from '../plugins/contract.mjs';
import { createPan115StoragePlugin } from '../plugins/pan115/index.mjs';
import { createPan115ShareLister } from '../plugins/pan115/cli.mjs';

test('SQLite follow-up flow uses the 115 storage plugin with path-based share references', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-115-followup-'));
  let database;

  try {
    database = openSqliteDatabase({ filename: path.join(directory, 'catalog.sqlite') });
    const shows = createShowRepository(database);
    const episodes = createEpisodeRepository(database);
    const events = createEventRepository(database);
    const show = await shows.create({ name: 'Fixture Show' });
    const storage = await episodes.createStorage({
      showId: show.id,
      providerId: 'pan115',
      rootPath: '/library/fixture-show',
    });

    const shareUrl = 'https://share.example/s/fixture-115-followup';
    const shareVideo = {
      ID: '115-share-video-01',
      Name: 'Fixture.Show.S01E01.1080p.WEB-DL.mkv',
      Type: 'file',
      Size: 2048,
      Modified: '2026-11-04T12:00:00Z',
    };
    const shareNotes = {
      ID: '115-share-notes-01',
      Name: 'release-notes.txt',
      Type: 'file',
      Size: 32,
      Modified: '2026-11-04T12:00:00Z',
    };
    const savedFiles = new Map();
    const saveRequests = [];
    const moveRequests = [];
    const shareListRequests = [];

    const pan115ShareFiles = createPan115ShareLister({
      async available() { return true; },
      async run(args) {
        assert.deepEqual(args.slice(0, 2), ['share', 'list']);
        assert.equal(args.at(-2), shareUrl);
        const sharedPath = args.at(-1);
        shareListRequests.push(sharedPath);
        if (sharedPath === '/') return [
          { ID: '115-share-release-dir', Name: 'release', Type: 'dir' },
          shareNotes,
        ];
        if (sharedPath === 'release') return [shareVideo];
        throw new Error('fake 115 CLI received an unexpected share path');
      },
    });

    const adapter = {
      pan115ShareFiles,
      async pan115List(targetPath) {
        return {
          path: targetPath,
          files: [...savedFiles.entries()]
            .filter(([filePath]) => path.posix.dirname(filePath) === targetPath)
            .map(([filePath, file]) => ({ ...file, name: path.posix.basename(filePath) })),
          truncated: false,
          recent: false,
        };
      },
      async mkdirParents() {
        return { ok: true };
      },
      async pan115Save(requestUrl, destinationPath, { selection }) {
        assert.equal(requestUrl, shareUrl);
        saveRequests.push({ requestUrl, destinationPath, selection });
        for (const selected of selection) {
          assert.equal(selected.id, shareVideo.ID);
          assert.equal(selected.path, 'release/' + shareVideo.Name);
          assert.equal(selected.name, shareVideo.Name);
          const filePath = path.posix.join(destinationPath, selected.name);
          savedFiles.set(filePath, {
            size: shareVideo.Size,
            mtime: Math.floor(Date.parse(shareVideo.Modified) / 1000),
          });
        }
        return { ok: true, savedCount: selection.length };
      },
      async pan115Move(sourcePath, destinationPath) {
        moveRequests.push({ sourcePath, destinationPath });
        const file = savedFiles.get(sourcePath);
        if (!file) throw new Error('fake 115 CLI could not find move source');
        if (savedFiles.has(destinationPath)) throw new Error('fake 115 CLI target already exists');
        savedFiles.delete(sourcePath);
        savedFiles.set(destinationPath, file);
        return { ok: true };
      },
    };

    const pluginCalls = [];
    const host = createPluginHost({ onCall: async (call) => pluginCalls.push(call) });
    host.register(defineMetadataPlugin({
      manifest: {
        id: 'fixture-metadata',
        name: 'Fixture Metadata',
        label: 'Fixture Metadata',
        version: '1.0.0',
      },
      async search({ query, mediaType = 'tv' } = {}) {
        if (mediaType !== 'tv' || query !== show.name) return [];
        return [{ id: 'fixture-series-01', name: show.name, originalName: show.name }];
      },
      async detail({ externalId, mediaType = 'tv' } = {}) {
        if (mediaType !== 'tv' || externalId !== 'fixture-series-01') return null;
        return {
          id: externalId,
          name: show.name,
          mediaType: 'tv',
          seasons: [{ seasonNumber: 1, episodeCount: 1, airDate: '2020-01-01' }],
        };
      },
      async episodes({ externalId, seasonNumber } = {}) {
        if (externalId !== 'fixture-series-01' || Number(seasonNumber) !== 1) return [];
        return [{
          id: 'fixture-episode-01',
          seasonNumber: 1,
          episodeNumber: 1,
          name: 'Fixture Episode 1',
          airDate: '2020-01-01',
        }];
      },
    }));
    host.register(createPan115StoragePlugin({ adapter }));
    await host.initializePlugins();

    const metadata = createMetadataService({
      shows,
      catalog: episodes,
      listProviders: ({ enabledOnly = true } = {}) => host.listPlugins({
        domain: 'metadata',
        enabledOnly,
      }),
      invoke: host.invoke,
    });
    const followup = createFollowupService({
      shows,
      episodes,
      events,
      metadata,
      listPlugins: host.listPlugins,
      invoke: host.invoke,
      now: () => new Date('2026-11-05T00:00:00.000Z'),
    });

    const preview = await followup.previewShare({
      showId: show.id,
      storageId: storage.id,
      shareUrl,
      today: '2026-11-05',
    });
    assert.equal(preview.eligible, true);
    assert.deepEqual(preview.plan.saveBatch.map((file) => file.episodeNumber), [1]);
    assert.deepEqual(shareListRequests, ['/', 'release']);

    const identities = await shows.listMetadataIdentities(show.id);
    assert.deepEqual(identities.map(({ providerId, externalId }) => ({ providerId, externalId })), [
      { providerId: 'fixture-metadata', externalId: 'fixture-series-01' },
    ]);

    const queued = await followup.queueShare({
      showId: show.id,
      storageId: storage.id,
      shareUrl,
      shareTitle: 'Fixture release',
      today: '2026-11-05',
      correlationId: 'pan115-followup-integration',
    });
    assert.equal(queued.queued, true);
    assert.equal(queued.event.status, 'pending');
    assert.deepEqual((await episodes.listWriteClaims(queued.event.id))
      .map(({ episodeNumber, status }) => ({ episodeNumber, status })), [
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
    const destinationPath = '/library/fixture-show/Season 01';
    assert.deepEqual([...savedFiles.keys()], [destinationPath + '/' + canonicalName]);
    assert.equal(saveRequests.length, 1);
    assert.deepEqual(saveRequests[0], {
      requestUrl: shareUrl,
      destinationPath,
      selection: [{ id: shareVideo.ID, path: 'release/' + shareVideo.Name, name: shareVideo.Name }],
    });
    assert.deepEqual(moveRequests, [{
      sourcePath: destinationPath + '/' + shareVideo.Name,
      destinationPath: destinationPath + '/' + canonicalName,
    }]);

    const storedEpisode = (await episodes.listStorageEpisodes(storage.id))
      .find((item) => item.seasonNumber === 1 && item.episodeNumber === 1);
    assert.equal(storedEpisode.status, 'present');
    assert.equal(storedEpisode.assetCount, 1);
    assert.deepEqual(await episodes.listWriteClaims(queued.event.id)
      .then((claims) => claims.map((claim) => claim.status)), ['completed']);
    assert.equal((await events.getById(queued.event.id)).status, 'processed');

    assert.ok(pluginCalls.some((call) =>
      call.pluginId === 'fixture-metadata' && call.capability === 'episodes' && call.ok));
    assert.ok(pluginCalls.some((call) =>
      call.pluginId === 'pan115' && call.capability === 'save' && call.ok));
    assert.ok(pluginCalls.every((call) => !Object.hasOwn(call, 'input')));
  } finally {
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
