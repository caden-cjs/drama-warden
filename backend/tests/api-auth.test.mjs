import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createApiHandler } from '../api/http.mjs';

test('business API rejects missing and incorrect bearer tokens', async () => {
  const handler = createApiHandler({
    shows: {},
    episodes: {},
    events: {},
    metadata: {},
    storageCatalog: {},
    followup: {},
    resourceDiscovery: {},
    automation: {},
    scheduler: { status: () => ({ enabled: false }) },
    subtitles: {
      async queue() {
        return {
          queued: true,
          job: {
            id: 1,
            status: 'pending',
            writeStartedAt: 'internal-only',
          },
        };
      },
      async list() { return []; },
      async get() { return null; },
      async retry() { return { id: 1, status: 'pending' }; },
    },
    subtitleWorker: { status: () => ({ enabled: false }) },
    listPlugins: () => [],
    pluginCalls: {
      async list(filters) {
        assert.equal(filters.pluginId, 'tvmaze');
        assert.equal(filters.ok, false);
        assert.equal(filters.limit, 10);
        assert.equal(filters.offset, 2);
        return [{
          id: 7,
          pluginId: 'tvmaze',
          capability: 'search',
          source: 'metadata-search',
          correlationId: 'trace-7',
          ok: false,
          errorCode: 'METADATA_TIMEOUT',
          durationMs: 250,
          calledAt: '2026-11-05T00:00:00.000Z',
        }];
      },
    },
    token: 'test-only-token',
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/api/plugins`;

  try {
    const missing = await fetch(endpoint);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).code, 'unauthorized');

    const incorrect = await fetch(endpoint, { headers: { authorization: 'Bearer wrong-token' } });
    assert.equal(incorrect.status, 401);

    const accepted = await fetch(endpoint, { headers: { authorization: 'Bearer test-only-token' } });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { items: [] });

    const callLog = await fetch(
      `http://127.0.0.1:${address.port}/api/plugin-calls?pluginId=tvmaze&ok=false&limit=10&offset=2`,
      { headers: { authorization: 'Bearer test-only-token' } },
    );
    assert.equal(callLog.status, 200);
    const callLogBody = await callLog.json();
    assert.equal(callLogBody.items[0].errorCode, 'METADATA_TIMEOUT');
    assert.equal(callLogBody.items[0].durationMs, 250);

    const queued = await fetch(`http://127.0.0.1:${address.port}/api/shows/7/subtitle-jobs`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-only-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ storageId: 3, seasonNumber: 1, episodeNumber: 2 }),
    });
    assert.equal(queued.status, 202);
    const queuedBody = await queued.json();
    assert.equal(queuedBody.job.status, 'pending');
    assert.equal(Object.hasOwn(queuedBody.job, 'writeStartedAt'), false);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('event recovery route requires bearer auth, validates the ID, and redacts the share URL', async () => {
  const recoveryBearer = 'recovery-route-test-token';
  let recoveryCall = null;
  const handler = createApiHandler({
    shows: {},
    episodes: {},
    events: {},
    metadata: {},
    storageCatalog: {},
    followup: {
      async recoverInterruptedEvent(id, input) {
        recoveryCall = { id, input };
        return {
          ok: true,
          resolution: 'processed',
          event: {
            id,
            status: 'processed',
            payload: {
              shareUrl: 'https://share.example/private-token',
              storageId: 9,
            },
          },
        };
      },
    },
    resourceDiscovery: {},
    automation: {},
    scheduler: {},
    subtitles: {},
    subtitleWorker: {},
    listPlugins: () => [],
    token: recoveryBearer,
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/events`;
  const input = {
    action: 'complete',
    confirmNoActiveWorker: true,
    confirmOutputsMatch: true,
  };

  try {
    const unauthorized = await fetch(`${endpoint}/17/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(recoveryCall, null);

    const invalidId = await fetch(`${endpoint}/not-an-id/recover`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${recoveryBearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    assert.equal(invalidId.status, 400);
    assert.equal(recoveryCall, null);

    const response = await fetch(`${endpoint}/17/recover`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${recoveryBearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(recoveryCall, { id: 17, input });
    const result = await response.json();
    assert.equal(result.resolution, 'processed');
    assert.equal(result.event.payload.shareUrl, '[redacted]');
    assert.equal(result.event.payload.storageId, 9);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
