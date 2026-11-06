import { createHmac } from 'node:crypto';
import { definePlugin } from '../contract.mjs';

const TERMINAL_STATUS = Object.freeze({
  processed: { label: '追更完成', template: 'green' },
  skipped: { label: '追更已跳过', template: 'orange' },
  failed: { label: '追更失败', template: 'red' },
});
const MARKDOWN_SPECIALS = new Set('\\`*_{}[]()#+-.!|>~');

function pluginError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeWebhookUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  let url;
  try {
    url = new URL(input);
  } catch {
    throw pluginError('NOTIFICATION_INVALID_CONFIG');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw pluginError('NOTIFICATION_INVALID_CONFIG');
  }
  return url.toString();
}

function escapeMarkdown(value, fallback = '未知', maxLength = 240) {
  const input = String(value ?? fallback).replace(/[\r\n\t]+/g, ' ').trim() || fallback;
  return [...input].slice(0, maxLength)
    .map((character) => MARKDOWN_SPECIALS.has(character) ? `\\${character}` : character)
    .join('');
}

function formatStatusEvent(event = {}) {
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  const status = Object.hasOwn(TERMINAL_STATUS, payload.status)
    ? TERMINAL_STATUS[payload.status]
    : null;
  if (!status) return null;

  const showNameText = String(payload.showName || `节目 #${payload.showId ?? event.showId ?? '-'}`)
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240) || '未知';
  const showName = escapeMarkdown(showNameText);
  const lines = [`**节目**：${showName}`];
  if (payload.kind) lines.push(`**事件**：${escapeMarkdown(payload.kind)}`);
  if (Number.isSafeInteger(payload.seasonNumber) && payload.seasonNumber > 0) {
    const episodes = Array.isArray(payload.episodeNumbers)
      ? payload.episodeNumbers.filter((number) => Number.isSafeInteger(number) && number > 0)
      : [];
    lines.push(`**季 / 集**：S${String(payload.seasonNumber).padStart(2, '0')}${episodes.length
      ? ` E${episodes.map((number) => String(number).padStart(2, '0')).join(', E')}`
      : ''}`);
  }
  lines.push(`**结果**：${status.label}`);
  return {
    title: `${status.label} · ${showNameText}`.slice(0, 100),
    content: lines.join('\n'),
    template: status.template,
  };
}

export function createFeishuNotificationPlugin({
  webhookUrl = process.env.FEISHU_WEBHOOK_URL,
  webhookSecret = process.env.FEISHU_WEBHOOK_SECRET,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const endpoint = normalizeWebhookUrl(webhookUrl);
  const secret = String(webhookSecret || '');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive integer');
  }

  async function postCard({ title, content, template = 'blue' } = {}) {
    if (!endpoint) throw pluginError('NOTIFICATION_NOT_CONFIGURED');
    const payload = {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: { title: { content: String(title || '追剧引擎通知').slice(0, 100), tag: 'plain_text' }, template },
        elements: [{ tag: 'div', text: { content: String(content || '').slice(0, 3000), tag: 'lark_md' } }],
      },
    };
    if (secret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      payload.timestamp = timestamp;
      payload.sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch {
        throw pluginError(controller.signal.aborted
          ? 'NOTIFICATION_TIMEOUT'
          : 'NOTIFICATION_NETWORK_ERROR');
      }
      if (!response?.ok) throw pluginError('NOTIFICATION_HTTP_ERROR');

      let result;
      try {
        result = await response.json();
      } catch {
        throw pluginError(controller.signal.aborted
          ? 'NOTIFICATION_TIMEOUT'
          : 'NOTIFICATION_INVALID_RESPONSE');
      }
      if (!result || Number(result.code) !== 0) {
        throw pluginError('NOTIFICATION_REJECTED');
      }
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  }

  async function notifyStatusEvent({ event } = {}) {
    const message = formatStatusEvent(event);
    if (!message) return { ok: true, skipped: true };
    return postCard(message);
  }

  return definePlugin({
    manifest: {
      id: 'feishu-notification',
      name: 'Feishu notification provider',
      label: '飞书通知',
      kind: 'notification-provider',
      version: '0.1.0',
      configSchema: {
        version: 1,
        fields: [
          { key: 'webhookUrl', label: '飞书 Webhook 地址', type: 'url', required: true },
          { key: 'webhookSecret', label: '飞书签名密钥', type: 'password' },
        ],
      },
    },
    actions: { notifyStatusEvent },
    capabilityDomains: { notifyStatusEvent: ['notification'] },
    subscriptions: ['workflow.event.status_changed'],
    async onEvent(event) {
      return notifyStatusEvent({ event });
    },
    async health() {
      return {
        ok: Boolean(endpoint),
        detail: endpoint ? '飞书 Webhook 已配置' : '飞书 Webhook 未配置',
      };
    },
  });
}
