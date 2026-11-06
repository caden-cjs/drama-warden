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
import { createQuarkStoragePlugin } from '../plugins/quark/index.mjs';
import { defineMetadataPlugin } from '@drama-warden/plugin-sdk';

test('SQLite follow-up flow uses the Quark storage plugin contract end to end', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-quark-followup-'));
  let database;

  try {
    database = openSqliteDatabase({ filename: path.join(directory, 'catalog.sqlite') });
    const shows = createShowRepository(database);
    const episodes = createEpisodeRepository(database);
    const events = createEventRepository(database);
    const show = await shows.create({ name: 'Fixture Show' });
    const storage = await episodes.createStorage({
      showId: show.id,
      providerId: 'quark',
      rootPath: '/library/fixture-show',
    });

    const shareUrl = 'https://share.example/s/quark-followup-fixture';
    const sourceVideo = {
      fid: 'quark-share-video-01',
      name: 'Fixture.Show.S01E01.1080p.WEB-DL.mkv',
      path: '',
      size: 2048,
      mtime: 1793836800,
    };
    const shareFiles = [sourceVideo, {
      fid: 'quark-share-notes-01',
      name: 'release-notes.txt',
      path: '',
      size: 32,
      mtime: 1793836800,
    }];
    const directories = new Set(['/']);
    const storedFiles = new Map();
    const saveRequests = [];
    const renameRequests = [];

    function listDirectory(targetPath) {
      const files = [];
      for (const directoryPath of directories) {
        if (directoryPath !== '/' && path.posix.dirname(directoryPath) === targetPath) {
          files.push({ name: path.posix.basename(directoryPath), isDir: true });
        }
      }
      for (const [filePath, file] of storedFiles) {
        if (path.posix.dirname(filePath) === targetPath) {
          files.push({ ...file, isDir: false });
        }
      }
      return { files, truncated: false, recent: false };
    }

    const quarkCli = {
      async quarkShareFiles(requestUrl) {
        assert.equal(requestUrl, shareUrl);
        return shareFiles.map((file) => ({ ...file }));
      },
      async quarkList(targetPath) {
        return listDirectory(targetPath);
      },
      async mkdirChain(targetPath) {
        const segments = targetPath.split('/').filter(Boolean);
        let current = '';
        for (const segment of segments) {
          current += '/' + segment;
          directories.add(current);
        }
        return { ok: true };
      },
      async quarkSave(requestUrl, destinationPath, { fidList }) {
        assert.equal(requestUrl, shareUrl);
        saveRequests.push({ requestUrl, destinationPath, fidList: [...fidList] });
        const selected = shareFiles.filter((file) => fidList.includes(file.fid));
        for (const file of selected) {
          const filePath = path.posix.join(destinationPath, file.name);
          storedFiles.set(filePath, {
            fid: 'quark-stored-' + file.fid,
            name: file.name,
            size: file.size,
            mtime: file.mtime,
          });
        }
        return {
          ok: true,
          savedCount: selected.length,
          taskPoll: { completed: true, status: 'finished' },
          verified: true,
        };
      },
      async quarkRenameBatch(items) {
        renameRequests.push(items.map((item) => ({ ...item })));
        for (const item of items) {
          const file = storedFiles.get(item.path);
          if (!file) throw new Error('fake Quark CLI could not find rename source');
          const targetPath = path.posix.join(path.posix.dirname(item.path), item.newName);
          if (storedFiles.has(targetPath)) throw new Error('fake Quark rename target exists');
          storedFiles.delete(item.path);
          storedFiles.set(targetPath, { ...file, name: item.newName });
        }
        return { ok: true, requested: items.length };
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
    host.register(createQuarkStoragePlugin(quarkCli));
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
      correlationId: 'quark-followup-integration',
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
    assert.deepEqual([...storedFiles.keys()], [destinationPath + '/' + canonicalName]);
    assert.deepEqual(saveRequests, [{
      requestUrl: shareUrl,
      destinationPath,
      fidList: ['quark-share-video-01'],
    }]);
    assert.equal(renameRequests.length, 1);
    assert.equal(renameRequests[0][0].newName, canonicalName);
    assert.equal(shareFiles.length, 2);

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
      call.pluginId === 'quark' && call.capability === 'save' && call.ok));
    assert.ok(pluginCalls.every((call) => !Object.hasOwn(call, 'input')));
  } finally {
    await database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
