const DEFAULT_TIMEOUT_MS = 12_000;

function metadataError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requestFailureCode(cause) {
  return cause?.name === 'TimeoutError' || cause?.name === 'AbortError'
    ? 'METADATA_TIMEOUT'
    : 'METADATA_NETWORK_ERROR';
}

export function requiredExternalId(value) {
  const externalId = String(value ?? '').trim();
  if (!/^\d+$/.test(externalId)) {
    throw new TypeError('externalId must be a positive numeric identifier');
  }
  return externalId;
}

export function positiveSeasonNumber(value) {
  const seasonNumber = Number(value);
  if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0) {
    throw new TypeError('seasonNumber must be a nonnegative integer');
  }
  return seasonNumber;
}

export function boundedSearchInput({ query, limit = 10 } = {}) {
  const normalizedQuery = String(query ?? '').trim();
  if (!normalizedQuery) throw new TypeError('query is required');
  if (normalizedQuery.length > 200) throw new TypeError('query must be 200 characters or fewer');
  const requestedLimit = Number(limit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new TypeError('limit must be a positive integer');
  }
  return { query: normalizedQuery, limit: Math.min(50, requestedLimit) };
}

export async function requestJson(url, {
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  beforeRequest,
  fetchImpl = globalThis.fetch,
} = {}) {
  await beforeRequest?.();
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'drama-warden/0.1.0 metadata-provider',
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw metadataError(
      'metadata provider request failed',
      requestFailureCode(cause),
    );
  }

  if (!response.ok) {
    const code = response.status === 404 ? 'METADATA_NOT_FOUND'
      : response.status === 429 ? 'METADATA_RATE_LIMITED'
        : response.status >= 500 ? 'METADATA_UPSTREAM_ERROR'
          : 'METADATA_UPSTREAM_REJECTED';
    throw metadataError('metadata provider returned an unsuccessful response', code);
  }

  try {
    return await response.json();
  } catch (cause) {
    if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
      throw metadataError('metadata provider request failed', 'METADATA_TIMEOUT');
    }
    if (!(cause instanceof SyntaxError)) {
      throw metadataError('metadata provider request failed', requestFailureCode(cause));
    }
    throw metadataError('metadata provider returned invalid JSON', 'METADATA_INVALID_RESPONSE');
  }
}

export async function checkMetadataConnection(url, options = {}) {
  try {
    const result = await requestJson(url, options);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { ok: false, configured: true, errorCode: 'METADATA_INVALID_RESPONSE' };
    }
    return { ok: true, configured: true };
  } catch (error) {
    const code = String(error?.code || 'METADATA_PROVIDER_ERROR');
    return {
      ok: false,
      configured: true,
      errorCode: /^[A-Z0-9_-]{1,64}$/i.test(code) ? code : 'METADATA_PROVIDER_ERROR',
    };
  }
}

export function dateYear(value) {
  const match = String(value || '').match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

export function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
