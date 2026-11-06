import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPlugin,
  definePlugin,
  defineSubtitlePlugin,
  defineStoragePlugin,
  STORAGE_CAPABILITIES,
} from '../plugins/contract.mjs';

function storageActions() {
  return Object.fromEntries(STORAGE_CAPABILITIES.map((name) => [name, async () => ({ ok: true })]));
}

test('storage providers expose the complete version 2 contract and explicit removal modes', () => {
  const plugin = defineStoragePlugin({
    manifest: { id: 'sample-storage', name: 'Sample storage', version: '1.0.0' },
    actions: storageActions(),
    removeModes: ['recycle'],
  });

  assert.equal(plugin.kind, 'storage-provider');
  assert.equal(plugin.storageContract.version, 2);
  assert.deepEqual(plugin.storageContract.coreCapabilities, STORAGE_CAPABILITIES);
  assert.deepEqual(plugin.storageContract.removeModes, ['recycle']);
  assert.equal(assertPlugin(plugin), plugin);
});

test('storage providers reject undeclared removal semantics', () => {
  assert.throws(() => defineStoragePlugin({
    manifest: { id: 'unsafe-storage', name: 'Unsafe storage', version: '1.0.0' },
    actions: storageActions(),
    removeModes: ['delete'],
  }), /storage providers must declare storage contract v2/);
});

test('plugin capabilities must map to a declared semantic domain', () => {
  assert.throws(() => definePlugin({
    manifest: {
      id: 'unmapped-plugin',
      name: 'Unmapped plugin',
      kind: 'workflow-provider',
      version: '1.0.0',
    },
    actions: { execute: async () => ({ ok: true }) },
  }), /plugin action is missing a capability domain/);
});

test('subtitle providers must expose search and download in the subtitle domain', () => {
  const plugin = defineSubtitlePlugin({
    manifest: { id: 'sample-subtitles', name: 'Sample subtitles', version: '1.0.0' },
    search: async () => [],
    download: async () => ({ fileName: 'episode.srt', content: Buffer.from('subtitle') }),
  });
  assert.equal(plugin.kind, 'subtitle-provider');
  assert.deepEqual(plugin.capabilities.slice(0, 2), ['search', 'download']);
  assert.deepEqual(plugin.manifest.capabilityDomains, {
    search: ['subtitle'],
    download: ['subtitle'],
  });
  assert.equal(assertPlugin(plugin), plugin);

  assert.throws(() => definePlugin({
    manifest: {
      id: 'incomplete-subtitles',
      name: 'Incomplete subtitles',
      kind: 'subtitle-provider',
      version: '1.0.0',
      capabilityDomains: { search: ['subtitle'] },
    },
    actions: { search: async () => [] },
  }), /subtitle providers must implement search and download/);
});

test('storage providers may declare the optional sidecar write capability', () => {
  const plugin = defineStoragePlugin({
    manifest: { id: 'sidecar-storage', name: 'Sidecar storage', version: '1.0.0' },
    actions: { ...storageActions(), writeSidecar: async () => ({ ok: true }) },
    removeModes: ['permanent'],
  });
  assert.ok(plugin.capabilities.includes('writeSidecar'));
  assert.deepEqual(plugin.manifest.capabilityDomains.writeSidecar, ['storage']);

  assert.throws(() => defineStoragePlugin({
    manifest: { id: 'misclassified-storage', name: 'Misclassified storage', version: '1.0.0' },
    actions: { ...storageActions(), writeSidecar: async () => ({ ok: true }) },
    capabilityDomains: { writeSidecar: ['subtitle'] },
    removeModes: ['permanent'],
  }), /storage writeSidecar must use the storage domain/);
});
