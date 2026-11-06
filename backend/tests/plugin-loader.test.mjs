import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createPluginHost } from '../plugins/host.mjs';
import { loadConfiguredPlugins, loadPlugin } from '../plugins/loader.mjs';

const CONFIGURED_PLUGIN_ID = 'fixture-metadata';
const endpointVariable = 'DRAMA_WARDEN_PLUGIN_FIXTURE_METADATA_ENDPOINT';
const tokenVariable = 'DRAMA_WARDEN_PLUGIN_FIXTURE_METADATA_API_KEY';

function createPluginModule(source) {
  const directory = mkdtempSync(join(tmpdir(), 'drama-warden-plugin-loader-'));
  const path = join(directory, 'plugin.mjs');
  writeFileSync(path, source, { mode: 0o600 });
  return { directory, path };
}

function configuredPluginSource({ factory = true } = {}) {
  const sdkUrl = pathToFileURL(resolve('packages/plugin-sdk/index.mjs')).href;
  const manifest = `const manifest = {
  id: ${JSON.stringify(CONFIGURED_PLUGIN_ID)},
  name: 'Fixture metadata',
  version: '1.0.0',
  configSchema: { version: 1, fields: [
    { key: 'endpoint', type: 'url', required: true },
    { key: 'apiKey', type: 'password' },
  ] },
};
`;
  const action = ({ endpoint, apiKey, hasLogger }) => `defineMetadataPlugin({
  manifest,
  search: async ({ query }) => [{
    id: 'fixture:' + query,
    externalId: 'fixture:' + query,
    providerId: manifest.id,
    mediaType: 'tv',
    name: query,
    endpoint: ${endpoint},
    hasToken: Boolean(${apiKey}),
    hasLogger: ${hasLogger},
  }],
  detail: async () => null,
  episodes: async () => [],
})`;
  const header = `import { defineMetadataPlugin } from ${JSON.stringify(sdkUrl)};\n`;
  if (!factory) {
    return header + manifest + `export default ${action({
      endpoint: `process.env.${endpointVariable}`,
      apiKey: `process.env.${tokenVariable}`,
      hasLogger: 'true',
    })};`;
  }
  return header + manifest + `export default {
  manifest,
  create({ config = {}, logger }) {
    return ${action({
      endpoint: 'config.endpoint',
      apiKey: 'config.apiKey',
      hasLogger: 'Boolean(logger)',
    })};
  },
};`;
}

async function withPluginModule(source, callback) {
  const fixture = createPluginModule(source);
  try {
    return await callback(fixture.path);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}

test('plugin factories receive schema-checked environment configuration', async () => {
  await withPluginModule(configuredPluginSource(), async (path) => {
    const env = {
      DRAMA_WARDEN_PLUGINS: path,
      [endpointVariable]: 'https://metadata.example.test/v1',
      [tokenVariable]: 'private-token',
      UNRELATED_SETTING: 'ignored',
    };
    const audits = [];
    const host = createPluginHost({ onCall: async (audit) => audits.push(audit) });
    const ids = await loadConfiguredPlugins(host, {
      env,
      context: { logger: 'test-logger' },
    });
    const results = await host.invoke(CONFIGURED_PLUGIN_ID, {
      capability: 'search',
      input: { query: 'Sample' },
    });

    assert.deepEqual(ids, [CONFIGURED_PLUGIN_ID]);
    assert.equal(results[0].endpoint, 'https://metadata.example.test/v1');
    assert.equal(results[0].hasToken, true);
    assert.equal(results[0].hasLogger, true);
    assert.equal(JSON.stringify(host.getPlugin(CONFIGURED_PLUGIN_ID).manifest)
      .includes('private-token'), false);
    assert.equal(JSON.stringify(audits).includes('private-token'), false);
  });
});

test('plugin loader reports missing, malformed, and undeclared configuration without values', async () => {
  await withPluginModule(configuredPluginSource(), async (path) => {
    await assert.rejects(loadPlugin(path, { env: {} }), {
      code: 'PLUGIN_CONFIG_REQUIRED',
    });
    await assert.rejects(loadPlugin(path, {
      env: { [endpointVariable]: 'javascript:alert(1)' },
    }), {
      code: 'PLUGIN_CONFIG_INVALID',
    });
    await assert.rejects(loadPlugin(path, {
      env: {
        [endpointVariable]: 'https://metadata.example.test/v1',
        DRAMA_WARDEN_PLUGIN_FIXTURE_METADATA_UNKNOWN: 'do-not-print-this',
      },
    }), (error) => {
      assert.equal(error.code, 'PLUGIN_CONFIG_INVALID');
      assert.equal(error.message.includes('do-not-print-this'), false);
      return true;
    });
  });
});

test('configured plugin exports must use a factory to receive configuration', async () => {
  await withPluginModule(configuredPluginSource({ factory: false }), async (path) => {
    await assert.rejects(loadPlugin(path, {
      env: { [endpointVariable]: 'https://metadata.example.test/v1' },
    }), {
      code: 'PLUGIN_CONFIG_FACTORY_REQUIRED',
    });
  });
});
