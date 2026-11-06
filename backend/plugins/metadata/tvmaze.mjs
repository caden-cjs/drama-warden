import { defineMetadataPlugin } from '../contract.mjs';
import {
  boundedSearchInput,
  checkMetadataConnection,
  cleanText,
  dateYear,
  positiveSeasonNumber,
  requestJson,
  requiredExternalId,
} from './http.mjs';

const API_ROOT = 'https://api.tvmaze.com';
const MAX_REQUESTS_PER_WINDOW = 19;
const RATE_WINDOW_MS = 10_000;
const SEASON_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHED_SHOWS = 100;

function createRateLimiter() {
  const requestTimes = [];
  return async function waitForCapacity() {
    while (true) {
      const now = Date.now();
      while (requestTimes.length && now - requestTimes[0] >= RATE_WINDOW_MS) {
        requestTimes.shift();
      }
      if (requestTimes.length < MAX_REQUESTS_PER_WINDOW) {
        requestTimes.push(now);
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, Math.max(1, requestTimes[0] + RATE_WINDOW_MS - now));
      });
    }
  };
}

function showResult(show, score) {
  const externalId = String(show.id);
  const firstAirDate = show.premiered || null;
  return {
    id: externalId,
    externalId,
    providerId: 'tvmaze',
    mediaType: 'tv',
    name: show.name || '',
    originalName: show.name || '',
    overview: cleanText(show.summary),
    firstAirDate,
    year: dateYear(firstAirDate),
    status: show.status || null,
    language: show.language || null,
    genres: Array.isArray(show.genres) ? show.genres : [],
    posterPath: show.image?.medium || show.image?.original || null,
    externalUrl: show.url || null,
    ...(score != null && Number.isFinite(Number(score)) ? { score: Number(score) } : {}),
  };
}

function seasonResult(season) {
  const seasonNumber = Number(season.number);
  if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0) return null;
  return {
    seasonNumber,
    name: season.name || null,
    episodeCount: season.episodeOrder != null && Number.isSafeInteger(Number(season.episodeOrder))
      ? Number(season.episodeOrder)
      : null,
    airDate: season.premiereDate || null,
    externalId: String(season.id),
  };
}

function episodeResult(episode, seasonNumber) {
  const episodeNumber = Number(episode.number);
  if (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) return null;
  return {
    id: String(episode.id),
    externalId: String(episode.id),
    seasonNumber,
    episodeNumber,
    name: episode.name || null,
    overview: cleanText(episode.summary),
    airDate: episode.airdate || null,
    airTime: episode.airtime || null,
    runtime: episode.runtime != null && Number.isSafeInteger(Number(episode.runtime))
      ? Number(episode.runtime)
      : null,
    stillPath: episode.image?.original || episode.image?.medium || null,
  };
}

export function createTvmazePlugin() {
  const beforeRequest = createRateLimiter();
  const seasonCache = new Map();

  async function getSeasons(externalId, { refresh = false } = {}) {
    const cached = seasonCache.get(externalId);
    if (!refresh && cached && Date.now() - cached.cachedAt < SEASON_CACHE_TTL_MS) {
      return cached.seasons;
    }

    const url = new URL('/shows/' + encodeURIComponent(externalId) + '/seasons', API_ROOT);
    const seasons = await requestJson(url, { beforeRequest });
    const normalized = Array.isArray(seasons) ? seasons.map(seasonResult).filter(Boolean) : [];
    seasonCache.delete(externalId);
    seasonCache.set(externalId, { cachedAt: Date.now(), seasons: normalized });
    while (seasonCache.size > MAX_CACHED_SHOWS) {
      seasonCache.delete(seasonCache.keys().next().value);
    }
    return normalized;
  }

  return defineMetadataPlugin({
    manifest: {
      id: 'tvmaze',
      name: 'TVmaze',
      label: 'TVmaze',
      version: '1.0.0',
    },
    search: async ({ query, mediaType = 'tv', limit = 10 } = {}) => {
      if (mediaType !== 'tv') return [];
      const input = boundedSearchInput({ query, limit });
      const url = new URL('/search/shows', API_ROOT);
      url.searchParams.set('q', input.query);
      const results = await requestJson(url, { beforeRequest });
      return (Array.isArray(results) ? results : [])
        .slice(0, input.limit)
        .filter((item) => item?.show && item.show.id != null)
        .map((item) => showResult(item.show, item.score));
    },
    detail: async ({ externalId, mediaType = 'tv' } = {}) => {
      if (mediaType !== 'tv') {
        const error = new TypeError('TVmaze provides TV series details only');
        error.code = 'UNSUPPORTED_MEDIA_TYPE';
        throw error;
      }
      const id = requiredExternalId(externalId);
      const showUrl = new URL('/shows/' + encodeURIComponent(id), API_ROOT);
      const show = await requestJson(showUrl, { beforeRequest });
      const seasons = await getSeasons(id, { refresh: true });
      return { ...showResult(show), seasons };
    },
    episodes: async ({ externalId, seasonNumber } = {}) => {
      const id = requiredExternalId(externalId);
      const season = positiveSeasonNumber(seasonNumber);
      const cached = seasonCache.get(id);
      const seasons = cached && Date.now() - cached.cachedAt < SEASON_CACHE_TTL_MS
        ? cached.seasons
        : await getSeasons(id);
      const match = seasons.find((item) => item.seasonNumber === season);
      if (!match) return [];

      const url = new URL('/seasons/' + encodeURIComponent(match.externalId) + '/episodes', API_ROOT);
      const episodes = await requestJson(url, { beforeRequest });
      return (Array.isArray(episodes) ? episodes : [])
        .map((episode) => episodeResult(episode, season))
        .filter(Boolean);
    },
    health: async () => checkMetadataConnection(
      new URL('/shows/1', API_ROOT),
      { beforeRequest },
    ),
    reset: async () => seasonCache.clear(),
  });
}
