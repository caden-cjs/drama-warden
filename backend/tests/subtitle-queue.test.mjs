import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSqliteDatabase } from '../db/sqlite.mjs';
import { createEpisodeRepository } from '../core/episode-repository.mjs';
import { createShowRepository } from '../core/show-repository.mjs';
import { createSubtitleRepository } from '../core/subtitle-repository.mjs';
import { createSubtitleService } from '../core/subtitle-service.mjs';
import { createSubtitleWorker } from '../core/subtitle-worker.mjs';
import { createPluginHost } from '../plugins/host.mjs';
import { createLocalStoragePlugin } from '../plugins/local-storage/index.mjs';
import { defineSubtitlePlugin } from '../plugins/contract.mjs';

async function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'drama-warden-subtitles-'));
  const database = openSqliteDatabase({ filename: path.join(directory, 'test.sqlite') });
  const shows = createShowRepository(database);
  const episodes = createEpisodeRepository(database);
  const repository = createSubtitleRepository(database);
  const show = await shows.create({ name: 'Example Show' });
  await episodes.upsertSeason({ showId: show.id, seasonNumber: 1, episodeCount: 1 });
  const episode = await episodes.upsertEpisode({ showId: show.id, seasonNumber: 1, episodeNumber: 1 });
  const storage = await episodes.createStorage({
    showId: show.id,
    providerId: 'local-storage',
    rootPath: '/shows/example',
  });
  return { directory, database, shows, episodes, repository, show, episode, storage };
}

test('subtitle queue is idempotent and uncertain writes cannot be retried automatically', async () => {
  const fixture = await setup();
  try {
    const first = await fixture.repository.create({
      showId: fixture.show.id,
      storageId: fixture.storage.id,
      seasonNumber: 1,
      episodeNumber: 1,
    });
    const duplicate = await fixture.repository.create({
      showId: fixture.show.id,
      storageId: fixture.storage.id,
      seasonNumber: 1,
      episodeNumber: 1,
      languages: ['eng'],
    });
    assert.equal(duplicate.id, first.id);
    assert.equal((await fixture.repository.list()).length, 1);

    const claimed = await fixture.repository.claimNext();
    assert.equal(claimed.id, first.id);
    await fixture.repository.markWriteStarted(first.id, 'sample-subtitles', claimed.claimToken);
    const uncertain = await fixture.repository.fail(
      first.id,
      'SIDECAR_WRITE_UNCONFIRMED',
      claimed.claimToken,
    );
    assert.equal(uncertain.status, 'uncertain');
    await assert.rejects(fixture.repository.retryFailed(first.id), /only subtitle jobs failed before writing/);
  } finally {
    await fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a stale worker lease cannot update a job after another worker reclaims it', async () => {
  const fixture = await setup();
  try {
    const job = await fixture.repository.create({
      showId: fixture.show.id,
      storageId: fixture.storage.id,
      seasonNumber: 1,
      episodeNumber: 1,
    });
    const oldClaim = await fixture.repository.claimNext();
    await fixture.database.run(
      "UPDATE subtitle_job SET locked_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE id = ?",
      [job.id],
    );
    const newClaim = await fixture.repository.claimNext();
    assert.equal(newClaim.id, oldClaim.id);
    assert.notEqual(newClaim.claimToken, oldClaim.claimToken);
    assert.equal(newClaim.attemptCount, 2);
    await assert.rejects(
      fixture.repository.markWriteStarted(job.id, 'sample-subtitles', oldClaim.claimToken),
      { code: 'SUBTITLE_JOB_LEASE_LOST' },
    );
    await fixture.repository.markWriteStarted(job.id, 'sample-subtitles', newClaim.claimToken);
    await assert.rejects(
      fixture.repository.fail(job.id, 'old-worker-failed', oldClaim.claimToken),
      { code: 'SUBTITLE_JOB_LEASE_LOST' },
    );
    assert.equal((await fixture.repository.getById(job.id)).status, 'processing');
  } finally {
    await fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('subtitle provider failures back off, become terminal after three claims, and can be explicitly retried', async () => {
  const fixture = await setup();
  try {
    const job = await fixture.repository.create({
      showId: fixture.show.id,
      storageId: fixture.storage.id,
      seasonNumber: 1,
      episodeNumber: 1,
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await fixture.repository.claimNext();
      assert.equal(claimed?.attemptCount, attempt);
      const failed = await fixture.repository.fail(job.id, 'SUBTITLE_TIMEOUT', claimed.claimToken);
      assert.equal(failed.status, attempt === 3 ? 'failed' : 'pending');
      if (attempt < 3) {
        await fixture.database.run(
          "UPDATE subtitle_job SET next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE id = ?",
          [job.id],
        );
      }
    }
    const retried = await fixture.repository.retryFailed(job.id);
    assert.equal(retried.status, 'pending');
    assert.equal(retried.attemptCount, 3);
  } finally {
    await fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('subtitle worker writes one verified sidecar through the storage plugin', async () => {
  const fixture = await setup();
  const mediaRoot = path.join(fixture.directory, 'media');
  const shareRoot = path.join(fixture.directory, 'shares');
  const episodePath = '/shows/example/Season 01/Example Show S01E01.mkv';
  const targetVideo = path.join(mediaRoot, episodePath.slice(1));
  mkdirSync(path.dirname(targetVideo), { recursive: true });
  mkdirSync(shareRoot, { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(targetVideo, 'video-bytes'));
  await fixture.database.run(
    'INSERT INTO show_episode_asset ' +
    '(episode_id, show_storage_id, asset_key, relative_path, file_name, file_size, file_mtime, is_present, scan_id) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
    [fixture.episode.id, fixture.storage.id, episodePath, episodePath, path.posix.basename(episodePath), 11, 1, 'scan-one'],
  );
  const host = createPluginHost();
  host.register(createLocalStoragePlugin({ storageRoot: mediaRoot, shareRoot }));
  host.register(defineSubtitlePlugin({
    manifest: { id: 'sample-subtitles', name: 'Sample subtitles', version: '1.0.0' },
    search: async () => [{ id: 'candidate-1', fileName: 'Example.Show.S01E01.srt', episodeNumber: 1 }],
    download: async () => ({ fileName: 'Example.Show.S01E01.srt', content: Buffer.from('1\nsubtitle\n') }),
  }));
  await host.initializePlugins();
  const subtitles = createSubtitleService({
    shows: fixture.shows,
    episodes: fixture.episodes,
    repository: fixture.repository,
    listPlugins: host.listPlugins,
  });
  const result = await subtitles.queue({
    showId: fixture.show.id,
    storageId: fixture.storage.id,
    seasonNumber: 1,
    episodeNumber: 1,
  });
  assert.equal(result.queued, true);

  const worker = createSubtitleWorker({
    repository: fixture.repository,
    listPlugins: host.listPlugins,
    invoke: host.invoke,
    intervalMs: 60_000,
    logger: { warn() {}, error() {} },
  });
  try {
    worker.start();
    await worker.waitForIdle();
    const completed = await fixture.repository.getById(result.job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.outputPath, '/shows/example/Season 01/Example Show S01E01.srt');
    assert.equal(
      readFileSync(path.join(path.dirname(targetVideo), 'Example Show S01E01.srt'), 'utf8'),
      '1\nsubtitle\n',
    );
  } finally {
    worker.stop();
    await worker.waitForIdle();
    await fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
