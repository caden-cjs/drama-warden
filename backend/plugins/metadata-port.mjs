export function createMetadataPluginPort(host) {
  if (!host || typeof host.listPlugins !== 'function' || typeof host.invoke !== 'function') {
    throw new TypeError('plugin host is required');
  }

  return Object.freeze({
    listProviders({ enabledOnly = true } = {}) {
      return host.listPlugins({ kind: 'metadata-provider', enabledOnly })
        .filter((plugin) => plugin.capabilities.includes('detail')
          && plugin.capabilities.includes('episodes'))
        .map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          label: plugin.label,
          capabilities: plugin.capabilities,
          capabilityDomains: plugin.capabilityDomains,
        }));
    },

    invoke(providerId, request) {
      return host.invoke(providerId, request);
    },
  });
}
