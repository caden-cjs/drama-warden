import { limitEpisodeSaveBatch, planResourceEpisodeSelection } from './episode-selection.mjs';

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizedDate(value) {
  const date = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function episodeKey(seasonNumber, episodeNumber) {
  return seasonNumber + ':' + episodeNumber;
}

function statusByEpisode(storedEpisodes, seasonNumber) {
  const result = new Map();
  for (const item of storedEpisodes || []) {
    const season = positiveInteger(item?.seasonNumber);
    const episode = positiveInteger(item?.episodeNumber);
    if (season !== seasonNumber || !episode) continue;
    const status = item.status === 'conflict' || Number(item.assetCount) > 1
      ? 'conflict'
      : item.status === 'present' || Number(item.assetCount) === 1
        ? 'present'
        : 'missing';
    result.set(episodeKey(season, episode), status);
  }
  return result;
}

/**
 * Build a single-season, single-resource plan. The caller must supply an
 * explicit storage snapshot and a normalized share listing before any write.
 */
export function createFollowupPlan({
  seasonNumber,
  metadataEpisodes = [],
  storedEpisodes = [],
  sharedFiles = [],
  today = new Date().toISOString().slice(0, 10),
  maxEpisodes = 3,
  maxBytes = 8 * 1024 ** 3,
} = {}) {
  const season = positiveInteger(seasonNumber);
  if (!season) throw new TypeError('seasonNumber must be a positive integer');
  const currentDate = normalizedDate(today);
  if (!currentDate) throw new TypeError('today must use YYYY-MM-DD');

  const statuses = statusByEpisode(storedEpisodes, season);
  const expected = new Map();
  for (const item of metadataEpisodes || []) {
    const episode = positiveInteger(item?.episodeNumber);
    const itemSeason = positiveInteger(item?.seasonNumber) || season;
    if (itemSeason !== season || !episode) continue;
    const date = normalizedDate(item.airDate);
    expected.set(episode, {
      episodeNumber: episode,
      airDate: date,
      isFuture: date != null && date > currentDate,
      status: statuses.get(episodeKey(season, episode)) || 'missing',
    });
  }

  const conflicts = [...expected.values()]
    .filter((item) => item.status === 'conflict')
    .map((item) => item.episodeNumber)
    .sort((a, b) => a - b);
  const missingAiredEpisodeNumbers = [...expected.values()]
    .filter((item) => item.status === 'missing' && !item.isFuture)
    .map((item) => item.episodeNumber)
    .sort((a, b) => a - b);
  const missingFutureEpisodeNumbers = [...expected.values()]
    .filter((item) => item.status === 'missing' && item.isFuture)
    .map((item) => item.episodeNumber)
    .sort((a, b) => a - b);

  const resourcePlan = planResourceEpisodeSelection({
    missingAiredEpisodeNumbers,
    missingFutureEpisodeNumbers,
    files: sharedFiles,
    seasonNumber: season,
  });
  const batch = limitEpisodeSaveBatch(resourcePlan.selectedFiles, {
    maxEpisodes,
    maxBytes,
  });

  return {
    seasonNumber: season,
    conflicts,
    missingAiredEpisodeNumbers,
    missingFutureEpisodeNumbers,
    futureAvailableEpisodeNumbers: resourcePlan.futureAvailableEpisodeNumbers,
    requestedEpisodeNumbers: resourcePlan.requestedEpisodeNumbers,
    selectedFiles: resourcePlan.selectedFiles,
    saveBatch: batch.files,
    estimatedBytes: batch.bytes,
    deferredCount: batch.deferred,
  };
}
