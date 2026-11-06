import { randomUUID } from 'node:crypto';

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(field + ' must be a positive integer');
  }
  return id;
}

function boundedLimit(value) {
  const limit = value == null ? 10 : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('limit must be a positive integer');
  }
  return Math.min(limit, 20);
}

function safeErrorCode(error) {
  const code = String(error?.code || 'RESOURCE_PROVIDER_ERROR');
  return /^[A-Z0-9_-]{1,64}$/i.test(code) ? code : 'RESOURCE_PROVIDER_ERROR';
}

function normalizeCandidate(item, providerId) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const shareUrl = String(item.shareUrl ?? item.url ?? '').trim();
  if (!shareUrl || shareUrl.length > 4096 || /[\u0000-\u001f\u007f]/.test(shareUrl)) return null;
  const title = String(item.title ?? item.name ?? '').trim().slice(0, 500) || null;
  const sourceId = item.sourceId ?? item.id;
  return {
    providerId,
    shareUrl,
    title,
    sourceId: sourceId == null ? null : String(sourceId).slice(0, 255),
  };
}

function latestProgress(episodes) {
  const present = (episodes || []).filter((item) =>
    item.status === 'present' || item.status === 'conflict' || Number(item.assetCount) > 0);
  present.sort((left, right) => Number(left.seasonNumber) - Number(right.seasonNumber)
    || Number(left.episodeNumber) - Number(right.episodeNumber));
  return present.at(-1) || { seasonNumber: 0, episodeNumber: 0 };
}

export function createResourceDiscoveryService({
  shows,
  episodes,
  listPlugins,
  invoke,
  followup,
} = {}) {
  if (!shows || typeof shows.getById !== 'function') {
    throw new TypeError('shows repository is required');
  }
  if (!episodes || typeof episodes.getStorageById !== 'function'
      || typeof episodes.listStorageEpisodes !== 'function') {
    throw new TypeError('episode repository is required');
  }
  if (typeof listPlugins !== 'function' || typeof invoke !== 'function') {
    throw new TypeError('plugin listing and invocation functions are required');
  }
  if (!followup || typeof followup.previewShare !== 'function') {
    throw new TypeError('follow-up preview service is required');
  }

  async function searchForShow({
    showId: showIdValue,
    storageId: storageIdValue,
    query: queryValue,
    limit: limitValue,
  } = {}) {
    const showId = positiveId(showIdValue, 'showId');
    const storageId = positiveId(storageIdValue, 'storageId');
    const show = await shows.getById(showId);
    if (!show) {
      const error = new Error('show ' + showId + ' not found');
      error.status = 404;
      error.code = 'SHOW_NOT_FOUND';
      throw error;
    }
    if (show.mediaType !== 'tv') {
      const error = new Error('resource discovery only supports TV shows');
      error.status = 422;
      error.code = 'UNSUPPORTED_MEDIA_TYPE';
      throw error;
    }

    const storage = await episodes.getStorageById(storageId);
    if (!storage || storage.showId !== showId) {
      const error = new Error('storage ' + storageId + ' does not belong to show ' + showId);
      error.status = 404;
      error.code = 'STORAGE_NOT_FOUND';
      throw error;
    }
    if (!storage.enabled) {
      const error = new Error('storage ' + storageId + ' is disabled');
      error.status = 422;
      error.code = 'STORAGE_DISABLED';
      throw error;
    }

    const limit = boundedLimit(limitValue);
    const query = String(queryValue ?? show.name).trim();
    if (!query || query.length > 200) {
      const error = new TypeError('query must contain 1 to 200 characters');
      error.code = 'INVALID_QUERY';
      throw error;
    }

    const providers = listPlugins({
      domain: 'resource',
      capability: 'search',
      enabledOnly: true,
    });
    const progress = latestProgress(await episodes.listStorageEpisodes(storageId));
    const correlationId = randomUUID();
    const results = [];
    const providerResults = [];
    const seenShares = new Set();

    for (const provider of providers) {
      const remaining = limit - results.length;
      if (remaining <= 0) break;
      try {
        const response = await invoke(provider.id, {
          capability: 'search',
          input: {
            query,
            aliases: [...(show.aliases || [])],
            mediaType: 'tv',
            storageProvider: storage.providerId,
            seasonNumber: Number(progress.seasonNumber) || null,
            episodeNumber: Number(progress.episodeNumber) || 0,
            limit: remaining,
          },
          context: { source: 'resource-discovery', showId, storageId, correlationId },
        });
        const items = Array.isArray(response) ? response : response?.items;
        if (!Array.isArray(items)) {
          const error = new Error('resource provider returned an invalid result');
          error.code = 'RESOURCE_RESPONSE_INVALID';
          throw error;
        }
        const truncated = !Array.isArray(response) && response.truncated === true;

        let accepted = 0;
        for (const item of items) {
          if (results.length >= limit) break;
          const candidate = normalizeCandidate(item, provider.id);
          if (!candidate || seenShares.has(candidate.shareUrl)) continue;
          seenShares.add(candidate.shareUrl);

          let preview;
          try {
            preview = await followup.previewShare({
              showId,
              storageId,
              shareUrl: candidate.shareUrl,
              shareTitle: candidate.title,
            });
          } catch (error) {
            preview = {
              eligible: false,
              reason: 'preview_failed',
              errorCode: safeErrorCode(error),
            };
          }
          results.push({ ...candidate, preview, searchComplete: !truncated });
          accepted += 1;
        }
        providerResults.push({
          providerId: provider.id,
          ok: true,
          resultCount: accepted,
          truncated,
        });
      } catch (error) {
        providerResults.push({
          providerId: provider.id,
          ok: false,
          resultCount: 0,
          errorCode: safeErrorCode(error),
        });
      }
    }

    if (providers.length > 0 && providerResults.length > 0
        && providerResults.every((result) => !result.ok)) {
      const error = new Error('all resource providers failed');
      error.status = 502;
      error.code = 'ALL_RESOURCE_PROVIDERS_FAILED';
      error.providers = providerResults;
      throw error;
    }

    return {
      show: { id: show.id, name: show.name },
      storage: { id: storage.id, providerId: storage.providerId },
      query,
      providers: providerResults,
      results,
    };
  }

  return Object.freeze({ searchForShow });
}
