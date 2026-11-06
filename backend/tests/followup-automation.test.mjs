import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFollowupAutomationService,
  createFollowupScheduler,
} from '../core/followup-automation.mjs';

function createFixture({
  shows = [{ id: 1, name: 'Active Show', mediaType: 'tv', finished: false }],
  storages = new Map([[1, [{ id: 11 }, { id: 12 }]]]),
  findCandidates = async () => ({ results: [] }),
  events = [],
} = {}) {
  const state = {
    searches: [],
    queued: [],
    processed: [],
    listedEvents: 0,
    events: events.map((event) => ({ ...event })),
  };
  let nextEventId = Math.max(0, ...state.events.map((event) => event.id)) + 1;

  const automation = createFollowupAutomationService({
    shows: { async list() { return shows; } },
    episodes: {
      async listShowStorages(showId, options) {
        assert.deepEqual(options, { enabledOnly: true });
        return storages.get(showId) || [];
      },
    },
    events: {
      async list({ status, limit }) {
        assert.equal(status, 'pending');
        assert.equal(limit, 1000);
        state.listedEvents += 1;
        return state.events.filter((event) => event.status === 'pending');
      },
    },
    resourceDiscovery: {
      async searchForShow(input) {
        state.searches.push(input);
        return findCandidates(input);
      },
    },
    followup: {
      async queueShare(input) {
        state.queued.push(input);
        const event = {
          id: nextEventId++,
          kind: 'new_ep',
          source: input.source,
          status: 'pending',
        };
        state.events.push(event);
        return { queued: true, event };
      },
      async processEvent(eventId) {
        state.processed.push(eventId);
        const event = state.events.find((item) => item.id === eventId);
        assert.ok(event, `event ${eventId} should exist`);
        event.status = 'processed';
        return { ok: true, event };
      },
    },
    now: () => new Date('2026-11-05T00:00:00.000Z'),
  });

  return { automation, state };
}

function candidate({ shareUrl, eligible = true, searchComplete = true, title = 'Episode' }) {
  return {
    providerId: 'fixture-resource',
    shareUrl,
    title,
    sourceId: shareUrl,
    ...(searchComplete ? {} : { searchComplete: false }),
    preview: { eligible },
  };
}

test('manual automation scan reports candidates without queueing or processing', async () => {
  const { automation, state } = createFixture({
    shows: [
      { id: 1, name: 'Active Show', mediaType: 'tv', finished: false },
      { id: 2, name: 'Finished Show', mediaType: 'tv', finished: true },
      { id: 3, name: 'Movie', mediaType: 'movie', finished: false },
    ],
    storages: new Map([[1, [{ id: 11 }]]]),
    findCandidates: async () => ({ results: [
      candidate({ shareUrl: 'fixture:/eligible' }),
      candidate({ shareUrl: 'fixture:/partial', searchComplete: false }),
      candidate({ shareUrl: 'fixture:/ineligible', eligible: false }),
    ] }),
  });

  const result = await automation.runScan();

  assert.equal(result.showsChecked, 1);
  assert.equal(result.storagesChecked, 1);
  assert.equal(result.candidatesFound, 3);
  assert.equal(result.eligibleCandidates, 1);
  assert.equal(result.eventsQueued, 0);
  assert.equal(result.eventsProcessed, 0);
  assert.equal(state.searches.length, 1);
  assert.equal(state.queued.length, 0);
  assert.equal(state.processed.length, 0);
  assert.deepEqual(state.searches[0], { showId: 1, storageId: 11, limit: 5 });
});

test('automation queues only the first complete eligible candidate per storage', async () => {
  const { automation, state } = createFixture({
    findCandidates: async ({ storageId }) => ({ results: [
      candidate({ shareUrl: `fixture:/${storageId}/first` }),
      candidate({ shareUrl: `fixture:/${storageId}/second` }),
      candidate({ shareUrl: `fixture:/${storageId}/partial`, searchComplete: false }),
    ] }),
  });

  const result = await automation.runScan({ queueCandidates: true });

  assert.equal(result.storagesChecked, 2);
  assert.equal(result.eligibleCandidates, 4);
  assert.equal(result.eventsQueued, 2);
  assert.deepEqual(state.queued.map(({ shareUrl, source }) => ({ shareUrl, source })), [
    { shareUrl: 'fixture:/11/first', source: 'automation' },
    { shareUrl: 'fixture:/12/first', source: 'automation' },
  ]);
  assert.equal(state.processed.length, 0);
  assert.equal(state.listedEvents, 0);
});

