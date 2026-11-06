import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPlugin, PLUGIN_API_VERSION } from './contract.mjs';

function isPathSpecifier(specifier) {
  return specifier.startsWith('./')
    || specifier.startsWith('../')
    || specifier.startsWith('/')
    || specifier.startsWith('file:');
}

async function importPluginModule(specifier, baseDir) {
  if (!isPathSpecifier(specifier)) return import(specifier);
  const url = specifier.startsWith('file:')
    ? specifier
    : pathToFileURL(resolve(baseDir, specifier)).href;
  return import(url);
}

function configurationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizedPluginLoadError(error, message) {
  const code = String(error?.code || 'PLUGIN_ERROR');
  return configurationError(
    /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'PLUGIN_ERROR',
    message,
  );
}

function pluginEnvironmentPrefix(pluginId) {
  const normalizedId = String(pluginId)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll('-', '_')
    .toUpperCase();
  return `DRAMA_WARDEN_PLUGIN_${normalizedId}_`;
}

function pluginConfigEnvironmentKey(prefix, key) {
  const normalizedKey = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();
  return prefix + normalizedKey;
}

function resolvePluginConfig(manifest, env) {
  const pluginId = String(manifest?.id || '');
  const prefix = pluginEnvironmentPrefix(pluginId);
  const schema = manifest?.configSchema ?? { version: 1, fields: [] };
  if (!schema || schema.version !== 1 || !Array.isArray(schema.fields)) {
    throw configurationError('PLUGIN_CONFIG_INVALID', 'plugin config schema is invalid');
  }

  const values = {};
  const declaredVariables = new Set();
  const keys = new Set();
  const configFields = [];
  for (const field of schema.fields) {
    const key = String(field?.key || '');
    const type = String(field?.type || 'text');
    if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(key) || keys.has(key)
        || !['text', 'url', 'password'].includes(type)) {
      throw configurationError('PLUGIN_CONFIG_INVALID', 'plugin config schema is invalid');
    }
    keys.add(key);
    const variable = pluginConfigEnvironmentKey(prefix, key);
    if (declaredVariables.has(variable)) {
      throw configurationError('PLUGIN_CONFIG_INVALID', 'plugin config fields map to the same environment key');
    }
    declaredVariables.add(variable);
    configFields.push({ key, type, required: Boolean(field.required) });
    const value = env[variable];
    if (value == null || String(value).trim() === '') {
      if (Boolean(field.required)) {
        throw configurationError('PLUGIN_CONFIG_REQUIRED', 'required plugin configuration is missing');
      }
      continue;
    }
    const normalizedValue = String(value);
    if (type === 'url') {
      let parsed;
      try {
        parsed = new URL(normalizedValue);
      } catch {
        throw configurationError('PLUGIN_CONFIG_INVALID', 'plugin URL configuration is invalid');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw configurationError('PLUGIN_CONFIG_INVALID', 'plugin URL configuration is invalid');
      }
    }
    values[key] = normalizedValue;
  }

  if (pluginId) {
    for (const variable of Object.keys(env)) {
      if (variable.startsWith(prefix) && !declaredVariables.has(variable)) {
        throw configurationError('PLUGIN_CONFIG_INVALID', 'plugin has an unknown configuration key');
      }
    }
  }
  return {
    values: Object.freeze(values),
    fields: Object.freeze(configFields.map((field) => Object.freeze(field))),
  };
}

async function materializePlugin(moduleNamespace, context, env) {
  const exported = moduleNamespace.default
    || moduleNamespace.plugin
    || moduleNamespace;
  if (exported && typeof exported.create === 'function') {
    const manifest = exported.manifest || {};
    const apiVersion = manifest.apiVersion;
    if (apiVersion !== undefined && apiVersion !== PLUGIN_API_VERSION) {
      throw configurationError('PLUGIN_API_VERSION_UNSUPPORTED', 'plugin API version is unsupported');
    }
    const { values: config, fields: configFields } = resolvePluginConfig(manifest, env);
    let plugin;
    try {
      plugin = await exported.create({ ...context, config });
    } catch (error) {
      throw normalizedPluginLoadError(error, 'plugin factory failed');
    }
    return { plugin, configFields, factoryManifest: manifest };
  }
  const plugin = exported;
  const { values: config, fields: configFields } = resolvePluginConfig(plugin?.manifest, env);
  if (Object.keys(config).length > 0) {
    throw configurationError(
      'PLUGIN_CONFIG_FACTORY_REQUIRED',
      'configured plugins must export a create(context) factory',
    );
  }
  return { plugin, configFields, factoryManifest: plugin?.manifest };
}

export async function loadPlugin(specifier, {
  baseDir = process.cwd(),
  context = {},
  env = process.env,
} = {}) {
  if (typeof specifier !== 'string' || !specifier.trim()) {
    throw new TypeError('plugin specifier is required');
  }
  const normalizedSpecifier = specifier.trim();
  let moduleNamespace;
  try {
    moduleNamespace = await importPluginModule(normalizedSpecifier, baseDir);
  } catch (error) {
    throw normalizedPluginLoadError(error, 'plugin module import failed');
  }
  const { plugin, configFields, factoryManifest } = await materializePlugin(
    moduleNamespace,
    context,
    env,
  );
  const validated = assertPlugin(plugin);
  if ((factoryManifest?.id != null && factoryManifest.id !== validated.id)
      || (factoryManifest.version != null && factoryManifest.version !== validated.version)
      || (factoryManifest.kind != null && factoryManifest.kind !== validated.kind)) {
    throw configurationError('PLUGIN_MANIFEST_INVALID', 'plugin factory manifest does not match its plugin');
  }
  const actualConfigFields = validated.configSchema.fields.map((field) => ({
    key: field.key,
    type: field.type,
    required: Boolean(field.required),
  }));
  if (JSON.stringify(configFields) !== JSON.stringify(actualConfigFields)) {
    throw configurationError(
      'PLUGIN_CONFIG_INVALID',
      'plugin factory config schema does not match its manifest',
    );
  }
  return validated;
}

export async function loadConfiguredPlugins(host, {
  env = process.env,
  variable = 'DRAMA_WARDEN_PLUGINS',
  baseDir = process.cwd(),
  context = {},
} = {}) {
  const configured = String(env[variable] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const loaded = [];
  for (const specifier of configured) {
    const plugin = await loadPlugin(specifier, { baseDir, context, env });
    host.register(plugin);
    loaded.push(plugin.id);
  }
  return loaded;
}
