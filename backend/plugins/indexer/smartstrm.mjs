import { definePlugin } from '../contract.mjs';

function pluginError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw pluginError('SMARTSTRM_BASE_URL must be an absolute HTTP(S) URL', 'INDEXER_INVALID_CONFIG');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw pluginError('SMARTSTRM_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment', 'INDEXER_INVALID_CONFIG');
  }
  return url.toString().replace(/\/+$/, '');
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createSmartstrmIndexerPlugin({
  baseUrl = process.env.SMARTSTRM_BASE_URL,
  webhookToken = process.env.SMARTSTRM_WEBHOOK_TOKEN,
  taskName = process.env.SMARTSTRM_TASK_NAME,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const token = String(webhookToken || '').trim();
  const normalizedTaskName = String(taskName || '').trim();
  if (!token || !normalizedTaskName) {
    throw pluginError('SMARTSTRM_WEBHOOK_TOKEN and SMARTSTRM_TASK_NAME are required', 'INDEXER_INVALID_CONFIG');
  }
  if (typeof fetchImpl !== 'function') {
    throw pluginError('fetch is unavailable in this Node.js runtime', 'INDEXER_UNAVAILABLE');
  }

  const webhookUrl = normalizedBaseUrl + '/webhook/' + encodeURIComponent(token);

  async function post(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      const payload = parseJson(await response.text());
      if (!response.ok) {
        throw pluginError('SmartStrm returned HTTP ' + response.status, 'INDEXER_HTTP_ERROR');
      }
      return payload;
    } catch (error) {
      if (error?.code) throw error;
      if (error?.name === 'AbortError') {
        throw pluginError('SmartStrm request timed out', 'INDEXER_TIMEOUT');
      }
      throw pluginError('SmartStrm request failed', 'INDEXER_NETWORK_ERROR');
    } finally {
      clearTimeout(timeout);
    }
  }

  async function reindex() {
    const result = await post({ event: 'a_task', task: { name: normalizedTaskName } });
    if (result?.success !== true) {
      throw pluginError('SmartStrm did not confirm the reindex request', 'INDEXER_UNCONFIRMED');
    }
    return { ok: true, taskName: normalizedTaskName };
  }

  async function health() {
    try {
      await post({ action: 'ping' });
      return { ok: true, configured: true, detail: 'SmartStrm webhook is reachable' };
    } catch (error) {
      return {
        ok: false,
        configured: true,
        detail: error?.code === 'INDEXER_TIMEOUT'
          ? 'SmartStrm webhook timed out'
          : error?.code === 'INDEXER_HTTP_ERROR'
            ? 'SmartStrm rejected the health request'
            : 'SmartStrm webhook is unavailable',
        errorCode: error?.code || 'INDEXER_ERROR',
      };
    }
  }

  return definePlugin({
    manifest: {
      id: 'smartstrm',
      name: 'SmartStrm',
      label: 'SmartStrm 索引',
      kind: 'indexer',
      version: '0.1.0',
      configSchema: {
        version: 1,
        fields: [
          { key: 'baseUrl', label: 'SmartStrm 地址', type: 'url', required: true },
          { key: 'webhookToken', label: 'Webhook Token', type: 'password', required: true },
          { key: 'taskName', label: '索引任务名', type: 'text', required: true },
        ],
      },
    },
    actions: { reindex },
    capabilityDomains: { reindex: ['indexer'] },
    health,
    monitor: health,
  });
}

const configured = [
  process.env.SMARTSTRM_BASE_URL,
  process.env.SMARTSTRM_WEBHOOK_TOKEN,
  process.env.SMARTSTRM_TASK_NAME,
].every((value) => String(value || '').trim());

export const plugin = configured ? createSmartstrmIndexerPlugin() : null;
export const manifest = plugin?.manifest || null;
export const provider = plugin;
export default plugin;
