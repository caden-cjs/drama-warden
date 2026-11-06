export const PLUGIN_API_VERSION = 2;
export const PLUGIN_KINDS = Object.freeze([
  'resource-provider',
  'metadata-provider',
  'storage-provider',
  'indexer',
  'notification-provider',
  'subtitle-provider',
  'workflow-provider',
]);

export const METADATA_CAPABILITIES = Object.freeze(['search', 'detail', 'episodes']);
export const RESOURCE_CAPABILITIES = Object.freeze(['search']);
export const SUBTITLE_CAPABILITIES = Object.freeze(['search', 'download']);
export const STORAGE_CAPABILITIES = Object.freeze([
  'list',
  'listSharedFiles',
  'save',
  'move',
  'mkdir',
  'rename',
  'renameMany',
  'remove',
  'clean',
  'status',
]);
export const STORAGE_OPTIONAL_CAPABILITIES = Object.freeze(['writeSidecar']);
export const STORAGE_REMOVE_MODES = Object.freeze(['recycle', 'permanent']);

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const CAPABILITY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;
const DOMAIN_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const EVENT_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
const CONFIG_TYPES = new Set(['text', 'url', 'password']);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(label + ' must be an object');
  }
}

function normalizeConfigSchema(configSchema = { version: 1, fields: [] }) {
  assertObject(configSchema, 'configSchema');
  if (configSchema.version !== 1 || !Array.isArray(configSchema.fields)) {
    throw new TypeError('configSchema must use version 1 and contain fields');
  }
  const keys = new Set();
  const fields = configSchema.fields.map((field) => {
    assertObject(field, 'config field');
    const key = String(field.key || '');
    const type = String(field.type || 'text');
    if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(key) || keys.has(key)) {
      throw new TypeError('config schema has an invalid or duplicate key');
    }
    if (!CONFIG_TYPES.has(type)) throw new TypeError('config field has an unsupported type');
    keys.add(key);
    return Object.freeze({
      key,
      label: String(field.label || key),
      type,
      ...(field.placeholder == null ? {} : { placeholder: String(field.placeholder) }),
      ...(field.helpText == null ? {} : { helpText: String(field.helpText) }),
      ...(field.required == null ? {} : { required: Boolean(field.required) }),
    });
  });
  return Object.freeze({ version: 1, fields: Object.freeze(fields) });
}

function normalizeDomains(domains = {}) {
  assertObject(domains, 'capabilityDomains');
  const result = {};
  for (const [capability, values] of Object.entries(domains)) {
    if (!CAPABILITY_PATTERN.test(capability) || !Array.isArray(values) || values.length === 0) {
      throw new TypeError('capabilityDomains contains an invalid capability');
    }
    const unique = [...new Set(values.map(String))];
    if (unique.length !== values.length || unique.some((domain) => !DOMAIN_PATTERN.test(domain))) {
      throw new TypeError('capabilityDomains contains an invalid domain');
    }
    result[capability] = Object.freeze(unique);
  }
  return Object.freeze(result);
}

function normalizeManifest(manifest, configSchema, capabilityDomains, storageContract) {
  assertObject(manifest, 'manifest');
  const id = String(manifest.id || '');
  const kind = String(manifest.kind || '');
  const version = String(manifest.version || '');
  if (!ID_PATTERN.test(id)) throw new TypeError('plugin manifest id is invalid');
  if (!PLUGIN_KINDS.includes(kind)) throw new TypeError('plugin manifest kind is unsupported');
  if (manifest.apiVersion != null && manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new TypeError('plugin API version is unsupported');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new TypeError('plugin manifest version must use semantic versioning');
  }
  return Object.freeze({
    id,
    name: String(manifest.name || id),
    label: String(manifest.label || manifest.name || id),
    kind,
    version,
    apiVersion: PLUGIN_API_VERSION,
    capabilityDomains,
    configSchema,
    ...(storageContract ? { storageContract } : {}),
  });
}

