import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginSettings } from '../core/plugin-settings.mjs';
import { createPluginHost } from '../plugins/host.mjs';
import { defineMetadataPlugin } from '../plugins/contract.mjs';
import { createPan115StoragePlugin } from '../plugins/pan115/index.mjs';

const PLUGIN_ID = 'lifecycle-metadata';

function createPlugin({ initialize, reset, search, subscriptions, onEvent } = {}) {
  return defineMetadataPlugin({
    manifest: { id: PLUGIN_ID, name: 'Lifecycle metadata', version: '1.0.0' },
    search: search || (async () => []),
    detail: async () => null,
    episodes: async () => [],
    initialize,
    reset,
    subscriptions,
    onEvent,
  });
}

function createSettingsDb({ failWrite = false } = {}) {
  let storedValue = null;
  return {
    dialect: 'sqlite',
    async get(_sql, [key]) {
      assert.equal(key, 'plugins');
      return storedValue === null ? null : { value_json: storedValue };
    },
    async transaction(work) {
      return work({
        async run(_sql, [key, value]) {
          assert.equal(key, 'plugins');
          if (failWrite) throw new Error('database write failed');
          storedValue = value;
        },
      });
    },
    stored() {
      return storedValue === null ? null : JSON.parse(storedValue);
    },
  };
}

test('disabling resets a plugin and re-enabling initializes it again', async () => {
  const lifecycle = [];
  const plugin = createPlugin({
    initialize: async () => lifecycle.push('initialize'),
    reset: async () => lifecycle.push('reset'),
  });
  const host = createPluginHost();
  host.register(plugin);
  const settings = createPluginSettings({ db: createSettingsDb(), host });

  await settings.update(PLUGIN_ID, { enabled: false });
  assert.equal(host.state(PLUGIN_ID).enabled, false);
  assert.deepEqual(lifecycle, ['reset']);
  assert.equal(settings.list().find((item) => item.id === PLUGIN_ID).enabled, false);
  await assert.rejects(
    host.invoke(PLUGIN_ID, { capability: 'search', input: { query: 'series' } }),
    { code: 'PLUGIN_DISABLED' },
  );

  await settings.update(PLUGIN_ID, { enabled: true });
  assert.equal(host.state(PLUGIN_ID).enabled, true);
  assert.deepEqual(lifecycle, ['reset', 'initialize']);
});

test('disable blocks new calls and waits for in-flight calls before reset', async () => {
  const lifecycle = [];
  let finishSearch;
  const plugin = createPlugin({
    search: async () => {
      lifecycle.push('search-start');
      await new Promise((resolve) => { finishSearch = resolve; });
      lifecycle.push('search-finish');
      return [];
    },
    reset: async () => lifecycle.push('reset'),
  });
  const host = createPluginHost();
  host.register(plugin);

  const search = host.invoke(PLUGIN_ID, {
    capability: 'search',
    input: { query: 'series' },
  });
  const disable = host.disable(PLUGIN_ID);

  assert.equal(host.state(PLUGIN_ID).enabled, false);
  assert.deepEqual(lifecycle, ['search-start']);
  await assert.rejects(
    host.invoke(PLUGIN_ID, { capability: 'search', input: { query: 'later' } }),
    { code: 'PLUGIN_DISABLED' },
  );
  assert.deepEqual(lifecycle, ['search-start']);

  finishSearch();
  await Promise.all([search, disable]);
  assert.deepEqual(lifecycle, ['search-start', 'search-finish', 'reset']);
});

test('reset waits for active calls and resumes queued calls afterward', async () => {
  const lifecycle = [];
  let finishFirstSearch;
  let searchCount = 0;
  const plugin = createPlugin({
    search: async () => {
      searchCount += 1;
      lifecycle.push(`search-${searchCount}-start`);
      if (searchCount === 1) {
        await new Promise((resolve) => { finishFirstSearch = resolve; });
      }
      lifecycle.push(`search-${searchCount}-finish`);
      return [];
    },
    reset: async () => lifecycle.push('reset'),
  });
  const host = createPluginHost();
  host.register(plugin);

  const firstSearch = host.invoke(PLUGIN_ID, {
    capability: 'search',
    input: { query: 'first' },
  });
  const reset = host.reset(PLUGIN_ID);
  const secondSearch = host.invoke(PLUGIN_ID, {
    capability: 'search',
    input: { query: 'second' },
  });

  assert.deepEqual(lifecycle, ['search-1-start']);
  finishFirstSearch();
  await Promise.all([firstSearch, reset, secondSearch]);
  assert.deepEqual(lifecycle, [
    'search-1-start',
    'search-1-finish',
    'reset',
    'search-2-start',
    'search-2-finish',
  ]);
});

