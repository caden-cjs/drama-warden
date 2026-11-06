import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSharedEpisodeFiles, limitEpisodeSaveBatch } from '../core/episode-selection.mjs';
import { createFollowupPlan } from '../core/followup-plan.mjs';

test('selects one best matching video per requested episode and respects season boundaries', () => {
  const selected = selectSharedEpisodeFiles([
    { id: 'wrong-season', name: 'Example S01E03 4K.mkv', size: 900 },
    { id: 'lower-quality', name: 'Example S02E03 720p.mkv', size: 100 },
    { id: 'best-quality', name: 'Example S02E03 4K.mkv', size: 200 },
    { id: 'episode-four', name: 'Example S02E04 1080p.mkv', size: 150 },
    { id: 'unseasoned', name: 'Episode 03 4K.mkv', size: 500 },
    { id: 'subtitle', name: 'Example S02E03.srt', size: 20 },
  ], [3, 4], { seasonNumber: 2 });

  assert.deepEqual(selected.map((file) => file.id), ['best-quality', 'episode-four']);
  assert.deepEqual(selected.map((file) => file.episodeNumber), [3, 4]);
});

test('bounds a save batch by count and estimated bytes', () => {
  const result = limitEpisodeSaveBatch([
    { id: 'one', size: 5 },
    { id: 'two', size: 7 },
    { id: 'three', size: 1 },
  ], { maxEpisodes: 3, maxBytes: 12 });

  assert.deepEqual(result.files.map((file) => file.id), ['one', 'two']);
  assert.equal(result.bytes, 12);
  assert.equal(result.deferred, 1);
});

test('only queues future episodes that appear in the share listing and surfaces conflicts', () => {
  const plan = createFollowupPlan({
    seasonNumber: 2,
    today: '2026-11-04',
    metadataEpisodes: [
      { seasonNumber: 2, episodeNumber: 1, airDate: '2026-10-01' },
      { seasonNumber: 2, episodeNumber: 2, airDate: '2026-12-01' },
      { seasonNumber: 2, episodeNumber: 3, airDate: '2026-10-15' },
      { seasonNumber: 2, episodeNumber: 4, airDate: '2026-10-22' },
      { seasonNumber: 2, episodeNumber: 5, airDate: '2026-12-08' },
    ],
    storedEpisodes: [
      { seasonNumber: 2, episodeNumber: 3, status: 'present', assetCount: 1 },
      { seasonNumber: 2, episodeNumber: 4, status: 'conflict', assetCount: 2 },
    ],
    sharedFiles: [
      { id: 'future-two', name: 'Example S02E02.mkv', size: 1024 },
      { id: 'other-season', name: 'Example S01E05.mkv', size: 1024 },
    ],
  });

  assert.deepEqual(plan.missingAiredEpisodeNumbers, [1]);
  assert.deepEqual(plan.missingFutureEpisodeNumbers, [2, 5]);
  assert.deepEqual(plan.futureAvailableEpisodeNumbers, [2]);
  assert.deepEqual(plan.requestedEpisodeNumbers, [1, 2]);
  assert.deepEqual(plan.conflicts, [4]);
  assert.deepEqual(plan.selectedFiles.map((file) => file.id), ['future-two']);
});