export function assertPlugin(plugin) {
  assertObject(plugin, 'plugin');
  assertObject(plugin.manifest, 'plugin manifest');
  assertObject(plugin.actions, 'plugin actions');
  if (plugin.apiVersion !== PLUGIN_API_VERSION || plugin.manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new TypeError('plugin API version is unsupported');
  }
  if (!ID_PATTERN.test(String(plugin.id || ''))
      || plugin.id !== plugin.manifest.id
      || plugin.kind !== plugin.manifest.kind
      || plugin.version !== plugin.manifest.version
      || plugin.name !== plugin.manifest.name
      || plugin.label !== plugin.manifest.label) {
    throw new TypeError('plugin runtime fields do not match its manifest');
  }
  if (!Array.isArray(plugin.capabilities)
      || plugin.capabilities.length !== Object.keys(plugin.actions).length
      || new Set(plugin.capabilities).size !== plugin.capabilities.length
      || plugin.capabilities.some((name) => typeof plugin.actions[name] !== 'function')) {
    throw new TypeError('plugin capabilities do not match its action map');
  }
  for (const [name, action] of Object.entries(plugin.actions)) {
    if (!CAPABILITY_PATTERN.test(name) || typeof action !== 'function') {
      throw new TypeError('plugin contains an invalid action');
    }
  }
  const configSchema = normalizeConfigSchema(plugin.manifest.configSchema);
  const capabilityDomains = normalizeDomains(plugin.manifest.capabilityDomains);
  if (JSON.stringify(capabilityDomains) !== JSON.stringify(plugin.capabilityDomains)
      || JSON.stringify(plugin.configKeys) !== JSON.stringify(configSchema.fields.map((field) => field.key))) {
    throw new TypeError('plugin runtime configuration does not match its manifest');
  }
  for (const [capability, domains] of Object.entries(capabilityDomains)) {
    if (!plugin.capabilities.includes(capability) || capability === 'monitor' || domains.length === 0) {
      throw new TypeError('plugin capability domains must map declared actions');
    }
  }
  for (const capability of plugin.capabilities) {
    if (capability !== 'monitor' && !capabilityDomains[capability]) {
      throw new TypeError('plugin action is missing a capability domain: ' + capability);
    }
  }
  if (JSON.stringify(configSchema) !== JSON.stringify(plugin.configSchema)) {
    throw new TypeError('plugin config schema does not match its manifest');
  }
  if (typeof plugin.invoke !== 'function'
      || typeof plugin.onEvent !== 'function'
      || typeof plugin.health !== 'function'
      || typeof plugin.monitor !== 'function'
      || typeof plugin.reset !== 'function') {
    throw new TypeError('plugin is missing a required lifecycle method');
  }
  if (!Array.isArray(plugin.subscriptions)
      || plugin.subscriptions.some((event) => event !== '*' && !EVENT_PATTERN.test(event))) {
    throw new TypeError('plugin subscriptions are invalid');
  }
  if (plugin.kind === 'metadata-provider'
      && METADATA_CAPABILITIES.some((capability) => !plugin.actions[capability])) {
    throw new TypeError('metadata providers must implement search, detail, and episodes');
  }
  if (plugin.kind === 'resource-provider'
      && RESOURCE_CAPABILITIES.some((capability) => !plugin.actions[capability])) {
    throw new TypeError('resource providers must implement search');
  }
  if (plugin.kind === 'resource-provider'
      && !plugin.manifest.capabilityDomains.search.includes('resource')) {
    throw new TypeError('resource provider search must use the resource capability domain');
  }
  if (plugin.kind === 'subtitle-provider') {
    if (SUBTITLE_CAPABILITIES.some((capability) => !plugin.actions[capability])) {
      throw new TypeError('subtitle providers must implement search and download');
    }
    if (SUBTITLE_CAPABILITIES.some((capability) =>
      !plugin.manifest.capabilityDomains[capability]?.includes('subtitle'))) {
      throw new TypeError('subtitle provider capabilities must use the subtitle domain');
    }
  }
  if (plugin.kind === 'storage-provider') {
    const contract = plugin.storageContract;
    if (!contract || contract.version !== 2
        || JSON.stringify(contract.coreCapabilities) !== JSON.stringify(STORAGE_CAPABILITIES)
        || !Array.isArray(contract.removeModes)
        || contract.removeModes.length === 0
        || contract.removeModes.some((mode) => !STORAGE_REMOVE_MODES.includes(mode))) {
      throw new TypeError('storage providers must declare storage contract v2');
    }
    if (STORAGE_CAPABILITIES.some((capability) => !plugin.actions[capability])) {
      throw new TypeError('storage provider does not implement the common contract');
    }
    if (Object.keys(plugin.actions).some((capability) =>
      !STORAGE_CAPABILITIES.includes(capability)
        && !STORAGE_OPTIONAL_CAPABILITIES.includes(capability)
        && capability !== 'monitor')) {
      throw new TypeError('storage provider declares an unsupported optional capability');
    }
    if (plugin.actions.writeSidecar
        && !plugin.manifest.capabilityDomains.writeSidecar?.includes('storage')) {
      throw new TypeError('storage writeSidecar must use the storage domain');
    }
  } else if (plugin.storageContract) {
    throw new TypeError('only storage providers may declare a storage contract');
  }
  return plugin;
}