test('auto-process handles pending automation events before and after queueing', async () => {
  const { automation, state } = createFixture({
    storages: new Map([[1, [{ id: 11 }]]]),
    events: [
      { id: 20, kind: 'new_ep', source: 'automation', status: 'pending' },
      { id: 21, kind: 'new_ep', source: 'manual', status: 'pending' },
      { id: 22, kind: 'other', source: 'automation', status: 'pending' },
    ],
    findCandidates: async () => ({ results: [candidate({ shareUrl: 'fixture:/new' })] }),
  });

  const result = await automation.runScan({ queueCandidates: true, processQueued: true });

  assert.equal(result.eventsQueued, 1);
  assert.equal(result.eventsProcessed, 2);
  assert.equal(result.eventsFailed, 0);
  assert.deepEqual(state.processed, [20, 23]);
  assert.equal(state.listedEvents, 2);
  assert.equal(state.events.find((event) => event.id === 21).status, 'pending');
  assert.equal(state.events.find((event) => event.id === 22).status, 'pending');
});

test('overlapping automation scans are skipped until the active scan completes', async () => {
  let markStarted;
  let releaseSearch;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const delayedSearch = new Promise((resolve) => { releaseSearch = resolve; });
  const { automation } = createFixture({
    storages: new Map([[1, [{ id: 11 }]]]),
    findCandidates: async () => {
      markStarted();
      return delayedSearch;
    },
  });

  const active = automation.runScan();
  await started;
  assert.deepEqual(await automation.runScan(), { skipped: true, reason: 'scan_in_progress' });
  releaseSearch({ results: [] });
  const completed = await active;
  assert.equal(completed.storagesChecked, 1);
  assert.equal(automation.status().running, false);
});

test('scheduler queues on startup and interval while auto-processing remains separately controlled', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = [];
  const cleared = [];
  const scans = [];
  const automation = {
    async runScan(options) {
      scans.push(options);
      return {
        startedAt: '2026-11-05T00:00:00.000Z',
        completedAt: '2026-11-05T00:00:01.000Z',
        showsChecked: 1,
        storagesChecked: 1,
        candidatesFound: 1,
        eventsQueued: 0,
        eventsProcessed: 0,
        eventsFailed: 0,
        errors: [],
      };
    },
    status: () => ({ running: false, lastRun: null }),
  };

  globalThis.setInterval = (callback, delay) => {
    const handle = { callback, delay, unref() {} };
    intervals.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => cleared.push(handle);

  try {
    const scheduler = createFollowupScheduler({
      enabled: true,
      intervalMinutes: 10,
      autoProcess: false,
      automation,
      logger: { info() {}, error() {} },
      now: () => new Date('2026-11-05T00:00:00.000Z'),
    });

    assert.equal(scheduler.start(), true);
    await scheduler.waitForIdle();
    assert.deepEqual(scans, [{ queueCandidates: true, processQueued: false }]);
    assert.equal(intervals[0].delay, 10 * 60 * 1000);

    scheduler.updateSettings({ enabled: true, intervalMinutes: 15, autoProcess: true });
    assert.deepEqual(cleared, [intervals[0]]);
    assert.equal(intervals[1].delay, 15 * 60 * 1000);
    assert.equal(scans.length, 1);

    intervals[1].callback();
    await scheduler.waitForIdle();
    assert.deepEqual(scans[1], { queueCandidates: true, processQueued: true });

    scheduler.updateSettings({ enabled: false, intervalMinutes: 15, autoProcess: true });
    assert.deepEqual(cleared, [intervals[0], intervals[1]]);
    assert.equal(scheduler.status().enabled, false);
    assert.equal(scheduler.status().autoProcess, true);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