test('initialization waits for a concurrent reset to finish', async () => {
  const lifecycle = [];
  let finishReset;
  const plugin = createPlugin({
    initialize: async () => lifecycle.push('initialize'),
    reset: async () => {
      lifecycle.push('reset-start');
      await new Promise((resolve) => { finishReset = resolve; });
      lifecycle.push('reset-finish');
    },
  });
  const host = createPluginHost();
  host.register(plugin);

  const reset = host.reset(PLUGIN_ID);
  await Promise.resolve();
  host.setEnabled(PLUGIN_ID, false);
  const initialize = host.initializePlugin(PLUGIN_ID, {}, { allowDisabled: true });

  assert.deepEqual(lifecycle, ['reset-start']);
  finishReset();
  await Promise.all([reset, initialize]);
  assert.deepEqual(lifecycle, ['reset-start', 'reset-finish', 'initialize']);
});

test('disable drains event callbacks before resetting plugin state', async () => {
  const lifecycle = [];
  let finishEvent;
  const plugin = createPlugin({
    subscriptions: ['episode.ready'],
    onEvent: async () => {
      lifecycle.push('event-start');
      await new Promise((resolve) => { finishEvent = resolve; });
      lifecycle.push('event-finish');
    },
    reset: async () => lifecycle.push('reset'),
  });
  const host = createPluginHost();
  host.register(plugin);

  const publish = host.publishEvent({ type: 'episode.ready' });
  const disable = host.disable(PLUGIN_ID);

  assert.deepEqual(lifecycle, ['event-start']);
  finishEvent();
  await Promise.all([publish, disable]);
  assert.deepEqual(lifecycle, ['event-start', 'event-finish', 'reset']);
});

test('replacement is rejected while the current plugin is in use', async () => {
  let finishSearch;
  const plugin = createPlugin({
    search: async () => new Promise((resolve) => { finishSearch = resolve; }),
  });
  const host = createPluginHost();
  host.register(plugin);
  const search = host.invoke(PLUGIN_ID, {
    capability: 'search',
    input: { query: 'series' },
  });

  assert.throws(() => host.register(createPlugin(), { replace: true }), {
    code: 'PLUGIN_LIFECYCLE_BUSY',
  });
  finishSearch([]);
  await search;

  const replacement = createPlugin();
  host.register(replacement, { replace: true });
  assert.equal(host.getPlugin(PLUGIN_ID), replacement);
});

test('failed persistence keeps an enabled plugin active without resetting it', async () => {
  let resetCount = 0;
  const plugin = createPlugin({ reset: async () => { resetCount += 1; } });
  const host = createPluginHost();
  host.register(plugin);
  const settings = createPluginSettings({
    db: createSettingsDb({ failWrite: true }),
    host,
  });

  await assert.rejects(settings.update(PLUGIN_ID, { enabled: false }), /database write failed/);
  assert.equal(host.state(PLUGIN_ID).enabled, true);
  assert.equal(resetCount, 0);
});

test('failed reset leaves the persisted plugin disabled and reports a stable error code', async () => {
  const plugin = createPlugin({
    reset: async () => { throw new Error('provider detail must stay internal'); },
  });
  const host = createPluginHost();
  host.register(plugin);
  const db = createSettingsDb();
  const settings = createPluginSettings({ db, host });

  await assert.rejects(settings.update(PLUGIN_ID, { enabled: false }), (error) => {
    assert.equal(error.code, 'PLUGIN_RESET_FAILED');
    return true;
  });
  assert.equal(host.state(PLUGIN_ID).enabled, false);
  assert.deepEqual(db.stored(), { [PLUGIN_ID]: { enabled: false } });
});

test('115 disable and re-enable clears a failed authorization cache so it can retry', async () => {
  let authorizationAttempts = 0;
  const host = createPluginHost();
  host.register(createPan115StoragePlugin({
    cookie: 'fixture-cookie',
    adapter: {
      async pan115Authorize() {
        authorizationAttempts += 1;
        if (authorizationAttempts === 1) throw new Error('temporary authorization failure');
      },
      async pan115ShareFiles() {
        return [];
      },
    },
  }));
  const settings = createPluginSettings({ db: createSettingsDb(), host });
  const request = {
    capability: 'listSharedFiles',
    input: { shareUrl: 'https://share.example/s/115-lifecycle-fixture' },
  };

  await assert.rejects(host.invoke('pan115', request), { code: 'PAN115_AUTH_FAILED' });
  await settings.update('pan115', { enabled: false });
  assert.equal(host.state('pan115').enabled, false);
  await settings.update('pan115', { enabled: true });
  assert.equal(host.state('pan115').enabled, true);
  assert.deepEqual(await host.invoke('pan115', request), {
    files: [],
    total: 0,
    truncated: false,
  });
  assert.equal(authorizationAttempts, 2);

  await host.invoke('pan115', request);
  assert.equal(authorizationAttempts, 2);
});