export function definePlugin({
  manifest,
  actions,
  capabilityDomains,
  configSchema,
  subscriptions = [],
  storageContract = null,
  onEvent = async () => {},
  health = async () => ({ ok: true }),
  monitor = health,
  reset = async () => {},
  initialize,
} = {}) {
  assertObject(actions, 'actions');
  if (Object.hasOwn(actions, 'monitor')) {
    throw new TypeError('monitor is a reserved common capability');
  }
  const normalizedConfig = normalizeConfigSchema(
    configSchema ?? manifest?.configSchema,
  );
  const normalizedDomains = normalizeDomains(
    capabilityDomains ?? manifest?.capabilityDomains ?? {},
  );
  const normalizedStorageContract = storageContract == null
    ? null
    : Object.freeze({
      version: storageContract.version,
      coreCapabilities: Object.freeze([...storageContract.coreCapabilities]),
      removeModes: Object.freeze([...storageContract.removeModes]),
    });
  const normalizedManifest = normalizeManifest(
    manifest,
    normalizedConfig,
    normalizedDomains,
    normalizedStorageContract,
  );
  const actionMap = Object.freeze({
    ...actions,
    monitor: (input = {}, context = {}) => monitor(input, context),
  });
  const plugin = {
    ...normalizedManifest,
    manifest: normalizedManifest,
    capabilities: Object.freeze(Object.keys(actionMap)),
    actions: actionMap,
    configKeys: Object.freeze(normalizedConfig.fields.map((field) => field.key)),
    configSchema: normalizedConfig,
    subscriptions: Object.freeze([...subscriptions]),
    ...(normalizedStorageContract ? { storageContract: normalizedStorageContract } : {}),
    health,
    monitor,
    reset,
    ...(initialize ? { initialize } : {}),
    onEvent,
    async invoke({ capability, input = {}, context = {} } = {}) {
      const action = actionMap[capability];
      if (!action) throw new Error('unsupported capability: ' + capability);
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('plugin capability input must be an object');
      }
      return action(input, context);
    },
  };
  return assertPlugin(plugin);
}

export function defineMetadataPlugin({ manifest, search, detail, episodes, ...options } = {}) {
  for (const [name, action] of Object.entries({ search, detail, episodes })) {
    if (typeof action !== 'function') {
      throw new TypeError('metadata plugin requires ' + name + '()');
    }
  }
  return definePlugin({
    ...options,
    manifest: { ...manifest, kind: 'metadata-provider' },
    actions: { search, detail, episodes },
    capabilityDomains: {
      search: ['metadata'],
      detail: ['metadata'],
      episodes: ['metadata'],
      ...(options.capabilityDomains || {}),
    },
  });
}

export function defineResourcePlugin({ manifest, search, ...options } = {}) {
  if (typeof search !== 'function') {
    throw new TypeError('resource plugin requires search()');
  }
  return definePlugin({
    ...options,
    manifest: { ...manifest, kind: 'resource-provider' },
    actions: { search },
    capabilityDomains: {
      search: ['resource'],
      ...(options.capabilityDomains || {}),
    },
  });
}

export function defineSubtitlePlugin({ manifest, search, download, ...options } = {}) {
  for (const [name, action] of Object.entries({ search, download })) {
    if (typeof action !== 'function') {
      throw new TypeError('subtitle plugin requires ' + name + '()');
    }
  }
  return definePlugin({
    ...options,
    manifest: { ...manifest, kind: 'subtitle-provider' },
    actions: { search, download },
    capabilityDomains: {
      search: ['subtitle'],
      download: ['subtitle'],
      ...(options.capabilityDomains || {}),
    },
  });
}

export function defineStoragePlugin({ manifest, actions, removeModes, ...options } = {}) {
  const capabilityDomains = Object.fromEntries(
    Object.keys(actions || {}).filter((capability) => capability !== 'monitor')
      .map((capability) => [capability, ['storage']]),
  );
  return definePlugin({
    ...options,
    manifest: { ...manifest, kind: 'storage-provider' },
    actions,
    capabilityDomains: {
      ...capabilityDomains,
      ...(actions?.writeSidecar ? { writeSidecar: ['storage'] } : {}),
      ...(options.capabilityDomains || {}),
    },
    storageContract: {
      version: 2,
      coreCapabilities: STORAGE_CAPABILITIES,
      removeModes,
    },
  });
}
