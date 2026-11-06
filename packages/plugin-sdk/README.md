# @drama-warden/plugin-sdk

MIT-licensed contract helpers for Drama Warden external plugins.

This package is version `0.1.0`. Its API v2 contract is still evolving and is not yet stable. Pin the SDK version used by a plugin and review the matching Drama Warden release before upgrading. The runtime requires Node.js `>=22.15`; TypeScript declarations use `const` type parameters and require TypeScript `>=5.0`. JavaScript consumers do not need TypeScript. This workspace package has not yet been published to npm.

## Metadata provider

```js
import { defineMetadataPlugin } from '@drama-warden/plugin-sdk';

export default defineMetadataPlugin({
  manifest: {
    id: 'example-metadata',
    name: 'Example Metadata',
    version: '1.0.0',
  },
  search: async ({ query, mediaType = 'tv', limit = 10 }) => [],
  detail: async ({ externalId, mediaType = 'tv' }) => null,
  episodes: async ({ externalId, seasonNumber }) => [],
});
```

The host validates the plugin manifest and required capabilities at startup. Plugins run in the application process and inherit its environment and file/network access; load only code you trust. Per-plugin environment prefixes route settings into `context.config`, but they do not isolate secrets: any loaded plugin can read every value in `process.env`.

## Other provider kinds

Use `defineResourcePlugin()` for resource search, `defineSubtitlePlugin()` for subtitle search and download, and `defineStoragePlugin()` for storage. These helpers expose capability-specific TypeScript inputs and results. Storage actions encode their paths, file selections, and sidecar bytes; plugins must implement every capability in `STORAGE_CAPABILITIES` and declare at least one supported `removeModes` policy. In TypeScript, a literal declaration such as `removeModes: ['recycle']` narrows the `mode` accepted by both `remove` and `clean`, and the returned `storageContract.removeModes` retains that tuple type. `recycle` and `permanent` have different effects and must not be substituted for one another.

Indexers, notification providers, and workflow providers use `definePlugin()` with an explicit `manifest.kind`, `actions`, and a `capabilityDomains` entry for every action. Shared lifecycle hooks include `health`, `monitor`, `reset`, `initialize`, `subscriptions`, and `onEvent`. The host serializes `reset()` and `initialize()` against active calls and each other. Disabling a plugin also calls `reset()` after draining active calls; re-enabling calls `initialize()` before accepting new calls. Keep reset safe to retry because cleanup can fail partway through. See the [provider contract guide](../../docs/PROVIDERS.md) for capability inputs, outputs, and side-effect boundaries.

`PluginContext` fields are optional because each lifecycle receives different context. The plugin factory receives configured `config` and may receive a `logger`; capability calls may include `source`, `correlationId`, and numeric application-local `showId` or `storageId`. `onEvent()` receives the subscribing plugin's `pluginId`. Show and storage IDs are local database identifiers, not provider identities.

Plugins with settings should export a factory and declare matching `key`, `type`, and `required` fields in the factory manifest and returned plugin manifest:

```js
import { defineMetadataPlugin } from '@drama-warden/plugin-sdk';

const manifest = {
  id: 'example-metadata',
  version: '1.0.0',
  configSchema: {
    version: 1,
    fields: [
      { key: 'endpoint', type: 'url', required: true },
      { key: 'apiKey', type: 'password', required: true },
    ],
  },
};

export default {
  manifest,
  create({ config }) {
    return defineMetadataPlugin({
      manifest,
      search: async ({ query }) => [],
      detail: async () => null,
      episodes: async () => [],
    });
  },
};
```

Set `DRAMA_WARDEN_PLUGIN_EXAMPLE_METADATA_ENDPOINT` and `DRAMA_WARDEN_PLUGIN_EXAMPLE_METADATA_API_KEY` in the private process environment. The host validates required fields and HTTP(S) URLs, then passes the values as `context.config`. Configuration values are never stored in plugin settings, manifests, or capability audit records.

`packages/plugin-sdk/type-tests/consumer.mts` is compiled in CI as an external TypeScript consumer with both TypeScript 5.0.4 and the current development compiler. The check first verifies that the application dependency, lockfile root dependency, locked workspace version, and lockfile workspace link all match this package version and path. It then packs the SDK, places the tarball contents in a temporary consumer project, compares all JavaScript value exports and TypeScript type exports with the reviewed public API, verifies the ESM runtime import, and compiles the fixture against the packaged declarations. The fixture is not included in the SDK tarball.
