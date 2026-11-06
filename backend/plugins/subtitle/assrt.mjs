import { defineSubtitlePlugin } from '../contract.mjs';
import { MAX_SUBTITLE_DOWNLOAD_BYTES, subtitleError } from './http.mjs';

const ASSRT_ROOT = 'https://assrt.net';

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

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw subtitleError('Assrt returned an invalid file name', 'INVALID_SUBTITLE_RESPONSE');
  }
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, number) => {
      const point = Number(number);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, digits) => {
      const point = Number.parseInt(digits, 16);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
    })
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function createAssrtPlugin({ fetchImpl = fetch } = {}) {
  let lastRequestAt = 0;
  let rateQueue = Promise.resolve();
  async function waitForRateLimit() {
    const previous = rateQueue;
    let release;
    rateQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const delay = 2400 - (Date.now() - lastRequestAt);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      lastRequestAt = Date.now();
    } finally {
      release();
    }
  }
  async function request(url, { maxBytes, timeoutMs = 15_000 } = {}) {
    await waitForRateLimit();
    // Use the shared bounded downloader after an explicit request so the response
    // body is streamed and cannot grow without limit.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': 'drama-warden/0.1.0', Accept: 'text/html,application/zip,*/*' },
        signal: controller.signal,
        redirect: 'follow',
      });
      const finalUrl = new URL(response.url || String(url));
      if (finalUrl.protocol !== 'https:'
          || (finalUrl.hostname !== 'assrt.net' && !finalUrl.hostname.endsWith('.assrt.net'))) {
        throw subtitleError('Assrt redirected to an unsupported host', 'UNSAFE_DOWNLOAD_URL');
      }
      if (!response.ok) throw subtitleError('Assrt returned HTTP ' + response.status, 'SUBTITLE_HTTP_ERROR');
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body || []) {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > maxBytes) throw subtitleError('Assrt response exceeds the size limit', 'SUBTITLE_TOO_LARGE');
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      if (error?.name === 'AbortError') throw subtitleError('Assrt request timed out', 'SUBTITLE_TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return defineSubtitlePlugin({
    manifest: {
      id: 'assrt',
      name: 'Assrt',
      label: '伪射手字幕网',
      version: '1.0.0',
    },
    search: async ({ query, limit = 10 } = {}) => {
      const searchText = requiredText(query, 'query');
      if (searchText.length > 200) throw new TypeError('query is too long');
      const url = new URL('/sub/', ASSRT_ROOT);
      url.searchParams.set('searchword', searchText);
      const html = (await request(url, { maxBytes: 1_000_000 })).toString('utf8');
      const results = [];
      const pattern = /href=["']\/download\/(\d+)\/([^"']+\.zip)["']/gi;
      let match;
      while ((match = pattern.exec(html)) && results.length < boundedLimit(limit)) {
        const fileName = decodePathSegment(match[2]).split('/').at(-1);
        if (!fileName.toLowerCase().endsWith('.zip')) continue;
        const rowStart = html.lastIndexOf('<tr', match.index);
        const rowEnd = html.indexOf('</tr', match.index);
        const row = rowStart >= 0 && rowEnd > match.index && rowEnd - rowStart <= 4000
          ? html.slice(rowStart, rowEnd)
          : html.slice(Math.max(0, match.index - 300), Math.min(html.length, match.index + 500));
        results.push({
          id: match[1] + '/' + match[2],
          fileName: fileName.slice(0, 255),
          title: stripHtml(row).slice(0, 500),
          language: 'chi',
          seasonNumber: null,
          episodeNumber: null,
        });
      }
      return results;
    },
    download: async ({ candidateId } = {}) => {
      const id = requiredText(candidateId, 'candidateId');
      const match = id.match(/^(\d+)\/([^/]+\.zip)$/i);
      if (!match || match[2].includes('..')) throw new TypeError('candidateId is invalid');
      const decodedName = decodePathSegment(match[2]);
      if (decodedName.includes('/') || decodedName.includes('\\') || /[\u0000-\u001f]/.test(decodedName)) {
        throw new TypeError('candidateId is invalid');
      }
      const url = new URL('/download/' + match[1] + '/' + encodeURIComponent(decodedName), ASSRT_ROOT);
      const content = await request(url, { maxBytes: MAX_SUBTITLE_DOWNLOAD_BYTES, timeoutMs: 30_000 });
      return { fileName: decodePathSegment(match[2]), content };
    },
    health: async () => ({ ok: true, configured: true }),
  });
}
