import { assertPlugin } from './contract.mjs';

function safeErrorCode(error) {
  const code = String(error?.code || 'PLUGIN_ERROR');
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'PLUGIN_ERROR';
}

function normalizedPluginError(error) {
  const normalized = new Error('plugin operation failed');
  normalized.code = safeErrorCode(error);
  normalized.isPluginError = true;
  if (error?.sideEffectMayHaveCompleted === true) {
    normalized.sideEffectMayHaveCompleted = true;
  }
  return normalized;
}

export function createPluginHost({ onCall = async () => {}, logger = console } = {}) {
  const entries = new Map();
  let nextOrder = 0;

  function getEntry(id) {
    const entry = entries.get(String(id));
    if (!entry) throw new Error('plugin is not registered: ' + id);
    return entry;
  }

  async function runPluginOperation(entry, operation, { allowDisabled = false } = {}) {
    if (!entry.enabled && !allowDisabled) {
      const error = new Error('plugin is disabled: ' + entry.plugin.id);
      error.code = 'PLUGIN_DISABLED';
      throw error;
    }
    while (entry.maintenance) await entry.maintenance;
    if (!entry.enabled && !allowDisabled) {
      const error = new Error('plugin is disabled: ' + entry.plugin.id);
      error.code = 'PLUGIN_DISABLED';
      throw error;
    }
    entry.activeCalls += 1;
    try {
      return await operation();
    } finally {
      entry.activeCalls -= 1;
      if (entry.activeCalls === 0) {
        for (const resolveIdle of entry.idleWaiters.splice(0)) resolveIdle();
      }
    }
  }

  function register(plugin, { replace = false, enabled = true, order } = {}) {
    assertPlugin(plugin);
    const current = entries.get(plugin.id);
    if (current && !replace) throw new Error('plugin is already registered: ' + plugin.id);
    if (current && replace && (current.activeCalls > 0 || current.maintenance)) {
      const error = new Error('plugin cannot be replaced while it is in use: ' + plugin.id);
      error.code = 'PLUGIN_LIFECYCLE_BUSY';
      throw error;
    }
    const entry = {
      plugin,
      enabled: current ? current.enabled : Boolean(enabled),
      order: Number.isFinite(order) ? Number(order) : current?.order ?? nextOrder,
      activeCalls: 0,
      idleWaiters: [],
      maintenance: null,
    };
    nextOrder = Math.max(nextOrder, entry.order + 1);
    entries.set(plugin.id, entry);
    return plugin;
  }

  function listPlugins({
    kind,
    enabledOnly = true,
    capability,
    domain,
  } = {}) {
    return [...entries.values()]
      .filter((entry) => !enabledOnly || entry.enabled)
      .filter((entry) => !kind || entry.plugin.kind === kind)
      .filter((entry) => !capability || entry.plugin.capabilities.includes(capability))
      .filter((entry) => !domain || (
        capability
          ? entry.plugin.manifest.capabilityDomains?.[capability]?.includes(domain)
          : Object.values(entry.plugin.manifest.capabilityDomains || {}).some((domains) =>
            domains.includes(domain))
      ))
      .sort((a, b) => a.order - b.order || a.plugin.id.localeCompare(b.plugin.id))
      .map((entry) => ({
        id: entry.plugin.id,
        name: entry.plugin.name,
        label: entry.plugin.label,
        kind: entry.plugin.kind,
        version: entry.plugin.version,
        apiVersion: entry.plugin.apiVersion,
        capabilities: [...entry.plugin.capabilities],
        capabilityDomains: entry.plugin.manifest.capabilityDomains,
        configSchema: entry.plugin.configSchema,
        ...(entry.plugin.storageContract ? { storageContract: entry.plugin.storageContract } : {}),
        enabled: entry.enabled,
        order: entry.order,
      }));
  }

  async function invoke(id, request = {}) {
    const entry = getEntry(id);
    return runPluginOperation(entry, async () => {
      const capability = String(request.capability || '');
      const startedAt = Date.now();
      let result;
      let operationError;
      try {
        result = await entry.plugin.invoke({
          capability,
          input: request.input || {},
          context: request.context || {},
        });
      } catch (error) {
        operationError = error;
      }

      const audit = {
        pluginId: entry.plugin.id,
        capability,
        source: String(request.context?.source || 'application'),
        correlationId: request.context?.correlationId || null,
        ok: !operationError,
        errorCode: operationError ? safeErrorCode(operationError) : null,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
      try {
        await onCall(audit);
      } catch (auditError) {
        logger.error?.('plugin call audit failed', {
          pluginId: entry.plugin.id,
          capability,
          errorCode: safeErrorCode(auditError),
        });
        if (!operationError) {
          const error = new Error('plugin operation completed but its audit record failed');
          error.code = 'PLUGIN_AUDIT_FAILED';
          error.sideEffectMayHaveCompleted = true;
          throw error;
        }
      }
      if (operationError) throw normalizedPluginError(operationError);
      return result;
    });
  }

  function setEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    const entry = getEntry(id);
    if (enabled && entry.maintenance) {
      const error = new Error('plugin lifecycle operation is in progress: ' + id);
      error.code = 'PLUGIN_LIFECYCLE_BUSY';
      throw error;
    }
    entry.enabled = enabled;
    return enabled;
  }

  function setOrder(id, order) {
    if (!Number.isSafeInteger(order) || order < 0) {
      throw new TypeError('order must be a nonnegative integer');
    }
    getEntry(id).order = order;
    return order;
  }

  function state(id) {
    const entry = getEntry(id);
    return { enabled: entry.enabled, order: entry.order };
  }

  async function initializePlugins(context = {}) {
    for (const entry of [...entries.values()].sort((a, b) => a.order - b.order)) {
      if (entry.enabled) await initializePlugin(entry.plugin.id, context);
    }
  }

  async function initializePlugin(id, context = {}, { allowDisabled = false } = {}) {
    const entry = getEntry(id);
    if (!entry.enabled && !allowDisabled) return false;
    let initialized = false;
    await runMaintenance(entry, async () => {
      if (!entry.enabled && !allowDisabled) return;
      if (typeof entry.plugin.initialize === 'function') {
        try {
          await entry.plugin.initialize(context);
        } catch (error) {
          throw normalizedPluginError(error);
        }
      }
      initialized = true;
    });
    return initialized;
  }

  async function publishEvent(event, context = {}) {
    if (!event || typeof event.type !== 'string') {
      throw new TypeError('event.type is required');
    }
    const subscribers = [...entries.values()].filter((entry) => entry.enabled
      && entry.plugin.subscriptions.some((subscription) =>
        subscription === '*' || subscription === event.type));
    const outcomes = await Promise.allSettled(subscribers.map((entry) =>
      runPluginOperation(entry, () => entry.plugin.onEvent(event, {
        ...context,
        pluginId: entry.plugin.id,
      }))));
    return outcomes.map((outcome, index) => ({
      pluginId: subscribers[index].plugin.id,
      ok: outcome.status === 'fulfilled',
      ...(outcome.status === 'rejected'
        ? { errorCode: safeErrorCode(outcome.reason) }
        : {}),
    }));
  }

  function waitForIdle(entry) {
    if (entry.activeCalls === 0) return Promise.resolve();
    return new Promise((resolve) => entry.idleWaiters.push(resolve));
  }

  async function runMaintenance(entry, operation) {
    const previous = entry.maintenance;
    const task = (async () => {
      if (previous) await previous.catch(() => {});
      await waitForIdle(entry);
      return operation();
    })();
    entry.maintenance = task;
    try {
      return await task;
    } finally {
      if (entry.maintenance === task) entry.maintenance = null;
    }
  }

  async function reset(id) {
    const entry = getEntry(id);
    await runMaintenance(entry, async () => {
      try {
        await entry.plugin.reset();
      } catch (error) {
        throw normalizedPluginError(error);
      }
    });
  }

  async function disable(id) {
    const entry = getEntry(id);
    entry.enabled = false;
    await runMaintenance(entry, async () => {
      try {
        await entry.plugin.reset();
      } catch (error) {
        throw normalizedPluginError(error);
      }
    });
    return false;
  }

  async function monitor(id) {
    const entry = getEntry(id);
    try {
      const result = await runPluginOperation(entry, () => entry.plugin.monitor(), {
        allowDisabled: true,
      });
      return { ...result, pluginId: entry.plugin.id, enabled: entry.enabled };
    } catch (error) {
      return {
        pluginId: entry.plugin.id,
        enabled: entry.enabled,
        ok: false,
        errorCode: safeErrorCode(error),
      };
    }
  }

  return Object.freeze({
    register,
    listPlugins,
    getPlugin: (id) => getEntry(id).plugin,
    invoke,
    setEnabled,
    setOrder,
    state,
    initializePlugin,
    initializePlugins,
    publishEvent,
    reset,
    disable,
    monitor,
  });
}
