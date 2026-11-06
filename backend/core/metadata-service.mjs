import { episodeFromVideoFile } from './media-naming.mjs';

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function latestSeasonNumber(seasons = []) {
  return seasons.reduce((latest, item) => {
    const number = Number(item?.seasonNumber);
    return Number.isSafeInteger(number) && number > latest ? number : latest;
  }, 0);
}

function manifestCoverage(episodes) {
  const numbers = new Set(
    episodes.map((item) => Number(item.episodeNumber))
      .filter((number) => Number.isSafeInteger(number) && number > 0),
  );
  const sorted = [...numbers].sort((a, b) => a - b);
  const maximum = sorted.at(-1) || 0;
  let nextExpected = 1;
  let firstGap = null;
  for (const number of sorted) {
    if (number < nextExpected) continue;
    if (number > nextExpected) {
      firstGap = nextExpected;
      break;
    }
    nextExpected += 1;
  }
  if (firstGap == null && nextExpected <= maximum) firstGap = nextExpected;
  return { numbers, maximum, firstGap };
}

function providerFailure(providerId, error) {
  const code = String(error?.code || 'provider_error');
  return {
    providerId,
    code: /^[A-Z0-9_-]{1,64}$/i.test(code) ? code : 'provider_error',
    message: 'Metadata provider request failed',
  };
}

function validateProviderList(providers) {
  if (!Array.isArray(providers)) throw new TypeError('providers must be an array');
  return providers.filter((provider) =>
    provider && typeof provider.id === 'string' && Array.isArray(provider.capabilities));
}

async function persistManifest({ showId, providerId, externalId, detail, seasonNumber, episodes, catalog }) {
  const seasons = Array.isArray(detail?.seasons) ? detail.seasons : [];
  const seasonsByNumber = new Map();
  for (const season of seasons) {
    const number = Number(season?.seasonNumber);
    if (!Number.isSafeInteger(number) || number < 0) continue;
    seasonsByNumber.set(number, season);
  }

  const targetSeasonNumber = Number(seasonNumber);
  if (!seasonsByNumber.has(targetSeasonNumber)) {
    seasonsByNumber.set(targetSeasonNumber, { seasonNumber: targetSeasonNumber });
  }
  for (const season of seasonsByNumber.values()) {
    await catalog.upsertSeason({
      showId,
      seasonNumber: Number(season.seasonNumber),
      name: season.name,
      episodeCount: season.episodeCount,
      firstAirDate: season.airDate,
      providerId,
    });
  }

  let persistedEpisodes = 0;
  for (const item of episodes) {
    const seasonValue = item.seasonNumber == null || item.seasonNumber === ''
      ? targetSeasonNumber
      : Number(item.seasonNumber);
    const currentSeason = Number.isSafeInteger(seasonValue) && seasonValue >= 0
      ? seasonValue
      : targetSeasonNumber;
    const episodeNumber = positiveInteger(item.episodeNumber);
    if (!episodeNumber) continue;

    if (!seasonsByNumber.has(currentSeason)) {
      await catalog.upsertSeason({
        showId,
        seasonNumber: currentSeason,
        providerId,
      });
      seasonsByNumber.set(currentSeason, { seasonNumber: currentSeason });
    }
    const episode = await catalog.upsertEpisode({
      showId,
      seasonNumber: currentSeason,
      episodeNumber,
    });
    const providerEpisodeId = item.externalId ?? item.id;
    await catalog.upsertEpisodeMetadata({
      episodeId: episode.id,
      providerId,
      providerExternalId: String(externalId),
      providerEpisodeId: providerEpisodeId == null ? null : String(providerEpisodeId),
      name: item.name,
      overview: item.overview,
      airDate: item.airDate,
      airTime: item.airTime,
      runtime: item.runtime,
      stillPath: item.stillPath,
      metadata: item,
    });
    persistedEpisodes += 1;
  }

  return { showId: Number(showId), providerId, externalId: String(externalId), persistedEpisodes };
}

