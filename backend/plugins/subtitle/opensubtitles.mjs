import { defineSubtitlePlugin } from '../contract.mjs';
import {
  MAX_SUBTITLE_DOWNLOAD_BYTES,
  requestSubtitleBytes,
  requestSubtitleJson,
  subtitleError,
} from './http.mjs';

const API_ROOT = 'https://api.opensubtitles.com/api/v1';
const MIN_REQUEST_INTERVAL_MS = 1500;

function requiredText(value, field) {
  const result = String(value ?? '').trim();
  if (!result) throw new TypeError(field + ' is required');
  return result;
}

function boundedLimit(value) {
  const number = Number(value ?? 10);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError('limit must be a positive integer');
  return Math.min(number, 30);
}

function languagesValue(value) {
  const values = Array.isArray(value) ? value : value ? [value] : ['zh-CN', 'zh-TW'];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))]
    .filter((item) => /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/.test(item))
    .slice(0, 5)
    .join(',');
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function createOpenSubtitlesPlugin({
  apiKey = process.env.OPENSUBTITLES_API_KEY || '',
  userAgent = process.env.OPENSUBTITLES_USER_AGENT || 'drama-warden v0.1.0',
  fetchImpl = fetch,
  requestIntervalMs = MIN_REQUEST_INTERVAL_MS,
} = {}) {
  const key = String(apiKey || '').trim();
  let lastRequestAt = 0;
  let waiting = Promise.resolve();

  async function throttle() {
    const previous = waiting;
    let release;
    waiting = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const delay = requestIntervalMs - (Date.now() - lastRequestAt);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      lastRequestAt = Date.now();
    } finally {
      release();
    }
  }

  async function apiJson(url, options = {}) {
    if (!key) throw subtitleError('OpenSubtitles API key is not configured', 'PROVIDER_NOT_CONFIGURED');
    await throttle();
    return requestSubtitleJson(url, {
      method: options.method || 'GET',
      headers: {
        'Api-Key': key,
        'User-Agent': userAgent,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      allowedHosts: ['opensubtitles.com'],
      redirect: 'error',
      fetchImpl,
    });
  }

  return defineSubtitlePlugin({
    manifest: {
      id: 'opensubtitles',
      name: 'OpenSubtitles',
      label: 'OpenSubtitles',
      version: '1.0.0',
      configSchema: {
        version: 1,
        fields: [
          { key: 'apiKey', label: 'API key', type: 'password', required: true },
          { key: 'userAgent', label: 'User-Agent', type: 'text' },
        ],
      },
    },
    search: async ({ query, languages, seasonNumber, episodeNumber, limit = 10 } = {}) => {
      const searchText = requiredText(query, 'query');
      if (searchText.length > 200) throw new TypeError('query is too long');
      const url = new URL('/subtitles', API_ROOT);
      url.searchParams.set('query', searchText);
      url.searchParams.set('type', 'episode');
      url.searchParams.set('languages', languagesValue(languages));
      if (Number.isSafeInteger(Number(seasonNumber))) url.searchParams.set('season_number', String(seasonNumber));
      if (Number.isSafeInteger(Number(episodeNumber))) url.searchParams.set('episode_number', String(episodeNumber));
      const data = await apiJson(url);
      const results = [];
      for (const item of Array.isArray(data?.data) ? data.data : []) {
        const attributes = item?.attributes || {};
        const feature = attributes.feature_details || {};
        for (const file of Array.isArray(attributes.files) ? attributes.files : []) {
          const fileId = String(file?.file_id ?? '');
          if (!/^\d+$/.test(fileId)) continue;
          results.push({
            id: fileId,
            fileName: String(file?.file_name || attributes.release || ('subtitle-' + fileId + '.srt')).slice(0, 255),
            language: String(attributes.language || ''),
            release: String(attributes.release || ''),
            seasonNumber: numericOrNull(feature.season_number ?? attributes.season_number),
            episodeNumber: numericOrNull(feature.episode_number ?? attributes.episode_number),
          });
          if (results.length >= boundedLimit(limit)) return results;
        }
      }
      return results;
    },
    download: async ({ candidateId } = {}) => {
      const fileId = requiredText(candidateId, 'candidateId');
      if (!/^\d+$/.test(fileId)) throw new TypeError('candidateId is invalid');
      const info = await apiJson(new URL('/download', API_ROOT), {
        method: 'POST',
        body: { file_id: Number(fileId) },
      });
      const link = new URL(requiredText(info?.link, 'download link'));
      if (link.protocol !== 'https:' || link.username || link.password
          || (link.hostname !== 'opensubtitles.com' && !link.hostname.endsWith('.opensubtitles.com'))) {
        throw subtitleError('OpenSubtitles returned an unsafe download URL', 'UNSAFE_DOWNLOAD_URL');
      }
      const content = await requestSubtitleBytes(link, {
        maxBytes: MAX_SUBTITLE_DOWNLOAD_BYTES,
        timeoutMs: 30_000,
        allowedHosts: ['opensubtitles.com'],
        headers: { 'User-Agent': userAgent },
        fetchImpl,
      });
      return { fileName: String(info.file_name || ('subtitle-' + fileId + '.srt')), content };
    },
    health: async () => ({ ok: Boolean(key), configured: Boolean(key) }),
  });
}
