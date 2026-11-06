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

const API_ROOT = 'https://api.themoviedb.org/3';

function mediaEndpoint(mediaType) {
  if (mediaType === 'tv' || mediaType === 'movie') return mediaType;
  throw new TypeError('mediaType must be tv or movie');
}

function tmdbResult(item, mediaType) {
  const externalId = String(item.id);
  const title = mediaType === 'movie' ? item.title : item.name;
  const originalName = mediaType === 'movie' ? item.original_title : item.original_name;
  const firstAirDate = mediaType === 'movie' ? item.release_date : item.first_air_date;
  return {
    id: externalId,
    externalId,
    providerId: 'tmdb',
    mediaType,
    name: title || '',
    originalName: originalName || title || '',
    overview: cleanText(item.overview),
    firstAirDate: firstAirDate || null,
    year: dateYear(firstAirDate),
    language: item.original_language || null,
    posterPath: item.poster_path || null,
    backdropPath: item.backdrop_path || null,
    voteAverage: item.vote_average != null && Number.isFinite(Number(item.vote_average))
      ? Number(item.vote_average)
      : null,
    externalUrl: 'https://www.themoviedb.org/' + mediaType + '/' + externalId,
  };
}

function tmdbSeason(season) {
  const seasonNumber = Number(season.season_number);
  if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0) return null;
  return {
    seasonNumber,
    name: season.name || null,
    episodeCount: season.episode_count != null && Number.isSafeInteger(Number(season.episode_count))
      ? Number(season.episode_count)
      : null,
    airDate: season.air_date || null,
    externalId: String(season.id),
  };
}

function tmdbEpisode(episode, seasonNumber) {
  const episodeNumber = Number(episode.episode_number);
  if (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) return null;
  return {
    id: String(episode.id),
    externalId: String(episode.id),
    seasonNumber,
    episodeNumber,
    name: episode.name || null,
    overview: cleanText(episode.overview),
    airDate: episode.air_date || null,
    runtime: episode.runtime != null && Number.isSafeInteger(Number(episode.runtime))
      ? Number(episode.runtime)
      : null,
    stillPath: episode.still_path || null,
  };
}

export function createTmdbPlugin({ apiKey = process.env.TMDB_API_KEY } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new TypeError('TMDB_API_KEY is required to create the TMDB provider');

  function apiUrl(path, params = {}) {
    const url = new URL(API_ROOT + path);
    url.searchParams.set('api_key', key);
    for (const [name, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(name, String(value));
    }
    return url;
  }

  async function getTvShow(externalId) {
    return requestJson(apiUrl('/tv/' + encodeURIComponent(externalId)));
  }

  return defineMetadataPlugin({
    manifest: {
      id: 'tmdb',
      name: 'The Movie Database',
      label: 'TMDB',
      version: '1.0.0',
    },
    search: async ({ query, mediaType = 'tv', limit = 10 } = {}) => {
      const endpoint = mediaEndpoint(mediaType);
      const input = boundedSearchInput({ query, limit });
      const response = await requestJson(apiUrl('/search/' + endpoint, {
        query: input.query,
        include_adult: false,
        page: 1,
      }));
      return (Array.isArray(response?.results) ? response.results : [])
        .slice(0, input.limit)
        .filter((item) => item?.id != null)
        .map((item) => tmdbResult(item, endpoint));
    },
    detail: async ({ externalId, mediaType = 'tv' } = {}) => {
      if (mediaType !== 'tv') {
        const error = new TypeError('TMDB episode manifests are supported for TV series only');
        error.code = 'UNSUPPORTED_MEDIA_TYPE';
        throw error;
      }
      const id = requiredExternalId(externalId);
      const show = await getTvShow(id);
      return {
        ...tmdbResult(show, 'tv'),
        seasons: (Array.isArray(show.seasons) ? show.seasons : [])
          .map(tmdbSeason)
          .filter(Boolean),
      };
    },
    episodes: async ({ externalId, seasonNumber } = {}) => {
      const id = requiredExternalId(externalId);
      const season = positiveSeasonNumber(seasonNumber);
      const response = await requestJson(apiUrl(
        '/tv/' + encodeURIComponent(id) + '/season/' + season,
      ));
      return (Array.isArray(response?.episodes) ? response.episodes : [])
        .map((episode) => tmdbEpisode(episode, season))
        .filter(Boolean);
    },
    health: async () => checkMetadataConnection(apiUrl('/configuration')),
  });
}
