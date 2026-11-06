import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEpisodeRepository } from '../core/episode-repository.mjs';
import { createEventRepository } from '../core/event-repository.mjs';
import { createFollowupService } from '../core/followup-service.mjs';
import { formatCanonicalEpisodeName } from '../core/media-naming.mjs';
import { createShowRepository } from '../core/show-repository.mjs';
import { openSqliteDatabase } from '../db/sqlite.mjs';

const STORAGE_PLUGIN_ID = 'recovery-test-storage';
const INDEXER_PLUGIN_ID = 'recovery-test-indexer';

async function createFixture({ files = [], truncated = false, blockListSharedFiles = null } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-event-recovery-'));
  const database = openSqliteDatabase({ filename: path.join(directory, 'test.sqlite') });
  const shows = createShowRepository(database);
  const episodes = createEpisodeRepository(database);
  const events = createEventRepository(database);
  const show = await shows.create({ name: 'Recovery Fixture' });
  const storage = await episodes.createStorage({
    showId: show.id,
    providerId: STORAGE_PLUGIN_ID,
    rootPath: '/library/recovery-fixture',
  });
  const destinationPath = storage.rootPath + '/Season 01';
  const destinationFiles = files.map((file) => ({ ...file }));
  const calls = [];
  let saveCount = 0;

  const listPlugins = ({ domain, capability } = {}) => {
    if (domain === 'storage' && ['list', 'listSharedFiles'].includes(capability)) {
      return [{ id: STORAGE_PLUGIN_ID }];
    }
    if (domain === 'indexer' && capability === 'reindex') return [{ id: INDEXER_PLUGIN_ID }];
    return [];
  };

  const invoke = async (pluginId, { capability, input } = {}) => {
    calls.push({ pluginId, capability, input });
    if (capability === 'mkdir') return { ok: true };
    if (capability === 'listSharedFiles') {
      if (blockListSharedFiles) await blockListSharedFiles();
      return { files: [], truncated: false };
    }
    if (capability === 'list') {
      return {
        files: destinationFiles.filter((file) =>
          file.path === input.path || file.path.startsWith(input.path.replace(/\/$/, '') + '/')),
        truncated,
      };
    }
    if (capability === 'move') {
      const file = destinationFiles.find((item) => item.path === input.sourcePath);
      if (!file) throw new Error('recovery fixture could not find file to move');
      file.path = input.destinationPath;
      file.name = path.posix.basename(input.destinationPath);
      return { ok: true };
    }
    if (capability === 'renameMany') {
      for (const item of input.items) {
        const file = destinationFiles.find((candidate) => candidate.path === item.path);
        if (!file) throw new Error('recovery fixture could not find file to rename');
        file.name = item.newName;
        file.path = path.posix.join(path.posix.dirname(item.path), item.newName);
      }
      return { ok: true };
    }
    if (capability === 'reindex') return { ok: true };
    if (capability === 'save') {
      saveCount += 1;
      return { ok: true };
    }
    throw new Error('unexpected recovery fixture capability: ' + capability);
  };

  const followup = createFollowupService({
    shows,
    episodes,
    events,
    metadata: { async resolveEpisodeManifest() { return {}; } },
    listPlugins,
    invoke,
  });

  async function createEvent({ episodeNumbers = [1], status = 'processing' } = {}) {
    const selectedFiles = episodeNumbers.map((episodeNumber) => ({
      id: 'shared-file-' + episodeNumber,
      episodeNumber,
      name: 'Release.S01E' + String(episodeNumber).padStart(2, '0') + '.1080p.WEB-DL.mkv',
      size: 10000 + episodeNumber,
      quality: '1080p',
    }));
    await episodes.upsertSeason({
      showId: show.id,
      seasonNumber: 1,
      episodeCount: Math.max(...episodeNumbers),
      providerId: 'test-metadata',
    });
    for (const episodeNumber of episodeNumbers) {
      await episodes.upsertEpisode({
        showId: show.id,
        seasonNumber: 1,
        episodeNumber,
      });
    }
    const event = await events.create({
      showId: show.id,
      kind: 'new_ep',
      source: 'test',
      payload: {
        storageId: storage.id,
        providerId: STORAGE_PLUGIN_ID,
        shareUrl: 'test-share://recovery-fixture',
        seasonNumber: 1,
        selectedFiles,
      },
    });
    const reservation = await episodes.reserveWrites({
      storageId: storage.id,
      seasonNumber: 1,
      eventId: event.id,
      episodeNumbers,
    });
    assert.deepEqual(reservation.blocked, []);
    if (status === 'failed') {
      await events.transition({ id: event.id, status: 'processing' });
      await episodes.markWritesUncertain({ eventId: event.id });
      await events.transition({ id: event.id, status: 'failed', error: 'INDEXER_UNCONFIRMED' });
    } else if (status === 'processing') {
      await events.transition({ id: event.id, status: 'processing' });
    } else if (status !== 'pending') {
      throw new TypeError('unsupported fixture event status');
    }
    return { event, selectedFiles };
  }

  return {
    calls,
    createEvent,
    database,
    destinationFiles,
    destinationPath,
    episodes,
    events,
    followup,
    get saveCount() { return saveCount; },
    show,
    storage,
    async close() {
      await database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function recoveryInput(action, confirmations = {}) {
  return {
    action,
    confirmNoActiveWorker: true,
    ...(action === 'complete'
      ? { confirmOutputsMatch: true }
      : { confirmNoOutput: true }),
    ...confirmations,
  };
}

function assertErrorCode(code) {
  return (error) => error?.code === code;
}

test('recovery completes verified saved files, syncs assets, and never saves again', async () => {
  const fixture = await createFixture();
  try {
    const { event, selectedFiles } = await fixture.createEvent({ episodeNumbers: [1, 2] });
    const firstCanonicalName = formatCanonicalEpisodeName({
      showName: fixture.show.name,
      seasonNumber: 1,
      episodeNumber: 1,
      quality: '1080p',
      extension: '.mkv',
    });
    const secondCanonicalName = formatCanonicalEpisodeName({
      showName: fixture.show.name,
      seasonNumber: 1,
      episodeNumber: 2,
      quality: '1080p',
      extension: '.mkv',
    });
    fixture.destinationFiles.push(
      {
        name: selectedFiles[0].name,
        path: fixture.destinationPath + '/partial/' + selectedFiles[0].name,
        size: selectedFiles[0].size,
        isDir: false,
      },
      {
        name: secondCanonicalName,
        path: fixture.destinationPath + '/' + secondCanonicalName,
        size: selectedFiles[1].size,
        isDir: false,
      },
    );

    const result = await fixture.followup.recoverInterruptedEvent(
      event.id,
      recoveryInput('complete', { confirmOutputsMatch: true }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.resolution, 'processed');
    assert.equal(result.event.status, 'processed');
    assert.deepEqual((await fixture.episodes.listWriteClaims(event.id)).map((claim) => claim.status), [
      'completed', 'completed',
    ]);
    assert.deepEqual(fixture.destinationFiles.map((file) => file.name).sort(), [
      firstCanonicalName,
      secondCanonicalName,
    ].sort());
    assert.ok(fixture.calls.some((call) => call.capability === 'move'));
    assert.ok(fixture.calls.some((call) => call.capability === 'renameMany'));
    assert.ok(fixture.calls.some((call) => call.pluginId === INDEXER_PLUGIN_ID
      && call.capability === 'reindex'));
    assert.equal(fixture.saveCount, 0);
    assert.deepEqual((await fixture.episodes.listStorageEpisodes(fixture.storage.id))
      .map((item) => [item.episodeNumber, item.status, item.assetCount]), [
        [1, 'present', 1],
        [2, 'present', 1],
      ]);
  } finally {
    await fixture.close();
  }
});

test('a processing event with a complete empty listing becomes explicitly retryable and keeps its claim', async () => {
  const fixture = await createFixture();
  try {
    const { event } = await fixture.createEvent();
    const result = await fixture.followup.recoverInterruptedEvent(
      event.id,
      recoveryInput('retry_after_review'),
    );

    assert.equal(result.resolution, 'retryable');
    assert.equal(result.event.status, 'failed');
    assert.equal(result.event.retryable, true);
    assert.deepEqual((await fixture.episodes.listWriteClaims(event.id)).map((claim) => claim.status), [
      'reserved',
    ]);
    assert.equal(fixture.saveCount, 0);

    const retried = await fixture.events.retryFailed(event.id);
    assert.equal(retried.status, 'pending');
    assert.deepEqual((await fixture.episodes.listWriteClaims(event.id)).map((claim) => claim.status), [
      'reserved',
    ]);
  } finally {
    await fixture.close();
  }
});

test('a failed uncertain write claim becomes reserved only after an empty destination review', async () => {
  const fixture = await createFixture();
  try {
    const { event } = await fixture.createEvent({ status: 'failed' });
    assert.deepEqual((await fixture.episodes.listWriteClaims(event.id)).map((claim) => claim.status), [
      'uncertain',
    ]);

    const result = await fixture.followup.recoverInterruptedEvent(
      event.id,
      recoveryInput('retry_after_review'),
    );

    assert.equal(result.event.status, 'failed');
    assert.equal(result.event.retryable, true);
    assert.deepEqual((await fixture.episodes.listWriteClaims(event.id)).map((claim) => claim.status), [
      'reserved',
    ]);
    assert.equal((await fixture.events.retryFailed(event.id)).status, 'pending');
    assert.equal(fixture.saveCount, 0);
  } finally {
    await fixture.close();
  }
});

test('partial, duplicate, and truncated destination listings preserve the event and its write claims', async (context) => {
  const cases = [
    { name: 'partial output', episodeNumbers: [1, 2], files: (base) => [base[0]] },
    { name: 'duplicate output', episodeNumbers: [1], files: (base, root) => [
      base[0],
      { ...base[0], path: root + '/duplicate/' + base[0].name },
    ] },
    { name: 'truncated listing', episodeNumbers: [1], files: () => [], truncated: true },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const fixture = await createFixture({ truncated: item.truncated === true });
      try {
        const { event, selectedFiles } = await fixture.createEvent({
          episodeNumbers: item.episodeNumbers,
        });
        const files = selectedFiles.map((selectedFile) => ({
          name: selectedFile.name,
          path: fixture.destinationPath + '/' + selectedFile.name,
          size: selectedFile.size,
          isDir: false,
        }));
        fixture.destinationFiles.push(...item.files(files, fixture.destinationPath));

        const expectedCode = item.truncated
          ? 'INCOMPLETE_LISTING'
          : 'RECOVERY_INCOMPLETE';
        await assert.rejects(
          fixture.followup.recoverInterruptedEvent(event.id, recoveryInput('complete')),
          assertErrorCode(expectedCode),
        );

        const unchangedEvent = await fixture.events.getById(event.id);
        assert.equal(unchangedEvent.status, 'processing');
        assert.deepEqual((await fixture.episodes.listWriteClaims(event.id)).map((claim) => claim.status),
          item.episodeNumbers.map(() => 'reserved'));
        assert.equal(fixture.calls.some((call) => ['move', 'renameMany', 'reindex'].includes(call.capability)),
          false);
        assert.equal(fixture.saveCount, 0);
      } finally {
        await fixture.close();
      }
    });
  }
});

test('recovery conflicts while processEvent is active in the same service process', async () => {
  let signalEntered;
  let releaseShareListing;
  const enteredMkdir = new Promise((resolve) => { signalEntered = resolve; });
  const shareListingGate = new Promise((resolve) => { releaseShareListing = resolve; });
  const fixture = await createFixture({
    blockListSharedFiles: async () => {
      signalEntered();
      await shareListingGate;
    },
  });
  let activeProcessing;

  try {
    const { event } = await fixture.createEvent({ status: 'pending' });
    activeProcessing = fixture.followup.processEvent(event.id);
    await enteredMkdir;

    await assert.rejects(
      fixture.followup.recoverInterruptedEvent(event.id, recoveryInput('complete')),
      assertErrorCode('EVENT_STILL_ACTIVE'),
    );

    releaseShareListing();
    const result = await activeProcessing;
    assert.equal(result.event.status, 'failed');
    assert.equal(fixture.saveCount, 0);
  } finally {
    releaseShareListing();
    await activeProcessing?.catch(() => {});
    await fixture.close();
  }
});
