import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPluginSettings } from '../core/plugin-settings.mjs';
import { openDatabase } from '../db/index.mjs';
import { createPluginHost } from '../plugins/host.mjs';
import { defineMetadataPlugin } from '../plugins/contract.mjs';

test('MySQL persists plugin disable state across host restart and initializes on re-enable', {
  skip: process.env.RUN_MYSQL_INTEGRATION !== '1',
}, async () => {
  const pluginId = 'mysql-settings-' + randomUUID();
  let database;
  let hadStoredSettings = false;
  let originalSettings;

  function createPlugin(lifecycle) {
    return defineMetadataPlugin({
      manifest: { id: pluginId, name: 'MySQL settings fixture', version: '1.0.0' },
      search: async () => [],
      detail: async () => null,
      episodes: async () => [],
      initialize: async () => lifecycle.push('initialize'),
      reset: async () => lifecycle.push('reset'),
    });
  }

  try {
    database = await openDatabase({ driver: 'mysql', env: process.env });
    const storedRow = await database.get(
      'SELECT CAST(value_json AS CHAR) AS value_json '
        + 'FROM application_setting WHERE setting_key = ?',
      ['plugins'],
    );
    hadStoredSettings = storedRow !== null;
    originalSettings = storedRow?.value_json;

    const firstLifecycle = [];
    const firstHost = createPluginHost();
    firstHost.register(createPlugin(firstLifecycle));
    const firstSettings = createPluginSettings({ db: database, host: firstHost });
    await firstSettings.initialize();
    await firstSettings.update(pluginId, { enabled: false });

    assert.deepEqual(firstLifecycle, ['reset']);
    assert.equal(firstHost.state(pluginId).enabled, false);

    await database.close();
    database = null;

    database = await openDatabase({ driver: 'mysql', env: process.env });
    const secondLifecycle = [];
    const secondHost = createPluginHost();
    secondHost.register(createPlugin(secondLifecycle));
    const secondSettings = createPluginSettings({ db: database, host: secondHost });
    await secondSettings.initialize();
    await secondHost.initializePlugins();

    assert.equal(secondHost.state(pluginId).enabled, false);
    assert.equal(secondSettings.list().find((plugin) => plugin.id === pluginId).enabled, false);
    assert.deepEqual(secondLifecycle, []);
    await assert.rejects(
      secondHost.invoke(pluginId, { capability: 'search', input: { query: 'fixture' } }),
      { code: 'PLUGIN_DISABLED' },
    );

    await secondSettings.update(pluginId, { enabled: true });
    assert.equal(secondHost.state(pluginId).enabled, true);
    assert.deepEqual(secondLifecycle, ['initialize']);

    const savedSettings = await database.get(
      'SELECT value_json FROM application_setting WHERE setting_key = ?',
      ['plugins'],
    );
    const parsedSettings = typeof savedSettings.value_json === 'string'
      ? JSON.parse(savedSettings.value_json)
      : savedSettings.value_json;
    assert.equal(parsedSettings[pluginId]?.enabled, true);
  } finally {
    if (database) {
      if (hadStoredSettings) {
        await database.run(
          'INSERT INTO application_setting (setting_key, value_json) VALUES (?, ?) '
            + 'ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), '
            + 'updated_at = CURRENT_TIMESTAMP(3)',
          ['plugins', originalSettings],
        );
      } else {
        await database.run('DELETE FROM application_setting WHERE setting_key = ?', ['plugins']);
      }
      await database.close();
    }
  }
});
