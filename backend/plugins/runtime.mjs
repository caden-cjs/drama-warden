import { createPluginHost } from './host.mjs';
import { loadConfiguredPlugins } from './loader.mjs';

export async function createPluginRuntime({
  builtins = [],
  env = process.env,
  context = {},
  onCall,
  logger,
  initialize = true,
} = {}) {
  const host = createPluginHost({ onCall, logger });
  for (const plugin of builtins) host.register(plugin);
  const externalPluginIds = await loadConfiguredPlugins(host, {
    env,
    context,
  });
  async function initializePlugins() {
    return host.initializePlugins(context);
  }
  if (initialize) await initializePlugins();
  return Object.freeze({
    host,
    initializePlugins,
    externalPluginIds: Object.freeze(externalPluginIds),
  });
}
