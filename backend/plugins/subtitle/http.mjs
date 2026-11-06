export const SUBTITLE_TIMEOUT_MS = 15_000;
export const MAX_SUBTITLE_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 1 * 1024 * 1024;

export function subtitleError(message, code = 'SUBTITLE_PROVIDER_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readResponseBytes(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw subtitleError('subtitle provider response exceeds the size limit', 'SUBTITLE_TOO_LARGE');
  }
  const chunks = [];
  let total = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        throw subtitleError('subtitle provider response exceeds the size limit', 'SUBTITLE_TOO_LARGE');
      }
      chunks.push(bytes);
    }
  }
  return Buffer.concat(chunks, total);
}

export async function requestSubtitleBytes(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = SUBTITLE_TIMEOUT_MS,
  maxBytes = MAX_JSON_BYTES,
  allowedHosts,
  fetchImpl = fetch,
  redirect = 'follow',
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
      redirect,
    });
    const finalUrl = new URL(response.url || String(url));
    if (allowedHosts && !allowedHosts.some((host) =>
      finalUrl.hostname === host || finalUrl.hostname.endsWith('.' + host))) {
      throw subtitleError('subtitle provider redirected to an unsupported host', 'UNSAFE_DOWNLOAD_URL');
    }
    if (!response.ok) {
      throw subtitleError('subtitle provider returned HTTP ' + response.status, 'SUBTITLE_HTTP_ERROR');
    }
    return await readResponseBytes(response, maxBytes);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw subtitleError('subtitle provider request timed out', 'SUBTITLE_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestSubtitleJson(url, options = {}) {
  const content = await requestSubtitleBytes(url, {
    ...options,
    maxBytes: options.maxBytes || MAX_JSON_BYTES,
  });
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    throw subtitleError('subtitle provider returned invalid JSON', 'INVALID_SUBTITLE_RESPONSE');
  }
}