export function createMetadataService({
  shows,
  catalog,
  listProviders,
  invoke,
} = {}) {
  if (!shows || typeof shows.getById !== 'function'
      || typeof shows.linkMetadataIdentity !== 'function'
      || typeof shows.listMetadataIdentities !== 'function') {
    throw new TypeError('shows repository is required');
  }
  if (!catalog || typeof catalog.upsertSeason !== 'function'
      || typeof catalog.upsertEpisode !== 'function'
      || typeof catalog.upsertEpisodeMetadata !== 'function') {
    throw new TypeError('episode catalog repository is required');
  }
  if (typeof listProviders !== 'function' || typeof invoke !== 'function') {
    throw new TypeError('provider listing and invocation functions are required');
  }

  function availableProviders({ enabledOnly = true } = {}) {
    return validateProviderList(listProviders({ enabledOnly }));
  }

  function callProvider(providerId, capability, input, context) {
    return invoke(providerId, { capability, input, context });
  }

  async function getShow(showId) {
    const show = await shows.getById(showId);
    if (!show) throw new Error('show ' + showId + ' not found');
    return show;
  }

  async function listIdentities(showId) {
    await getShow(showId);
    return shows.listMetadataIdentities(showId);
  }

  async function linkIdentity({
    showId,
    providerId,
    externalId,
    mediaType = 'tv',
    linkedBy = 'manual',
  } = {}) {
    const show = await getShow(showId);
    if (!/^[a-z][a-z0-9-]*$/.test(String(providerId || ''))) {
      throw new TypeError('providerId is invalid');
    }
    if (!['tv', 'movie'].includes(mediaType)) {
      throw new TypeError('mediaType must be tv or movie');
    }
    const provider = availableProviders({ enabledOnly: false })
      .find((item) => item.id === providerId);
    if (!provider) throw new Error('metadata provider is not registered: ' + providerId);
    if (!provider.capabilities.includes('detail')) {
      throw new Error('metadata provider does not provide detail: ' + providerId);
    }
    const identity = await shows.linkMetadataIdentity({
      showId: show.id,
      providerId,
      externalId,
      mediaType,
      linkedBy,
    });
    return { ...identity, showName: show.name };
  }

  async function findExactIdentity(show, provider, { persist = true } = {}) {
    if (!provider.capabilities.includes('search')) return null;
    const titles = [...new Set([show.name, ...(show.aliases || [])]
      .map((value) => String(value || '').trim())
      .filter(Boolean))];
    for (const title of titles) {
      const matches = await callProvider(provider.id, 'search', {
        query: title,
        mediaType: 'tv',
        limit: 25,
      }, { source: 'metadata-auto-link', showId: show.id });
      const normalized = normalizeTitle(title);
      const exact = (Array.isArray(matches) ? matches : []).filter((item) =>
        normalizeTitle(item.name) === normalized
        || normalizeTitle(item.originalName) === normalized);
      const externalIds = [...new Set(exact
        .map((item) => String(item.externalId ?? item.id ?? '').trim())
        .filter(Boolean))];
      if (externalIds.length === 1) {
        if (persist) {
          try {
            await shows.linkMetadataIdentity({
              showId: show.id,
              providerId: provider.id,
              externalId: externalIds[0],
              mediaType: 'tv',
              linkedBy: 'exact-match',
            });
          } catch (cause) {
            const error = new Error('metadata identity could not be saved', { cause });
            error.code = 'METADATA_LINK_FAILED';
            throw error;
          }
        }
        return { providerId: provider.id, externalId: externalIds[0], mediaType: 'tv' };
      }
    }
    return null;
  }

  async function resolveEpisodeManifest(showId, {
    seasonNumber,
    observedMaxEpisode = 0,
    observedEpisodes,
    currentSeason = 0,
    currentEpisode = 0,
    requireNextEpisode = true,
    autoLink = true,
  } = {}) {
    const show = await getShow(showId);
    const eligible = availableProviders({ enabledOnly: true })
      .filter((provider) => provider.capabilities.includes('detail')
        && provider.capabilities.includes('episodes'));
    const identities = new Map(
      (await shows.listMetadataIdentities(show.id))
        .map((identity) => [identity.providerId, identity]),
    );
    const failures = [];
    let bestInsufficient = null;

    for (const provider of eligible) {
      try {
        let identity = identities.get(provider.id);
        if (!identity) identity = await findExactIdentity(show, provider, { persist: autoLink });
        if (!identity) continue;

        const detail = await callProvider(provider.id, 'detail', {
          externalId: identity.externalId,
          mediaType: identity.mediaType || 'tv',
        }, { source: 'metadata-resolution', showId: show.id });
        if (!detail) continue;

        const targetSeason = positiveInteger(seasonNumber)
          || latestSeasonNumber(detail.seasons);
        if (!Number.isSafeInteger(targetSeason) || targetSeason <= 0) continue;

        const providerEpisodes = await callProvider(provider.id, 'episodes', {
          externalId: identity.externalId,
          seasonNumber: targetSeason,
        }, { source: 'metadata-resolution', showId: show.id });
        const episodes = (Array.isArray(providerEpisodes) ? providerEpisodes : [])
          .filter((item) => positiveInteger(item?.episodeNumber))
          .filter((item) => item.seasonNumber == null
            || Number(item.seasonNumber) === targetSeason)
          .map((item) => ({
            ...item,
            seasonNumber: positiveInteger(item.seasonNumber) || targetSeason,
            episodeNumber: positiveInteger(item.episodeNumber),
          }));
        if (episodes.length === 0) continue;

        try {
          await persistManifest({
            showId: show.id,
            providerId: provider.id,
            externalId: identity.externalId,
            detail,
            seasonNumber: targetSeason,
            episodes,
            catalog,
          });
        } catch (cause) {
          const error = new Error('metadata manifest could not be saved', { cause });
          error.code = 'METADATA_PERSIST_FAILED';
          throw error;
        }

        const coverage = manifestCoverage(episodes);
        const observed = Array.isArray(observedEpisodes)
          ? observedEpisodes.reduce((maximum, item) => {
            const parsed = episodeFromVideoFile(item);
            return parsed?.seasonNumber === targetSeason
              ? Math.max(maximum, parsed.episodeNumber)
              : maximum;
          }, 0)
          : Number.isSafeInteger(Number(observedMaxEpisode))
            ? Math.max(0, Number(observedMaxEpisode))
            : 0;
        const nextRequiredEpisode = Number(currentSeason) > 0
          && Number(currentSeason) < targetSeason
          ? 1
          : Math.max(0, Number(currentEpisode) || 0) + 1;
        const requiredStart = requireNextEpisode
          ? nextRequiredEpisode
          : Math.max(1, observed);
        const requiredEpisode = Math.max(
          observed,
          requireNextEpisode ? nextRequiredEpisode : 0,
        );
        const hasRequiredRange = requiredEpisode >= requiredStart;
        const sufficient = coverage.maximum >= requiredEpisode
          && coverage.firstGap == null
          && (!hasRequiredRange || coverage.numbers.has(requiredEpisode));
        const result = {
          showId: show.id,
          showName: show.name,
          providerId: provider.id,
          externalId: identity.externalId,
          mediaType: identity.mediaType || 'tv',
          detail,
          seasonNumber: targetSeason,
          episodes,
          maxEpisode: coverage.maximum,
          sufficient,
          requiredEpisode,
          coverageGapEpisode: coverage.firstGap,
        };
        if (sufficient) return { ...result, failures };
        bestInsufficient ||= result;
      } catch (error) {
        if (error?.code === 'METADATA_LINK_FAILED'
            || error?.code === 'METADATA_PERSIST_FAILED') throw error;
        failures.push(providerFailure(provider.id, error));
      }
    }

    if (bestInsufficient) return { ...bestInsufficient, sufficient: false, failures };
    return {
      showId: Number(showId),
      showName: show.name,
      detail: null,
      seasonNumber: positiveInteger(seasonNumber),
      episodes: [],
      maxEpisode: 0,
      sufficient: false,
      failures,
    };
  }

  async function search(query, {
    mediaType = 'tv',
    limit = 10,
    context = {},
  } = {}) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) throw new TypeError('query is required');
    if (normalizedQuery.length > 200) throw new TypeError('query must be 200 characters or fewer');
    if (!['tv', 'movie'].includes(mediaType)) {
      throw new TypeError('mediaType must be tv or movie');
    }
    const requestedLimit = Number(limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new TypeError('limit must be a positive integer');
    }
    const boundedLimit = Math.min(50, requestedLimit);
    const providers = availableProviders({ enabledOnly: true })
      .filter((provider) => provider.capabilities.includes('search'));
    const results = [];
    const providerResults = [];
    const errors = [];

    for (const provider of providers) {
      try {
        const matches = await callProvider(provider.id, 'search', {
          query: normalizedQuery,
          mediaType,
          limit: boundedLimit,
        }, { source: 'metadata-search', ...context });
        const items = (Array.isArray(matches) ? matches : [])
          .slice(0, boundedLimit)
          .map((item) => ({
            ...item,
            providerId: provider.id,
            providerLabel: provider.label || provider.name || provider.id,
          }));
        providerResults.push({
          providerId: provider.id,
          providerLabel: provider.label || provider.name || provider.id,
          ok: true,
          count: items.length,
        });
        results.push(...items);
      } catch (error) {
        const failure = providerFailure(provider.id, error);
        providerResults.push({
          providerId: provider.id,
          providerLabel: provider.label || provider.name || provider.id,
          ok: false,
          code: failure.code,
        });
        errors.push(failure);
      }
    }

    if (providerResults.length && !providerResults.some((provider) => provider.ok)) {
      const error = new Error('all metadata providers failed');
      error.code = 'ALL_PROVIDERS_FAILED';
      error.providers = errors;
      throw error;
    }
    return {
      query: normalizedQuery,
      mediaType,
      providers: providerResults,
      results,
      errors,
    };
  }

  async function searchProvider(providerId, query, { mediaType = 'tv', limit = 10 } = {}) {
    const provider = availableProviders({ enabledOnly: false })
      .find((item) => item.id === providerId);
    if (!provider) throw new Error('plugin is not registered: ' + providerId);
    if (!provider.capabilities.includes('search')) {
      throw new Error('plugin does not provide search: ' + providerId);
    }
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) throw new TypeError('query is required');
    if (normalizedQuery.length > 200) throw new TypeError('query must be 200 characters or fewer');
    if (!['tv', 'movie'].includes(mediaType)) {
      throw new TypeError('mediaType must be tv or movie');
    }
    const requestedLimit = Number(limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new TypeError('limit must be a positive integer');
    }
    return callProvider(provider.id, 'search', {
      query: normalizedQuery,
      mediaType,
      limit: Math.min(50, requestedLimit),
    }, {
      source: 'metadata-search',
    });
  }

  return Object.freeze({
    getShow,
    listIdentities,
    linkIdentity,
    resolveEpisodeManifest,
    searchProvider,
    search,
  });
}
